import Db from '../services/storage/Db.js';

/**
 * SQLite-backed geocode cache (table geocode_cache). Both hits and "looked, found nothing" results
 * are stored, so repeated queries never hit the network again.
 *
 * @typedef {object} GeocodeCache
 * @property {(query: string) => ({lat: number, lng: number}|null|undefined)} get
 *   undefined = never asked, null = asked and not found, object = found.
 * @property {(query: string, result: {lat: number, lng: number}|null) => void} set
 */

/** @returns {GeocodeCache} */
export function createSqliteGeocodeCache(now = () => Date.now()) {
  return {
    get(query) {
      const row = Db.getConnection().prepare('SELECT found, lat, lng FROM geocode_cache WHERE query = ?').get(query);
      if (!row) return undefined;
      return row.found === 1 ? { lat: row.lat, lng: row.lng } : null;
    },
    set(query, result) {
      Db.execute(
        `INSERT INTO geocode_cache (query, found, lat, lng, created_at) VALUES (@query, @found, @lat, @lng, @now)
         ON CONFLICT(query) DO UPDATE SET found = @found, lat = @lat, lng = @lng, created_at = @now`,
        { query, found: result ? 1 : 0, lat: result?.lat ?? null, lng: result?.lng ?? null, now: now() },
      );
    },
  };
}
