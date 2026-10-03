import { describe, it, expect, vi, afterEach } from 'vitest';
import { xhrSend } from '../../ui/src/services/xhr.js';

describe('#xhrSend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends a JSON body with a content type only when a body is given', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }));
    vi.stubGlobal('fetch', fetchMock);
    await xhrSend('POST', 'x', { reason: 'messaged' });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: '{"reason":"messaged"}',
      headers: { 'Content-Type': 'application/json' },
    });
    await xhrSend('DELETE', '/x');
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers['Content-Type']).toBeUndefined();
  });

  it('requests relative URLs: a leading slash is dropped so the app works under a path prefix such as /wgg/', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    await xhrSend('GET', '/api/listings?page=2');
    await xhrSend('GET', 'api/status');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['api/listings?page=2', 'api/status']);
  });

  it('sends the session cookie with same-origin requests', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    await xhrSend('GET', 'api/me');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
  });
});
