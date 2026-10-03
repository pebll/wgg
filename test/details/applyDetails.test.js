import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  getUserListing,
  updateListingGeo,
} from '../../lib/services/listings/listingsStorage.js';
import { giveQuery } from '../helpers/db.js';
import { applyDetails } from '../../lib/details/applyDetails.js';
import { RuleBasedEvaluator } from '../../lib/evaluation/ruleBasedEvaluator.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const U = 'alice';
const V = 'bob';
const config = defaultEvaluationConfig();

const page = (extra = {}) => ({
  sections: [],
  description: 'Ein nettes Zimmer.',
  costs: [],
  address: {
    raw: 'Teststraße 5 80331 München Altstadt',
    street: 'Teststraße 5',
    postcodeCity: '80331 München Altstadt',
  },
  availableFrom: null,
  availableUntil: null,
  availabilityRaw: null,
  onlineRaw: null,
  onlineMinutes: null,
  wgFacts: [],
  objectFacts: [],
  ...extra,
});

function deps(table = {}) {
  const asked = [];
  return {
    asked,
    contexts: [{ userId: U, evaluator: new RuleBasedEvaluator(config), target: config.target }],
    geocoder: {
      geocode: async (q) => {
        asked.push(q);
        return table[q] ?? null;
      },
    },
    now: NOW,
  };
}

const store = (extra = {}) => {
  storeNewListings(
    [
      {
        providerId: '1',
        link: 'https://www.wg-gesucht.de/x.1.html',
        title: 'Room',
        price: 500,
        size: 15,
        district: 'München Altstadt',
        street: null,
        onlineRaw: 'Online: 5 Minuten',
        onlineMinutes: 5,
        ...extra,
      },
    ],
    SEARCH,
    NOW - 60_000,
  );
  return getListingByProviderId('1');
};

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.reset());

describe('#applyDetails', () => {
  it('stores the details and re-evaluates with the description', async () => {
    const row = store();
    const d = deps();
    const r = await applyDetails(row, page({ description: 'Wir sind eine Studentenverbindung mit Haus.' }), d);
    const after = getListingByProviderId('1');
    expect(after.details_status).toBe('fetched');
    expect(after.description_text).toContain('Studentenverbindung');
    const mine = getUserListing(U, '1');
    expect(mine.excluded_reason).toMatch(/Studentenverbindung/);
    expect(mine.overall_score).toBe(1);
    expect(r).toMatchObject({ excluded: { [U]: expect.stringMatching(/Studentenverbindung/) } });
  });

  it('a harmless description keeps the listing included', async () => {
    const row = store();
    await applyDetails(row, page({ description: 'Gute Verbindung zur U-Bahn.' }), deps());
    expect(getUserListing(U, '1').excluded_reason).toBeNull();
    expect(getUserListing(U, '1').overall_score).not.toBeNull();
  });

  it('geocodes the detail street when the card only gave a district centroid', async () => {
    const row = store();
    updateListingGeo(row.id, {
      lat: 48.14,
      lng: 11.57,
      precision: 'district',
      query: 'Altstadt, München',
      distanceKm: 1,
    });
    const d = deps({ 'Teststraße 5, Altstadt, München': { lat: 48.1371, lng: 11.5754 } });
    const r = await applyDetails(getListingByProviderId('1'), page(), d);
    expect(r.regeocoded).toBe(true);
    expect(d.asked[0]).toBe('Teststraße 5, Altstadt, München');
    expect(getListingByProviderId('1')).toMatchObject({
      geo_precision: 'address',
      geocode_query: 'Teststraße 5, Altstadt, München',
    });
  });

  it('geocodes when the detail street has a house number the card street lacks', async () => {
    const row = store({ street: 'Teststraße' });
    updateListingGeo(row.id, {
      lat: 48.14,
      lng: 11.57,
      precision: 'address',
      query: 'Teststraße, München',
      distanceKm: 1,
    });
    const d = deps({ 'Teststraße 5, Altstadt, München': { lat: 48.1371, lng: 11.5754 } });
    expect((await applyDetails(getListingByProviderId('1'), page(), d)).regeocoded).toBe(true);
  });

  it('does not geocode when the card already had the same address precision', async () => {
    const row = store({ street: 'Teststraße 5' });
    updateListingGeo(row.id, {
      lat: 48.14,
      lng: 11.57,
      precision: 'address',
      query: 'Teststraße 5, München',
      distanceKm: 1,
    });
    const d = deps();
    const r = await applyDetails(getListingByProviderId('1'), page(), d);
    expect(r.regeocoded).toBe(false);
    expect(d.asked).toEqual([]);
  });

  it('keeps the old location when the detail street cannot be found', async () => {
    const row = store();
    updateListingGeo(row.id, {
      lat: 48.14,
      lng: 11.57,
      precision: 'district',
      query: 'Altstadt, München',
      distanceKm: 1,
    });
    await applyDetails(getListingByProviderId('1'), page(), deps());
    expect(getListingByProviderId('1')).toMatchObject({ geo_precision: 'district', lat: 48.14 });
  });

  it('survives a page without an address', async () => {
    const row = store();
    const d = deps();
    await expect(applyDetails(row, page({ address: null }), d)).resolves.toMatchObject({ regeocoded: false });
  });
});

describe('#applyDetails for several users', () => {
  it('stores the page once and re-evaluates it for every user who has the listing, with their own rules', async () => {
    giveQuery(V, SEARCH);
    const row = store();
    const d = deps();
    const lenient = { ...config, exclusions: { keywords: [] } };
    d.contexts.push({ userId: V, evaluator: new RuleBasedEvaluator(lenient), target: lenient.target });
    const r = await applyDetails(row, page({ description: 'Wir sind eine Studentenverbindung mit Haus.' }), d);
    expect(r.excluded).toEqual({ [U]: expect.stringMatching(/Studentenverbindung/), [V]: null });
    expect(getUserListing(U, '1').excluded_reason).toMatch(/Studentenverbindung/);
    expect(getUserListing(V, '1').excluded_reason).toBeNull();
    expect(getListingByProviderId('1').details_status).toBe('fetched');
  });

  it('does not evaluate for users who do not have the listing in their view', async () => {
    const row = store();
    const d = deps();
    d.contexts.push({ userId: V, evaluator: new RuleBasedEvaluator(config), target: config.target }); // bob has no query
    const r = await applyDetails(row, page(), d);
    expect(Object.keys(r.excluded)).toEqual([U]);
    expect(getUserListing(V, '1').evaluated_at).toBeNull();
  });
});
