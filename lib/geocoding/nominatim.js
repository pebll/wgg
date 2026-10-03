import logger from '../services/logger.js';

const SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/** Nominatim usage policy: at most 1 request per second. We keep a safety margin. */
export const MIN_INTERVAL_MS = 1100;

/**
 * Identifying User-Agent as required by the Nominatim usage policy.
 * @param {string} version wgg package version.
 */
export function buildUserAgent(version) {
  return `wgg/${version} (private self-hosted)`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OpenStreetMap Nominatim geocoder (https://operations.osmfoundation.org/policies/nominatim/).
 *
 * Policy compliance: strictly serial queue, >= 1100 ms between actual requests, identifying
 * User-Agent, optional contact `email` (only sent when configured), results cached (also negative
 * ones). Errors and timeouts resolve to null, are logged and are NOT cached.
 *
 * @param {object} options
 * @param {string} options.userAgent
 * @param {string} [options.email] Contact address, sent as the `email` parameter when set.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {import('./cache.js').GeocodeCache} [options.cache]
 * @param {boolean} [options.retryNegatives] Ignore cached "not found" entries (positives are kept).
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.timeoutMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @returns {import('./geocoder.js').Geocoder}
 */
export function createNominatimGeocoder({
  userAgent,
  email,
  fetchImpl = fetch,
  cache = null,
  retryNegatives = false,
  minIntervalMs = MIN_INTERVAL_MS,
  timeoutMs = 10_000,
  sleep = defaultSleep,
  now = () => Date.now(),
}) {
  let queue = Promise.resolve();
  let lastRequestAt = null;

  async function request(query) {
    if (lastRequestAt !== null) {
      const wait = lastRequestAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt = now();

    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'de');
    url.searchParams.set('accept-language', 'de');
    if (email) url.searchParams.set('email', email);

    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timeout after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: controller.signal }),
        timeout,
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body) || body.length === 0) return { found: null };
      const lat = Number.parseFloat(body[0].lat);
      const lng = Number.parseFloat(body[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('unparseable coordinates');
      return { found: { lat, lng } };
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(query) {
    const cached = cache?.get(query);
    if (cached !== undefined && !(cached === null && retryNegatives)) return cached;
    try {
      const { found } = await request(query);
      cache?.set(query, found);
      return found;
    } catch (e) {
      logger.warn(`Nominatim lookup failed for "${query}": ${e.message}`);
      return null;
    }
  }

  return {
    geocode(query) {
      const result = queue.then(() => run(query));
      queue = result.catch(() => {});
      return result;
    },
  };
}
