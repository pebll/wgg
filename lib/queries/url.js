/** Longest search URL accepted (WG-Gesucht filter URLs are a few hundred characters). */
export const MAX_URL_LENGTH = 2000;

/** A search URL that is not acceptable; the message is shown to the user. */
export class QueryUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryUrlError';
  }
}

/**
 * The canonical form of a search URL (what is stored in user_queries and listing_queries and what the scheduler fetches),
 * so the same search entered twice is one search. Text that is not a URL is returned unchanged (validation is a
 * separate step, see validateQueryUrl).
 * @param {string} url
 */
export function normalizeQueryUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    parsed.hash = '';
    return parsed.href;
  } catch {
    return String(url).trim();
  }
}

/**
 * Result pages look like /wg-zimmer-in-Muenchen.90.0.1.0.html or /1-zimmer-wohnungen-in-Hamburg.55.1.1.0.html:
 * "<kind>-in-<City>.<city id>.<category>.<rent type>.<page>.html". An ad is /wg-zimmer-in-<City>-<District>.<id>.html (one
 * number), which is not a list of results.
 */
const RESULT_PATH = /^\/[A-Za-z0-9-]+-in-[A-Za-z0-9%_-]+\.\d{1,6}\.\d{1,2}\.\d{1,2}\.\d{1,2}\.html$/;

/**
 * Checks that `value` is the address of a WG-Gesucht search result page and returns it in canonical form. Only
 * https://www.wg-gesucht.de/ is accepted (so wgg never requests anything else), without credentials or a port.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {QueryUrlError}
 */
export function validateQueryUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new QueryUrlError('Enter the search URL.');
  if (value.length > MAX_URL_LENGTH) throw new QueryUrlError('That URL is too long.');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new QueryUrlError('That is not a valid URL. Copy the whole address from your browser.');
  }
  if (url.protocol !== 'https:') throw new QueryUrlError('Only https:// URLs are allowed.');
  if (url.hostname !== 'www.wg-gesucht.de') {
    throw new QueryUrlError(
      'Only www.wg-gesucht.de searches are allowed: the address must start with https://www.wg-gesucht.de/',
    );
  }
  if (url.username !== '' || url.password !== '') throw new QueryUrlError('The URL must not contain credentials.');
  if (url.port !== '') throw new QueryUrlError('The URL must not contain a port.');
  if (!RESULT_PATH.test(url.pathname)) {
    throw new QueryUrlError(
      'That is not a WG-Gesucht search result page. Set your filters on wg-gesucht.de, open the list of results and copy that address.',
    );
  }
  return normalizeQueryUrl(value);
}
