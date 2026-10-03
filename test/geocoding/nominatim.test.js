import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { createNominatimGeocoder, buildUserAgent } from '../../lib/geocoding/nominatim.js';
import { createSqliteGeocodeCache } from '../../lib/geocoding/cache.js';
import { haversineKm } from '../../lib/geocoding/distance.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function harness(responder, options = {}) {
  const calls = [];
  const sleeps = [];
  let clock = 1_000_000;
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init, at: clock });
    return responder(new URL(url), calls.length);
  };
  const geocoder = createNominatimGeocoder({
    fetchImpl,
    userAgent: 'wgg/test',
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...options,
  });
  return { geocoder, calls, sleeps, tick: (ms) => (clock += ms) };
}

describe('#haversineKm', () => {
  it('is zero for identical points and plausible for Munich', () => {
    expect(haversineKm({ lat: 48.1, lng: 11.5 }, { lat: 48.1, lng: 11.5 })).toBe(0);
    // TUM library to Marienplatz is roughly 1.7 km.
    const d = haversineKm({ lat: 48.1488833, lng: 11.5677668 }, { lat: 48.1374, lng: 11.5755 });
    expect(d).toBeGreaterThan(1.2);
    expect(d).toBeLessThan(1.6);
  });
});

describe('#buildUserAgent', () => {
  it('identifies wgg with its version', () => {
    expect(buildUserAgent('0.1.0')).toBe('wgg/0.1.0 (private self-hosted)');
  });
});

describe('#createNominatimGeocoder', () => {
  it('sends the documented query parameters and a User-Agent, and parses lat/lng', async () => {
    const { geocoder, calls } = harness(() => ok([{ lat: '48.15', lon: '11.57' }]));
    expect(await geocoder.geocode('Arcisstraße 21, München')).toEqual({ lat: 48.15, lng: 11.57 });
    const { url, init } = calls[0];
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Arcisstraße 21, München',
      format: 'jsonv2',
      limit: '1',
      countrycodes: 'de',
      'accept-language': 'de',
    });
    expect(init.headers['User-Agent']).toBe('wgg/test');
  });

  it('adds the email parameter only when configured', async () => {
    const { geocoder, calls } = harness(() => ok([]), { email: 'me@example.org' });
    await geocoder.geocode('x');
    expect(calls[0].url.searchParams.get('email')).toBe('me@example.org');
  });

  it('serializes requests with at least 1100 ms between them, even when called concurrently', async () => {
    const { geocoder, calls } = harness(() => ok([{ lat: '1', lon: '2' }]));
    await Promise.all([geocoder.geocode('a'), geocoder.geocode('b'), geocoder.geocode('c')]);
    expect(calls).toHaveLength(3);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(1100);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(1100);
  });

  it('returns null for "not found" and for errors, never throwing', async () => {
    const empty = harness(() => ok([]));
    expect(await empty.geocoder.geocode('nowhere')).toBeNull();
    const http = harness(() => ({ ok: false, status: 429, json: async () => ({}) }));
    expect(await http.geocoder.geocode('x')).toBeNull();
    const boom = harness(() => {
      throw new Error('network down');
    });
    expect(await boom.geocoder.geocode('x')).toBeNull();
    const bad = harness(() => ok([{ lat: 'abc', lon: 'def' }]));
    expect(await bad.geocoder.geocode('x')).toBeNull();
  });

  it('aborts a hanging request after the timeout', async () => {
    const { geocoder } = harness(
      () => new Promise(() => {}), // never resolves
      { timeoutMs: 20 },
    );
    expect(await geocoder.geocode('x')).toBeNull();
  });
});

describe('#geocode cache', () => {
  beforeEach(async () => {
    Db.reset();
    Db.init(':memory:');
    await runMigrations();
  });
  afterEach(() => Db.reset());

  it('serves repeated queries from the cache, including negative results', async () => {
    const cache = createSqliteGeocodeCache();
    const { geocoder, calls } = harness(
      (url) => (url.searchParams.get('q') === 'hit' ? ok([{ lat: '1', lon: '2' }]) : ok([])),
      {
        cache,
      },
    );
    expect(await geocoder.geocode('hit')).toEqual({ lat: 1, lng: 2 });
    expect(await geocoder.geocode('hit')).toEqual({ lat: 1, lng: 2 });
    expect(await geocoder.geocode('miss')).toBeNull();
    expect(await geocoder.geocode('miss')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('does not cache errors as negative results', async () => {
    const cache = createSqliteGeocodeCache();
    let fail = true;
    const { geocoder, calls } = harness(
      () => {
        if (fail) throw new Error('down');
        return ok([{ lat: '1', lon: '2' }]);
      },
      { cache },
    );
    expect(await geocoder.geocode('q')).toBeNull();
    fail = false;
    expect(await geocoder.geocode('q')).toEqual({ lat: 1, lng: 2 });
    expect(calls).toHaveLength(2);
  });

  it('retryNegatives re-asks previously unknown queries but still uses positives', async () => {
    const cache = createSqliteGeocodeCache();
    cache.set('old-miss', null);
    cache.set('old-hit', { lat: 5, lng: 6 });
    const { geocoder, calls } = harness(() => ok([{ lat: '1', lon: '2' }]), { cache, retryNegatives: true });
    expect(await geocoder.geocode('old-hit')).toEqual({ lat: 5, lng: 6 });
    expect(await geocoder.geocode('old-miss')).toEqual({ lat: 1, lng: 2 });
    expect(calls).toHaveLength(1);
  });
});
