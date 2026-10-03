import { describe, it, expect } from 'vitest';
import { cityFromSearchUrl, createCityAnchors, DEFAULT_ANCHOR } from '../../lib/geocoding/city.js';

describe('#cityFromSearchUrl', () => {
  it.each([
    ['https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html?x=1', 'München'],
    ['https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html', 'Berlin'],
    ['https://www.wg-gesucht.de/wg-zimmer-in-Frankfurt-am-Main.12.0.1.0.html', 'Frankfurt am Main'],
    ['https://www.wg-gesucht.de/wg-zimmer-in-Koeln.73.0.1.0.html', 'Köln'],
    ['https://www.wg-gesucht.de/1-zimmer-wohnungen-in-Hamburg.55.1.1.0.html', 'Hamburg'],
  ])('%s -> %s', (url, city) => {
    expect(cityFromSearchUrl(url)).toBe(city);
  });

  it('is null when no city can be read', () => {
    expect(cityFromSearchUrl('https://www.wg-gesucht.de/')).toBeNull();
    expect(cityFromSearchUrl('not a url')).toBeNull();
    expect(cityFromSearchUrl(undefined)).toBeNull();
  });
});

describe('#createCityAnchors', () => {
  it('München needs no lookup; other cities are geocoded once and remembered', async () => {
    const calls = [];
    const geocoder = {
      geocode: async (q) => {
        calls.push(q);
        return q.startsWith('Berlin') ? { lat: 52.52, lng: 13.4 } : null;
      },
    };
    const anchors = createCityAnchors(geocoder);
    expect(await anchors.forUrl('https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html')).toEqual(
      DEFAULT_ANCHOR,
    );
    expect(calls).toEqual([]);
    const berlin = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';
    expect(await anchors.forUrl(berlin)).toMatchObject({ city: 'Berlin', point: { lat: 52.52, lng: 13.4 } });
    await anchors.forUrl(berlin);
    expect(calls).toEqual(['Berlin, Deutschland']);
  });

  it('an unknown city yields no point (no plausibility check) but still names the city', async () => {
    const anchors = createCityAnchors({ geocode: async () => null });
    expect(await anchors.forUrl('https://www.wg-gesucht.de/wg-zimmer-in-Nirgendwo.1.0.1.0.html')).toEqual({
      city: 'Nirgendwo',
      point: null,
    });
    expect(await anchors.forUrl(undefined)).toEqual(DEFAULT_ANCHOR);
  });
});
