import Db from '../services/storage/Db.js';
import { notifyValues } from './notifyStorage.js';
import { tierFor } from './tier.js';

/**
 * Recomputes `user_listings.tier` of one user (or of one of their listings) from their alert rules, with the same values
 * the notifier looks at. The tier needs a finished AI assessment made with the user's current settings (`llmHash`) and
 * a listing that is not excluded. Hidden state and the alert age limit do not matter: they only restrict emails.
 * Only changed rows are written, and only that user's rows are touched.
 *
 * @param {string} userId
 * @param {{notify: object, llmHash: string}} user Their notify settings and current AI settings hash.
 * @param {{listingId?: number}} [options] Only this listing (row id).
 * @returns {number} Rows whose tier changed.
 */
export function refreshTiers(userId, { notify, llmHash }, { listingId } = {}) {
  const only = listingId === undefined ? '' : ' AND ul.listing_id = @listingId';
  const bound = { userId, ...(listingId === undefined ? {} : { listingId }) };
  return Db.withTransaction((db) => {
    const rows = db
      .prepare(
        `SELECT ul.listing_id AS id, ul.tier AS tier, ul.overall_score AS overall_score, ul.llm_json AS llm_json,
           ul.llm_status AS llm_status, ul.llm_settings_hash AS llm_settings_hash, ul.excluded_reason AS excluded_reason,
           ul.distance_km AS distance_km, l.price AS price, l.size AS size
         FROM user_listings ul JOIN listings l ON l.id = ul.listing_id WHERE ul.user_id = @userId${only}`,
      )
      .all(bound);
    const update = db.prepare('UPDATE user_listings SET tier = @tier WHERE user_id = @userId AND listing_id = @id');
    let changed = 0;
    for (const row of rows) {
      const eligible = row.llm_status === 'done' && row.llm_settings_hash === llmHash && row.excluded_reason === null;
      const tier = eligible ? tierFor(notify, notifyValues(row)) : null;
      if (tier === row.tier) continue;
      update.run({ userId, id: row.id, tier });
      changed++;
    }
    return changed;
  });
}

/** Recomputes the tiers of every user (startup: fills rows from before tiers existed, follows a changed AI model). */
export function backfillTiers(directory) {
  for (const ctx of directory.contexts()) {
    refreshTiers(ctx.userId, { notify: ctx.settings.notify, llmHash: ctx.llmHash });
  }
}
