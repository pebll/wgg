import { haversineKm } from './distance.js';

/** Results further than this from the target are treated as a wrong-city match. */
export const MAX_PLAUSIBLE_KM = 60;

const DEFAULT_CITY = 'München';

function cleanStreet(street) {
  return street
    .replace(/(?<=\p{L})str\./gu, 'straße')
    .replace(/\bStr\./g, 'Straße')
    .replace(/\s+0+$/, '') // WG-Gesucht shows "00" when the advertiser hid the house number
    .replace(/\s+/g, ' ')
    .trim();
}

const cityPrefix = (city) => new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s-]*`, 'u');

function cleanDistrict(district, city = DEFAULT_CITY) {
  const trimmed = (district ?? '').trim();
  if (trimmed === '') return { name: null, truncated: false };
  // "München Maxvorstadt" -> "Maxvorstadt"; the bare city carries no information.
  const name = trimmed.replace(cityPrefix(city), '');
  const truncated = /(\.{3}|…)$/.test(name);
  const clean = name.replace(/[-\s]*(\.{3}|…)$/, '').trim();
  return { name: clean === '' ? null : clean, truncated };
}

/**
 * Geocoder queries for a listing, most specific first.
 * street:   "<street>, <district>, München" (skipped when the district is missing or truncated by
 *           WG-Gesucht), then "<street>, München".
 * district: "<district>, München" centroid fallback, null when only the bare city is known.
 *
 * @param {{street?: string|null, district?: string|null}} listing
 * @param {string} [city] The city of the search (default München); the geocoder is told which city a street is in.
 * @returns {{street: string[], district: string|null}}
 */
export function buildQueries({ street, district }, city = DEFAULT_CITY) {
  const d = cleanDistrict(district, city);
  const s = street && street.trim() !== '' ? cleanStreet(street) : null;
  const streetQueries = [];
  if (s) {
    if (d.name && !d.truncated) streetQueries.push(`${s}, ${d.name}, ${city}`);
    streetQueries.push(`${s}, ${city}`);
  }
  return { street: streetQueries, district: d.name ? `${d.name}, ${city}` : null };
}

/**
 * Finds coordinates and the distance to the target for a listing. Never guesses silently: the
 * precision says whether the street ('address') or only the district centroid ('district') was
 * found; null means unknown.
 *
 * @param {{street?: string|null, district?: string|null}} listing
 * @param {{geocoder: import('./geocoder.js').Geocoder, target?: {lat: number, lng: number}|null, city?: string,
 *   maxPlausibleKm?: number}} options `target` is the point results must be near (the city's centre; without one no
 *   plausibility check is made and `distanceKm` is null); `city` names the city in the queries.
 * @returns {Promise<{lat: number, lng: number, precision: 'address'|'district', query: string, distanceKm: number|null}|null>}
 */
export async function locateListing(
  listing,
  { geocoder, target, city = DEFAULT_CITY, maxPlausibleKm = MAX_PLAUSIBLE_KM },
) {
  const queries = buildQueries(listing, city);
  const attempts = [
    ...queries.street.map((query) => ({ query, precision: 'address' })),
    ...(queries.district ? [{ query: queries.district, precision: 'district' }] : []),
  ];
  for (const { query, precision } of attempts) {
    const point = await geocoder.geocode(query);
    if (!point) continue;
    const distanceKm = target ? haversineKm(target, point) : null;
    if (distanceKm !== null && distanceKm > maxPlausibleKm) continue;
    return { lat: point.lat, lng: point.lng, precision, query, distanceKm };
  }
  return null;
}
