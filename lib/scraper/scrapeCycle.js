import { fetchListings } from '../provider/wgGesucht.js';
import { storeNewListings } from '../services/listings/listingsStorage.js';
import { startFetchRun, finishFetchRun, recordFailedRun } from '../services/status/fetchStatus.js';
import { BotDetectedError } from '../errors.js';
import logger from '../services/logger.js';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run one scrape cycle over all configured searches, strictly sequentially, with a small random
 * pause between them. New listings are stored (deduped on the WG-Gesucht id) and returned.
 *
 * The cycle is recorded in fetch_runs (start, finish, counts) for the dashboard status.
 *
 * Bot detection aborts the rest of the cycle (the other searches would hit the same wall) and is
 * flagged in the result so the scheduler can back off. Other errors are recorded and the cycle
 * continues with the next search.
 *
 * @param {object} params
 * @param {{searches?: {name: string, url: string}[], schedule: {delayBetweenSearchesSeconds: [number, number]}}} params.config
 * @param {{name: string, url: string}[]|(() => {name: string, url: string}[])} [params.searches] What to search (a
 *   function is called when the cycle starts, so queries users changed meanwhile apply). Default: `config.searches`.
 *   `wgg` passes the distinct enabled queries of all users (see listEnabledSearches).
 * @param {(url: string) => Promise<string>} params.fetchHtml Loads a page and returns its HTML.
 * @param {(search: {name: string, url: string}) => void} [params.onSearched] Called after each search was tried (success or
 *   not): `wgg` records the time so the round robin over many URLs knows who waited longest.
 * @param {(ms: number) => Promise<void>} [params.sleep]
 * @param {() => number} [params.random]
 * @param {(listings: import('../provider/wgGesucht.js').Listing[]) => Promise<unknown>} [params.enrich] Called with
 *   each search's newly stored listings (geocoding + evaluation). A failure is logged and never fails the cycle.
 * @returns {Promise<{
 *   newListings: {search: {name: string, url: string}, listing: import('../provider/wgGesucht.js').Listing}[],
 *   errors: {search: {name: string, url: string}, error: Error}[],
 *   botDetected: boolean,
 *   searchesRun: number,
 * }>}
 */
export async function runScrapeCycle(params) {
  const runId = startFetchRun();
  let result = null;
  let crash = null;
  try {
    result = await scrapeAllSearches(params);
    return result;
  } catch (error) {
    crash = error;
    throw error;
  } finally {
    finishFetchRun(runId, {
      newCount: result?.newListings.length ?? 0,
      errorCount: result ? result.errors.length : 1,
      botDetected: result?.botDetected ?? false,
      error: crash ? crash.message : (result?.errors[0]?.error.message ?? null),
    });
  }
}

/**
 * Runs one cycle through a fetcher provider (`withFetcher(fn)` launches the browser and calls
 * `fn(fetchHtml)`). A failure before the cycle starts, such as the browser not launching, would leave no
 * trace in fetch_runs, so it is recorded here as a failed run; failures after the start are recorded by
 * runScrapeCycle itself. The error is rethrown either way.
 *
 * @param {object} params Everything runScrapeCycle takes except `fetchHtml`, plus:
 * @param {(fn: (fetchHtml: (url: string) => Promise<string>) => Promise<any>) => Promise<any>} params.withFetcher
 */
export async function runCycleWithFetcher({ withFetcher, ...cycleParams }) {
  let started = false;
  try {
    return await withFetcher((fetchHtml) => {
      started = true;
      return runScrapeCycle({ ...cycleParams, fetchHtml });
    });
  } catch (error) {
    if (!started) recordFailedRun(error);
    throw error;
  }
}

async function scrapeAllSearches({
  config,
  searches,
  onSearched,
  fetchHtml,
  sleep = defaultSleep,
  random = Math.random,
  enrich,
}) {
  const [minDelay, maxDelay] = config.schedule.delayBetweenSearchesSeconds;
  const newListings = [];
  const errors = [];
  let botDetected = false;
  let searchesRun = 0;

  const wanted = typeof searches === 'function' ? searches() : (searches ?? config.searches);
  for (const [index, search] of wanted.entries()) {
    if (index > 0) {
      await sleep(Math.round((minDelay + random() * (maxDelay - minDelay)) * 1000));
    }
    searchesRun++;
    try {
      onSearched?.(search);
      logger.info(`Searching "${search.name}"`);
      const found = await fetchListings(search.url, { fetchHtml });
      const fresh = storeNewListings(found, search.url);
      logger.info(`"${search.name}": ${found.length} listings, ${fresh.length} new`);
      if (enrich && fresh.length > 0) {
        try {
          await enrich(fresh);
        } catch (e) {
          logger.error(`"${search.name}": evaluating new listings failed: ${e.message}`);
        }
      }
      for (const listing of fresh) newListings.push({ search, listing });
    } catch (error) {
      errors.push({ search, error });
      if (error instanceof BotDetectedError) {
        logger.warn(`"${search.name}": ${error.message}. Aborting this cycle.`);
        botDetected = true;
        break;
      }
      logger.error(`"${search.name}": failed: ${error.message}`);
    }
  }

  return { newListings, errors, botDetected, searchesRun };
}
