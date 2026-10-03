// A dot that introduces exactly three digits is a German thousands separator.
const THOUSANDS_DOT = /\.(?=\d{3}(?:\D|$))/g;

/**
 * Pulls the leading number out of display text such as "590 €", "1.234 €" or "3,5 Zi.".
 * Returns null when the text does not start with a number.
 *
 * @param {string|number|null|undefined} input
 * @returns {number|null}
 */
export function extractNumber(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return input;

  const normalised = String(input).replace(THOUSANDS_DOT, '').replace(',', '.');
  const value = parseFloat(normalised);
  return Number.isNaN(value) ? null : value;
}
