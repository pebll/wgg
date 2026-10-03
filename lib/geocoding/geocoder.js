/**
 * A geocoder turns a free-text place query into coordinates.
 *
 * Contract: `geocode(query)` resolves to `{lat, lng}` (WGS84) or `null` when the place is unknown or
 * the lookup failed. It never rejects. Implementations own their rate limiting and caching, so
 * callers may simply await it in a loop. The only implementation today is Nominatim
 * (see ./nominatim.js); a different provider only needs to satisfy this typedef.
 *
 * @typedef {object} Geocoder
 * @property {(query: string) => Promise<{lat: number, lng: number}|null>} geocode
 */

export {};
