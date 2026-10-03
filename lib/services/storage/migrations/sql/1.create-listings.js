/**
 * listings: one row per WG-Gesucht ad, identified by the card's data-id (provider_id).
 * Raw scraped strings are kept next to the parsed values so parsing can be fixed later.
 * Scores / notified_at are intentionally NOT here; later phases add them with their own
 * migration (nullable ALTER TABLE ... ADD COLUMN).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL UNIQUE,
      search_url TEXT NOT NULL,
      link TEXT NOT NULL,
      title TEXT,
      image TEXT,
      price REAL,
      price_raw TEXT,
      size REAL,
      size_raw TEXT,
      wg_size INTEGER,
      flatmates_raw TEXT,
      district TEXT,
      street TEXT,
      details_raw TEXT,
      available_from TEXT,
      available_until TEXT,
      availability_raw TEXT,
      online_raw TEXT,
      online_minutes INTEGER,
      first_seen_at INTEGER NOT NULL
    );
    CREATE INDEX idx_listings_first_seen_at ON listings (first_seen_at);
  `);
}
