/**
 * Email alert state (Phase 5). `notified_at` exists since migration 2: NULL = not announced yet. Timestamps are epoch ms.
 *
 * notified_kind     'priority' (single email right after the AI assessment) | 'bulk' (part of a digest); NULL while
 *                   not announced.
 * notify_error      message of the last failed send (never contains secrets); NULL after a successful send.
 * notify_attempts   failed sends so far; the notifier gives up after 3.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN notified_kind TEXT CHECK (notified_kind IN ('priority', 'bulk'));
    ALTER TABLE listings ADD COLUMN notify_error TEXT;
    ALTER TABLE listings ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;
  `);
}
