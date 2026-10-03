import Db from '../storage/Db.js';

/**
 * Drops what settings saved by earlier versions may still carry: the rent hard cap (`scoring.rent.hardMax`; the search
 * query limits the rent), the WG size range and weight (`scoring.wgSize`, `scoring.weights.wgSize`; the WG size is no
 * scoring parameter any more). Anything else is left as it is.
 * @param {any} doc
 */
export function stripRemovedSettings(doc) {
  const scoring = doc?.scoring;
  if (scoring && typeof scoring === 'object') {
    delete scoring.wgSize;
    if (scoring.rent && typeof scoring.rent === 'object') delete scoring.rent.hardMax;
    if (scoring.weights && typeof scoring.weights === 'object') delete scoring.weights.wgSize;
  }
  return doc;
}

/**
 * The stored settings document of a user (what the user saved; defaults are merged in by the caller).
 * @param {string} userId
 * @returns {object|null} null when the user has none yet.
 */
export function getStoredSettings(userId) {
  const row = Db.query('SELECT json FROM user_settings WHERE user_id = @userId', { userId })[0];
  if (!row) return null;
  try {
    return stripRemovedSettings(JSON.parse(row.json));
  } catch {
    return null;
  }
}

/** Replaces the user's settings document. */
export function saveSettings(userId, settings, now = Date.now()) {
  Db.execute(
    `INSERT INTO user_settings (user_id, json, updated_at) VALUES (@userId, @json, @now)
     ON CONFLICT(user_id) DO UPDATE SET json = @json, updated_at = @now`,
    { userId, json: JSON.stringify(settings), now },
  );
}
