import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { createApp } from '../../lib/api/api.js';
import { makeUsers, login, asUser, SECRET } from '../helpers/auth.js';
import { addUserQuery, listUserQueries } from '../../lib/services/queries/queriesStorage.js';

const url = (n) => `https://www.wg-gesucht.de/wg-zimmer-in-City${n}.${n}.0.1.0.html`;
const MUNICH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';

let alice;
let bob;
let raw;
let reevaluated;
const limit = 5; // roomy for the CRUD tests; the default (1) is tested on its own below
beforeAll(async () => {
  globalThis.__users = await makeUsers();
});

beforeEach(async () => {
  Db.close();
  Db.init(':memory:');
  await runMigrations();
  reevaluated = [];
  raw = await createApp({
    auth: { users: globalThis.__users, secret: SECRET },
    maxQueriesPerUser: limit,
    pipeline: { reevaluate: async (opts) => void reevaluated.push(opts) },
  });
  alice = asUser(raw, await login(raw, 'alice', '10.0.0.1'));
  bob = asUser(raw, await login(raw, 'bob', '10.0.0.2'));
});
afterEach(async () => {
  await raw.close();
  Db.close();
});

const call = (who, method, path, payload) => who.inject({ method, url: `/api/queries${path}`, payload });

describe('#api queries', () => {
  it("GET lists the user's queries and the per-user limit", async () => {
    addUserQuery('alice', { name: 'Munich', url: MUNICH });
    const res = await call(alice, 'GET', '');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [{ id: expect.any(Number), name: 'Munich', url: MUNICH, enabled: true, createdAt: expect.any(Number) }],
      max: 5,
    });
    expect((await call(bob, 'GET', '')).json().items).toEqual([]);
  });

  it('POST creates a query (name optional, enabled by default) and asks the pipeline to evaluate the new view', async () => {
    const res = await call(alice, 'POST', '', { name: 'Berlin', url: `${MUNICH}#frag` });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Berlin', url: MUNICH, enabled: true });
    expect(listUserQueries('alice')).toHaveLength(1);
    expect(reevaluated).toEqual([{ userId: 'alice', all: false }]);
    const unnamed = await call(alice, 'POST', '', { url: url(1), enabled: false });
    expect(unnamed.json()).toMatchObject({ name: '', enabled: false });
  });

  it.each([
    [{ url: 'https://evil.example/wg-zimmer-in-Muenchen.90.0.1.0.html' }, /www\.wg-gesucht\.de/],
    [{ url: 'http://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html' }, /https/],
    [{ url: 'https://www.wg-gesucht.de/' }, /search result/],
    [{ url: 'nonsense' }, /valid URL/],
    [{ name: 'x' }, /URL|url/],
  ])('POST rejects %j with 400 and a readable message', async (payload, message) => {
    const res = await call(alice, 'POST', '', payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
    expect(listUserQueries('alice')).toEqual([]);
    expect(reevaluated).toEqual([]);
  });

  it('POST rejects a name that is too long and a wrong type of enabled, and ignores unknown properties', async () => {
    expect((await call(alice, 'POST', '', { url: MUNICH, name: 'x'.repeat(81) })).statusCode).toBe(400);
    expect((await call(alice, 'POST', '', { url: MUNICH, enabled: 'maybe' })).statusCode).toBe(400);
    const res = await call(alice, 'POST', '', { url: MUNICH, userId: 'bob', id: 99 });
    expect(res.statusCode).toBe(201);
    expect(listUserQueries('alice')).toHaveLength(1); // stored for the session user, whatever the body says
    expect(listUserQueries('bob')).toEqual([]);
  });

  it('POST refuses the same URL twice (409)', async () => {
    expect((await call(alice, 'POST', '', { url: MUNICH })).statusCode).toBe(201);
    const dup = await call(alice, 'POST', '', { url: MUNICH });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatch(/already|at most/);
  });

  it('allows one query per user by default: the second is refused with a clear message, other users have their own', async () => {
    await raw.close();
    raw = await createApp({ auth: { users: globalThis.__users, secret: SECRET } }); // no maxQueriesPerUser: default
    alice = asUser(raw, await login(raw, 'alice', '10.0.0.8'));
    bob = asUser(raw, await login(raw, 'bob', '10.0.0.9'));
    expect((await call(alice, 'POST', '', { url: MUNICH })).statusCode).toBe(201);
    const over = await call(alice, 'POST', '', { url: url(2) });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatch(/at most 1 query/);
    expect(listUserQueries('alice')).toHaveLength(1);
    expect((await call(bob, 'POST', '', { url: MUNICH })).statusCode).toBe(201);
    // deleting frees the slot
    await call(alice, 'DELETE', `/${listUserQueries('alice')[0].id}`);
    expect((await call(alice, 'POST', '', { url: url(2) })).statusCode).toBe(201);
  });

  it('honours a raised limit (queries.maxPerUser) and reports it', async () => {
    await raw.close();
    raw = await createApp({ auth: { users: globalThis.__users, secret: SECRET }, maxQueriesPerUser: 3 });
    alice = asUser(raw, await login(raw, 'alice', '10.0.0.7'));
    for (let n = 1; n <= 3; n++) expect((await call(alice, 'POST', '', { url: url(n) })).statusCode).toBe(201);
    const over = await call(alice, 'POST', '', { url: url(4) });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatch(/at most 3 queries/);
    expect((await call(alice, 'GET', '')).json().max).toBe(3);
  });

  it('PUT changes name, URL and enabled (partial), validates, and reevaluates', async () => {
    const { id } = (await call(alice, 'POST', '', { name: 'a', url: MUNICH })).json();
    reevaluated.length = 0;
    const res = await call(alice, 'PUT', `/${id}`, { name: 'Munich', enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, name: 'Munich', url: MUNICH, enabled: false });
    expect(reevaluated).toEqual([{ userId: 'alice', all: false }]);
    expect((await call(alice, 'PUT', `/${id}`, { url: url(2) })).json().url).toBe(url(2));
    expect((await call(alice, 'PUT', `/${id}`, { url: 'https://evil.example/x' })).statusCode).toBe(400);
    expect((await call(alice, 'PUT', `/${id}`, { enabled: 'x' })).statusCode).toBe(400);
    expect((await call(alice, 'PUT', `/${id}`, {})).statusCode).toBe(200);
  });

  it('PUT refuses a URL the user already has in another query (409)', async () => {
    await call(alice, 'POST', '', { url: MUNICH });
    const second = (await call(alice, 'POST', '', { url: url(2) })).json();
    expect((await call(alice, 'PUT', `/${second.id}`, { url: MUNICH })).statusCode).toBe(409);
  });

  it('DELETE removes the query', async () => {
    const { id } = (await call(alice, 'POST', '', { url: MUNICH })).json();
    reevaluated.length = 0;
    const res = await call(alice, 'DELETE', `/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id, deleted: true });
    expect(listUserQueries('alice')).toEqual([]);
    expect((await call(alice, 'DELETE', `/${id}`)).statusCode).toBe(404);
  });

  it("a user can never read, change or delete another user's query (404, data untouched)", async () => {
    const { id } = (await call(alice, 'POST', '', { name: 'private', url: MUNICH })).json();
    expect((await call(bob, 'PUT', `/${id}`, { name: 'hijacked', enabled: false })).statusCode).toBe(404);
    expect((await call(bob, 'DELETE', `/${id}`)).statusCode).toBe(404);
    expect((await call(bob, 'GET', '')).json().items).toEqual([]);
    expect(listUserQueries('alice')[0]).toMatchObject({ name: 'private', enabled: true });
  });

  it('rejects non-numeric ids with 400 and needs a login', async () => {
    expect((await call(alice, 'PUT', '/abc', {})).statusCode).toBe(400);
    expect((await call(alice, 'DELETE', '/1.5')).statusCode).toBe(400);
    expect((await raw.inject({ method: 'GET', url: '/api/queries' })).statusCode).toBe(401);
    expect((await raw.inject({ method: 'POST', url: '/api/queries', payload: { url: MUNICH } })).statusCode).toBe(401);
  });

  it('does not fail the request when the background evaluation fails', async () => {
    await raw.close();
    raw = await createApp({
      auth: { users: globalThis.__users, secret: SECRET },
      pipeline: {
        reevaluate: async () => {
          throw new Error('geocoder down');
        },
      },
    });
    alice = asUser(raw, await login(raw, 'alice', '10.0.0.3'));
    expect((await call(alice, 'POST', '', { url: MUNICH })).statusCode).toBe(201);
  });
});
