// Minimal OpenAI-compatible client on plain fetch (no SDK). The API key only ever travels in the Authorization
// header; every error text is passed through `redact` so it can never reach logs, the database or the UI.

export class LlmError extends Error {
  /** @param {string} message @param {{status?: number}} [options] */
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

/** Masks secrets and bearer tokens, collapses whitespace and truncates. */
export function redact(text, secrets = [], max = 300) {
  let out = String(text ?? '');
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  out = out
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/**
 * Reads the gateway settings from an environment. Throws naming the missing variable only (never a value).
 * @param {Record<string, string|undefined>} [env]
 * @returns {{baseUrl: string, apiKey: string, model: string|undefined}}
 */
export function readLlmEnv(env = process.env) {
  if (!env.LLM_BASE_URL) throw new LlmError('LLM_BASE_URL is not set (see .env.example)');
  if (!env.LLM_API_KEY) throw new LlmError('LLM_API_KEY is not set (see .env.example)');
  return {
    baseUrl: env.LLM_BASE_URL.replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL || undefined,
  };
}

/**
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {string} params.apiKey
 * @param {string} [params.model]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 */
export function createLlmClient({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const base = baseUrl.replace(/\/+$/, '');
  const clean = (t) => redact(t, [apiKey]);
  let jsonModeSupported = true;
  let prefix = ''; // '' or '/v1', whichever the gateway answered on

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...init.headers },
        signal: controller.signal,
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    } catch (e) {
      if (controller.signal.aborted) throw new LlmError(`LLM request to ${path} timed out after ${timeoutMs} ms`);
      throw new LlmError(`LLM request to ${path} failed: ${clean(e.message)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const httpError = (path, r) =>
    new LlmError(`LLM ${path} returned HTTP ${r.status}: ${clean(r.text)}`, { status: r.status });

  function parseBody(path, r) {
    try {
      return JSON.parse(r.text);
    } catch {
      throw new LlmError(`LLM ${path}: unexpected response (not JSON): ${clean(r.text)}`, { status: r.status });
    }
  }

  return {
    /** @returns {Promise<{status: number, path: string, models: string[]}>} */
    async listModels() {
      let r;
      let path;
      for (const p of ['/models', '/v1/models']) {
        path = p;
        r = await request(p);
        if (r.status !== 404) break;
      }
      if (!r.ok) throw httpError(path, r);
      const body = parseBody(path, r);
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
      if (!list) throw new LlmError(`LLM ${path}: unexpected response (no model list)`, { status: r.status });
      if (path === '/v1/models') prefix = '/v1';
      return { status: r.status, path, models: list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean) };
    },

    /**
     * One chat completion (OpenAI shape). With `jsonMode` the request asks for a JSON object; a gateway that
     * rejects `response_format` (HTTP 400) is retried once without it and remembered.
     * @param {{messages: {role: string, content: string}[], temperature?: number, jsonMode?: boolean, model?: string}} params
     * @returns {Promise<{status: number, content: string}>}
     */
    async chat({ messages, temperature = 0, jsonMode = false, model: modelOverride }) {
      const path = `${prefix}/chat/completions`;
      const build = (withJson) =>
        JSON.stringify({
          model: modelOverride ?? model,
          messages,
          temperature,
          ...(withJson ? { response_format: { type: 'json_object' } } : {}),
        });
      const withJson = jsonMode && jsonModeSupported;
      let r = await request(path, { method: 'POST', body: build(withJson) });
      if (withJson && r.status === 400) {
        jsonModeSupported = false;
        r = await request(path, { method: 'POST', body: build(false) });
      }
      if (!r.ok) throw httpError(path, r);
      const content = parseBody(path, r)?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new LlmError(`LLM ${path}: unexpected response (no message content)`, { status: r.status });
      }
      return { status: r.status, content };
    },
  };
}
