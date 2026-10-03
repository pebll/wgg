import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  findNewListings,
  storeNewListings,
  getListingByProviderId,
} from '../../lib/services/listings/listingsStorage.js';

const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const U = 'alice';

const listing = (id, extra = {}) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  image: null,
  price: 600,
  priceRaw: '600 €',
  size: 20,
  sizeRaw: '20 m²',
  flatmatesRaw: '2er WG',
  wgSize: 2,
  district: 'München Maxvorstadt',
  street: 'Teststr. 1',
  detailsRaw: '2er WG | München Maxvorstadt | Teststr. 1',
  availableFrom: '2026-08-01',
  availableUntil: null,
  availabilityRaw: '01.08.2026',
  onlineRaw: 'Online: 3 Minuten',
  onlineMinutes: 3,
  ...extra,
});

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});

afterEach(() => Db.reset());

describe('#listingsStorage', () => {
  it('creates the listings table with a unique provider_id', () => {
    expect(Db.tableExists('listings')).toBe(true);
    storeNewListings([listing(1)], SEARCH, 1000);
    expect(() =>
      Db.execute("INSERT INTO listings (provider_id, search_url, link, first_seen_at) VALUES ('1', 'x', 'y', 1)"),
    ).toThrow(/UNIQUE/);
  });

  it('stores raw + parsed fields and first_seen_at', () => {
    storeNewListings([listing(1)], SEARCH, 1234);
    const row = getListingByProviderId('1');
    expect(row).toMatchObject({
      provider_id: '1',
      search_url: SEARCH,
      title: 'Room 1',
      price: 600,
      price_raw: '600 €',
      size: 20,
      size_raw: '20 m²',
      wg_size: 2,
      flatmates_raw: '2er WG',
      district: 'München Maxvorstadt',
      street: 'Teststr. 1',
      available_from: '2026-08-01',
      available_until: null,
      availability_raw: '01.08.2026',
      online_raw: 'Online: 3 Minuten',
      online_minutes: 3,
      first_seen_at: 1234,
    });
  });

  it('returns only new listings and processes each exactly once', () => {
    const first = storeNewListings([listing(1), listing(2)], SEARCH, 1000);
    expect(first.map((l) => l.providerId)).toEqual(['1', '2']);

    const second = storeNewListings([listing(2), listing(3)], SEARCH, 2000);
    expect(second.map((l) => l.providerId)).toEqual(['3']);

    expect(storeNewListings([listing(1), listing(2), listing(3)], SEARCH, 3000)).toEqual([]);
    expect(getListingByProviderId('2').first_seen_at).toBe(1000);
  });

  it('is not fooled by a price change (id is the provider id only)', () => {
    storeNewListings([listing(1)], SEARCH, 1000);
    expect(storeNewListings([listing(1, { price: 650, priceRaw: '650 €' })], SEARCH, 2000)).toEqual([]);
    expect(getListingByProviderId('1').price).toBe(600);
  });

  it('dedupes within one batch', () => {
    expect(storeNewListings([listing(1), listing(1)], SEARCH, 1000)).toHaveLength(1);
  });

  it('findNewListings is read-only', () => {
    storeNewListings([listing(1)], SEARCH, 1000);
    expect(findNewListings([listing(1), listing(2)]).map((l) => l.providerId)).toEqual(['2']);
    expect(getListingByProviderId('2')).toBeUndefined();
  });
});
