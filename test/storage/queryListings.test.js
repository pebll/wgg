import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery, setRow } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { storeNewListings, queryListings, normalizeListingQuery } from '../../lib/services/listings/listingsStorage.js';

const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const U = 'alice';

const listing = (id, extra = {}) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 600,
  size: 20,
  wgSize: 2,
  district: 'München Maxvorstadt',
  street: 'Teststr. 1',
  availableFrom: '2026-08-01',
  availableUntil: null,
  onlineRaw: 'Online: 3 Minuten',
  onlineMinutes: 3,
  ...extra,
});

const evaluate = (providerId, fields) => setRow(U, providerId, fields);

beforeEach(async () => {
  Db.close();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.close());

describe('#migration 2 (evaluation columns)', () => {
  it('adds nullable evaluation and notify columns and keeps existing rows', () => {
    const cols = Db.query('PRAGMA table_info(listings)').map((c) => c.name);
    for (const c of [
      'overall_score',
      'scores_json',
      'details_json',
      'missing_json',
      'excluded_reason',
      'evaluated_at',
      'notified_at',
    ]) {
      expect(cols).toContain(c);
    }
    storeNewListings([listing(1)], SEARCH, 1000);
    const row = Db.query('SELECT overall_score, notified_at, evaluated_at FROM listings')[0];
    expect(row).toEqual({ overall_score: null, notified_at: null, evaluated_at: null });
  });
});

describe('#normalizeListingQuery', () => {
  it('applies defaults', () => {
    expect(normalizeListingQuery({})).toEqual({
      sort: 'first_seen',
      dir: 'desc',
      minScore: null,
      maxRent: null,
      maxAgeDays: null,
      maxAgeHours: null,
      includeHidden: false,
      show: { notInterested: false, messaged: false, auto: false },
      ranges: {
        score: { min: null, max: null },
        ai: { min: null, max: null },
        rent: { min: null, max: null },
        dist: { min: null, max: null },
      },
      tier: null,
      page: 1,
      pageSize: 50,
    });
  });

  it('accepts only the known tiers', () => {
    expect(normalizeListingQuery({ tier: 'good' }).tier).toBe('good');
    expect(normalizeListingQuery({ tier: 'fantastic' }).tier).toBe('fantastic');
    expect(normalizeListingQuery({ tier: "good' OR 1=1" }).tier).toBeNull();
  });

  it('whitelists sort and dir, falling back to defaults', () => {
    const q = normalizeListingQuery({ sort: 'id; DROP TABLE listings', dir: 'sideways' });
    expect(q.sort).toBe('first_seen');
    expect(q.dir).toBe('desc');
    expect(normalizeListingQuery({ sort: 'price', dir: 'asc' })).toMatchObject({ sort: 'price', dir: 'asc' });
    expect(normalizeListingQuery({ sort: 'overall' }).sort).toBe('overall');
  });

  it('coerces numeric strings, ignores garbage and caps pageSize', () => {
    expect(normalizeListingQuery({ minScore: '7.5', maxRent: '500' })).toMatchObject({ minScore: 7.5, maxRent: 500 });
    expect(normalizeListingQuery({ minScore: 'abc', maxRent: '' })).toMatchObject({ minScore: null, maxRent: null });
    expect(normalizeListingQuery({ page: '0', pageSize: '100000' })).toMatchObject({ page: 1, pageSize: 200 });
    expect(normalizeListingQuery({ page: '3', pageSize: '10' })).toMatchObject({ page: 3, pageSize: 10 });
    expect(normalizeListingQuery({ pageSize: '-5' }).pageSize).toBe(50);
  });
});

describe('#queryListings', () => {
  beforeEach(() => {
    storeNewListings([listing(1, { price: 700 })], SEARCH, 1000);
    storeNewListings([listing(2, { price: 400 })], SEARCH, 2000);
    storeNewListings([listing(3, { price: 550 })], SEARCH, 3000);
    storeNewListings([listing(4, { price: null })], SEARCH, 4000);
    evaluate('1', {
      overall_score: 8,
      scores_json: JSON.stringify({ price: 9, size: 7 }),
      details_json: JSON.stringify({ price: 'cheap' }),
      missing_json: JSON.stringify(['size']),
      evaluated_at: 5000,
      notified_at: 6000,
    });
    evaluate('2', { overall_score: 5, evaluated_at: 5000, excluded_reason: 'too far' });
  });

  it('defaults to newest first and returns total', () => {
    const r = queryListings(U, {});
    expect(r.items.map((i) => i.providerId)).toEqual(['4', '3', '2', '1']);
    expect(r).toMatchObject({ total: 4, page: 1, pageSize: 50 });
  });

  it('sorts by price asc with null prices last, desc too', () => {
    expect(queryListings(U, { sort: 'price', dir: 'asc' }).items.map((i) => i.providerId)).toEqual([
      '2',
      '3',
      '1',
      '4',
    ]);
    expect(queryListings(U, { sort: 'price', dir: 'desc' }).items.map((i) => i.providerId)).toEqual([
      '1',
      '3',
      '2',
      '4',
    ]);
  });

  it('sorts by overall score with unevaluated last', () => {
    expect(queryListings(U, { sort: 'overall', dir: 'desc' }).items.map((i) => i.providerId)).toEqual([
      '1',
      '2',
      '4',
      '3',
    ]);
    expect(queryListings(U, { sort: 'overall', dir: 'asc' }).items.map((i) => i.providerId)).toEqual([
      '2',
      '1',
      '4',
      '3',
    ]);
  });

  it('filters by maxRent (inclusive) and minScore', () => {
    expect(queryListings(U, { maxRent: 550 }).items.map((i) => i.providerId)).toEqual(['3', '2']);
    expect(queryListings(U, { minScore: 6 }).items.map((i) => i.providerId)).toEqual(['1']);
    expect(queryListings(U, { minScore: 5, maxRent: 500 }).items.map((i) => i.providerId)).toEqual(['2']);
  });

  it('is not injectable through sort/dir/filters', () => {
    const r = queryListings(U, { sort: 'price; DROP TABLE listings; --', dir: 'asc; --', maxRent: '1 OR 1=1' });
    expect(r.total).toBe(4);
    expect(Db.tableExists('listings')).toBe(true);
  });

  it('paginates and reports total of the filtered set', () => {
    const p1 = queryListings(U, { pageSize: 3, page: 1 });
    const p2 = queryListings(U, { pageSize: 3, page: 2 });
    expect(p1.items).toHaveLength(3);
    expect(p2.items.map((i) => i.providerId)).toEqual(['1']);
    expect(p1.total).toBe(4);
  });

  it('maps rows to the API shape with parsed evaluation JSON', () => {
    const evaluated = queryListings(U, { sort: 'overall', dir: 'desc' }).items[0];
    expect(evaluated).toMatchObject({
      providerId: '1',
      link: 'https://www.wg-gesucht.de/x.1.html',
      title: 'Room 1',
      price: 700,
      size: 20,
      wgSize: 2,
      district: 'München Maxvorstadt',
      street: 'Teststr. 1',
      availableFrom: '2026-08-01',
      availableUntil: null,
      onlineMinutes: 3,
      firstSeenAt: 1000,
      notified: true,
      notifiedAt: 6000,
      evaluation: {
        overall: 8,
        scores: { price: 9, size: 7 },
        details: { price: 'cheap' },
        missing: ['size'],
        excludedReason: null,
        evaluatedAt: 5000,
      },
    });
    expect(evaluated).not.toHaveProperty('search_url');
  });

  it('gives null evaluation for unevaluated rows and tolerates sparse/invalid JSON', () => {
    evaluate('3', { scores_json: '{not json' });
    const r = queryListings(U, {}).items.find((i) => i.providerId === '3');
    expect(r.evaluation).toBeNull();
    expect(r.notified).toBe(false);
    evaluate('3', { overall_score: 4, evaluated_at: 1, scores_json: '{not json' });
    const r2 = queryListings(U, {}).items.find((i) => i.providerId === '3');
    expect(r2.evaluation).toEqual({
      overall: 4,
      scores: {},
      details: {},
      missing: [],
      excludedReason: null,
      evaluatedAt: 1,
    });
  });
});

describe('#queryListings maxAgeDays and new payload fields', () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;

  beforeEach(() => {
    storeNewListings([listing(1, { onlineRaw: 'Online: 2 Tage', onlineMinutes: 2880 })], SEARCH, NOW - DAY); // published 3 days before NOW
    storeNewListings([listing(2, { onlineRaw: null, onlineMinutes: null })], SEARCH, NOW - 2 * DAY); // no age: first_seen
    storeNewListings([listing(3, { onlineRaw: 'Online: 3 Minuten' })], SEARCH, NOW - 10 * DAY); // old
    storeNewListings([listing(4, { onlineRaw: 'Online: 5 Stunden', onlineMinutes: 300 })], SEARCH, NOW - 100);
    evaluate('4', {
      lat: 48.15,
      lng: 11.57,
      geo_precision: 'address',
      distance_km: 0.8,
      image: 'https://img/x.jpg',
    });
  });

  it('normalizes maxAgeDays like other numeric filters', () => {
    expect(normalizeListingQuery({ maxAgeDays: '3' }).maxAgeDays).toBe(3);
    expect(normalizeListingQuery({ maxAgeDays: 'abc' }).maxAgeDays).toBeNull();
  });

  it('is unfiltered by default', () => {
    expect(queryListings(U, {}, NOW).total).toBe(4);
  });

  it('filters on published_at, falling back to first_seen_at', () => {
    const ids = queryListings(U, { maxAgeDays: 2.5, sort: 'first_seen', dir: 'asc' }, NOW).items.map(
      (i) => i.providerId,
    );
    expect(ids).toEqual(['2', '4']);
    expect(queryListings(U, { maxAgeDays: 3 }, NOW).total).toBe(3); // boundary is inclusive
  });

  it('exposes publishedAt, image and geo fields', () => {
    const item = queryListings(U, { maxAgeDays: 1 }, NOW).items[0];
    expect(item).toMatchObject({
      providerId: '4',
      publishedAt: NOW - 100 - 300 * 60_000,
      image: 'https://img/x.jpg',
      lat: 48.15,
      lng: 11.57,
      geoPrecision: 'address',
      distanceKm: 0.8,
    });
    const bare = queryListings(U, { maxAgeDays: 3 }, NOW).items.find((i) => i.providerId === '2');
    expect(bare).toMatchObject({ publishedAt: null, lat: null, geoPrecision: null, distanceKm: null });
  });
});
