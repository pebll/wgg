/**
 * The send schedule of email alerts: the last digest slot a user's tier went out in (epoch ms of the slot start, see
 * ui/src/services/schedule.js). Claimed before sending, so a restart or a second process never sends a slot twice.
 * `tier` is the stored kind: 'bulk' (Good digests; Fantastic needs no slot, its waiting offers are simply unmarked).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE notify_schedule (
      user_id TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('priority', 'bulk')),
      last_slot_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tier)
    );
  `);
}
