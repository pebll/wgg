/**
 * Detail-page data (fetched in the background, one page at a time by the detail worker). All timestamps are epoch ms.
 *
 * details_status      pending | fetched | failed | skipped (too old for details). New listings start pending.
 * details_attempts    fetch attempts so far (a successful one counts too).
 * details_error       message of the last failed attempt; NULL after a successful fetch.
 * details_fetched_at  when the page was parsed and stored.
 * description_text    the full plain description (all sections); used for the keyword exclusion and the LLM.
 * detail_page_json    the other parsed parts: sections, costs, address, availability, WG and object facts.
 *                     (details_json is taken: it holds the evaluation details.)
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN details_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (details_status IN ('pending', 'fetched', 'failed', 'skipped'));
    ALTER TABLE listings ADD COLUMN details_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE listings ADD COLUMN details_error TEXT;
    ALTER TABLE listings ADD COLUMN details_fetched_at INTEGER;
    ALTER TABLE listings ADD COLUMN description_text TEXT;
    ALTER TABLE listings ADD COLUMN detail_page_json TEXT;
    CREATE INDEX idx_listings_details_status ON listings (details_status);
  `);
}
