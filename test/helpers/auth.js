import { hashPassword } from '../../lib/auth/password.js';

export const SECRET = 'test-secret-test-secret-test-secret-0123456789';
export const PASSWORDS = { alice: 'alice-password-1', bob: 'bob-password-22' };

/** Two users for tests: alice is the admin, bob a normal user. Hashes are real (scrypt), so create them once. */
export async function makeUsers() {
  return [
    { username: 'alice', passwordHash: await hashPassword(PASSWORDS.alice), admin: true, email: 'alice@example.org' },
    { username: 'bob', passwordHash: await hashPassword(PASSWORDS.bob), admin: false, email: null },
  ];
}

/** Logs `username` in and returns the cookie header value. */
export async function login(app, username, remoteAddress = '10.0.0.1') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    remoteAddress,
    payload: { username, password: PASSWORDS[username] },
  });
  if (res.statusCode !== 200) throw new Error(`test login failed: ${res.statusCode} ${res.body}`);
  const cookie = [res.headers['set-cookie']].flat()[0];
  return cookie.split(';')[0];
}

/** Wraps app.inject so every request carries the session cookie (tests act as that user). */
export function asUser(app, cookie) {
  const inject = app.inject.bind(app);
  return {
    inject: (opts) => inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } }),
    raw: app,
    close: () => app.close(),
  };
}

/** Writes a users.yaml next to a test config (alice admin, bob normal; passwords in PASSWORDS). Default: alice only. */
export async function writeUsersFile(dir, names = ['alice']) {
  const fs = await import('fs');
  const path = await import('path');
  const users = (await makeUsers()).filter((u) => names.includes(u.username));
  const lines = users.map(
    (u) =>
      `  - username: ${u.username}\n    passwordHash: "${u.passwordHash}"\n    admin: ${u.admin}\n` +
      (u.email ? `    email: ${u.email}\n` : ''),
  );
  fs.writeFileSync(path.join(dir, 'users.yaml'), `users:\n${lines.join('')}`);
}

/** fetch() against a running server as `username` (logs in first). */
export async function httpLogin(port, username = 'alice') {
  const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORDS[username] }),
  });
  if (res.status !== 200) throw new Error(`test login failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } });
}
