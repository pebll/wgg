import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery, setRow } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  dismissListing,
  queryListings,
  selectNextPendingDetail,
  storeListingDetails,
  recordDetailFailure,
  getDetailCounts,
} from '../../lib/services/listings/listingsStorage.js';

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const U = 'alice';
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();

const listing = (id, extra = {}) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 600,
  onlineRaw: null,
  ...extra,
});

const parsed = {
  sections: [{ heading: 'Zimmer', text: 'Schönes Zimmer' }],
  description: 'Zimmer\nSchönes Zimmer',
  costs: [{ label: 'Miete', raw: '600€', value: 600 }],
  address: { raw: 'Teststr. 1 80331 München', street: 'Teststr. 1', postcodeCity: '80331 München' },
  availableFrom: '2026-11-01',
  availableUntil: null,
  availabilityRaw: '01.11.2026',
  onlineRaw: '2 Tage',
  onlineMinutes: 2880,
  wgFacts: [{ group: 'Die WG', label: null, value: '3er WG' }],
  objectFacts: [{ label: 'möbliert', value: null }],
};

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.reset());

describe('#migration 7 (detail columns)', () => {
  it('adds the detail columns and new listings default to pending', () => {
    const cols = Db.query('PRAGMA table_info(listings)').map((c) => c.name);
    for (const c of [
      'details_status',
      'details_attempts',
      'details_error',
      'details_fetched_at',
      'description_text',
      'detail_page_json',
    ]) {
      expect(cols).toContain(c);
    }
    storeNewListings([listing(1)], SEARCH, NOW);
    expect(getListingByProviderId('1')).toMatchObject({
      details_status: 'pending',
      details_attempts: 0,
      details_error: null,
      details_fetched_at: null,
      description_text: null,
    });
  });

  it('rejects an unknown status', () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    expect(() => Db.execute("UPDATE listings SET details_status = 'bogus'")).toThrow();
  });
});

describe('#selectNextPendingDetail', () => {
  const ids = (row) => row?.provider_id;

  it('returns the newest pending listing first', () => {
    storeNewListings([listing(1)], SEARCH, NOW - 3 * 3_600_000);
    storeNewListings([listing(2)], SEARCH, NOW - 1 * 3_600_000);
    storeNewListings([listing(3)], SEARCH, NOW - 2 * 3_600_000);
    expect(ids(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }))).toBe('2');
  });

  it('prefers published_at over first_seen_at when ordering', () => {
    storeNewListings([listing(1, { onlineRaw: 'Online: 5 Minuten', onlineMinutes: 5 })], SEARCH, NOW - 1000);
    storeNewListings([listing(2, { onlineRaw: 'Online: 3 Stunden', onlineMinutes: 180 })], SEARCH, NOW - 500);
    expect(ids(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }))).toBe('1');
  });

  it('skips dismissed listings without changing them', () => {
    storeNewListings([listing(1)], SEARCH, NOW - 1000);
    storeNewListings([listing(2)], SEARCH, NOW - 2000);
    dismissListing(U, getListingByProviderId('1').id, NOW);
    expect(ids(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }))).toBe('2');
    expect(getListingByProviderId('1').details_status).toBe('pending');
  });

  it('marks listings older than maxAgeDays as skipped and never returns them', () => {
    storeNewListings([listing(1)], SEARCH, NOW - 8 * DAY);
    storeNewListings([listing(2)], SEARCH, NOW - 6 * DAY);
    expect(ids(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }))).toBe('2');
    expect(getListingByProviderId('1').details_status).toBe('skipped');
    expect(getListingByProviderId('2').details_status).toBe('pending');
  });

  it('returns undefined when nothing is pending', () => {
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 })).toBeUndefined();
  });

  it('serves retries after fresh listings', () => {
    storeNewListings([listing(1)], SEARCH, NOW - 1000);
    storeNewListings([listing(2)], SEARCH, NOW - 2000);
    recordDetailFailure(getListingByProviderId('1').id, 'boom', { maxAttempts: 3, now: NOW });
    expect(ids(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }))).toBe('2');
  });
});

describe('#storeListingDetails / #recordDetailFailure', () => {
  it('stores the description and the parsed page, status fetched', () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    const { id } = getListingByProviderId('1');
    storeListingDetails(id, parsed, NOW + 5);
    const row = getListingByProviderId('1');
    expect(row).toMatchObject({
      details_status: 'fetched',
      details_error: null,
      details_fetched_at: NOW + 5,
      description_text: 'Zimmer\nSchönes Zimmer',
      details_attempts: 1,
    });
    expect(JSON.parse(row.detail_page_json)).toMatchObject({ costs: parsed.costs, wgFacts: parsed.wgFacts });
    expect(JSON.parse(row.detail_page_json)).not.toHaveProperty('description');
  });

  it('counts attempts, stays pending until maxAttempts, then failed with the last error', () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    const { id } = getListingByProviderId('1');
    expect(recordDetailFailure(id, 'e1', { maxAttempts: 3, now: NOW })).toBe('pending');
    expect(recordDetailFailure(id, 'e2', { maxAttempts: 3, now: NOW })).toBe('pending');
    expect(getListingByProviderId('1')).toMatchObject({ details_attempts: 2, details_error: 'e2' });
    expect(recordDetailFailure(id, 'e3', { maxAttempts: 3, now: NOW })).toBe('failed');
    expect(getListingByProviderId('1')).toMatchObject({ details_status: 'failed', details_attempts: 3 });
    expect(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 })).toBeUndefined();
  });
});

describe('#getDetailCounts', () => {
  it('counts pending (not dismissed, not expired), fetched and failed', () => {
    storeNewListings([listing(1), listing(2), listing(3), listing(4), listing(5)], SEARCH, NOW - 1000);
    storeNewListings([listing(6)], SEARCH, NOW - 9 * DAY);
    const id = (p) => getListingByProviderId(p).id;
    storeListingDetails(id('1'), parsed, NOW);
    recordDetailFailure(id('2'), 'x', { maxAttempts: 1, now: NOW });
    dismissListing(U, id('3'), NOW);
    expect(getDetailCounts({ userId: U, now: NOW, maxAgeDays: 7 })).toEqual({ pending: 2, fetched: 1, failed: 1 });
  });
});

describe('#queryListings details', () => {
  it('exposes the detail status and parsed content', () => {
    storeNewListings([listing(1), listing(2)], SEARCH, NOW);
    storeListingDetails(getListingByProviderId('1').id, parsed, NOW);
    const { items } = queryListings(U, {}, NOW);
    const byId = Object.fromEntries(items.map((i) => [i.providerId, i]));
    expect(byId['2'].details).toMatchObject({ status: 'pending', attempts: 0, error: null, fetchedAt: null });
    expect(byId['2'].details.description).toBeNull();
    expect(byId['1'].details).toMatchObject({
      status: 'fetched',
      description: 'Zimmer\nSchönes Zimmer',
      sections: parsed.sections,
      costs: parsed.costs,
      address: parsed.address,
      wgFacts: parsed.wgFacts,
      objectFacts: parsed.objectFacts,
    });
  });
});

describe('#selectNextPendingDetail priority by score', () => {
  const ids = (row) => row?.provider_id;
  const scoreOf = (providerId, overall) => setRow(U, String(providerId), { overall_score: overall });

  it('takes the highest overall score first, then the newest; unscored listings come last', () => {
    storeNewListings([listing(1)], SEARCH, NOW - 1_000); // newest, unscored
    storeNewListings([listing(2)], SEARCH, NOW - 4 * 3_600_000); // oldest, best score
    storeNewListings([listing(3)], SEARCH, NOW - 2 * 3_600_000); // score 7, newer than 4
    storeNewListings([listing(4)], SEARCH, NOW - 3 * 3_600_000); // score 7, older than 3
    scoreOf(2, 9);
    scoreOf(3, 7);
    scoreOf(4, 7);
    const order = [];
    for (let i = 0; i < 4; i++) {
      const row = selectNextPendingDetail({ now: NOW, maxAgeDays: 7 });
      order.push(ids(row));
      Db.execute("UPDATE listings SET details_status = 'fetched' WHERE provider_id = @p", {
        p: ids(row),
      });
    }
    expect(order).toEqual(['2', '3', '4', '1']);
  });

  it('keeps the skip rules: hidden and too-old listings are never picked, however good their score', () => {
    storeNewListings([listing(1)], SEARCH, NOW - 1_000);
    storeNewListings([listing(2)], SEARCH, NOW - 2_000);
    storeNewListings([listing(3)], SEARCH, NOW - 30 * 86_400_000);
    scoreOf(1, 10);
    scoreOf(3, 10);
    scoreOf(2, 3);
    dismissListing(U, getListingByProviderId('1').id, NOW);
    expect(ids(selectNextPendingDetail({ now: NOW, maxAgeDays: 7 }))).toBe('2');
    expect(getListingByProviderId('3').details_status).toBe('skipped');
  });
});
