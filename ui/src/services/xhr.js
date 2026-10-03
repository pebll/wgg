const INVALID_RESPONSE = 'The server returned an invalid response.';
const LOGIN_URL = /^\/*api\/login(?:\?.*)?$/;

let onUnauthorized = null;

/** Registers the single callback run when a request finds the session gone; null removes it. */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler ?? null;
}

function retryAfterOf(response) {
  const raw = typeof response.headers?.get === 'function' ? response.headers.get('Retry-After') : null;
  const seconds = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function parseBody(text) {
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: INVALID_RESPONSE };
  }
}

/**
 * The one place that talks to the backend. Resolves `{status, json}` for 2xx answers and rejects with the same
 * shape (plus `retryAfterSeconds` when the server sent a Retry-After) for everything else.
 */
export async function xhrSend(method, url, body) {
  const headers = { Accept: 'application/json' };
  const init = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  // Never an absolute path: the app may live under a prefix such as /wgg/.
  const relative = url.replace(/^\/+/, '');
  const response = await fetch(relative, init);
  const json = parseBody(await response.text());

  if (response.ok) return { status: response.status, json };

  const rejection = { status: response.status, json };
  const retryAfterSeconds = retryAfterOf(response);
  if (retryAfterSeconds !== null) rejection.retryAfterSeconds = retryAfterSeconds;
  if (response.status === 401 && !LOGIN_URL.test(url) && onUnauthorized) onUnauthorized();
  throw rejection;
}

export function xhrGet(url) {
  return xhrSend('GET', url);
}

/** Server-provided message of a rejected request, or `fallback`. */
export function errorMessage(rejection, fallback) {
  const json = rejection?.json;
  for (const candidate of [json?.error, json?.message]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return fallback;
}
