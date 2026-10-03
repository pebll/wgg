import { jitterMs } from '../scheduler/timing.js';
import { abortableSleep } from '../scheduler/scheduler.js';
import { parseDetailPage } from '../provider/wgGesuchtDetail.js';
import {
  selectNextPendingDetail,
  recordDetailFailure,
  requeueDetails,
  getListingByProviderId,
} from '../services/listings/listingsStorage.js';
import { BotDetectedError, FetchError } from '../errors.js';
import logger from '../services/logger.js';

/**
 * @typedef {object} DrainResult
 * @property {number} fetched Listings whose details were stored.
 * @property {number} failed Listings that used up their attempts in this drain.
 * @property {number} retried Failed attempts that leave the listing pending for a later retry.
 * @property {boolean} botDetected A bot wall stopped the drain.
 * @property {'idle'|'limit'|'aborted'|'bot'|'backoff'|'running'} stopped
 */

/**
 * The detail queue worker: fetches the detail page of pending listings one at a time (newest first, never
 * dismissed ones, never ones older than `details.maxAgeDays`), parses and stores it, re-evaluates the listing, and
 * waits `details.delaySeconds` +/- `details.jitterPercent` before the next request.
 *
 * Politeness: every request runs under the coordinator's lock (never parallel to a search cycle or another detail
 * fetch). A bot wall stops the drain, is reported to the coordinator (recorded like a bot-detected cycle, the
 * scheduler backs off) and is never retried; a drain does not start while that backoff lasts. One browser serves the
 * whole drain (`withFetcher`) and is closed when the queue is empty.
 *
 * @param {object} params
 * @param {{details: {delaySeconds: number, jitterPercent: number, maxAgeDays: number, maxAttempts: number}}} params.config
 * @param {{runExclusive: Function, backoffRemainingMs: () => number, reportBotDetected: (e: Error) => void}} params.coordinator
 * @param {(fn: (fetchHtml: (url: string) => Promise<string>) => Promise<any>) => Promise<any>} params.withFetcher
 * @param {(row: object, page: import('../provider/wgGesuchtDetail.js').DetailPage) => Promise<unknown>} params.apply
 *   Stores the page and re-evaluates (see applyDetails).
 * @param {(row: object) => void} [params.onStored] Called after a page was stored and the listing evaluated (never for a
 *   failed fetch). `wgg run` wakes the AI queue with it, so a listing is assessed right after its details instead of
 *   after the whole detail queue. Errors are logged and never fail the fetch.
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [params.sleep]
 * @param {() => number} [params.random]
 * @param {() => number} [params.now]
 * @param {{info: Function, warn: Function, error: Function}} [params.log]
 */
export function createDetailWorker({
  config,
  coordinator,
  withFetcher,
  apply,
  onStored = null,
  sleep = abortableSleep,
  random = Math.random,
  now = Date.now,
  log = logger,
}) {
  const { delaySeconds, jitterPercent, maxAgeDays, maxAttempts } = config.details;
  let running = false;
  let nextAt = null;

  let ids; // set per drain (wgg details --ids)
  const next = () => selectNextPendingDetail({ now: now(), maxAgeDays, ids });

  /** @returns {Promise<'fetched'|'failed'|'retry'|'bot'>} */
  async function processOne(row, fetchHtml) {
    let page;
    try {
      const html = await coordinator.runExclusive(async () => {
        try {
          return await fetchHtml(row.link);
        } catch (error) {
          // Reported while still holding the lock, so no search cycle can start in between.
          if (error instanceof BotDetectedError) coordinator.reportBotDetected(error);
          throw error;
        }
      });
      page = parseDetailPage(html);
      if (!page.description && page.costs.length === 0) {
        throw new FetchError('no description or costs found on the detail page (removed ad or changed layout?)');
      }
    } catch (error) {
      if (error instanceof BotDetectedError) {
        log.warn(
          `Detail page of listing ${row.provider_id}: ${error.message}. Stopping detail fetching and backing off.`,
        );
        return 'bot';
      }
      const status = recordDetailFailure(row.id, error.message, { maxAttempts });
      log.warn(`Detail page of listing ${row.provider_id} failed (${status}): ${error.message}`);
      return status === 'failed' ? 'failed' : 'retry';
    }

    try {
      await apply(row, page);
    } catch (error) {
      if (getListingByProviderId(row.provider_id).details_status !== 'fetched') {
        const status = recordDetailFailure(row.id, error.message, { maxAttempts });
        log.error(`Storing details of listing ${row.provider_id} failed (${status}): ${error.message}`);
        return status === 'failed' ? 'failed' : 'retry';
      }
      // The page is stored; only the follow-up (geocoding / evaluation) failed. `wgg evaluate` can redo it.
      log.warn(`Details of listing ${row.provider_id} stored, but re-evaluation failed: ${error.message}`);
    }
    log.info(`Details fetched for listing ${row.provider_id}.`);
    if (onStored) {
      try {
        onStored(row);
      } catch (error) {
        log.error(`After-details hook of listing ${row.provider_id} failed: ${error.message}`);
      }
    }
    return 'fetched';
  }

  /**
   * Works through the queue until it is empty, `limit` listings were handled, the signal aborts or a bot wall
   * stops it.
   * With `ids` (provider or row ids) only those listings are fetched: skipped and failed ones are re-queued first
   * and the age limit does not apply.
   * @param {{signal?: AbortSignal, limit?: number, ids?: string[]}} [options]
   * @returns {Promise<DrainResult>}
   */
  async function drain({ signal, limit, ids: only } = {}) {
    const result = { fetched: 0, failed: 0, retried: 0, botDetected: false, stopped: 'idle' };
    if (running) return { ...result, stopped: 'running' };
    if (signal?.aborted) return { ...result, stopped: 'aborted' };

    const backoffMs = coordinator.backoffRemainingMs();
    if (backoffMs > 0) {
      log.info(`Not fetching detail pages: bot backoff, ${Math.ceil(backoffMs / 60_000)} min left.`);
      return { ...result, stopped: 'backoff' };
    }

    running = true;
    ids = only;
    try {
      if (ids) requeueDetails(ids);
      if (!next()) return result;
      let handled = 0;
      await withFetcher(async (fetchHtml) => {
        for (;;) {
          if (signal?.aborted) return void (result.stopped = 'aborted');
          if (limit !== undefined && handled >= limit) return void (result.stopped = 'limit');
          const row = next();
          if (!row) return void (result.stopped = 'idle');

          const outcome = await processOne(row, fetchHtml);
          handled++;
          if (outcome === 'bot') {
            result.botDetected = true;
            return void (result.stopped = 'bot');
          }
          if (outcome === 'fetched') result.fetched++;
          else if (outcome === 'failed') result.failed++;
          else result.retried++;

          if (limit !== undefined && handled >= limit) return void (result.stopped = 'limit');
          if (!next()) return void (result.stopped = 'idle');

          const delayMs = Math.round(jitterMs(delaySeconds * 1000, jitterPercent, random));
          nextAt = now() + delayMs;
          try {
            await sleep(delayMs, signal);
          } finally {
            nextAt = null;
          }
        }
      });
      return result;
    } finally {
      running = false;
      ids = undefined;
      nextAt = null;
    }
  }

  return {
    drain,
    /** @returns {{running: boolean, nextAt: number|null}} nextAt: epoch ms of the next planned request while waiting. */
    state: () => ({ running, nextAt }),
  };
}
