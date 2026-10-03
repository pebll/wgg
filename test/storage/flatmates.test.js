import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { giveQuery, openDb, Db } from '../helpers/db.js';
import {
  storeNewListings,
  getListingByProviderId,
  getUserListing,
  queryListings,
  storeListingDetails,
} from '../../lib/services/listings/listingsStorage.js';
import { rowToEvaluatedListing } from '../../lib/evaluation/pipeline.js';

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const U = 'alice';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const mates = { wgSize: 3, female: 1, male: 1, diverse: 0, unspecified: 0, raw: '3er WG (1w,1m,0d,0n)' };
const card = (id, over = {}) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 600,
  wgSize: 3,
  flatmates: mates,
  ...over,
});
const page = (over = {}) => ({
  sections: [],
  description: 'Zimmer',
  costs: [],
  address: null,
  wgFacts: [],
  objectFacts: [],
  ...over,
});
const item = (id) => queryListings(U, {}, NOW).items.find((i) => i.providerId === String(id));

beforeEach(async () => {
  await openDb();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.reset());

describe('#flatmates storage', () => {
  it('stores the flatmates of a card and exposes them in the API item next to the WG size', () => {
    storeNewListings([card(1)], SEARCH, NOW);
    expect(item(1)).toMatchObject({ wgSize: 3, flatmates: mates });
  });

  it('a card without flatmates gives null; the API still shows the WG size', () => {
    storeNewListings([card(2, { flatmates: null })], SEARCH, NOW);
    expect(item(2)).toMatchObject({ wgSize: 3, flatmates: null });
  });

  it('fills the flatmates of an already stored listing when a later search card has them', () => {
    storeNewListings([card(3, { flatmates: null })], SEARCH, NOW);
    expect(item(3).flatmates).toBeNull();
    const stored = storeNewListings([card(3)], SEARCH, NOW + 60_000);
    expect(stored).toEqual([]); // not a new listing
    expect(item(3).flatmates).toEqual(mates);
  });

  it('a later card never overwrites flatmates that are already stored with nothing', () => {
    storeNewListings([card(4)], SEARCH, NOW);
    storeNewListings([card(4, { flatmates: null })], SEARCH, NOW + 1);
    expect(item(4).flatmates).toEqual(mates);
  });

  it('fills the flatmates from the detail page when the card lacked them', () => {
    storeNewListings([card(5, { flatmates: null })], SEARCH, NOW);
    storeListingDetails(getListingByProviderId('5').id, page({ flatmates: mates }), NOW);
    expect(item(5).flatmates).toEqual(mates);
  });

  it('keeps the card flatmates when the detail page has other ones', () => {
    storeNewListings([card(6)], SEARCH, NOW);
    storeListingDetails(getListingByProviderId('6').id, page({ flatmates: { ...mates, female: 9 } }), NOW);
    expect(item(6).flatmates).toEqual(mates);
  });

  it('reaches the evaluation input (and so the AI prompt)', () => {
    storeNewListings([card(7)], SEARCH, NOW);
    storeListingDetails(getListingByProviderId('7').id, page(), NOW);
    expect(rowToEvaluatedListing(getUserListing(U, '7')).flatmates).toEqual(mates);
  });
});
