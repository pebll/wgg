/**
 * AI rows of listings whose details were skipped (too old) or failed stayed 'pending' for ever: no description comes,
 * so the AI check can never run. Mark them skipped ("no description"); they are queued again when details arrive.
 */
export function up(db) {
  db.exec(`
    UPDATE user_listings SET llm_status = 'skipped', llm_error = 'no description'
    WHERE llm_status = 'pending'
      AND listing_id IN (SELECT id FROM listings WHERE details_status IN ('failed', 'skipped'));
  `);
}
