import Db from '../services/storage/Db.js';

/** What one assessment takes when nothing was measured yet (the free local model needs about this long). */
export const DEFAULT_LLM_SECONDS = 8;

const SAMPLE = 30; // finished assessments looked at
const MIN_GAPS = 3; // fewer gaps than this is no measurement
const MAX_GAP_SECONDS = 120; // a longer gap between two assessments was idle time, not a duration

/**
 * Measured seconds per assessment: the average gap between consecutive assessments (all users, the queue is serial) of
 * the last finished ones; gaps over two minutes (the queue was idle) are left out. Null without enough data.
 * @returns {number|null}
 */
export function getLlmAvgSeconds() {
  const times = Db.getConnection()
    .prepare(
      `SELECT llm_evaluated_at AS at FROM user_listings WHERE llm_status = 'done' AND llm_evaluated_at IS NOT NULL
       ORDER BY llm_evaluated_at DESC LIMIT ?`,
    )
    .all(SAMPLE)
    .map((r) => r.at);
  const gaps = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const seconds = (times[i] - times[i + 1]) / 1000;
    if (seconds > 0 && seconds <= MAX_GAP_SECONDS) gaps.push(seconds);
  }
  if (gaps.length < MIN_GAPS) return null;
  return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
}

/**
 * Seconds until a user's `own` pending assessments are done. The queue is serial and the users are served in turns, so
 * every other user with a backlog takes a turn between two of this user's: at most `own` assessments each.
 * @param {{own: number, others?: number[], avgSeconds?: number|null}} p `others`: pending counts of the other users.
 */
export function estimateLlmEtaSeconds({ own, others = [], avgSeconds }) {
  if (!(own > 0)) return 0;
  const ahead = own + others.reduce((sum, n) => sum + Math.min(Math.max(n, 0), own), 0);
  return Math.round(ahead * (avgSeconds ?? DEFAULT_LLM_SECONDS));
}
