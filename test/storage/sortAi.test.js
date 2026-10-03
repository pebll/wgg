import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery, setRow } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  queryListings,
  normalizeListingQuery,
  recordLlmResult,
  updateListingEvaluation,
} from '../../lib/services/listings/listingsStorage.js';
import { queryStats } from '../../lib/services/listings/listingsStats.js';

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;
const SEARCH = 'https://www.wg-gesucht.de/x.html';
const U = 'alice';
const listing = (id, extra = {}) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 600,
  onlineRaw: null,
  onlineMinutes: null,
  ...extra,
});
const idOf = (p) => getListingByProviderId(String(p)).id;
const score = (p, overall) =>
  updateListingEvaluation(U, idOf(p), { scores: {}, overall, missing: [], details: {} }, NOW);
const ai = (p, fitScore) => recordLlmResult(U, idOf(p), { fitScore, summary: 's', model: 'm' }, NOW);
const order = (q) => queryListings(U, q, NOW).items.map((i) => i.providerId);

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.reset());

describe('#sort=ai', () => {
  beforeEach(() => {
    storeNewListings(
      [1, 2, 3, 4, 5].map((n) => listing(n, { price: 100 * n })),
      SEARCH,
      NOW,
    );
    score(1, 5);
    score(2, 9);
    score(3, 7);
    score(4, 8);
    score(5, 6);
    ai(1, 9); // best AI score, lowest overall
    ai(3, 4);
    ai(4, 4); // ties with 3: overall desc decides (4 before 3)
    // 2 and 5 are not assessed: last, then overall desc
  });

  it('orders by the LLM fit score desc, unassessed last, then overall desc', () => {
    expect(order({ sort: 'ai' })).toEqual(['1', '4', '3', '2', '5']);
  });

  it('ignores the dir parameter and a failed assessment', () => {
    expect(order({ sort: 'ai', dir: 'asc' })).toEqual(['1', '4', '3', '2', '5']);
    setRow(U, '1', { llm_status: 'failed' });
    expect(order({ sort: 'ai' })[0]).not.toBe('1');
  });

  it('keeps sort=overall (desc) and sort=price (asc) working', () => {
    expect(order({ sort: 'overall' })).toEqual(['2', '4', '3', '5', '1']);
    expect(order({ sort: 'price', dir: 'asc' })).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('#maxAgeHours', () => {
  beforeEach(() => {
    storeNewListings([listing(1)], SEARCH, NOW - 30 * 60_000); // 30 min
    storeNewListings([listing(2)], SEARCH, NOW - 5 * HOUR);
    storeNewListings([listing(3)], SEARCH, NOW - 30 * HOUR);
    storeNewListings([listing(4)], SEARCH, NOW - 80 * HOUR);
    storeNewListings([listing(5, { onlineRaw: 'Online: 33 Stunden', onlineMinutes: 33 * 60 })], SEARCH, NOW); // seen now, published 33 h ago
  });

  it('is validated: positive finite numbers only', () => {
    expect(normalizeListingQuery({ maxAgeHours: '1' }).maxAgeHours).toBe(1);
    expect(normalizeListingQuery({ maxAgeHours: '0.5' }).maxAgeHours).toBe(0.5);
    for (const bad of ['abc', '', '0', '-3', undefined, 'Infinity']) {
      expect(normalizeListingQuery({ maxAgeHours: bad }).maxAgeHours).toBeNull();
    }
  });

  it('keeps listings published (else first seen) within that many hours', () => {
    expect(order({ maxAgeHours: 1, sort: 'first_seen' }).sort()).toEqual(['1']);
    expect(order({ maxAgeHours: 24, sort: 'first_seen' }).sort()).toEqual(['1', '2']); // 5 counts as 33 h old
    expect(order({ maxAgeHours: 72, sort: 'first_seen' }).sort()).toEqual(['1', '2', '3', '5']);
  });

  it('the stats use the same filter', () => {
    expect(queryStats(U, { maxAgeHours: 24 }, NOW).total).toBe(2);
    expect(queryStats(U, { maxAgeHours: 1 }, NOW).total).toBe(1);
  });
});
