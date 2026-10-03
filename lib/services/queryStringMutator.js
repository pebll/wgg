import queryString from 'query-string';

/**
 * Overlays `extraParams` (a query string without "?") on the query of `url`.
 * Without extra params the url is returned as it came in.
 *
 * @param {string} url
 * @param {string|null|undefined} extraParams
 * @returns {string}
 */
export default function mutateQuery(url, extraParams) {
  if (extraParams == null) return url;

  const { url: base, query } = queryString.parseUrl(url);
  const merged = { ...query, ...queryString.parse(extraParams) };
  return `${base}?${queryString.stringify(merged)}`;
}
