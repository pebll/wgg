/**
 * geocode_cache: one row per geocoder query text. found = 0 is a negative result ("Nominatim knows
 * nothing about this query"); transient errors are never stored. created_at is epoch ms.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE geocode_cache (
      query TEXT PRIMARY KEY,
      found INTEGER NOT NULL,
      lat REAL,
      lng REAL,
      created_at INTEGER NOT NULL
    );
  `);
}
