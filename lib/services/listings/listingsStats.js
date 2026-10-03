import Db from '../storage/Db.js';
import { AI_SCORE_SQL, buildListingFilter, normalizeListingQuery, userRows } from './listingsStorage.js';

const RENT_STEP = 50;
const MAX_RENT_BINS = 60; // 50 EUR steps: up to 3000 EUR, anything above lands in the last bin
const DISTANCE_STEP = 1;
const MAX_DISTANCE_BINS = 30; // 1 km steps: up to 30 km, anything above lands in the last bin
const SCORE_BINS = 9; // [1,2) ... [8,9) and [9,10]: the 1-10 scale with 10 inside the last bin

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Counts values into `count` equal bins of width `step` starting at `start` (half-open [from, to)).
 * Values at or above the end land in the last bin, so the number of bins stays bounded; values below
 * `start` and non-numbers are ignored.
 *
 * @param {unknown[]} values
 * @param {{start: number, step: number, count: number}} spec
 * @returns {{from: number, to: number, count: number}[]}
 */
export function binValues(values, { start, step, count }) {
  const bins = Array.from({ length: count }, (_, i) => ({
    from: start + i * step,
    to: start + (i + 1) * step,
    count: 0,
  }));
  for (const v of values) {
    if (!isNumber(v) || v < start) continue;
    bins[Math.min(count - 1, Math.floor((v - start) / step))].count++;
  }
  return bins;
}

/** Bins for data-dependent ranges: starts at the first non-empty step, covers up to the maximum (bounded). */
function binRange(values, { step, maxBins, startAtZero }) {
  const known = values.filter(isNumber);
  if (known.length === 0) return [];
  const start = startAtZero ? 0 : Math.floor(Math.min(...known) / step) * step;
  const count = Math.min(maxBins, Math.floor((Math.max(...known) - start) / step) + 1);
  return binValues(known, { start, step, count });
}

/**
 * Distribution of the listings matching the same filters as `queryListings` (shared WHERE builder), for
 * the dashboard charts. Excluded listings (any `excluded_reason`: keyword, rent, later the LLM) are not part of the
 * statistics at all: not in `total`, not in any bin. Rows without a score are counted separately as `unscored` (no AI
 * assessment: `unassessed`, no value: `unknown`).
 *
 * The range filters (scoreMin/scoreMax, aiMin/aiMax, rentMin/rentMax, distMin/distMax) apply to `total` and to every
 * chart except their own: a chart ignores its own range so the other bars stay visible and can be clicked.
 *
 * @param {string} userId Whose listings are counted (only their view, with their scores and distances).
 * @param {Record<string, unknown>} [rawQuery] Same parameters as /api/listings (paging and sort are ignored).
 * @param {number} [now]
 */
export function queryStats(userId, rawQuery = {}, now = Date.now()) {
  const q = normalizeListingQuery(rawQuery);
  const db = Db.getConnection();
  const rowsWithout = (...omitRanges) => {
    const { whereSql, params } = buildListingFilter(q, now, { omitRanges });
    const notExcluded = whereSql === '' ? 'WHERE excluded_reason IS NULL' : `${whereSql} AND excluded_reason IS NULL`;
    return db
      .prepare(
        `SELECT overall_score, price, distance_km, ${AI_SCORE_SQL} AS ai_score FROM ${userRows()} AS v ${notExcluded}`,
      )
      .all({ ...params, userId });
  };
  const all = rowsWithout();
  const scoreRows = rowsWithout('score');
  const aiRows = rowsWithout('ai');
  const rentRows = rowsWithout('rent');
  const distRows = rowsWithout('dist');

  const scored = scoreRows.filter((r) => r.overall_score !== null);
  const assessed = aiRows.filter((r) => isNumber(r.ai_score));
  const prices = rentRows.map((r) => r.price);
  const distances = distRows.map((r) => r.distance_km);

  return {
    total: all.length,
    score: {
      bins: binValues(
        scored.map((r) => r.overall_score),
        { start: 1, step: 1, count: SCORE_BINS },
      ),
      unscored: scoreRows.length - scored.length,
    },
    ai: {
      bins: binValues(
        assessed.map((r) => r.ai_score),
        { start: 1, step: 1, count: SCORE_BINS },
      ),
      unassessed: aiRows.length - assessed.length,
    },
    rent: {
      bins: binRange(prices, { step: RENT_STEP, maxBins: MAX_RENT_BINS, startAtZero: false }),
      unknown: prices.filter((v) => !isNumber(v)).length,
    },
    distance: {
      bins: binRange(distances, { step: DISTANCE_STEP, maxBins: MAX_DISTANCE_BINS, startAtZero: true }),
      unknown: distances.filter((v) => !isNumber(v)).length,
    },
  };
}
