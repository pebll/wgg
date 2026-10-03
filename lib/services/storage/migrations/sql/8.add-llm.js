/**
 * LLM assessment of the full description (see lib/evaluation/llmEvaluator.js). Timestamps are epoch ms.
 *
 * llm_status        pending | done | failed | skipped (excluded by the rules, or no description). Start pending.
 * llm_json          the validated answer: verbindungProbability, verbindungSignals, fitScore, summary, positives,
 *                   redFlags, plus model, truncated (description cut for the prompt) and descriptionChars.
 * llm_model         model id that produced llm_json.
 * llm_evaluated_at  when llm_json was stored.
 * llm_error         last failure / skip reason (never contains secrets); NULL after a success.
 * llm_attempts      LLM attempts so far.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE listings ADD COLUMN llm_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (llm_status IN ('pending', 'done', 'failed', 'skipped'));
    ALTER TABLE listings ADD COLUMN llm_json TEXT;
    ALTER TABLE listings ADD COLUMN llm_model TEXT;
    ALTER TABLE listings ADD COLUMN llm_evaluated_at INTEGER;
    ALTER TABLE listings ADD COLUMN llm_error TEXT;
    ALTER TABLE listings ADD COLUMN llm_attempts INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX idx_listings_llm_status ON listings (llm_status);
  `);
}
