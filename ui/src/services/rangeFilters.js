/**
 * Range filters of the distribution charts: one [min, max) range per chart (Score, AI score, Rent, Distance), AND-combined
 * on the server. A null bound is open. `ranges` is `{score, ai, rent, dist}`, each `{min, max}`.
 */

/** The charts in display order; `unit` follows the number in chips. */
export const RANGE_CHARTS = [
  { key: 'score', title: 'Score', unit: '' },
  { key: 'ai', title: 'AI score', unit: '' },
  { key: 'rent', title: 'Rent', unit: ' €' },
  { key: 'dist', title: 'Distance', unit: ' km' },
];

const OPEN = { min: null, max: null };
export const EMPTY_RANGES = Object.freeze(
  Object.fromEntries(RANGE_CHARTS.map(({ key }) => [key, Object.freeze({ ...OPEN })])),
);

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isOpen = (r) => r.min === null && r.max === null;

export const hasRanges = (ranges) => RANGE_CHARTS.some(({ key }) => !isOpen(ranges[key] ?? OPEN));

/** The range a bar stands for. The last bar has no upper bound: it also holds everything above (and the score 10). */
const binRange = ({ from, to }, last) => ({ min: from, max: last ? null : to });

/** True when `ranges[key]` is exactly this bar. */
export function isActiveBin(ranges, key, bin, { last = false } = {}) {
  const r = ranges[key] ?? OPEN;
  const b = binRange(bin, last);
  return r.min === b.min && r.max === b.max;
}

/** Clicking a bar sets its chart's range; clicking the active bar again clears it. Other charts keep theirs. */
export function toggleBin(ranges, key, bin, { last = false } = {}) {
  const next = isActiveBin(ranges, key, bin, { last }) ? OPEN : binRange(bin, last);
  return { ...ranges, [key]: { ...next } };
}

export const clearRange = (ranges, key) => ({ ...ranges, [key]: { ...OPEN } });

/** One removable chip per active range: "Score 7–8", "Rent 600–650 €", "AI score 9+", "Rent below 500 €". */
export function rangeChips(ranges) {
  return RANGE_CHARTS.flatMap(({ key, title, unit }) => {
    const { min, max } = ranges[key] ?? OPEN;
    if (min === null && max === null) return [];
    let text;
    if (min !== null && max !== null) text = `${min}–${max}${unit}`;
    else if (min !== null) text = `${min}+${unit}`;
    else text = `below ${max}${unit}`;
    return [{ key, label: `${title} ${text}` }];
  });
}

/** Query parameters (`scoreMin`, `rentMax`, ...) for the bounds that are set. */
export function rangeParams(ranges) {
  const params = {};
  for (const { key } of RANGE_CHARTS) {
    const { min, max } = ranges?.[key] ?? OPEN;
    if (isNumber(min)) params[`${key}Min`] = String(min);
    if (isNumber(max)) params[`${key}Max`] = String(max);
  }
  return params;
}

/** Ranges from remembered JSON values; anything that is not a number becomes an open bound. */
export function restoreRanges(saved) {
  const pick = (v) => (isNumber(v) ? v : null);
  return Object.fromEntries(
    RANGE_CHARTS.map(({ key }) => {
      const r = saved && typeof saved === 'object' ? saved[key] : null;
      return [key, r && typeof r === 'object' ? { min: pick(r.min), max: pick(r.max) } : { ...OPEN }];
    }),
  );
}
