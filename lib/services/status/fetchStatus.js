import Db from '../storage/Db.js';

/**
 * How long after its planned time a next fetch still counts as "scheduler alive". A cycle that is
 * running right now leaves the previous plan in the past until it finishes (several searches with
 * pauses and a browser start), so a strict "in the future" check would flicker.
 */
export const SCHEDULER_GRACE_MS = 10 * 60_000;

/** An unfinished run older than this is treated as left behind by a crashed process, not as "still running". */
export const UNFINISHED_RUN_MAX_AGE_MS = 15 * 60_000;

/** Records the start of a scrape cycle. @returns {number} run id */
export function startFetchRun(now = Date.now()) {
  const info = Db.execute('INSERT INTO fetch_runs (started_at) VALUES (@now)', { now });
  return Number(info.lastInsertRowid);
}

/**
 * @param {number} id
 * @param {{newCount: number, errorCount: number, botDetected: boolean, error: string|null}} result
 */
export function finishFetchRun(id, { newCount, errorCount, botDetected, error }, now = Date.now()) {
  Db.execute(
    `UPDATE fetch_runs SET finished_at = @now, new_count = @newCount, error_count = @errorCount,
       bot_detected = @bot, error = @error WHERE id = @id`,
    { id, now, newCount, errorCount, bot: botDetected ? 1 : 0, error: error ?? null },
  );
}

/**
 * Records a cycle that failed before it could start (e.g. the browser did not launch) as a finished,
 * failed run, so it shows in the header and counts for the minimum gap between fetches. A bot wall met outside a
 * search cycle (a detail page) is recorded the same way with `botDetected`, so every guard that reads the last run
 * (manual fetch, detail worker) sees the backoff.
 * @param {Error} error
 * @param {number} [now]
 * @param {{botDetected?: boolean}} [options]
 */
export function recordFailedRun(error, now = Date.now(), { botDetected = false } = {}) {
  const id = startFetchRun(now);
  finishFetchRun(id, { newCount: 0, errorCount: 1, botDetected, error: error.message }, now);
  return id;
}

/** True when a run started less than UNFINISHED_RUN_MAX_AGE_MS ago has not finished (another process is fetching). */
export function hasRecentUnfinishedRun(now = Date.now()) {
  const row = Db.query('SELECT 1 AS found FROM fetch_runs WHERE finished_at IS NULL AND started_at > @cutoff LIMIT 1', {
    cutoff: now - UNFINISHED_RUN_MAX_AGE_MS,
  })[0];
  return row !== undefined;
}

function saveSchedulerState(nextFetchAt, backoff, now) {
  Db.execute(
    `INSERT INTO scheduler_state (id, next_fetch_at, backoff, updated_at) VALUES (1, @nextFetchAt, @backoff, @now)
     ON CONFLICT(id) DO UPDATE SET next_fetch_at = @nextFetchAt, backoff = @backoff, updated_at = @now`,
    { nextFetchAt, backoff: backoff ? 1 : 0, now },
  );
}

/** The scheduler planned its next cycle (after jitter/backoff). */
export function setNextFetch({ nextFetchAt, backoff }, now = Date.now()) {
  saveSchedulerState(nextFetchAt, backoff, now);
}

/** The scheduler stopped (clean shutdown): no next fetch is planned. */
export function clearNextFetch(now = Date.now()) {
  saveSchedulerState(null, false, now);
}

/**
 * Status for the dashboard header. `schedulerRunning` is a heuristic: a next fetch is planned and
 * it is not overdue by more than SCHEDULER_GRACE_MS. A crashed scheduler therefore reads as not
 * running after the grace period; a clean shutdown clears the plan immediately.
 *
 * @returns {{lastFetch: object|null, nextFetchAt: number|null, backoff: boolean, schedulerRunning: boolean}}
 */
export function getFetchStatus(now = Date.now()) {
  const run = Db.query('SELECT * FROM fetch_runs ORDER BY id DESC LIMIT 1')[0];
  const state = Db.query('SELECT * FROM scheduler_state WHERE id = 1')[0];
  const alive = Boolean(state) && state.next_fetch_at !== null && now <= state.next_fetch_at + SCHEDULER_GRACE_MS;
  return {
    lastFetch: run
      ? {
          id: run.id,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          newCount: run.new_count,
          errorCount: run.error_count,
          botDetected: run.bot_detected === 1,
          error: run.error,
        }
      : null,
    nextFetchAt: alive ? state.next_fetch_at : null,
    backoff: alive && state.backoff === 1,
    schedulerRunning: alive,
  };
}
