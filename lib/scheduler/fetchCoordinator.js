import { getFetchStatus, hasRecentUnfinishedRun, recordFailedRun } from '../services/status/fetchStatus.js';
import { backoffMinutes } from './timing.js';
import { msUntilFetchOpen } from './fetchWindow.js';
import { formatHour } from '../../ui/src/services/schedule.js';
import logger from '../services/logger.js';

const secondsUntil = (ms) => Math.max(1, Math.ceil(ms / 1000));

/**
 * Decides whether a manual "fetch now" may start, and starts it. Shared by the scheduler (`wgg run`) and the
 * API in one process so both honour the same politeness rules as the automatic fetching:
 *
 *  1. never two cycles at once (in-process flag, plus an unfinished recent run in the database, which covers
 *     a `wgg run` / `scrape-once` in another process)        -> 409
 *  2. not while in bot backoff (the scheduler's plan; without a live scheduler, the first backoff interval
 *     after a bot-detected run)                              -> 429 with the remaining time
 *  3. only inside the fetch window (union of the users' Good send windows, see fetchWindow.js): at night a manual fetch
 *     is refused -> 429 "Fetching pauses at night (until 07:00)." (politeness; the scheduler and the detail worker pause
 *     too). Without `fetchWindow` (CLI commands) there is no pause.
 *  4. at least `schedule.manualFetchMinGapSeconds` (default 600) since the last fetch started, scheduled or
 *     manual                                                 -> 429 with the remaining time
 *
 * The coordinator is also the one lock of the process: search cycles and detail-page fetches (see
 * `lib/details/detailWorker.js`) go through the same FIFO queue, so a detail request never overlaps a search cycle or
 * another detail request. A bot wall on a detail page is reported here (`reportBotDetected`): it is recorded like a
 * bot-detected cycle and the scheduler of this process backs off one step more.
 *
 * When a scheduler runs in this process, it is woken to fetch now (and plans the next fetch as usual); otherwise
 * one cycle runs in this process via `runCycle`. The cycle is never awaited by the caller.
 *
 * @param {object} params
 * @param {{schedule: {intervalMinutes: number, maxBackoffMinutes: number, manualFetchMinGapSeconds: number}}} params.config
 * @param {() => Promise<unknown>} params.runCycle One complete cycle (browser + scrape + enrichment).
 * @param {() => {from: number, to: number}} [params.fetchWindow] The current fetch window; omitted: never paused.
 * @param {() => number} [params.now]
 * @param {{info: Function, warn: Function, error: Function}} [params.log]
 */
export function createFetchCoordinator({ config, runCycle, now = Date.now, log = logger, fetchWindow = null }) {
  const { intervalMinutes, maxBackoffMinutes, manualFetchMinGapSeconds } = config.schedule;
  let running = false;
  let schedulerAttached = false;
  let wake = null;
  let penalty = null;
  let detailBusy = false;
  let queued = 0;
  let tail = Promise.resolve();

  /** FIFO lock: `fn` starts (synchronously when idle) once everything queued before it has settled. */
  function exclusive(fn) {
    const start = () => {
      try {
        return Promise.resolve(fn());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const result = queued === 0 ? start() : tail.then(start);
    queued++;
    tail = result.then(
      () => {},
      () => {},
    );
    tail.then(() => queued--);
    return result;
  }

  const refuse = (status, error, retryAfterSeconds) =>
    retryAfterSeconds === undefined ? { ok: false, status, error } : { ok: false, status, error, retryAfterSeconds };

  /** Milliseconds of bot backoff still to wait, 0 when not backing off. */
  function backoffRemainingMs(at) {
    const status = getFetchStatus(at);
    if (status.schedulerRunning) {
      return status.backoff && status.nextFetchAt !== null ? Math.max(0, status.nextFetchAt - at) : 0;
    }
    const last = status.lastFetch;
    if (last?.botDetected && last.finishedAt !== null) {
      const wait = backoffMinutes({ baseMinutes: intervalMinutes, maxMinutes: maxBackoffMinutes, failures: 1 });
      return Math.max(0, last.finishedAt + wait * 60_000 - at);
    }
    return 0;
  }

  /** Milliseconds until the fetch window opens, 0 when it is open (or there is none). */
  const pauseRemainingMs = (at) => (fetchWindow ? msUntilFetchOpen(fetchWindow(), at) : 0);

  function guard(at) {
    if (running) return refuse(409, 'A fetch is already running.');
    if (detailBusy) return refuse(409, 'A detail page is being fetched; try again in a moment.');
    if (hasRecentUnfinishedRun(at)) return refuse(409, 'A fetch is already running (started by another wgg process).');

    const pauseMs = pauseRemainingMs(at);
    if (pauseMs > 0) {
      return refuse(429, `Fetching pauses at night (until ${formatHour(fetchWindow().from)}).`, secondsUntil(pauseMs));
    }

    const backoffMs = backoffRemainingMs(at);
    if (backoffMs > 0) {
      return refuse(
        429,
        'Bot backoff: wgg is waiting after bot detection or errors; fetching now would make it worse.',
        secondsUntil(backoffMs),
      );
    }

    const waitMs = gapRemainingMs(at);
    if (waitMs > 0) {
      return refuse(
        429,
        `The last fetch started less than ${manualFetchMinGapSeconds} s ago (minimum gap between fetches).`,
        secondsUntil(waitMs),
      );
    }
    return null;
  }

  /** Milliseconds until the minimum gap since the last fetch START (scheduled or manual) has passed, 0 when it has. */
  function gapRemainingMs(at) {
    const lastStart = getFetchStatus(at).lastFetch?.startedAt;
    return lastStart === undefined ? 0 : Math.max(0, lastStart + manualFetchMinGapSeconds * 1000 - at);
  }

  async function guarded() {
    running = true;
    try {
      return await exclusive(runCycle);
    } finally {
      running = false;
    }
  }

  return {
    /**
     * Runs one detail-page fetch under the shared lock (queued behind a running search cycle or detail fetch).
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    runExclusive(fn) {
      return exclusive(async () => {
        detailBusy = true;
        try {
          return await fn();
        } finally {
          detailBusy = false;
        }
      });
    },

    /**
     * What the "Fetch now" button needs: `availableAt` is the epoch ms from which a manual fetch is allowed (the later
     * of the end of the minimum gap and of the bot backoff), null when it is allowed now; `running` while a cycle or a
     * detail fetch runs (here or in another process). The 409/429 of `triggerNow` stays the authority.
     * `nightPause` is true outside the fetch window; then `availableAt` is at least the opening of the window.
     * @returns {{minGapSeconds: number, availableAt: number|null, running: boolean, nightPause: boolean}}
     */
    manualFetchState() {
      const at = now();
      const pauseMs = pauseRemainingMs(at);
      const waitMs = Math.max(gapRemainingMs(at), backoffRemainingMs(at), pauseMs);
      return {
        minGapSeconds: manualFetchMinGapSeconds,
        nightPause: pauseMs > 0,
        availableAt: waitMs > 0 ? at + waitMs : null,
        running: running || detailBusy || hasRecentUnfinishedRun(at),
      };
    },

    /** Milliseconds until the fetch window opens (0: open now, or no window), for the detail worker. */
    pauseRemainingMs: () => pauseRemainingMs(now()),

    /** Milliseconds of bot backoff still to wait (0: none), for the detail worker. */
    backoffRemainingMs: () => backoffRemainingMs(now()),

    /** The scheduler's `registerPenalty`: a function that makes it back off one step more. */
    registerPenalty(fn) {
      penalty = fn;
    },

    /** A detail page hit a bot wall: record it like a bot-detected cycle and make the scheduler back off. */
    reportBotDetected(error) {
      recordFailedRun(error, now(), { botDetected: true });
      penalty?.();
    },

    /** True while a cycle started through this coordinator runs. */
    isRunning: () => running,

    /** The scheduler of this process uses this as its `runCycle` so manual requests see it as busy. */
    runScheduledCycle: guarded,

    /** Call once when a scheduler runs in this process (`wgg run`). */
    attachScheduler() {
      schedulerAttached = true;
    },

    /** The scheduler's `registerWake`: a function while it waits for the next cycle, null otherwise. */
    registerWake(fn) {
      wake = fn;
    },

    /** @returns {{ok: true, mode: 'scheduler'|'one-off'} | {ok: false, status: 409|429, error: string, retryAfterSeconds?: number}} */
    triggerNow() {
      const refusal = guard(now());
      if (refusal) return refusal;

      if (schedulerAttached) {
        if (!wake) return refuse(409, 'The scheduler is busy right now.');
        wake();
        return { ok: true, mode: 'scheduler' };
      }

      let cycle;
      try {
        cycle = guarded();
      } catch (error) {
        cycle = Promise.reject(error);
      }
      cycle
        .then((result) => log.info(`Manual fetch finished: ${result?.newListings?.length ?? 0} new listing(s).`))
        .catch((error) => log.error(`Manual fetch failed: ${error.message}`));
      return { ok: true, mode: 'one-off' };
    },
  };
}
