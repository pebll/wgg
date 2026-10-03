/**
 * Evaluation + notification fields, all nullable: listings stay "not evaluated" / "not notified"
 * until the scoring and notification phases fill them in.
 *
 * scores_json   {"<parameter>": 1-10}
 * details_json  {"<parameter>": "reason"}
 * missing_json  ["<field the scorer could not read>"]
 * Timestamps are epoch ms, like first_seen_at.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN overall_score REAL;
    ALTER TABLE listings ADD COLUMN scores_json TEXT;
    ALTER TABLE listings ADD COLUMN details_json TEXT;
    ALTER TABLE listings ADD COLUMN missing_json TEXT;
    ALTER TABLE listings ADD COLUMN excluded_reason TEXT;
    ALTER TABLE listings ADD COLUMN evaluated_at INTEGER;
    ALTER TABLE listings ADD COLUMN notified_at INTEGER;
  `);
}
