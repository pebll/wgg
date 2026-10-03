import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  getUserListing,
  queryListings,
  recordLlmResult,
} from '../../lib/services/listings/listingsStorage.js';
import { evaluateNewListings, evaluateStoredListings, evaluatePending } from '../../lib/evaluation/pipeline.js';
import { RuleBasedEvaluator } from '../../lib/evaluation/ruleBasedEvaluator.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { runScrapeCycle } from '../../lib/scraper/scrapeCycle.js';
import { giveQuery } from '../helpers/db.js';

const SEARCH = 'https://www.wg-gesucht.de/x.html';
const BERLIN = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const config = defaultEvaluationConfig();
const U = 'alice';
const V = 'bob';

const listing = (id, extra = {}) => ({
  providerId: String(id),
  link: `https://www.wg-gesucht.de/x.${id}.html`,
  title: `Room ${id}`,
  price: 500,
  size: 15,
  district: 'München Maxvorstadt',
  street: `Straße${id} 1`,
  onlineRaw: 'Online: 5 Minuten',
  onlineMinutes: 5,
  ...extra,
});

const context = (userId, over = {}) => {
  const cfg = { ...config, ...over };
  return { userId, evaluator: new RuleBasedEvaluator(cfg), target: cfg.target };
};

const makeDeps = (table = {}, extra = {}) => {
  const asked = [];
  return {
    asked,
    contexts: [context(U)],
    geocoder: {
      geocode: async (q) => {
        asked.push(q);
        return table[q] ?? null;
      },
    },
    now: NOW,
    ...extra,
  };
};

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.reset());

describe('#evaluateStoredListings', () => {
  it('geocodes, evaluates and stores everything: the place on the listing, the evaluation on the user row', async () => {
    storeNewListings([listing(1), listing(2, { street: null, district: 'München' })], SEARCH, NOW - 60_000);
    const deps = makeDeps({ 'Straße1 1, Maxvorstadt, München': { lat: 48.1555, lng: 11.5903 } });
    const stats = await evaluateStoredListings({ ...deps, all: true });
    expect(stats).toEqual({ evaluated: 2, geocoded: 2, failed: 0 });

    const place = getListingByProviderId('1');
    expect(place.geo_precision).toBe('address');
    expect(place.geocode_query).toBe('Straße1 1, Maxvorstadt, München');
    const a = getUserListing(U, '1');
    expect(a.distance_km).toBeGreaterThan(1);
    expect(a.overall_score).toBeGreaterThan(1);
    expect(JSON.parse(a.scores_json)).toHaveProperty('distance');
    expect(a.evaluated_at).toBe(NOW);

    expect(getListingByProviderId('2').lat).toBeNull(); // no location at all
    const b = getUserListing(U, '2');
    expect(b.geo_precision).toBeNull();
    expect(JSON.parse(b.missing_json)).toContain('distance');
    expect(b.overall_score).not.toBeNull();
  });

  it('only evaluates unevaluated rows without --all, and only geocodes rows without geo data', async () => {
    storeNewListings([listing(1), listing(2)], SEARCH, NOW);
    const first = makeDeps({ 'Straße1 1, Maxvorstadt, München': { lat: 48.15, lng: 11.57 } });
    await evaluateStoredListings({ ...first, all: false });
    first.asked.length = 0;

    storeNewListings([listing(3)], SEARCH, NOW);
    expect(await evaluateStoredListings({ ...first, all: false })).toMatchObject({ evaluated: 1, geocoded: 1 });

    first.asked.length = 0;
    // --all: re-evaluates everything; row 1 has geo data (not asked again), rows without geo are retried.
    const stats = await evaluateStoredListings({ ...first, all: true });
    expect(stats.evaluated).toBe(3);
    expect(first.asked.some((q) => q.startsWith('Straße1 1'))).toBe(false);
    expect(first.asked.some((q) => q.startsWith('Straße2 1'))).toBe(true);
  });

  it('--regeocode asks the geocoder again for every row', async () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    const deps = makeDeps({ 'Straße1 1, Maxvorstadt, München': { lat: 48.15, lng: 11.57 } });
    await evaluateStoredListings({ ...deps, all: true });
    deps.asked.length = 0;
    await evaluateStoredListings({ ...deps, all: true, regeocode: true });
    expect(deps.asked).toEqual(['Straße1 1, Maxvorstadt, München']);
  });

  it('recomputes recency at evaluation time', async () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    const deps = makeDeps();
    await evaluateStoredListings({ ...deps, all: true });
    const fresh = JSON.parse(getUserListing(U, '1').scores_json).recency;
    await evaluateStoredListings({ ...deps, all: true, now: NOW + 48 * 3_600_000 });
    expect(JSON.parse(getUserListing(U, '1').scores_json).recency).toBeLessThan(fresh);
  });

  it('keeps going and counts a failing row', async () => {
    storeNewListings([listing(1), listing(2)], SEARCH, NOW);
    const deps = makeDeps();
    deps.contexts[0].evaluator = {
      name: 'boom',
      evaluate: (l) => {
        if (l.title === 'Room 1') throw new Error('bad');
        return { scores: {}, overall: null, missing: [], details: {} };
      },
    };
    expect(await evaluateStoredListings({ ...deps, all: true })).toMatchObject({ evaluated: 1, failed: 1 });
  });

  it('accepts the contexts as a function (read again for every run, so saved settings apply)', async () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    let calls = 0;
    const deps = makeDeps({}, { contexts: () => (calls++, [context(U)]) });
    await evaluateStoredListings({ ...deps, all: true });
    expect(calls).toBeGreaterThan(0);
  });
});

describe('#evaluation for several users', () => {
  const MUNICH = { lat: 48.1555, lng: 11.5903 };
  beforeEach(() => {
    giveQuery(V, SEARCH);
  });

  it("geocodes a listing once for everybody and computes each user's distance to their own target", async () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    const near = context(U); // default target: TUM library
    const far = context(V, { target: { name: 'Garching', lat: 48.2649, lng: 11.6711 } });
    const deps = makeDeps({ 'Straße1 1, Maxvorstadt, München': MUNICH }, { contexts: [near, far] });
    const stats = await evaluateStoredListings({ ...deps, all: true });
    expect(stats).toEqual({ evaluated: 2, geocoded: 1, failed: 0 });
    expect(deps.asked).toEqual(['Straße1 1, Maxvorstadt, München']);
    const dNear = getUserListing(U, '1').distance_km;
    const dFar = getUserListing(V, '1').distance_km;
    expect(dNear).toBeLessThan(3);
    expect(dFar).toBeGreaterThan(10);
    expect(JSON.parse(getUserListing(U, '1').scores_json).distance).toBeGreaterThan(
      JSON.parse(getUserListing(V, '1').scores_json).distance,
    );
  });

  it("applies each user's own rules: a keyword excludes the listing only for the user who listed it", async () => {
    storeNewListings([listing(1, { title: 'Corps-Haus Zimmer' })], SEARCH, NOW);
    const strict = context(U, { exclusions: { keywords: ['Corps'] } });
    const relaxed = context(V, { exclusions: { keywords: ['Burschenschaft'] } });
    await evaluateStoredListings({ ...makeDeps({}, { contexts: [strict, relaxed] }), all: true });
    expect(getUserListing(U, '1').excluded_reason).toMatch(/Corps/);
    expect(getUserListing(V, '1').excluded_reason).toBeNull();
    expect(queryListings(U, {}, NOW).items.map((i) => i.providerId)).toEqual([]);
    expect(queryListings(V, {}, NOW).items.map((i) => i.providerId)).toEqual(['1']);
  });

  it("evaluates only what is in a user's view", async () => {
    const other = 'https://www.wg-gesucht.de/y.html';
    giveQuery(V, other);
    Db.execute('DELETE FROM user_queries WHERE user_id = ? AND url = ?', [V, SEARCH]);
    storeNewListings([listing(1)], SEARCH, NOW); // only alice's search finds it
    storeNewListings([listing(2)], other, NOW);
    const stats = await evaluateStoredListings({ ...makeDeps({}, { contexts: [context(U), context(V)] }), all: true });
    expect(stats.evaluated).toBe(2);
    expect(getUserListing(V, '1').evaluated_at).toBeNull();
    expect(getUserListing(U, '2').evaluated_at).toBeNull();
    expect(getUserListing(V, '2').evaluated_at).toBe(NOW);
  });

  it("evaluatePending also catches a listing that came into a user's view later (a new query)", async () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    await evaluatePending(makeDeps());
    expect(getUserListing(U, '1').evaluated_at).toBe(NOW);
    // bob adds the same search later: the listing is new for him although it was stored long ago
    const stats = await evaluatePending(makeDeps({}, { contexts: [context(U), context(V)] }));
    expect(stats.evaluated).toBe(1);
    expect(getUserListing(V, '1').evaluated_at).toBe(NOW);
  });
});

describe('#geocoding other cities', () => {
  it("asks for the street in the search's city and checks plausibility against that city, not Munich", async () => {
    giveQuery(U, BERLIN);
    storeNewListings([listing(1, { district: 'Berlin Mitte', street: 'Torstraße 1' })], BERLIN, NOW);
    const table = {
      'Berlin, Deutschland': { lat: 52.52, lng: 13.405 },
      'Torstraße 1, Mitte, Berlin': { lat: 52.529, lng: 13.402 },
    };
    const deps = makeDeps(table);
    await evaluateStoredListings({ ...deps, all: true });
    expect(deps.asked).toEqual(['Berlin, Deutschland', 'Torstraße 1, Mitte, Berlin']);
    expect(getListingByProviderId('1')).toMatchObject({ geo_precision: 'address', lat: 52.529 });
  });

  it("drops a result far from the search's city (wrong-city match)", async () => {
    giveQuery(U, BERLIN);
    storeNewListings([listing(1, { district: 'Berlin Mitte', street: 'Hauptstraße 1' })], BERLIN, NOW);
    const table = {
      'Berlin, Deutschland': { lat: 52.52, lng: 13.405 },
      'Hauptstraße 1, Mitte, Berlin': { lat: 48.1, lng: 11.5 }, // Munich
    };
    await evaluateStoredListings({ ...makeDeps(table), all: true });
    expect(getListingByProviderId('1').lat).toBeNull();
  });
});

describe('#evaluateNewListings and the scrape cycle', () => {
  it('evaluates only the given listings', async () => {
    storeNewListings([listing(1), listing(2)], SEARCH, NOW);
    await evaluateNewListings([{ providerId: '2' }], makeDeps());
    expect(getUserListing(U, '1').evaluated_at).toBeNull();
    expect(getUserListing(U, '2').evaluated_at).toBe(NOW);
  });

  it('runScrapeCycle enriches new listings and survives an enrich failure', async () => {
    const calls = [];
    const html = (await import('fs')).readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');
    const result = await runScrapeCycle({
      config: { searches: [{ name: 'A', url: SEARCH }], schedule: { delayBetweenSearchesSeconds: [0, 0] } },
      fetchHtml: async () => html,
      enrich: async (fresh) => {
        calls.push(fresh.length);
        throw new Error('geocoder exploded');
      },
    });
    expect(calls).toEqual([28]);
    expect(result.newListings).toHaveLength(28);
    expect(result.errors).toEqual([]);
  });

  it('runScrapeCycle fetches the searches it is given (a function is read when the cycle starts)', async () => {
    const asked = [];
    const result = await runScrapeCycle({
      config: {
        searches: [{ name: 'ignored', url: 'https://www.wg-gesucht.de/ignored.html' }],
        schedule: { delayBetweenSearchesSeconds: [0, 0] },
      },
      searches: () => [
        { name: 'A', url: SEARCH },
        { name: 'B', url: BERLIN },
      ],
      fetchHtml: async (url) => {
        asked.push(url);
        return '<html></html>';
      },
      sleep: async () => {},
    });
    expect(asked.map((u) => u.split('?')[0])).toEqual([SEARCH, BERLIN]);
    expect(result.searchesRun).toBe(2);
  });

  it('evaluated rows reach the API payload', async () => {
    storeNewListings([listing(1)], SEARCH, Date.now());
    await evaluateStoredListings({
      ...makeDeps({ 'Straße1 1, Maxvorstadt, München': { lat: 48.15, lng: 11.57 } }),
      now: Date.now(),
      all: true,
    });
    const [item] = queryListings(U, { maxAgeDays: 3, sort: 'overall' }).items;
    expect(item.evaluation.overall).toBeGreaterThan(1);
    expect(item.geoPrecision).toBe('address');
    expect(item.distanceKm).toBeGreaterThan(0);
  });
});

describe('#tier after evaluation', () => {
  it('recomputes the tier of the evaluated row from the user notify rules and the stored assessment', async () => {
    storeNewListings([listing(1)], SEARCH, NOW);
    const id = getListingByProviderId('1').id;
    recordLlmResult(
      U,
      id,
      {
        verbindungProbability: 0.1,
        verbindungSignals: [],
        fitScore: 9,
        summary: 'Nice.',
        positives: [],
        redFlags: [],
        eligible: true,
        settingsHash: 'h1',
        promptVersion: 1,
      },
      NOW,
    );
    const notify = { priority: { rules: [{ ai: { gt: 8 } }] }, bulk: { rules: [] } };
    const ctx = { ...context(U), settings: { notify }, llmHash: 'h1' };
    await evaluateStoredListings({ ...makeDeps({}, { contexts: [ctx] }), all: true });
    expect(getUserListing(U, '1').tier).toBe('fantastic');
    const stale = { ...ctx, llmHash: 'other' };
    await evaluateStoredListings({ ...makeDeps({}, { contexts: [stale] }), all: true });
    expect(getUserListing(U, '1').tier).toBeNull();
  });
});
