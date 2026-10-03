import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  queryListings,
  dismissListing,
  restoreListing,
  normalizeListingQuery,
} from '../../lib/services/listings/listingsStorage.js';

const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const U = 'alice';
const listing = (id) => ({ providerId: String(id), link: `https://www.wg-gesucht.de/x.${id}.html`, price: 500 });

beforeEach(async () => {
  Db.close();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
  storeNewListings([listing(1), listing(2), listing(3)], SEARCH, 1000);
});
afterEach(() => Db.close());

const idOf = (providerId) => Db.query('SELECT id FROM listings WHERE provider_id = @p', { p: providerId })[0].id;

describe('#dismiss (not interested)', () => {
  it('migration adds a nullable dismissed_at column', () => {
    const col = Db.query('PRAGMA table_info(listings)').find((c) => c.name === 'dismissed_at');
    expect(col).toBeDefined();
    expect(col.notnull).toBe(0);
    expect(queryListings(U).items.every((i) => i.dismissed === false)).toBe(true);
  });

  it('dismissListing hides the row by default but keeps it in the database', () => {
    expect(dismissListing(U, idOf('2'), 5000)).toBe(true);
    const res = queryListings(U);
    expect(res.total).toBe(2);
    expect(res.items.map((i) => i.providerId).sort()).toEqual(['1', '3']);
    expect(Db.query('SELECT COUNT(*) AS n FROM listings')[0].n).toBe(3);
  });

  it('includeDismissed=1 returns hidden rows flagged as dismissed', () => {
    dismissListing(U, idOf('2'), 5000);
    const res = queryListings(U, { includeDismissed: '1' });
    expect(res.total).toBe(3);
    const hidden = res.items.find((i) => i.providerId === '2');
    expect(hidden).toMatchObject({ dismissed: true, dismissedAt: 5000 });
  });

  it('restoreListing brings the row back', () => {
    const id = idOf('2');
    dismissListing(U, id, 5000);
    expect(restoreListing(U, id)).toBe(true);
    expect(queryListings(U).total).toBe(3);
  });

  it('returns false for an unknown id', () => {
    expect(dismissListing(U, 9999)).toBe(false);
    expect(restoreListing(U, 9999)).toBe(false);
  });

  it('dismissing twice keeps the first timestamp', () => {
    const id = idOf('1');
    dismissListing(U, id, 5000);
    dismissListing(U, id, 9000);
    expect(queryListings(U, { includeDismissed: '1' }).items.find((i) => i.id === id).dismissedAt).toBe(5000);
  });

  it('normalizes includeHidden (alias includeDismissed) to a boolean (only "1"/"true" enable it)', () => {
    expect(normalizeListingQuery({}).includeHidden).toBe(false);
    expect(normalizeListingQuery({ includeHidden: '1' }).includeHidden).toBe(true);
    expect(normalizeListingQuery({ includeDismissed: '1' }).includeHidden).toBe(true);
    expect(normalizeListingQuery({ includeHidden: 'true' }).includeHidden).toBe(true);
    expect(normalizeListingQuery({ includeHidden: '0' }).includeHidden).toBe(false);
  });
});
