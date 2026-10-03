import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery } from '../helpers/db.js';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  queryListings,
  normalizeListingQuery,
  dismissListing,
  restoreListing,
  updateListingEvaluation,
} from '../../lib/services/listings/listingsStorage.js';
import { queryStats } from '../../lib/services/listings/listingsStats.js';

const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const SEARCH = 'https://www.wg-gesucht.de/x.html';
const U = 'alice';
const listing = (id) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 500 + id,
});
const idOf = (p) => getListingByProviderId(String(p)).id;
const ids = (q) =>
  queryListings(U, { sort: 'price', dir: 'asc', ...q }, NOW)
    .items.map((i) => i.providerId)
    .sort();

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
  storeNewListings([1, 2, 3, 4].map(listing), SEARCH, NOW);
  dismissListing(U, idOf(2), NOW, 'not_interested');
  dismissListing(U, idOf(3), NOW, 'messaged');
  updateListingEvaluation(
    U,
    idOf(4),
    { scores: {}, overall: 1, missing: [], details: {}, excluded: 'LLM: not eligible: only women' },
    NOW,
  );
});
afterEach(() => Db.reset());

describe('#show (not interested / messaged)', () => {
  it('normalizes show as a comma list; unknown values are ignored', () => {
    expect(normalizeListingQuery({}).show).toEqual({ notInterested: false, messaged: false, auto: false });
    expect(normalizeListingQuery({ show: 'not_interested' }).show).toEqual({
      notInterested: true,
      messaged: false,
      auto: false,
    });
    expect(normalizeListingQuery({ show: 'messaged, bogus' }).show).toEqual({
      notInterested: false,
      messaged: true,
      auto: false,
    });
    expect(normalizeListingQuery({ show: 'not_interested,messaged' }).show).toEqual({
      notInterested: true,
      messaged: true,
      auto: false,
    });
    expect(normalizeListingQuery({ show: 'auto' }).show).toEqual({ notInterested: false, messaged: false, auto: true });
  });

  it('hides all three kinds by default', () => {
    expect(ids({})).toEqual(['1']);
  });

  it('show=not_interested adds only the ones the user is not interested in', () => {
    expect(ids({ show: 'not_interested' })).toEqual(['1', '2']);
  });

  it('show=messaged adds only the messaged ones', () => {
    expect(ids({ show: 'messaged' })).toEqual(['1', '3']);
  });

  it('program-hidden (auto-excluded) listings stay hidden with the two user switches on', () => {
    expect(ids({ show: 'not_interested,messaged' })).toEqual(['1', '2', '3']);
  });

  it('show=auto adds only the automatically removed ones, with the reason', () => {
    expect(ids({ show: 'auto' })).toEqual(['1', '4']);
    expect(ids({ show: 'not_interested,messaged,auto' })).toEqual(['1', '2', '3', '4']);
    const hidden = queryListings(U, { show: 'auto' }, NOW).items.find((i) => i.providerId === '4');
    expect(hidden).toMatchObject({
      dismissed: true,
      hidden: { by: 'program', reason: 'LLM: not eligible: only women' },
    });
  });

  it('restoring an automatically removed listing keeps it visible without the switch', () => {
    restoreListing(U, idOf(4));
    expect(ids({})).toEqual(['1', '4']);
    expect(queryListings(U, {}, NOW).hiddenAutomatically).toBe(0);
  });

  it('includeHidden=1 (and the alias includeDismissed) still means everything', () => {
    expect(ids({ includeHidden: '1' })).toEqual(['1', '2', '3', '4']);
    expect(ids({ includeDismissed: 'true' })).toEqual(['1', '2', '3', '4']);
  });

  it('reports how many listings were hidden automatically', () => {
    expect(queryListings(U, {}, NOW).hiddenAutomatically).toBe(1);
    expect(queryListings(U, { show: 'not_interested,messaged' }, NOW).hiddenAutomatically).toBe(1);
  });

  it('the count follows the recency filter', () => {
    expect(queryListings(U, { maxAgeHours: 1 }, NOW + 5 * 3_600_000).hiddenAutomatically).toBe(0);
  });

  it('the stats follow the same show switches and always skip excluded listings', () => {
    expect(queryStats(U, {}, NOW).total).toBe(1);
    expect(queryStats(U, { show: 'not_interested' }, NOW).total).toBe(2);
    expect(queryStats(U, { show: 'not_interested,messaged' }, NOW).total).toBe(3);
    expect(queryStats(U, { includeHidden: '1' }, NOW).total).toBe(3); // 4 is excluded
  });
});
