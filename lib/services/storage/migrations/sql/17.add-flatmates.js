/**
 * The flatmates of a listing (WG-Gesucht's "3er WG (1w,1m,0d,0n)" title): JSON of {wgSize, female, male, diverse,
 * unspecified, raw}, NULL while unknown. Rows stored earlier get it when a search card or the detail page shows it.
 */
export function up(db) {
  db.exec(`ALTER TABLE listings ADD COLUMN flatmates_json TEXT;`);
}
