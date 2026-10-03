/**
 * Version of the LLM prompt (PROMPT_VERSION in lib/llm/prompt.js) that produced llm_json. The LLM worker re-assesses
 * `done` listings whose version differs from the current one; NULL = assessed before versions existed.
 */
export function up(db) {
  db.exec(`ALTER TABLE listings ADD COLUMN llm_prompt_version INTEGER;`);
}
