import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { createApp } from '../../lib/api/api.js';
import { readSessionSecret } from '../../lib/auth/session.js';
import { SqliteSessionStore } from '../../lib/services/storage/sessionStore.js';
import { ConfigError } from '../../lib/errors.js';
import { makeUsers, login, SECRET, PASSWORDS } from '../helpers/auth.js';

let users;
let app;
beforeAll(async () => {
  users = await makeUsers();
});

async function build(auth = {}) {
  app = await createApp({ auth: { users, secret: SECRET, ...auth } });
  return app;
}

beforeEach(async () => {
  Db.close();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  Db.close();
});

const post = (url, payload, extra = {}) =>
  app.inject({ method: 'POST', url, payload, remoteAddress: '10.0.0.1', ...extra });
const cookiesOf = (res) => [res.headers['set-cookie']].flat().filter(Boolean);

describe('#auth guard', () => {
  it('answers 401 JSON for every /api route except health and login', async () => {
    await build();
    for (const [method, url] of [
      ['GET', '/api/listings'],
      ['GET', '/api/stats'],
      ['GET', '/api/status'],
      ['GET', '/api/me'],
      ['POST', '/api/fetch'],
      ['POST', '/api/listings/1/dismiss'],
      ['DELETE', '/api/listings/1/dismiss'],
      ['GET', '/api/queries'],
      ['GET', '/api/settings'],
      ['GET', '/api/does-not-exist'],
      ['POST', '/api/logout'],
    ]) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json()).toEqual({ error: 'Not logged in' });
    }
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('does not guard the static UI (the login page is part of it)', async () => {
    await build();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).not.toBe(401);
  });

  it('refuses a made-up or foreign session cookie', async () => {
    await build();
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'wgg-session=abc.def' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('#login', () => {
  it('logs in with the right password and returns the user (never the hash)', async () => {
    await build();
    const res = await post('/api/login', { username: 'alice', password: PASSWORDS.alice });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ username: 'alice', admin: true, email: 'alice@example.org' });
    expect(res.body).not.toContain('scrypt');
  });

  it('answers the same 401 for a wrong password and an unknown user', async () => {
    await build();
    const wrong = await post('/api/login', { username: 'alice', password: 'not-the-password' });
    const unknown = await post('/api/login', { username: 'mallory', password: 'not-the-password' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(cookiesOf(wrong)).toEqual([]);
  });

  it('matches the username case-insensitively but never trims the password', async () => {
    await build();
    expect((await post('/api/login', { username: 'Alice', password: PASSWORDS.alice })).statusCode).toBe(200);
    expect((await post('/api/login', { username: 'alice', password: `${PASSWORDS.alice} ` })).statusCode).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    await build();
    expect((await post('/api/login', { username: 'alice' })).statusCode).toBe(400);
    expect((await post('/api/login', { username: { a: 1 }, password: 'x' })).statusCode).toBe(400);
    expect((await post('/api/login', undefined)).statusCode).toBe(400);
  });

  it('sets an HttpOnly, SameSite=Strict cookie that is not Secure over plain http', async () => {
    await build();
    const [cookie] = cookiesOf(await post('/api/login', { username: 'alice', password: PASSWORDS.alice }));
    expect(cookie).toMatch(/^wgg-session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/(;|$)/);
    expect(cookie).not.toMatch(/Secure/i);
    expect(cookie).toMatch(/Expires=/i);
  });

  it('marks the cookie Secure when the proxy says the request was https (trusted loopback proxy)', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'alice', password: PASSWORDS.alice },
    });
    expect(res.statusCode).toBe(200);
    expect(cookiesOf(res)[0]).toMatch(/Secure/i);
  });

  it('ignores X-Forwarded-Proto from an untrusted peer', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: '203.0.113.9',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'alice', password: PASSWORDS.alice },
    });
    expect(res.statusCode).toBe(200);
    expect(cookiesOf(res)[0]).not.toMatch(/Secure/i);
  });

  it('scopes the cookie to server.publicPath', async () => {
    await build({ publicPath: '/wgg' });
    const [cookie] = cookiesOf(await post('/api/login', { username: 'alice', password: PASSWORDS.alice }));
    expect(cookie).toMatch(/Path=\/wgg(;|$)/);
  });

  it('works behind a proxy that strips the prefix: the cookie is for /wgg, the app still sees /api/... and honours it', async () => {
    await build({ publicPath: '/wgg' });
    const login = await post('/api/login', { username: 'alice', password: PASSWORDS.alice });
    const cookie = cookiesOf(login)[0];
    expect(cookie).toMatch(/Path=\/wgg(;|$)/);
    // what the browser sends back for https://example.org/wgg/api/me, after Caddy removed "/wgg":
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie.split(';')[0] } });
    expect(me.statusCode).toBe(200);
    const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: cookie.split(';')[0] } });
    expect(cookiesOf(out).join(';')).toMatch(/Path=\/wgg/); // the logout clears the cookie at the same path
  });

  it('issues a new session id on every login (no session fixation)', async () => {
    await build();
    const first = await login(app, 'alice');
    const second = await login(app, 'alice');
    expect(first).not.toBe(second);
  });
});

describe('#session', () => {
  it('GET /api/me returns the logged-in user; logout ends the session server-side', async () => {
    await build();
    const cookie = await login(app, 'bob');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toEqual({ username: 'bob', admin: false, email: null });

    const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    // Replaying the old cookie must not work: the session is gone on the server, not just in the browser.
    const again = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(again.statusCode).toBe(401);
  });

  it('survives a restart (sessions live in SQLite)', async () => {
    await build();
    const cookie = await login(app, 'alice');
    await app.close();
    await build();
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it('a session of a user removed from users.yaml stops working', async () => {
    await build();
    const cookie = await login(app, 'bob');
    await app.close();
    await build({ users: users.filter((u) => u.username !== 'bob') });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('#login rate limit', () => {
  it('blocks the sixth attempt per IP and username within a minute (429 + Retry-After) but not other usernames', async () => {
    await build();
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/login', { username: 'alice', password: 'wrong-password-x' })).statusCode).toBe(401);
    }
    const blocked = await post('/api/login', { username: 'alice', password: PASSWORDS.alice });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // The right password is refused while blocked, so brute force gains nothing.
    expect(cookiesOf(blocked)).toEqual([]);
    expect((await post('/api/login', { username: 'bob', password: PASSWORDS.bob })).statusCode).toBe(200);
  });

  it('counts attempts per client IP: another address is not blocked', async () => {
    await build();
    for (let i = 0; i < 6; i++) await post('/api/login', { username: 'alice', password: 'wrong-password-x' });
    const other = await post(
      '/api/login',
      { username: 'alice', password: PASSWORDS.alice },
      { remoteAddress: '10.0.0.2' },
    );
    expect(other.statusCode).toBe(200);
  });

  it('a successful login resets the counter', async () => {
    await build();
    for (let i = 0; i < 4; i++) await post('/api/login', { username: 'alice', password: 'wrong-password-x' });
    expect((await post('/api/login', { username: 'alice', password: PASSWORDS.alice })).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await post('/api/login', { username: 'alice', password: 'wrong-password-x' })).statusCode).toBe(401);
    }
  });

  it('also limits one address spraying many usernames', async () => {
    await build();
    let last;
    for (let i = 0; i < 31; i++)
      last = await post('/api/login', { username: `user${i}`, password: 'wrong-password-x' });
    expect(last.statusCode).toBe(429);
  });
});

describe('#session secret', () => {
  it('is required when the app is created (never a built-in default)', async () => {
    await expect(createApp({ auth: { users, secret: undefined } })).rejects.toThrow(/SESSION_SECRET/);
    await expect(createApp({ auth: { users, secret: 'short' } })).rejects.toThrow(/at least 32/);
    await expect(createApp({})).rejects.toThrow(/users/);
  });

  it('readSessionSecret explains how to create one and never echoes a bad value', () => {
    expect(() => readSessionSecret({})).toThrow(ConfigError);
    expect(() => readSessionSecret({})).toThrow(/openssl rand -hex 32/);
    expect(() => readSessionSecret({ SESSION_SECRET: 'tooshortsecret' })).toThrow(/at least 32/);
    try {
      readSessionSecret({ SESSION_SECRET: 'tooshortsecret' });
    } catch (e) {
      expect(e.message).not.toContain('tooshortsecret');
    }
    expect(readSessionSecret({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });
});

describe('#SqliteSessionStore', () => {
  it('stores, reads, expires and destroys sessions', async () => {
    const store = new SqliteSessionStore();
    const call = (fn, ...args) =>
      new Promise((resolve, reject) => fn.call(store, ...args, (e, v) => (e ? reject(e) : resolve(v))));
    await call(store.set, 's1', { user: 'alice', cookie: { expires: new Date(Date.now() + 60_000) } });
    expect((await call(store.get, 's1')).user).toBe('alice');
    await call(store.set, 's2', { user: 'bob', cookie: { expires: new Date(Date.now() - 1000) } });
    expect(await call(store.get, 's2')).toBeNull();
    await call(store.destroy, 's1');
    expect(await call(store.get, 's1')).toBeNull();
  });
});

describe('#me target name', () => {
  it('GET /api/me and login return the target name of the user from the directory', async () => {
    const directory = { settings: (id) => ({ scoring: { target: { name: id === 'alice' ? 'Marienplatz' : '' } } }) };
    app = await createApp({ auth: { users, secret: SECRET }, directory });
    const cookie = await login(app, 'alice');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toEqual({
      username: 'alice',
      admin: true,
      email: 'alice@example.org',
      targetName: 'Marienplatz',
    });
  });
});
