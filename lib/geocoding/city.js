/**
 * The city of a search, so listings of other cities than Munich are geocoded in the right city: the city's name goes
 * into the geocoder queries and the city centre is the point results must be near (plausibility, see locate.js).
 */

/** Munich needs no lookup: it is the default city and its centre is known. */
export const DEFAULT_ANCHOR = { city: 'München', point: { lat: 48.1374, lng: 11.5755 } };

const SPELLINGS = {
  Muenchen: 'München',
  Koeln: 'Köln',
  Nuernberg: 'Nürnberg',
  Duesseldorf: 'Düsseldorf',
  Fuerth: 'Fürth',
  Wuerzburg: 'Würzburg',
  Tuebingen: 'Tübingen',
  Goettingen: 'Göttingen',
  Luebeck: 'Lübeck',
  Saarbruecken: 'Saarbrücken',
  Muenster: 'Münster',
  Luenen: 'Lünen',
};

/**
 * "…/wg-zimmer-in-Frankfurt-am-Main.12.0.1.0.html" -> "Frankfurt am Main". Null when the URL has no city.
 * @param {string|undefined} url
 * @returns {string|null}
 */
export function cityFromSearchUrl(url) {
  let pathname;
  try {
    pathname = new URL(String(url)).pathname;
  } catch {
    return null;
  }
  const match = /-in-([^./]+)\.\d/.exec(pathname);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  return SPELLINGS[slug] ?? slug.replace(/-/g, ' ');
}

/**
 * Resolves the geocoding anchor of a search URL: `{city, point}` where `point` is the city centre (null when it could
 * not be found: no plausibility check then). Other cities than Munich are looked up once per process (the geocoder
 * caches them in the database as well).
 * @param {import('./geocoder.js').Geocoder} geocoder
 */
export function createCityAnchors(geocoder) {
  const known = new Map();
  return {
    /** @param {string|undefined} url */
    async forUrl(url) {
      const city = cityFromSearchUrl(url);
      if (city === null || city === DEFAULT_ANCHOR.city) return DEFAULT_ANCHOR;
      if (!known.has(city)) {
        const point = await geocoder.geocode(`${city}, Deutschland`);
        known.set(city, { city, point: point ?? null });
      }
      return known.get(city);
    },
  };
}
