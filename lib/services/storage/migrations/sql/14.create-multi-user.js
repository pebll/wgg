/**
 * Multi-user data model. Listings stay global (scraped once per provider_id; details and geocoding are global).
 * Everything a person decides or computes about a listing moves to per-user tables. The old per-listing columns
 * (overall_score, llm_*, dismissed_at, hidden_*, messaged_at, notified_*, distance_km) stay in `listings` as an untouched
 * backup of the single-user data; nothing reads or writes them any more. The data is copied to the first admin by the
 * startup step in lib/users/bootstrap.js, because the admin's name lives in config/users.yaml, not in the database.
 *
 * user_id is the username from users.yaml (lowercase, stable).
 *
 * app_meta        key/value flags (`legacy_adopted_by`: who received the single-user data).
 * user_queries    one row per user and WG-Gesucht search URL; `enabled` = scraped and shown. UNIQUE(user_id, url).
 * listing_queries which search URL found which listing (any user's query): a user sees the listings found by their
 *                 enabled queries, plus the ones they hid or messaged.
 * user_listings   the per-user state of a listing: rule evaluation (+ distance to THIS user's target), the LLM assessment
 *                 (status, json, prompt version and settings hash of the profile/model that produced it, attempts,
 *                 error), hiding (hidden_at/by/reason, hide_override), messaged_at and the email alert state.
 * user_settings   one JSON document per user (scoring, AI profile, notification settings).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE user_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, url)
    );
    CREATE INDEX idx_user_queries_url ON user_queries (url);

    CREATE TABLE listing_queries (
      listing_id INTEGER NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
      query_url TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (listing_id, query_url)
    );
    CREATE INDEX idx_listing_queries_url ON listing_queries (query_url);

    CREATE TABLE user_listings (
      user_id TEXT NOT NULL,
      listing_id INTEGER NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
      overall_score REAL,
      scores_json TEXT,
      details_json TEXT,
      missing_json TEXT,
      excluded_reason TEXT,
      evaluated_at INTEGER,
      distance_km REAL,
      llm_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (llm_status IN ('pending', 'done', 'failed', 'skipped')),
      llm_json TEXT,
      llm_model TEXT,
      llm_evaluated_at INTEGER,
      llm_error TEXT,
      llm_attempts INTEGER NOT NULL DEFAULT 0,
      llm_prompt_version INTEGER,
      llm_settings_hash TEXT,
      hidden_at INTEGER,
      hidden_by TEXT CHECK (hidden_by IN ('user', 'program')),
      hidden_reason TEXT,
      hide_override INTEGER NOT NULL DEFAULT 0,
      messaged_at INTEGER,
      notified_at INTEGER,
      notified_kind TEXT CHECK (notified_kind IN ('priority', 'bulk')),
      notify_error TEXT,
      notify_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, listing_id)
    );
    CREATE INDEX idx_user_listings_listing ON user_listings (listing_id);
    CREATE INDEX idx_user_listings_llm ON user_listings (user_id, llm_status);

    CREATE TABLE user_settings (
      user_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
