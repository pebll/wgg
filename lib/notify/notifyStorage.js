import Db from '../services/storage/Db.js';
import { buildListingFilter, normalizeListingQuery, userRows } from '../services/listings/listingsStorage.js';

/** A listing whose send failed this many times is not tried again. */
export const MAX_NOTIFY_ATTEMPTS = 3;

/**
 * Listings that may be announced to one user by email: AI assessment done with the user's current AI settings (prompt
 * version, profile, model: the settings hash), not excluded, not hidden (the shared listing filter hides the user's and
 * the program's hidden rows, messaged ones included), posted (else first seen) within `maxAgeHours`, not announced yet
 * and not given up on after failed sends. Only the user's own view and state count.
 *
 * @param {{userId: string, now: number, maxAgeHours: number, settingsHash: string, maxAttempts?: number,
 *   providerId?: string}} options
 * @returns {object[]} Stored rows (the user's view).
 */
export function selectNotifyCandidates({
  userId,
  now,
  maxAgeHours,
  settingsHash,
  maxAttempts = MAX_NOTIFY_ATTEMPTS,
  providerId,
}) {
  const { whereSql, params } = buildListingFilter(normalizeListingQuery({ maxAgeHours }), now);
  const where = [
    whereSql === '' ? null : whereSql.replace(/^WHERE /, ''),
    `llm_status = 'done'`,
    'llm_settings_hash = @settingsHash',
    'excluded_reason IS NULL',
    'messaged_at IS NULL',
    'notified_at IS NULL',
    'notify_attempts < @maxAttempts',
  ].filter(Boolean);
  const bound = { ...params, settingsHash, maxAttempts, userId };
  if (providerId !== undefined) {
    where.push('provider_id = @providerId');
    bound.providerId = String(providerId);
  }
  return Db.getConnection()
    .prepare(`SELECT * FROM ${userRows()} AS v WHERE ${where.join(' AND ')} ORDER BY overall_score DESC, id ASC`)
    .all(bound);
}

/**
 * The values the alert rules look at (see RULE_FIELDS in rules.js). Missing values are null.
 * @param {object} row
 */
export function notifyValues(row) {
  let llm = null;
  try {
    llm = row.llm_json ? JSON.parse(row.llm_json) : null;
  } catch {
    // unreadable assessment: the AI values count as missing
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    overall: num(row.overall_score),
    ai: num(llm?.fitScore),
    rent: num(row.price),
    size: num(row.size),
    distanceKm: num(row.distance_km),
    verbindungProbability: num(llm?.verbindungProbability),
  };
}

/**
 * Atomically marks a listing as announced to a user. Returns false when it already was (another trigger or process got
 * there first), so a listing is never sent twice. Claim before sending; `releaseNotified` undoes it when the send fails.
 * @param {string} userId
 * @param {number} id
 * @param {'priority'|'bulk'} kind
 * @param {number} now
 * @returns {boolean} True when this call claimed the listing.
 */
export function claimNotified(userId, id, kind, now) {
  const info = Db.execute(
    `UPDATE user_listings SET notified_at = @now, notified_kind = @kind, notify_error = NULL
     WHERE user_id = @userId AND listing_id = @id AND notified_at IS NULL`,
    { userId, id, kind, now },
  );
  return info.changes === 1;
}

/** Gives claimed listings back after a failed send: not announced, error and attempt count stored. */
export function releaseNotified(userId, ids, message) {
  Db.withTransaction((db) => {
    const stmt = db.prepare(
      `UPDATE user_listings SET notified_at = NULL, notified_kind = NULL, notify_error = @message,
         notify_attempts = notify_attempts + 1 WHERE user_id = @userId AND listing_id = @id`,
    );
    for (const id of ids) stmt.run({ userId, id, message });
  });
}
