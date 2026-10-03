import { computePublishedAt } from '../../../../provider/onlineAge.js';

/**
 * published_at   epoch ms: when the ad went online (first_seen_at minus the "Online: ..." age, or the
 *                local midnight of an explicit date); NULL when unknown. Existing rows are backfilled.
 * lat, lng       WGS84 coordinates of the listing (geocoded), NULL when unknown.
 * geo_precision  'address' (street found), 'district' (district centroid fallback) or NULL.
 * distance_km    straight-line (haversine) distance to the evaluation target.
 * geocode_query  the query text that produced lat/lng (for debugging).
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN published_at INTEGER;
    ALTER TABLE listings ADD COLUMN lat REAL;
    ALTER TABLE listings ADD COLUMN lng REAL;
    ALTER TABLE listings ADD COLUMN geo_precision TEXT;
    ALTER TABLE listings ADD COLUMN distance_km REAL;
    ALTER TABLE listings ADD COLUMN geocode_query TEXT;
    CREATE INDEX idx_listings_published_at ON listings (published_at);
  `);
  const update = db.prepare('UPDATE listings SET published_at = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, online_raw, online_minutes, first_seen_at FROM listings').all()) {
    const publishedAt = computePublishedAt(row.online_raw, row.first_seen_at, row.online_minutes);
    if (publishedAt !== null) update.run(publishedAt, row.id);
  }
}
