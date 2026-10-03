import { describe, it, expect } from 'vitest';
import { buildQueries, locateListing } from '../../lib/geocoding/locate.js';

const TARGET = { lat: 48.1488833, lng: 11.5677668 };

const fakeGeocoder = (table) => {
  const asked = [];
  return {
    asked,
    geocode: async (q) => {
      asked.push(q);
      return table[q] ?? null;
    },
  };
};

describe('#buildQueries', () => {
  it('builds street and district queries, dropping the München prefix duplication', () => {
    expect(buildQueries({ street: 'Königinstraße 49', district: 'München Maxvorstadt' })).toEqual({
      street: ['Königinstraße 49, Maxvorstadt, München', 'Königinstraße 49, München'],
      district: 'Maxvorstadt, München',
    });
  });

  it('expands Str. and drops placeholder house number 00', () => {
    expect(buildQueries({ street: 'Grünwalderstr. 119', district: 'München Giesing' }).street[1]).toBe(
      'Grünwalderstraße 119, München',
    );
    expect(buildQueries({ street: 'Stockdorfer Str. 1', district: 'München X' }).street[1]).toBe(
      'Stockdorfer Straße 1, München',
    );
    expect(buildQueries({ street: 'Adams-Lehmann 00', district: 'München Schwabing-West' }).street[1]).toBe(
      'Adams-Lehmann, München',
    );
  });

  it('handles truncated districts and the bare city', () => {
    const q = buildQueries({ street: 'Irmgardstraße', district: 'München Thalkirchen-Obersendling-...' });
    expect(q.district).toBe('Thalkirchen-Obersendling, München');
    expect(q.street).toEqual(['Irmgardstraße, München']);
    expect(buildQueries({ street: 'Maxhofstraße', district: 'München' })).toEqual({
      street: ['Maxhofstraße, München'],
      district: null,
    });
    expect(buildQueries({ street: null, district: null })).toEqual({ street: [], district: null });
  });
});

describe('#locateListing', () => {
  it('returns address precision with distance when the street is found', async () => {
    const g = fakeGeocoder({ 'Königinstraße 49, Maxvorstadt, München': { lat: 48.1555, lng: 11.5903 } });
    const r = await locateListing(
      { street: 'Königinstraße 49', district: 'München Maxvorstadt' },
      { geocoder: g, target: TARGET },
    );
    expect(r).toMatchObject({
      precision: 'address',
      lat: 48.1555,
      lng: 11.5903,
      query: 'Königinstraße 49, Maxvorstadt, München',
    });
    expect(r.distanceKm).toBeGreaterThan(1.5);
    expect(r.distanceKm).toBeLessThan(2.1);
    expect(g.asked).toHaveLength(1);
  });

  it('tries the street without district, then falls back to the district centroid', async () => {
    const g = fakeGeocoder({ 'Giesingstr, München': null, 'Giesing, München': { lat: 48.12, lng: 11.57 } });
    const r = await locateListing(
      { street: 'Giesingstr', district: 'München Giesing' },
      { geocoder: g, target: TARGET },
    );
    expect(r.precision).toBe('district');
    expect(r.query).toBe('Giesing, München');
    expect(g.asked).toEqual(['Giesingstr, Giesing, München', 'Giesingstr, München', 'Giesing, München']);
  });

  it('is missing (null) when only the city is known and the street is not found', async () => {
    const g = fakeGeocoder({});
    expect(await locateListing({ street: 'Nope', district: 'München' }, { geocoder: g, target: TARGET })).toBeNull();
    expect(await locateListing({ street: null, district: null }, { geocoder: g, target: TARGET })).toBeNull();
  });

  it('rejects results implausibly far from the target (wrong city)', async () => {
    const g = fakeGeocoder({ 'Hauptstraße, München': { lat: 52.5, lng: 13.4 } });
    expect(
      await locateListing({ street: 'Hauptstraße', district: 'München' }, { geocoder: g, target: TARGET }),
    ).toBeNull();
  });
});
