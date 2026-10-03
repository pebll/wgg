import { describe, it, expect } from 'vitest';
import { createLlmClient, LlmError, redact, readLlmEnv } from '../../lib/llm/client.js';

const KEY = 'sk-super-secret-key-123';
const BASE = 'https://gw.example/api';

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) return json(404, 'not found');
    return typeof handler === 'function' ? handler(init, calls.length) : handler;
  };
  impl.calls = calls;
  return impl;
}

describe('#llm client', () => {
  it('lists models from /models with a bearer header', async () => {
    const f = fakeFetch({ [`${BASE}/models`]: json(200, { data: [{ id: 'a' }, { id: 'b' }] }) });
    const client = createLlmClient({ baseUrl: BASE + '/', apiKey: KEY, fetchImpl: f });
    const r = await client.listModels();
    expect(r).toEqual({ status: 200, path: '/models', models: ['a', 'b'] });
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('falls back to /v1/models on 404', async () => {
    const f = fakeFetch({ [`${BASE}/v1/models`]: json(200, { data: [{ id: 'm' }] }) });
    const r = await createLlmClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: f }).listModels();
    expect(r.path).toBe('/v1/models');
    expect(r.models).toEqual(['m']);
    expect(f.calls.map((c) => c.url)).toEqual([`${BASE}/models`, `${BASE}/v1/models`]);
  });

  it('sends a chat completion and returns the first message content', async () => {
    let body;
    const f = fakeFetch({
      [`${BASE}/chat/completions`]: (init) => {
        body = JSON.parse(init.body);
        return json(200, { choices: [{ message: { content: 'hello' } }] });
      },
    });
    const client = createLlmClient({ baseUrl: BASE, apiKey: KEY, model: 'm1', fetchImpl: f });
    const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }], jsonMode: true });
    expect(r).toEqual({ status: 200, content: 'hello' });
    expect(body).toMatchObject({ model: 'm1', temperature: 0, response_format: { type: 'json_object' } });
  });

  it('retries once without response_format when the gateway rejects it', async () => {
    const bodies = [];
    const f = fakeFetch({
      [`${BASE}/chat/completions`]: (init) => {
        const b = JSON.parse(init.body);
        bodies.push(b);
        return b.response_format
          ? json(400, { error: 'response_format unsupported' })
          : json(200, { choices: [{ message: { content: '{}' } }] });
      },
    });
    const client = createLlmClient({ baseUrl: BASE, apiKey: KEY, model: 'm', fetchImpl: f });
    const r = await client.chat({ messages: [], jsonMode: true });
    expect(r.content).toBe('{}');
    expect(bodies[1].response_format).toBeUndefined();
    // remembered: the next call does not try json mode again
    await client.chat({ messages: [], jsonMode: true });
    expect(bodies[2].response_format).toBeUndefined();
  });

  it('throws LlmError for a non-2xx status without leaking the key', async () => {
    const f = fakeFetch({ [`${BASE}/chat/completions`]: json(401, `bad key ${KEY} Authorization: Bearer ${KEY}`) });
    const client = createLlmClient({ baseUrl: BASE, apiKey: KEY, model: 'm', fetchImpl: f });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.status).toBe(401);
    expect(e.message).toContain('401');
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain('Bearer sk');
  });

  it('redacts the key from network errors', async () => {
    const f = async () => {
      throw new Error(`connect failed for Bearer ${KEY}`);
    };
    const client = createLlmClient({ baseUrl: BASE, apiKey: KEY, model: 'm', fetchImpl: f });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.message).not.toContain(KEY);
  });

  it('times out with a clear error', async () => {
    const f = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const client = createLlmClient({ baseUrl: BASE, apiKey: KEY, model: 'm', fetchImpl: f, timeoutMs: 20 });
    const e = await client.chat({ messages: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.message).toMatch(/timed out/);
  });

  it('rejects an unexpected response shape', async () => {
    const f = fakeFetch({ [`${BASE}/chat/completions`]: json(200, { nope: 1 }) });
    const e = await createLlmClient({ baseUrl: BASE, apiKey: KEY, model: 'm', fetchImpl: f })
      .chat({ messages: [] })
      .catch((x) => x);
    expect(e.message).toMatch(/unexpected response/);
  });

  it('redact masks the secret, bearer tokens and truncates', () => {
    expect(redact(`x ${KEY} y`, [KEY])).toBe('x [redacted] y');
    expect(redact('Authorization: Bearer abc.def', [])).not.toContain('abc.def');
    expect(redact('a'.repeat(1000), [], 100).length).toBeLessThanOrEqual(101);
  });

  it('readLlmEnv requires base url and key and never echoes values', () => {
    expect(() => readLlmEnv({})).toThrow(/LLM_BASE_URL/);
    expect(() => readLlmEnv({ LLM_BASE_URL: 'https://x' })).toThrow(/LLM_API_KEY/);
    expect(readLlmEnv({ LLM_BASE_URL: 'https://x/', LLM_API_KEY: 'k', LLM_MODEL: 'm' })).toEqual({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
    });
    expect(readLlmEnv({ LLM_BASE_URL: 'https://x', LLM_API_KEY: 'k' }).model).toBeUndefined();
  });
});
