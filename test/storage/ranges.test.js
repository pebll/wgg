import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery, setUserState } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  dismissListing,
  normalizeListingQuery,
  queryListings,
  storeNewListings,
} from '../../lib/services/listings/listingsStorage.js';
import { queryStats } from '../../lib/services/listings/listingsStats.js';

const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const U = 'alice';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();

const ai = (fitScore) => ({ llm_status: 'done', llm_json: JSON.stringify({ fitScore }) });

// id: [price, score, distance, ai fit score]
const DATA = {
  1: [420, 8.4, 1.2, 9],
  2: [460, 5, 3.7, 6],
  3: [510, 7, 1.0, 10],
  4: [600, 9.6, 12.5, null],
  5: [null, null, null, null],
};

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
  for (const [id, [price, score, distance, fit]] of Object.entries(DATA)) {
    storeNewListings([{ providerId: id, link: `https://www.wg-gesucht.de/x.${id}.html`, price }], SEARCH, NOW);
    setUserState(U, id, {
      overall_score: score,
      distance_km: distance,
      evaluated_at: 1,
      excluded_reason: null,
      ...(fit === null ? {} : ai(fit)),
    });
  }
});
afterEach(() => Db.reset());

const ids = (q) =>
  queryListings(U, { pageSize: 200, ...q }, NOW)
    .items.map((i) => i.providerId)
    .sort();

describe('#range filters', () => {
  it('are numbers or nothing: garbage is ignored like the other filters', () => {
    const q = normalizeListingQuery({ scoreMin: '7', scoreMax: 'x', aiMin: '', rentMax: '650.5', distMin: '0' });
    expect(q.ranges).toEqual({
      score: { min: 7, max: null },
      ai: { min: null, max: null },
      rent: { min: null, max: 650.5 },
      dist: { min: 0, max: null },
    });
  });

  it('are half-open [min, max) like the histogram bins', () => {
    expect(ids({ rentMin: '420', rentMax: '510' })).toEqual(['1', '2']);
    expect(ids({ rentMin: '510', rentMax: '600' })).toEqual(['3']);
    expect(ids({ scoreMin: '7', scoreMax: '9' })).toEqual(['1', '3']);
    expect(ids({ distMin: '1', distMax: '2' })).toEqual(['1', '3']);
    expect(ids({ aiMin: '9', aiMax: '10' })).toEqual(['1']);
  });

  it('accept an open end (the last bin has no upper bound)', () => {
    expect(ids({ scoreMin: '9' })).toEqual(['4']);
    expect(ids({ aiMin: '9' })).toEqual(['1', '3']);
    expect(ids({ rentMax: '460' })).toEqual(['1']);
    expect(ids({ distMin: '12' })).toEqual(['4']);
  });

  it('are combined with AND, and with the other filters', () => {
    expect(ids({ scoreMin: '7', rentMax: '500' })).toEqual(['1']);
    expect(ids({ scoreMin: '5', aiMin: '9', distMax: '1.1' })).toEqual(['3']);
    expect(ids({ scoreMin: '7', maxRent: '500' })).toEqual(['1']);
    dismissListing(U, 1, NOW);
    expect(ids({ scoreMin: '7' })).toEqual(['3', '4']); // the hidden switches still apply
    expect(ids({ scoreMin: '7', show: 'not_interested' })).toEqual(['1', '3', '4']);
  });

  it('never match a listing without that value', () => {
    expect(ids({ rentMin: '0' })).not.toContain('5');
    expect(ids({ aiMin: '1' })).not.toContain('4'); // not assessed by the AI
    expect(ids({ distMin: '0' })).not.toContain('5');
  });
});

describe('#stats', () => {
  const counts = (bins) => Object.fromEntries(bins.filter((b) => b.count > 0).map((b) => [b.from, b.count]));

  it('has AI score bins 1-10 and counts the unassessed separately', () => {
    const s = queryStats(U, {}, NOW);
    expect(s.ai.bins).toHaveLength(9);
    expect(s.ai.bins[0]).toMatchObject({ from: 1, to: 2 });
    expect(counts(s.ai.bins)).toEqual({ 6: 1, 9: 2 }); // 6, 9 and 10 (10 lands in the last bin [9,10])
    expect(s.ai.unassessed).toBe(2);
  });

  it('applies the range filters to the total, like the list', () => {
    expect(queryStats(U, { scoreMin: '7', scoreMax: '9' }, NOW).total).toBe(2);
    expect(queryStats(U, { aiMin: '9' }, NOW).total).toBe(2);
    expect(queryStats(U, { rentMin: '420', rentMax: '510' }, NOW).total).toBe(2);
  });

  it('shows each chart without its own range, so the other bars stay visible; the other ranges still apply', () => {
    const s = queryStats(U, { scoreMin: '9', rentMax: '500' }, NOW);
    expect(s.total).toBe(0);
    // score chart: ignores scoreMin, keeps rentMax -> listings 1, 2
    expect(counts(s.score.bins)).toEqual({ 5: 1, 8: 1 });
    // rent chart: ignores rentMax, keeps scoreMin -> listing 4
    expect(counts(s.rent.bins)).toEqual({ 600: 1 });
    // AI and distance charts keep both ranges
    expect(s.ai.bins.reduce((n, b) => n + b.count, 0)).toBe(0);
    expect(s.distance.bins).toEqual([]);
  });
});
