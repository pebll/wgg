/**
 * One hiding mechanism for "the user is not interested" and "the program found it too bad" (an exclusion). The
 * timestamp stays in `dismissed_at` (migration 6): NULL = visible, otherwise hidden.
 *
 * hidden_by       'user' (the "Not interested" button) | 'program' (an exclusion: keyword, rent, LLM Verbindung, or
 *                 the optional autoHide score limit); NULL while visible.
 * hidden_reason   shown next to the hidden offer: "Not interested" or the exclusion reason.
 * hide_override   1 once the user restored the offer: the program never hides it again.
 *
 * Existing data: dismissed rows become hidden by the user; excluded rows that are still visible become hidden by the
 * program (the evaluation already said they are not wanted).
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN hidden_by TEXT CHECK (hidden_by IN ('user', 'program'));
    ALTER TABLE listings ADD COLUMN hidden_reason TEXT;
    ALTER TABLE listings ADD COLUMN hide_override INTEGER NOT NULL DEFAULT 0;
    UPDATE listings SET hidden_by = 'user', hidden_reason = 'Not interested' WHERE dismissed_at IS NOT NULL;
    UPDATE listings
      SET dismissed_at = COALESCE(evaluated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
          hidden_by = 'program',
          hidden_reason = excluded_reason
      WHERE dismissed_at IS NULL AND excluded_reason IS NOT NULL;
  `);
}
