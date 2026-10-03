/**
 * When each search URL was last fetched (epoch ms). With more distinct enabled URLs than `queries.maxDistinctPerCycle`
 * the scheduler fetches the longest-waiting ones first, so every URL gets its turn across cycles (round robin).
 */
export function up(db) {
  db.exec(`CREATE TABLE query_fetches (url TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL);`);
}
