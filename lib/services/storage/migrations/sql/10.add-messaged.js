/**
 * "Messaged": the user already contacted the advertiser. The offer is hidden through the normal mechanism
 * (hidden_by 'user', hidden_reason 'Messaged'); `messaged_at` (epoch ms) additionally keeps it identifiable when it
 * is restored later. NULL = never marked as messaged.
 */
export function up(db) {
  db.exec(`ALTER TABLE listings ADD COLUMN messaged_at INTEGER;`);
}
