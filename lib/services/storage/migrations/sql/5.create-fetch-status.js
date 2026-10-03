/**
 * fetch_runs: one row per scrape cycle (finished_at NULL while it runs). All timestamps are epoch ms.
 * scheduler_state: single row (id = 1) written by the `wgg run` scheduler: when the next cycle is
 * planned and whether it is delayed by backoff. SQLite (not memory) so `wgg serve` can read it too.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE fetch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      new_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      bot_detected INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_fetch_at INTEGER,
      backoff INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
}
