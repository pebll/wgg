import { computeWaitMs } from './timing.js';
import logger from '../services/logger.js';

/** Sleep that resolves early when the signal aborts. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Poll forever (until `signal` aborts): run a cycle, then wait the configured interval with random
 * jitter. A cycle with bot detection, HTTP/fetch errors or a thrown exception counts as a failure
 * and doubles the wait (up to maxBackoffMinutes); a clean cycle resets it.
 *
 * @param {object} params
 * @param {{schedule: {intervalMinutes: number, jitterPercent: number, maxBackoffMinutes: number}}} params.config
 * @param {() => Promise<{newListings: any[], errors: any[], botDetected: boolean}>} params.runCycle
 * @param {AbortSignal} params.signal
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [params.sleep]
 * @param {() => number} [params.random]
 * @param {(newListings: any[]) => void} [params.onNewListings]
 * @param {() => number} [params.now]
 * @param {(plan: {nextFetchAt: number, backoff: boolean}) => void} [params.onSchedule] Called with the planned
 *   next cycle time before each wait.
 * @param {(penalty: (() => void)|null) => void} [params.registerPenalty] Called with a function that counts one more
 *   failure from outside (a bot wall on a detail page): it ends the current wait early and the wait is planned again
 *   with the longer backoff; no cycle runs for it.
 * @param {() => void} [params.onStop] Called once when the scheduler stops.
 * @param {(wake: (() => void)|null) => void} [params.registerWake] Called with a function that ends the current wait
 *   early (the next cycle then starts immediately and the one after is planned as usual), and with null when
 *   the scheduler is not waiting (a cycle is running or it stopped).
 */
export async function runScheduler({
  config,
  runCycle,
  signal,
  sleep = abortableSleep,
  random = Math.random,
  onNewListings = () => {},
  now = Date.now,
  onSchedule = () => {},
  onStop = () => {},
  registerWake = () => {},
  registerPenalty = () => {},
}) {
  const { intervalMinutes, jitterPercent, maxBackoffMinutes } = config.schedule;
  let failures = 0;
  let penalized = false;
  let skipCycle = false;
  let waiting = null;
  registerPenalty(() => {
    failures++;
    if (waiting) {
      penalized = true;
      waiting.abort();
    }
  });

  while (!signal.aborted) {
    if (!skipCycle) {
      let failed = false;
      try {
        const result = await runCycle();
        if (result.newListings.length > 0) onNewListings(result.newListings);
        failed = result.botDetected || result.errors.length > 0;
        if (result.botDetected) {
          logger.warn('Bot detection / human verification triggered. Not trying to bypass it; backing off.');
        } else if (failed) {
          logger.warn(`Cycle finished with ${result.errors.length} error(s); backing off.`);
        } else {
          logger.info(`Cycle finished: ${result.newListings.length} new listing(s).`);
        }
      } catch (error) {
        failed = true;
        logger.error(`Cycle crashed: ${error.message}; backing off.`);
      }
      failures = failed ? failures + 1 : 0;
    }
    skipCycle = false;
    if (signal.aborted) break;

    const waitMs = computeWaitMs({
      baseMinutes: intervalMinutes,
      maxMinutes: maxBackoffMinutes,
      failures,
      jitterPercent,
      random,
    });
    logger.info(
      `Next cycle in ${(waitMs / 60_000).toFixed(1)} min` +
        (failures > 0 ? ` (backoff after ${failures} failed cycle(s) in a row)` : ''),
    );
    onSchedule({ nextFetchAt: now() + waitMs, backoff: failures > 0 });
    const wakeController = new AbortController();
    waiting = wakeController;
    registerWake(() => wakeController.abort());
    try {
      await sleep(waitMs, AbortSignal.any([signal, wakeController.signal]));
    } finally {
      waiting = null;
      registerWake(null);
    }
    if (penalized) {
      penalized = false;
      skipCycle = true; // only the plan is redone, with the longer backoff
    }
  }
  registerWake(null);
  onStop();
  logger.info('Scheduler stopped.');
}
