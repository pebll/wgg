import Db from '../services/storage/Db.js';

/** @returns {number|null} The last slot (epoch ms) this user's tier was sent in, null when never. */
export function getLastSlot(userId, tier) {
  const row = Db.query('SELECT last_slot_at FROM notify_schedule WHERE user_id = @userId AND tier = @tier', {
    userId,
    tier,
  })[0];
  return row ? row.last_slot_at : null;
}

/**
 * Atomically takes a slot: succeeds only when it is later than the last one used, so a slot is sent at most once even
 * with several triggers or processes. Claim before sending; `releaseSlot` gives it back when the send fails.
 * @returns {{claimed: boolean, previous: number|null}}
 */
export function claimSlot(userId, tier, slot) {
  const previous = getLastSlot(userId, tier);
  const info = Db.execute(
    `INSERT INTO notify_schedule (user_id, tier, last_slot_at) VALUES (@userId, @tier, @slot)
     ON CONFLICT(user_id, tier) DO UPDATE SET last_slot_at = @slot WHERE last_slot_at < @slot`,
    { userId, tier, slot },
  );
  return { claimed: info.changes === 1, previous };
}

/** Puts the slot back to `previous`, but only while `slot` is still the stored one (never undoes a later claim). */
export function releaseSlot(userId, tier, slot, previous) {
  if (previous === null) {
    Db.execute('DELETE FROM notify_schedule WHERE user_id = @userId AND tier = @tier AND last_slot_at = @slot', {
      userId,
      tier,
      slot,
    });
  } else {
    Db.execute(
      'UPDATE notify_schedule SET last_slot_at = @previous WHERE user_id = @userId AND tier = @tier AND last_slot_at = @slot',
      { userId, tier, slot, previous },
    );
  }
}
