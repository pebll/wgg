/**
 * dismissed_at  epoch ms: the user flagged the offer "not interested". NULL = visible. Dismissed rows are
 *               never deleted: they stay hidden (undo possible) and keep the offer from being notified again.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN dismissed_at INTEGER;
    CREATE INDEX idx_listings_dismissed_at ON listings (dismissed_at);
  `);
}
