/**
 * The alert tier of a listing for one user: 'fantastic' (matches their priority rules), 'good' (matches their bulk
 * rules), NULL (neither, or not assessed yet). Computed by lib/notify/tierStorage.js from the user's rules, so it cannot
 * be derived in SQL here: existing rows are filled at startup (backfillTiers) and whenever the rules change.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE user_listings ADD COLUMN tier TEXT;
    CREATE INDEX idx_user_listings_tier ON user_listings (user_id, tier);
  `);
}
