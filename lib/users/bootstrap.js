import Db from '../services/storage/Db.js';
import { getMeta, setMeta } from '../services/storage/meta.js';
import { addUserQuery, listUserQueries } from '../services/queries/queriesStorage.js';
import { getStoredSettings, saveSettings } from '../services/settings/userSettingsStorage.js';
import { normalizeQueryUrl } from '../queries/url.js';
import { defaultUserSettings } from '../settings/defaults.js';
import { DEFAULT_TARGET, LEGACY_TUM_TARGET } from '../evaluation/config.js';
import { llmSettingsHash } from '../llm/settingsHash.js';
import logger from '../services/logger.js';

const ADOPTED_KEY = 'legacy_adopted_by';
const REPROFILE_KEY = 'migrated_generic_profile';
const RETARGET_KEY = 'migrated_kit_target';

const sameTarget = (t, ref) => t?.name === ref.name && t?.lat === ref.lat && t?.lng === ref.lng;

/**
 * Once: non-admin users whose profile is still byte-identical to the owner's (config) text, i.e. the copy they got when
 * they were set up and never edited, get `llm.defaultProfile`. Their AI is queued again through the settings hash.
 * @returns {string[]} The users changed.
 */
function moveToGenericProfile(users, evaluation, now) {
  if (getMeta(REPROFILE_KEY) !== null) return [];
  const changed = [];
  for (const user of users) {
    const stored = user.admin ? null : getStoredSettings(user.username);
    if (stored?.llm?.profile !== evaluation.llm.profile || evaluation.llm.profile === evaluation.llm.defaultProfile)
      continue;
    saveSettings(user.username, { ...stored, llm: { ...stored.llm, profile: evaluation.llm.defaultProfile } }, now);
    changed.push(user.username);
  }
  setMeta(REPROFILE_KEY, now);
  return changed;
}

/**
 * Once: non-admin users whose scoring target is still exactly the old built-in TUM default (name, lat, lng) move to the
 * KIT default. Their listings must be evaluated again (distances), the caller does that for the returned users.
 * @returns {string[]} The users changed.
 */
function moveToKitTarget(users, now) {
  if (getMeta(RETARGET_KEY) !== null) return [];
  const changed = [];
  for (const user of users) {
    const stored = user.admin ? null : getStoredSettings(user.username);
    if (!sameTarget(stored?.scoring?.target, LEGACY_TUM_TARGET)) continue;
    saveSettings(user.username, { ...stored, scoring: { ...stored.scoring, target: { ...DEFAULT_TARGET } } }, now);
    changed.push(user.username);
  }
  setMeta(RETARGET_KEY, now);
  return changed;
}

/**
 * Moves the per-listing state of the single-user era (evaluation, AI assessment, hidden, messaged, alerts, distance) to
 * the admin: one `user_listings` row per listing that has any state. Listings without state get theirs when the
 * pipeline first evaluates them. The legacy columns stay in `listings` as an untouched backup.
 * Also records which search found each listing and turns the old search URLs into the admin's queries.
 */
function adoptLegacyState(db, { adminId, searches, adminProfile, now }) {
  const copied = db
    .prepare(
      `INSERT OR IGNORE INTO user_listings (
         user_id, listing_id, overall_score, scores_json, details_json, missing_json, excluded_reason, evaluated_at,
         distance_km, llm_status, llm_json, llm_model, llm_evaluated_at, llm_error, llm_attempts, llm_prompt_version,
         hidden_at, hidden_by, hidden_reason, hide_override, messaged_at, notified_at, notified_kind, notify_error,
         notify_attempts)
       SELECT @adminId, id, overall_score, scores_json, details_json, missing_json, excluded_reason, evaluated_at,
         distance_km, llm_status, llm_json, llm_model, llm_evaluated_at, llm_error, llm_attempts, llm_prompt_version,
         dismissed_at, hidden_by, hidden_reason, hide_override, messaged_at, notified_at, notified_kind, notify_error,
         notify_attempts
       FROM listings
       WHERE evaluated_at IS NOT NULL OR overall_score IS NOT NULL OR llm_status <> 'pending' OR llm_attempts > 0
         OR dismissed_at IS NOT NULL OR messaged_at IS NOT NULL OR notified_at IS NOT NULL OR notify_attempts > 0
         OR hide_override = 1`,
    )
    .run({ adminId }).changes;

  // The assessments were made with the admin's profile: stamp them with the hash of (version, profile, model), so a
  // later profile or model change queues them again, and an unchanged setup does not.
  const stamp = db.prepare(
    `UPDATE user_listings SET llm_settings_hash = @hash
     WHERE user_id = @adminId AND llm_status = 'done' AND llm_prompt_version IS @version AND llm_model IS @model`,
  );
  const pairs = db
    .prepare(
      `SELECT DISTINCT llm_prompt_version AS version, llm_model AS model FROM user_listings
       WHERE user_id = @adminId AND llm_status = 'done'`,
    )
    .all({ adminId });
  for (const { version, model } of pairs) {
    const hash = llmSettingsHash({ model: model ?? '', profile: adminProfile, promptVersion: version ?? 0 });
    stamp.run({ hash, adminId, version, model });
  }

  const link = db.prepare(
    'INSERT OR IGNORE INTO listing_queries (listing_id, query_url, first_seen_at) VALUES (?, ?, ?)',
  );
  const urls = new Map();
  for (const row of db.prepare('SELECT id, search_url, first_seen_at FROM listings ORDER BY id').all()) {
    const url = normalizeQueryUrl(row.search_url);
    link.run(row.id, url, row.first_seen_at);
    urls.set(url, true);
  }

  const wanted = new Set();
  for (const search of searches) {
    const url = normalizeQueryUrl(search.url);
    wanted.add(url);
    addUserQuery(adminId, { name: search.name, url, enabled: true }, now);
  }
  for (const url of urls.keys()) {
    if (!wanted.has(url)) addUserQuery(adminId, { name: 'Earlier search', url, enabled: false }, now);
  }
  return { listings: copied, queries: listUserQueries(adminId).length };
}

/**
 * Startup step after the migrations: makes the database ready for the accounts in config/users.yaml. Idempotent.
 *
 *  1. Once, ever: the data from before accounts existed goes to the FIRST admin (see adoptLegacyState); the config
 *     `searches` become that admin's queries.
 *  2. Every user without a settings row is new: they get the default settings (config/evaluation.yaml, which holds the
 *     admin's profile text, plus the `notify` section; their users.yaml email) and a copy of the queries of the owner
 *     (the admin from step 1).
 *     Settings and queries of existing users are never touched, so a query a user deleted stays deleted.
 *
 * @param {object} params
 * @param {{username: string, admin: boolean, email: string|null}[]} params.users
 * @param {{name: string, url: string}[]} params.searches The `searches` of config/wgg.yaml (the admin's first queries).
 * @param {ReturnType<import('../evaluation/config.js').defaultEvaluationConfig>} params.evaluation
 * @param {ReturnType<import('../config.js').parseConfig>['notify']} params.notify
 * @param {number} [params.maxQueriesPerUser] `queries.maxPerUser`: new users get at most that many of the owner's queries.
 * @param {number} [params.now]
 *  3. Once each, for existing non-admin users: an unedited copy of the owner's profile becomes the generic
 *     `llm.defaultProfile`, and the old built-in TUM target becomes the KIT default (`retargeted` must be evaluated again).
 *
 * @returns {{adoptedBy: string|null, adopted: {listings: number, queries: number}|null, newUsers: string[],
 *   reprofiled: string[], retargeted: string[]}}
 */
export function bootstrapUsers({
  users,
  searches,
  evaluation,
  notify,
  maxQueriesPerUser = Infinity,
  now = Date.now(),
}) {
  const admin = users.find((u) => u.admin);
  if (!admin) throw new Error('bootstrapUsers needs an admin user.');
  return Db.withTransaction((db) => {
    let adoptedBy = null;
    let adopted = null;
    if (getMeta(ADOPTED_KEY) === null) {
      adopted = adoptLegacyState(db, {
        adminId: admin.username,
        searches,
        adminProfile: evaluation.llm.profile,
        now,
      });
      setMeta(ADOPTED_KEY, admin.username);
      adoptedBy = admin.username;
      logger.info(
        `Multi-user: ${adopted.listings} evaluated/assessed/hidden listing(s) and ${adopted.queries} search(es) now belong to "${admin.username}".`,
      );
    }

    // The owner (first admin of the very first start) stays the template for new users, whatever users.yaml lists first.
    const owner = getMeta(ADOPTED_KEY);
    const newUsers = [];
    for (const user of users) {
      if (getStoredSettings(user.username) !== null) continue;
      saveSettings(
        user.username,
        defaultUserSettings({ evaluation, notify, email: user.email, isOwner: user.username === owner }),
        now,
      );
      newUsers.push(user.username);
      if (user.username !== owner) {
        // At most the per-user limit, enabled ones first (a limit of 1 gives a new user the owner's main search).
        const template = listUserQueries(owner)
          .sort((a, b) => Number(b.enabled) - Number(a.enabled))
          .slice(0, maxQueriesPerUser);
        for (const q of template) {
          addUserQuery(user.username, { name: q.name, url: q.url, enabled: q.enabled }, now);
        }
      }
    }
    if (newUsers.length > 0) logger.info(`Multi-user: set up ${newUsers.join(', ')} with default settings.`);

    const existing = users.filter((u) => !newUsers.includes(u.username));
    const reprofiled = moveToGenericProfile(existing, evaluation, now);
    const retargeted = moveToKitTarget(existing, now);
    if (reprofiled.length > 0)
      logger.info(`Multi-user: ${reprofiled.join(', ')} now start from the generic AI profile.`);
    if (retargeted.length > 0)
      logger.info(`Multi-user: ${retargeted.join(', ')} now score distance to the KIT library.`);
    return { adoptedBy, adopted, newUsers, reprofiled, retargeted };
  });
}
