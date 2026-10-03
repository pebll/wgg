import { describe, it, expect, vi, afterEach } from 'vitest';
import { setUnauthorizedHandler, xhrSend } from '../../ui/src/services/xhr.js';
import { formatRetry, loginMessage } from '../../ui/src/services/auth.js';

const respond = (status, body, headers = {}) =>
  vi.fn(async () => ({
    ok: status < 400,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => JSON.stringify(body),
  }));

describe('#xhr 401 handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it('tells the app once per rejected request that the session is gone, and still rejects', async () => {
    vi.stubGlobal('fetch', respond(401, { error: 'Not logged in' }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(xhrSend('GET', '/api/listings')).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not treat a wrong password on the login request as a lost session', async () => {
    vi.stubGlobal('fetch', respond(401, { error: 'Wrong username or password.' }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    await expect(xhrSend('POST', '/api/login', { username: 'a', password: 'b' })).rejects.toMatchObject({
      status: 401,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the Retry-After header of a refusal', async () => {
    vi.stubGlobal('fetch', respond(429, { error: 'slow down' }, { 'Retry-After': '42' }));
    await expect(xhrSend('POST', '/api/login', {})).rejects.toMatchObject({ status: 429, retryAfterSeconds: 42 });
  });
});

describe('#login messages', () => {
  it('words a retry time', () => {
    expect(formatRetry(1)).toBe('1 second');
    expect(formatRetry(42)).toBe('42 seconds');
    expect(formatRetry(60)).toBe('1 minute');
    expect(formatRetry(150)).toBe('3 minutes');
    expect(formatRetry(undefined)).toBe('a minute');
    expect(formatRetry(0)).toBe('a minute');
  });

  it('shows the server message for a wrong password', () => {
    expect(loginMessage({ status: 401, json: { error: 'Wrong username or password.' } })).toBe(
      'Wrong username or password.',
    );
  });

  it('tells how long to wait when rate limited', () => {
    expect(loginMessage({ status: 429, json: {}, retryAfterSeconds: 42 })).toBe(
      'Too many login attempts. Try again in 42 seconds.',
    );
  });

  it('has a fallback for a server that cannot be reached', () => {
    expect(loginMessage(new TypeError('Failed to fetch'))).toBe('Could not reach the server. Try again.');
    expect(loginMessage({ status: 500, json: {} })).toBe('Login failed. Try again.');
  });
});
