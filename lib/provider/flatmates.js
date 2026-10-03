/**
 * The flatmates of a WG-Gesucht offer, read from the `title` attribute WG-Gesucht puts on the "3er WG" label:
 * "<N>er WG (<w>w,<m>m,<d>d,<n>n)". N is the size of the flat including the free room; w, m and d are the current
 * flatmates (female, male, diverse). What "n" counts is not documented: it is kept as `unspecified`, never labelled.
 * Examples: "3er WG (1w,1m,0d,0n)", "3er WG (0w,0m,0d,0n)" (nothing known about the flatmates).
 */
const TITLE = /^(\d+)\s*er\s+WG\s*\(\s*(\d+)\s*w\s*,\s*(\d+)\s*m\s*,\s*(\d+)\s*d\s*,\s*(\d+)\s*n\s*\)$/i;

/**
 * @typedef {object} Flatmates
 * @property {number} wgSize Size of the flat ("3er WG" = 3, the free room included).
 * @property {number} female
 * @property {number} male
 * @property {number} diverse
 * @property {number} unspecified The "n" count (meaning not verified).
 * @property {string} raw The title as WG-Gesucht wrote it.
 */

/**
 * @param {unknown} title
 * @returns {Flatmates|null} null when the title is missing or not in this format.
 */
export function parseFlatmates(title) {
  if (typeof title !== 'string') return null;
  const raw = title.trim();
  const m = TITLE.exec(raw);
  if (!m) return null;
  const [wgSize, female, male, diverse, unspecified] = m.slice(1).map(Number);
  return { wgSize, female, male, diverse, unspecified, raw };
}

/** "1 woman, 1 man" (only the known genders), or null when nothing is known (all zero) or there is no data. */
export function describeFlatmates(flatmates) {
  if (!flatmates) return null;
  const parts = [
    [flatmates.female, 'woman', 'women'],
    [flatmates.male, 'man', 'men'],
    [flatmates.diverse, 'diverse', 'diverse'],
  ]
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return parts.length > 0 ? parts.join(', ') : null;
}
