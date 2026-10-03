import { describe, it, expect } from 'vitest';
import { validateQueryUrl, normalizeQueryUrl, QueryUrlError, MAX_URL_LENGTH } from '../../lib/queries/url.js';

const OK = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';

describe('#validateQueryUrl', () => {
  it.each([
    OK,
    `${OK}?categories%5B%5D=0&rent_types%5B%5D=2&city_id=90&sort_column=3&radLat=48.1&radLng=11.5`,
    'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html',
    'https://www.wg-gesucht.de/wg-zimmer-in-Frankfurt-am-Main.41.0.1.0.html',
    'https://www.wg-gesucht.de/1-zimmer-wohnungen-in-Hamburg.55.1.1.0.html',
    'https://www.wg-gesucht.de/wohnungen-in-Koeln.73.2.1.0.html',
    'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.1.html',
  ])('accepts the WG-Gesucht result page %s', (url) => {
    expect(validateQueryUrl(url)).toBe(normalizeQueryUrl(url));
  });

  it('returns the canonical form (trimmed, fragment dropped, escaped)', () => {
    expect(validateQueryUrl(`  ${OK}#top `)).toBe(OK);
  });

  it.each([
    ['', /URL/],
    ['not a url', /URL/],
    ['http://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html', /https/],
    ['https://wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html', /www\.wg-gesucht\.de/],
    ['https://www.wg-gesucht.com/wg-zimmer-in-Muenchen.90.0.1.0.html', /www\.wg-gesucht\.de/],
    ['https://evil.example/www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html', /www\.wg-gesucht\.de/],
    ['https://www.wg-gesucht.de.evil.example/wg-zimmer-in-Muenchen.90.0.1.0.html', /www\.wg-gesucht\.de/],
    ['https://user:pw@www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html', /credentials/],
    ['https://www.wg-gesucht.de:8443/wg-zimmer-in-Muenchen.90.0.1.0.html', /port/],
    ['https://www.wg-gesucht.de/', /search result/],
    ['https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.9999999.html', /search result/],
    ['https://www.wg-gesucht.de/12345.html', /search result/],
    ['https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.12345678.html', /search result/], // an ad, not a result list
    ['https://www.wg-gesucht.de/mein-konto/profil.html', /search result/],
    ['https://www.wg-gesucht.de/../etc/passwd', /search result/],
    ['javascript:alert(1)', /URL|https/],
    ['file:///etc/passwd', /https/],
  ])('rejects %j', (url, message) => {
    expect(() => validateQueryUrl(url)).toThrow(QueryUrlError);
    expect(() => validateQueryUrl(url)).toThrow(message);
  });

  it('rejects non-strings and absurdly long URLs', () => {
    expect(() => validateQueryUrl(undefined)).toThrow(QueryUrlError);
    expect(() => validateQueryUrl(42)).toThrow(QueryUrlError);
    expect(() => validateQueryUrl(`${OK}?q=${'x'.repeat(MAX_URL_LENGTH)}`)).toThrow(/long/);
  });
});
