import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { storeNewListings, storeListingDetails } from '../../lib/services/listings/listingsStorage.js';
import { startFetchRun, finishFetchRun, setNextFetch } from '../../lib/services/status/fetchStatus.js';
import { createApp, startServer } from '../../lib/api/api.js';
import { makeUsers, login, asUser, SECRET } from '../helpers/auth.js';
import { giveQuery, setRow } from '../helpers/db.js';

const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const listing = (id, price) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price,
});

let dir;
let app;
let users;

/** The app, with every request made as the logged-in admin `alice` (see test/api/auth.test.js for the guard itself). */
const makeApp = async (opts = {}) => {
  users ??= await makeUsers();
  const raw = await createApp({ auth: { users, secret: SECRET }, ...opts });
  return asUser(raw, await login(raw, 'alice'));
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-api-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>wgg ui</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  Db.close();
  Db.init(':memory:');
  await runMigrations();
  giveQuery('alice', SEARCH);
  storeNewListings([listing(1, 700)], SEARCH, 1000);
  storeNewListings([listing(2, 400)], SEARCH, 2000);
  storeNewListings([listing(3, 550)], SEARCH, 3000);
  app = await makeApp({ uiDir: dir });
});

afterEach(async () => {
  await app.close();
  Db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('#api', () => {
  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/listings returns items, total and paging info', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/listings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.providerId)).toEqual(['3', '2', '1']);
    expect(body).toMatchObject({ page: 1, pageSize: 50 });
  });

  it('supports the maxAgeDays filter (unfiltered when omitted)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/listings?maxAgeDays=0.0001' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0); // fixtures were first seen in 1970
  });

  it('applies sort and filter query params', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/listings?sort=price&dir=asc&maxRent=600' });
    expect(res.json().items.map((i) => i.price)).toEqual([400, 550]);
  });

  it('ignores malicious params instead of failing or leaking', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/listings?${new URLSearchParams({ sort: 'price; DROP TABLE listings', dir: 'x', maxRent: '1 OR 1=1', pageSize: '999999' })}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 3, pageSize: 200 });
    expect(Db.tableExists('listings')).toBe(true);
  });

  it('returns JSON 404 for unknown /api routes (no SPA fallback)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('serves the built UI, static assets and falls back to index.html for SPA routes', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('wgg ui');
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    const deep = await app.inject({ method: 'GET', url: '/some/client/route' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('wgg ui');
  });

  it('serves the public presentation page without a session: UI and assets are open, the API stays closed', async () => {
    // The presentation lives at hash routes (#/about, #/login), which the server never sees: / is enough.
    for (const url of ['/', '/index.html', '/assets/app.js', '/some/client/route']) {
      const res = await app.raw.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect((await app.raw.inject({ method: 'GET', url: '/' })).body).toContain('wgg ui');
    expect((await app.raw.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    for (const url of ['/api/listings', '/api/stats', '/api/status', '/api/me']) {
      expect((await app.raw.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('does not allow a path traversal out of the UI dir', async () => {
    const res = await app.inject({ method: 'GET', url: '/..%2f..%2fetc%2fpasswd' });
    expect(res.body).not.toContain('root:');
  });

  it('sets no cookie for requests that did not log in', async () => {
    const res = await app.raw.inject({ method: 'GET', url: '/api/listings' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('#api without a built UI', () => {
  it('still serves the API and explains how to build the UI', async () => {
    const bare = await makeApp({ uiDir: path.join(dir, 'missing') });
    expect((await bare.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const res = await bare.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('build:frontend');
    await bare.close();
  });
});

describe('#startServer', () => {
  it('listens on the given host/port and closes cleanly', async () => {
    const server = await startServer({ host: '127.0.0.1', port: 0, uiDir: dir, auth: { users, secret: SECRET } });
    const { port } = server.app.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(await res.json()).toEqual({ status: 'ok' });
    await server.close();
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  it('GET /api/status returns the empty status before any fetch', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      lastFetch: null,
      nextFetchAt: null,
      backoff: false,
      schedulerRunning: false,
      manualFetch: null, // no coordinator in this process
      // the fixture listings are from 1970: too old for details, so nothing is pending
      details: { pending: 0, fetched: 0, failed: 0, running: false, nextAt: null },
      llm: { pending: 0, done: 0, failed: 0, avgSeconds: null, etaSeconds: 0, badgeThreshold: 0.3 },
    });
  });

  it('GET /api/status counts detail states and reports the worker state', async () => {
    const now = Date.now();
    storeNewListings([listing(10, 500), listing(11, 500), listing(12, 500)], SEARCH, now - 1000);
    storeListingDetails(
      Db.query("SELECT id FROM listings WHERE provider_id = '10'")[0].id,
      { description: 'x', sections: [], costs: [], wgFacts: [], objectFacts: [] },
      now,
    );
    const withWorker = await makeApp({
      uiDir: dir,
      details: { maxAgeDays: 7, worker: { state: () => ({ running: true, nextAt: now + 45_000 }) } },
    });
    const body = (await withWorker.inject({ method: 'GET', url: '/api/status' })).json();
    await withWorker.close();
    expect(body.details).toEqual({ pending: 2, fetched: 1, failed: 0, running: true, nextAt: now + 45_000 });
    // listing 10 has details but no LLM result yet
    expect(body.llm).toEqual({
      pending: 1,
      done: 0,
      failed: 0,
      avgSeconds: null,
      etaSeconds: 8,
      badgeThreshold: 0.3,
    });
  });

  it('GET /api/status reports the configured badge threshold', async () => {
    const custom = await makeApp({ uiDir: dir, llm: { badgeThreshold: 0.45 } });
    const body = (await custom.inject({ method: 'GET', url: '/api/status' })).json();
    await custom.close();
    expect(body.llm.badgeThreshold).toBe(0.45);
  });

  it('GET /api/status returns the last fetch and the planned next fetch', async () => {
    const now = Date.now();
    const id = startFetchRun(now - 120_000);
    finishFetchRun(id, { newCount: 2, errorCount: 0, botDetected: false, error: null }, now - 110_000);
    setNextFetch({ nextFetchAt: now + 300_000, backoff: false }, now - 100_000);
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(body.lastFetch).toEqual({
      id: expect.any(Number),
      startedAt: now - 120_000,
      finishedAt: now - 110_000,
      newCount: 2,
      errorCount: 0,
      botDetected: false,
      error: null,
    });
    expect(body).toMatchObject({ nextFetchAt: now + 300_000, backoff: false, schedulerRunning: true });
  });
});

describe('#api dismiss', () => {
  const idOf = (providerId) => Db.query('SELECT id FROM listings WHERE provider_id = @p', { p: providerId })[0].id;

  it('show=not_interested|messaged lists the user-hidden offers by kind and reports hiddenAutomatically', async () => {
    const post = (n, reason) =>
      app.inject({ method: 'POST', url: `/api/listings/${idOf(n)}/dismiss`, payload: { reason } });
    await post('1', 'not_interested');
    await post('2', 'messaged');
    const total = async (q) => (await app.inject({ method: 'GET', url: `/api/listings?${q}` })).json().total;
    expect(await total('')).toBe(1);
    expect(await total('show=not_interested')).toBe(2);
    expect(await total('show=messaged')).toBe(2);
    expect(await total('show=not_interested,messaged')).toBe(3);
    expect(await total('show=bogus')).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/listings' })).json().hiddenAutomatically).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/stats?show=messaged' })).json().total).toBe(2);
  });

  it('POST dismisses, hides it from /api/listings, DELETE restores it', async () => {
    const id = idOf('2');
    const post = await app.inject({ method: 'POST', url: `/api/listings/${id}/dismiss` });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ id, dismissed: true });
    expect((await app.inject({ method: 'GET', url: '/api/listings' })).json().total).toBe(2);
    const hidden = await app.inject({ method: 'GET', url: '/api/listings?includeDismissed=1' });
    expect(hidden.json().total).toBe(3);

    const del = await app.inject({ method: 'DELETE', url: `/api/listings/${id}/dismiss` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ id, dismissed: false });
    expect((await app.inject({ method: 'GET', url: '/api/listings' })).json().total).toBe(3);
  });

  it('POST with {reason: "messaged"} hides it as messaged; reason defaults to not_interested; unknown reason is 400', async () => {
    const id = idOf('2');
    const bad = await app.inject({
      method: 'POST',
      url: `/api/listings/${id}/dismiss`,
      payload: { reason: 'bogus' },
    });
    expect(bad.statusCode).toBe(400);
    const post = await app.inject({
      method: 'POST',
      url: `/api/listings/${id}/dismiss`,
      payload: { reason: 'messaged' },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ id, dismissed: true });
    const all = (await app.inject({ method: 'GET', url: '/api/listings?includeHidden=1' })).json().items;
    const item = all.find((i) => i.id === id);
    expect(item.hidden).toMatchObject({ by: 'user', reason: 'Messaged' });
    expect(item.messagedAt).toBeGreaterThan(0);

    await app.inject({ method: 'DELETE', url: `/api/listings/${id}/dismiss` });
    const restored = (await app.inject({ method: 'GET', url: '/api/listings' })).json().items.find((i) => i.id === id);
    expect(restored.messagedAt).toBe(item.messagedAt);
    expect(restored.hidden).toBeNull();

    const plain = await app.inject({ method: 'POST', url: `/api/listings/${id}/dismiss`, payload: {} });
    expect(plain.statusCode).toBe(200);
    const again = (await app.inject({ method: 'GET', url: '/api/listings?includeHidden=1' })).json().items;
    expect(again.find((i) => i.id === id).hidden.reason).toBe('Not interested');
  });

  it('answers 404 for an unknown id and 400 for a non-numeric id', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/listings/9999/dismiss' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/listings/9999/dismiss' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/listings/abc/dismiss' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/listings/1.5/dismiss' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/listings/-1/dismiss' })).statusCode).toBe(400);
  });
});

describe('#api stats', () => {
  it('GET /api/stats returns the distribution for the same filters as /api/listings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.score.unscored).toBe(3);
    expect(Array.isArray(body.rent.bins)).toBe(true);

    const filtered = (await app.inject({ method: 'GET', url: '/api/stats?maxRent=500' })).json();
    const listed = (await app.inject({ method: 'GET', url: '/api/listings?maxRent=500' })).json();
    expect(filtered.total).toBe(listed.total);
  });

  it('range filters narrow /api/listings and /api/stats alike, and stats carry the AI bins', async () => {
    const list = (q) => app.inject({ method: 'GET', url: `/api/listings?${q}` }).then((r) => r.json().total);
    const stats = (q) => app.inject({ method: 'GET', url: `/api/stats?${q}` }).then((r) => r.json());
    expect(await list('rentMin=400&rentMax=550')).toBe(1); // half-open: 400 yes, 550 no
    expect((await stats('rentMin=400&rentMax=550')).total).toBe(1);
    expect(await list('rentMin=400&rentMax=551')).toBe(2);
    expect((await stats('')).ai).toMatchObject({ unassessed: 3 });
    expect((await stats('')).ai.bins).toHaveLength(9);
  });

  it('GET /api/stats ignores excluded listings entirely while /api/listings still lists them', async () => {
    setRow('alice', '2', { excluded_reason: 'excluded keyword' });
    const stats = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
    expect(stats.total).toBe(2);
    expect(stats.score).not.toHaveProperty('excluded');
    expect(stats.rent.bins.reduce((n, b) => n + b.count, 0)).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/listings' })).json().total).toBe(3);
  });

  it('GET /api/stats excludes dismissed offers unless includeDismissed=1', async () => {
    const id = Db.query("SELECT id FROM listings WHERE provider_id = '1'")[0].id;
    await app.inject({ method: 'POST', url: `/api/listings/${id}/dismiss` });
    expect((await app.inject({ method: 'GET', url: '/api/stats' })).json().total).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/stats?includeDismissed=1' })).json().total).toBe(3);
  });
});

describe('#api GET /api/status manualFetch', () => {
  it('reports the gap and when a manual fetch becomes allowed', async () => {
    await app.close();
    const state = { minGapSeconds: 600, availableAt: 1_700_000_600_000, running: false };
    app = await makeApp({
      uiDir: dir,
      coordinator: { triggerNow: () => ({ ok: true }), manualFetchState: () => state },
    });
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(body.manualFetch).toEqual(state);
  });
});

describe('#api POST /api/fetch', () => {
  const withCoordinator = async (triggerNow) => {
    await app.close();
    app = await makeApp({ uiDir: dir, coordinator: { triggerNow } });
  };

  it('answers 202 when the coordinator accepts', async () => {
    await withCoordinator(() => ({ ok: true, mode: 'one-off' }));
    const res = await app.inject({ method: 'POST', url: '/api/fetch' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'started', mode: 'one-off' });
  });

  it('maps a busy coordinator to 409 with the reason', async () => {
    await withCoordinator(() => ({ ok: false, status: 409, error: 'A fetch is already running.' }));
    const res = await app.inject({ method: 'POST', url: '/api/fetch' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'A fetch is already running.' });
  });

  it('maps a too-early or backoff refusal to 429 with retryAfterSeconds and a Retry-After header', async () => {
    await withCoordinator(() => ({ ok: false, status: 429, error: 'Too soon.', retryAfterSeconds: 90 }));
    const res = await app.inject({ method: 'POST', url: '/api/fetch' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'Too soon.', retryAfterSeconds: 90 });
    expect(res.headers['retry-after']).toBe('90');
  });

  it('answers 503 when this server cannot fetch (no coordinator)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/fetch' });
    expect(res.statusCode).toBe(503);
  });

  it('GET /api/status exposes the id of the last run', async () => {
    const id = startFetchRun(Date.now());
    finishFetchRun(id, { newCount: 2, errorCount: 0, botDetected: false, error: null });
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(body.lastFetch.id).toBe(id);
  });
});

describe('#api isolation between users', () => {
  const OTHER = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';
  let bob;

  beforeEach(async () => {
    giveQuery('bob', OTHER);
    storeNewListings([listing(20, 300), listing(21, 350)], OTHER, 5000);
    bob = asUser(app.raw, await login(app.raw, 'bob', '10.0.0.2'));
  });

  const providers = async (who, url = '/api/listings') =>
    (await who.inject({ method: 'GET', url }))
      .json()
      .items.map((i) => i.providerId)
      .sort();

  it('every user lists only the listings of their own queries', async () => {
    expect(await providers(app)).toEqual(['1', '2', '3']);
    expect(await providers(bob)).toEqual(['20', '21']);
  });

  it("a user cannot hide or restore another user's listing (404), and their own hiding stays private", async () => {
    const aliceId = Db.query("SELECT id FROM listings WHERE provider_id = '1'")[0].id;
    const bobId = Db.query("SELECT id FROM listings WHERE provider_id = '20'")[0].id;
    expect((await bob.inject({ method: 'POST', url: `/api/listings/${aliceId}/dismiss` })).statusCode).toBe(404);
    expect((await bob.inject({ method: 'DELETE', url: `/api/listings/${aliceId}/dismiss` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/listings/${bobId}/dismiss` })).statusCode).toBe(404);
    expect(await providers(app)).toEqual(['1', '2', '3']);

    expect(
      (await bob.inject({ method: 'POST', url: `/api/listings/${bobId}/dismiss`, payload: { reason: 'messaged' } }))
        .statusCode,
    ).toBe(200);
    expect(await providers(bob)).toEqual(['21']);
    expect(await providers(bob, '/api/listings?show=messaged')).toEqual(['20', '21']);
    expect(await providers(app, '/api/listings?show=messaged')).toEqual(['1', '2', '3']);
  });

  it("stats and the status counts describe only the asking user's view", async () => {
    expect((await bob.inject({ method: 'GET', url: '/api/stats' })).json().total).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/stats' })).json().total).toBe(3);
    const detailsOf = async (who) => (await who.inject({ method: 'GET', url: '/api/status' })).json().details;
    // both users' listings are ancient (1970): nothing counts as pending for either, but the numbers are their own
    storeListingDetails(
      Db.query("SELECT id FROM listings WHERE provider_id = '20'")[0].id,
      { description: 'x', sections: [], costs: [], wgFacts: [], objectFacts: [] },
      Date.now(),
    );
    expect((await detailsOf(bob)).fetched).toBe(1);
    expect((await detailsOf(app)).fetched).toBe(0);
  });

  it("one user's session never reads another's data: no cookie, no data", async () => {
    const anon = await app.raw.inject({ method: 'GET', url: '/api/listings' });
    expect(anon.statusCode).toBe(401);
    expect(anon.body).not.toContain('Room');
  });
});

describe('#api tier filter', () => {
  it('GET /api/listings and /api/stats take tier=good|fantastic and agree on the totals', async () => {
    for (const [id, tier] of [
      [1, 'fantastic'],
      [2, 'good'],
      [3, 'good'],
    ]) {
      Db.execute(
        `INSERT INTO user_listings (user_id, listing_id, tier) VALUES ('alice', @id, @tier)
         ON CONFLICT(user_id, listing_id) DO UPDATE SET tier = @tier`,
        { id, tier },
      );
    }
    for (const [tier, n] of [
      ['fantastic', 1],
      ['good', 2],
    ]) {
      const list = (await app.inject({ method: 'GET', url: `/api/listings?tier=${tier}` })).json();
      const stats = (await app.inject({ method: 'GET', url: `/api/stats?tier=${tier}` })).json();
      expect(list.total).toBe(n);
      expect(stats.total).toBe(n);
      expect(list.items.every((i) => i.tier === tier)).toBe(true);
    }
    const none = (await app.inject({ method: 'GET', url: '/api/listings?tier=nonsense' })).json();
    expect(none.total).toBe(3);
  });
});
