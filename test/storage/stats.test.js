import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery, setUserState } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { storeNewListings, dismissListing, queryListings } from '../../lib/services/listings/listingsStorage.js';
import { binValues, queryStats } from '../../lib/services/listings/listingsStats.js';

const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const U = 'alice';
const NOW = 10_000_000;

describe('#binValues', () => {
  it('counts values into half-open bins [from, to) from a start with a fixed step', () => {
    const bins = binValues([0, 0.5, 1, 2.9, 3], { start: 0, step: 1, count: 4 });
    expect(bins).toEqual([
      { from: 0, to: 1, count: 2 },
      { from: 1, to: 2, count: 1 },
      { from: 2, to: 3, count: 1 },
      { from: 3, to: 4, count: 1 },
    ]);
  });

  it('puts values beyond the last bin into the last bin (no unbounded bin lists)', () => {
    const bins = binValues([1, 99], { start: 0, step: 1, count: 3 });
    expect(bins.map((b) => b.count)).toEqual([0, 1, 1]);
  });

  it('ignores values below the start and non-numbers', () => {
    expect(binValues([-5, null, undefined, NaN, 1], { start: 0, step: 1, count: 2 }).map((b) => b.count)).toEqual([
      0, 1,
    ]);
  });

  it('keeps the last bin inclusive when asked (scores 1..10 with 10 in the 9-10 bin)', () => {
    const bins = binValues([9, 10], { start: 1, step: 1, count: 9 });
    expect(bins[8]).toEqual({ from: 9, to: 10, count: 2 });
  });
});

describe('#queryStats', () => {
  const add = (id, price, extra = {}) => {
    storeNewListings([{ providerId: String(id), link: `https://www.wg-gesucht.de/x.${id}.html`, price }], SEARCH, NOW);
    setUserState(U, String(id), {
      overall_score: null,
      excluded_reason: null,
      distance_km: null,
      evaluated_at: null,
      ...extra,
    });
  };

  beforeEach(async () => {
    Db.close();
    Db.init(':memory:');
    await runMigrations();
    giveQuery(U, SEARCH);
    add(1, 420, { overall_score: 8.4, distance_km: 1.2, evaluated_at: 1 });
    add(2, 460, { overall_score: 5, distance_km: 3.7, evaluated_at: 1 });
    add(3, 700, { overall_score: 1, excluded_reason: 'rent above hard max', distance_km: 0.4, evaluated_at: 1 });
    add(4, null); // not evaluated, no price, no distance
    add(5, 430, { overall_score: 9.6, distance_km: 2.2, evaluated_at: 1 });
  });
  afterEach(() => Db.close());

  it('reports total, score bins (unscored separately), rent and distance bins', () => {
    const s = queryStats(U, {}, NOW);
    expect(s.total).toBe(4); // the excluded listing 3 is not part of the statistics at all
    expect(s.score).not.toHaveProperty('excluded');
    expect(s.score.unscored).toBe(1);
    expect(s.score.bins).toHaveLength(9);
    expect(s.score.bins[0]).toMatchObject({ from: 1, to: 2 });
    const byFrom = Object.fromEntries(s.score.bins.map((b) => [b.from, b.count]));
    expect(byFrom[8]).toBe(1); // 8.4
    expect(byFrom[5]).toBe(1); // 5
    expect(byFrom[9]).toBe(1); // 9.6
    expect(byFrom[1]).toBe(0);
    expect(s.score.bins.reduce((n, b) => n + b.count, 0)).toBe(3);

    expect(s.rent.unknown).toBe(1);
    expect(s.rent.bins[0].from).toBe(400);
    expect(s.rent.bins.every((b) => b.to - b.from === 50)).toBe(true);
    const rentByFrom = Object.fromEntries(s.rent.bins.map((b) => [b.from, b.count]));
    expect(rentByFrom[400]).toBe(2); // 420, 430
    expect(rentByFrom[450]).toBe(1); // 460
    expect(rentByFrom[700]).toBeUndefined(); // the excluded 700 EUR listing is not counted
    expect(s.rent.bins.reduce((n, b) => n + b.count, 0)).toBe(3);

    expect(s.distance.unknown).toBe(1);
    expect(s.distance.bins[0]).toMatchObject({ from: 0, to: 1, count: 0 }); // the excluded 0.4 km is not counted
    expect(s.distance.bins.reduce((n, b) => n + b.count, 0)).toBe(3);
  });

  it('ignores every listing with an excluded_reason, whatever set it (keyword, rent, later LLM)', () => {
    setUserState(U, '5', { excluded_reason: 'LLM: Verbindung (0.9)' });
    const s = queryStats(U, {}, NOW);
    expect(s.total).toBe(3);
    expect(s.rent.bins.reduce((n, b) => n + b.count, 0) + s.rent.unknown).toBe(3);
    expect(s.distance.bins.reduce((n, b) => n + b.count, 0) + s.distance.unknown).toBe(3);
    expect(s.score.bins.reduce((n, b) => n + b.count, 0) + s.score.unscored).toBe(3);
  });

  it('leaves the listing list unchanged: excluded listings are still listed (grey badge)', () => {
    const { items, total } = queryListings(U, {}, NOW);
    expect(total).toBe(5);
    expect(items.find((i) => i.providerId === '3').evaluation.excludedReason).toBe('rent above hard max');
  });

  it('combines the exclusion with the other filters and with includeDismissed', () => {
    expect(queryStats(U, { maxRent: 800 }, NOW).total).toBe(3); // 420, 460, 430 (not the excluded 700)
    dismissListing(U, 3, NOW);
    expect(queryStats(U, { includeDismissed: '1' }, NOW).total).toBe(4);
  });

  it('applies the same filters as the listing query, including dismissed rows', () => {
    expect(queryStats(U, { maxRent: 450 }, NOW).total).toBe(2); // 420, 430 (NULL price never matches)
    expect(queryStats(U, { minScore: 8 }, NOW).total).toBe(2);
    dismissListing(U, 1, NOW);
    expect(queryStats(U, {}, NOW).total).toBe(3);
    expect(queryStats(U, { includeDismissed: '1' }, NOW).total).toBe(4);
  });

  it('is empty-safe', () => {
    const s = queryStats(U, { maxRent: 1 }, NOW);
    expect(s).toMatchObject({ total: 0, score: { unscored: 0 }, rent: { bins: [], unknown: 0 } });
    expect(s.distance.bins).toEqual([]);
  });
});
