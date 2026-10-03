import { abortableSleep } from '../scheduler/scheduler.js';
import {
  selectLlmQueue,
  getUserListing,
  recordLlmResult,
  recordLlmFailure,
  markLlmSkipped,
} from '../services/listings/listingsStorage.js';
import { evaluateRow, rowToEvaluatedListing, storeEvaluation, distanceToTarget } from '../evaluation/pipeline.js';
import { refreshTiers } from '../notify/tierStorage.js';
import { redact } from './client.js';
import logger from '../services/logger.js';

/**
 * @typedef {object} LlmDrainResult
 * @property {number} done Listings assessed and merged.
 * @property {number} failed Failed attempts (the rule-based result stays; the error is stored).
 * @property {number} skipped Listings not sent (excluded by the rules, or no description).
 * @property {'idle'|'limit'|'aborted'} stopped
 *
 * @typedef {object} LlmUser What the worker needs for one user.
 * @property {string} userId
 * @property {import('../evaluation/ruleBasedEvaluator.js').Evaluator & {config: object}} ruleEvaluator The user's rules.
 * @property {import('../evaluation/llmEvaluator.js').LlmEvaluator} llmEvaluator Built with the user's profile.
 * @property {string} settingsHash Fingerprint of prompt version, the user's profile and the model.
 * @property {{lat: number, lng: number}} [target] The user's target (distance for the re-merged evaluation).
 * @property {{priority: object, bulk: object}} [notify] The user's alert rules: with them the listing's alert tier is
 *   stored after the assessment (see lib/notify/tierStorage.js).
 */

/**
 * The LLM queue worker. Serial: one call at a time, `llm.delaySeconds` between two calls. It talks to the LLM
 * gateway only, never to WG-Gesucht, so it does not take the fetch lock. The queue holds (user, listing) pairs: every
 * user's listings are assessed with THAT user's profile, ordered by that user's rule score, and the users' queues are
 * taken in turns so a long queue of one user does not starve the others. A listing the user's rules already exclude is
 * skipped (saves tokens). On failure the error is stored (redacted) and the listing keeps its rule-based result.
 *
 * @param {object} params
 * @param {() => LlmUser[]} params.users The users to serve, read at the start of every drain (settings changes apply).
 * @param {{delaySeconds: number}} params.config The `llm` section.
 * @param {string[]} [params.secrets] Strings to mask in stored error messages (the API key).
 * @param {number} [params.maxAttempts]
 * @param {(userId: string, providerId: string) => Promise<unknown>|unknown} [params.onAssessed] Called after an assessment
 *   was stored and merged into the evaluation (the priority email alert); errors are logged and never fail the assessment.
 */
export function createLlmWorker({
  users,
  config,
  secrets = [],
  maxAttempts = 3,
  onAssessed = null,
  sleep = abortableSleep,
  now = Date.now,
  log = logger,
}) {
  let running = false;

  /**
   * `beforeCall` runs right before an actual LLM call (never for skipped listings): the pause between two calls.
   * @param {LlmUser} user
   * @returns {Promise<'done'|'failed'|'skipped'>}
   */
  async function processOne(user, queued, beforeCall) {
    const { userId, ruleEvaluator, llmEvaluator, settingsHash } = user;
    const row = getUserListing(userId, queued.provider_id);
    if (!row.description_text) {
      markLlmSkipped(userId, row.id, 'no description');
      return 'skipped';
    }
    const withDistance = (r) => ({ ...r, distance_km: user.target ? distanceToTarget(r, user.target) : r.distance_km });
    const rule = ruleEvaluator.evaluate(rowToEvaluatedListing(withDistance(row)), { now: now() });
    if (rule.excluded) {
      markLlmSkipped(userId, row.id, `excluded by rules: ${rule.excluded}`.slice(0, 300));
      return 'skipped';
    }
    try {
      await beforeCall();
      const { assessment } = await llmEvaluator.evaluate(rowToEvaluatedListing(withDistance(row)), { now: now() });
      recordLlmResult(userId, row.id, { ...assessment, settingsHash }, now());
    } catch (error) {
      recordLlmFailure(userId, row.id, redact(error.message, secrets));
      log.warn(`LLM assessment of listing ${row.provider_id} for ${userId} failed: ${redact(error.message, secrets)}`);
      return 'failed';
    }
    try {
      const fresh = withDistance(getUserListing(userId, row.provider_id));
      storeEvaluation(userId, row.id, evaluateRow(fresh, ruleEvaluator, now()), ruleEvaluator, now(), {
        distanceKm: fresh.distance_km,
      });
      if (user.notify) refreshTiers(userId, { notify: user.notify, llmHash: settingsHash }, { listingId: row.id });
    } catch (error) {
      log.error(`Merging the LLM result of listing ${row.provider_id} for ${userId} failed: ${error.message}`);
    }
    if (onAssessed) {
      try {
        await onAssessed(userId, row.provider_id);
      } catch (error) {
        log.error(`After-assessment hook of listing ${row.provider_id} failed: ${error.message}`);
      }
    }
    return 'done';
  }

  /** The users' queues merged in turns: first of each user, second of each user, ... */
  function interleavedQueue(served, { ids, force, limit }) {
    const queues = served.map((user) => ({
      user,
      rows: selectLlmQueue({ userId: user.userId, ids, force, limit, maxAttempts, settingsHash: user.settingsHash }),
    }));
    const merged = [];
    for (let i = 0; queues.some((q) => i < q.rows.length); i++) {
      for (const q of queues) if (i < q.rows.length) merged.push({ user: q.user, row: q.rows[i] });
    }
    return limit ? merged.slice(0, limit) : merged;
  }

  /**
   * @param {{ids?: string[], force?: boolean, limit?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<LlmDrainResult & {running?: boolean}>}
   */
  async function drain({ ids, force = false, limit, signal } = {}) {
    const result = { done: 0, failed: 0, skipped: 0, stopped: 'idle' };
    if (running) return { ...result, running: true };
    if (signal?.aborted) return { ...result, stopped: 'aborted' };
    running = true;
    try {
      const queue = interleavedQueue(users(), { ids, force, limit });
      let calls = 0;
      for (const { user, row } of queue) {
        if (signal?.aborted) {
          result.stopped = 'aborted';
          break;
        }
        const outcome = await processOne(user, row, async () => {
          if (calls++ > 0) await sleep(Math.round(config.delaySeconds * 1000), signal);
        });
        result[outcome]++;
      }
      return result;
    } finally {
      running = false;
    }
  }

  return { drain, state: () => ({ running }) };
}
