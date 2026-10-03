import { locateListing } from '../geocoding/locate.js';
import { haversineKm } from '../geocoding/distance.js';
import { createCityAnchors } from '../geocoding/city.js';
import {
  selectRowsForEvaluation,
  updateListingGeo,
  updateListingEvaluation,
} from '../services/listings/listingsStorage.js';
import { mergeLlm } from './llmEvaluator.js';
import { parseFlatmatesJson } from '../services/listings/listingsStorage.js';
import { refreshTiers } from '../notify/tierStorage.js';
import logger from '../services/logger.js';

/**
 * Camel-case view of a stored row, as the evaluators expect it.
 * @param {object} row
 * @returns {import('./ruleBasedEvaluator.js').EvaluatedListing}
 */
export function rowToEvaluatedListing(row) {
  let page = {};
  try {
    page = JSON.parse(row.detail_page_json ?? '{}') ?? {};
  } catch {
    // unreadable detail JSON: treat as absent
  }
  return {
    title: row.title,
    link: row.link,
    onlineRaw: row.online_raw,
    detail: {
      costs: page.costs ?? [],
      address: page.address ?? null,
      availabilityRaw: page.availabilityRaw ?? null,
      onlineRaw: page.onlineRaw ?? null,
      wgFacts: page.wgFacts ?? [],
      objectFacts: page.objectFacts ?? [],
    },
    detailsRaw: row.details_raw,
    description: row.description_text,
    price: row.price,
    size: row.size,
    wgSize: row.wg_size,
    flatmates: parseFlatmatesJson(row.flatmates_json),
    district: row.district,
    street: row.street,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    distanceKm: row.distance_km,
    geoPrecision: row.geo_precision,
  };
}

/**
 * Rule-based evaluation of a stored row, merged with its stored LLM assessment (when there is one), so a re-evaluation
 * (new details, `wgg evaluate`) never drops the `llm` parameter or the LLM exclusion.
 *
 * @param {object} row
 * @param {import('./ruleBasedEvaluator.js').Evaluator & {config?: object}} evaluator
 * @param {number} now
 * @returns {import('./ruleBasedEvaluator.js').EvaluationResult}
 */
export function evaluateRow(row, evaluator, now) {
  const rule = evaluator.evaluate(rowToEvaluatedListing(row), { now });
  if (row.llm_status !== 'done' || !row.llm_json || !evaluator.config?.llm) return rule;
  let assessment = null;
  try {
    assessment = JSON.parse(row.llm_json);
  } catch {
    return rule;
  }
  return mergeLlm(rule, assessment, evaluator.config);
}

/**
 * Stores an evaluation result for one user and applies the program's hiding rule (exclusions, optional
 * `autoHide.belowOverall`).
 * @param {string} userId
 * @param {number} id
 * @param {import('./ruleBasedEvaluator.js').EvaluationResult} result
 * @param {{config?: {autoHide?: {belowOverall: number|null}}}} evaluator
 * @param {number} now
 * @param {{distanceKm?: number|null}} [options] Distance to this user's target, stored with the evaluation.
 */
export function storeEvaluation(userId, id, result, evaluator, now, { distanceKm } = {}) {
  updateListingEvaluation(userId, id, result, now, {
    autoHideBelow: evaluator.config?.autoHide?.belowOverall ?? null,
    distanceKm,
  });
}

/**
 * Distance in km from a user's target to a listing, from the listing's (global) coordinates; null when unknown.
 * @param {{lat: number|null, lng: number|null}} row
 * @param {{lat: number, lng: number}} target
 */
export function distanceToTarget(row, target) {
  return typeof row.lat === 'number' && typeof row.lng === 'number' ? haversineKm(target, row) : null;
}

/**
 * Evaluates one user's row: distance to the user's own target, rule-based score (merged with the user's stored AI
 * assessment), stored on the user's row.
 * @param {import('../users/directory.js').UserContext} ctx
 * @param {object} row The user's view of the listing (see selectRowsForEvaluation).
 * @param {number} now
 * @returns {import('./ruleBasedEvaluator.js').EvaluationResult}
 */
export function evaluateForUser(ctx, row, now) {
  const distanceKm = distanceToTarget(row, ctx.target);
  const result = evaluateRow({ ...row, distance_km: distanceKm }, ctx.evaluator, now);
  storeEvaluation(ctx.userId, row.id, result, ctx.evaluator, now, { distanceKm });
  // The overall score may have changed: the alert tier follows (contexts without settings, as in some tests, have none).
  if (ctx.settings?.notify) {
    refreshTiers(ctx.userId, { notify: ctx.settings.notify, llmHash: ctx.llmHash }, { listingId: row.id });
  }
  return result;
}

const resolveContexts = (contexts) => (typeof contexts === 'function' ? contexts() : contexts);

/**
 * Geocodes (when needed, once per listing for everybody) and evaluates stored listings for every user, one after
 * another (the geocoder is serial and rate-limited anyway). A failure on one row is logged and does not stop the others.
 *
 * Geocoding is global: the place of a listing is the same for all users, the distance is computed per user from the
 * user's own target. Only the user's view is evaluated (listings found by their enabled queries, plus their hidden ones).
 *
 * @param {object} deps
 * @param {import('../users/directory.js').UserContext[]|(() => import('../users/directory.js').UserContext[])} deps.contexts
 * @param {import('../geocoding/geocoder.js').Geocoder} deps.geocoder
 * @param {string[]} [deps.userIds] Only these users (default: all).
 * @param {boolean} [deps.regeocode] Geocode every row, not only rows without geo data.
 * @param {boolean} [deps.onlyUnevaluated] Only rows a user has no evaluation for yet.
 * @param {string[]} [deps.providerIds] Only these listings.
 * @param {number} [deps.now]
 * @returns {Promise<{evaluated: number, geocoded: number, failed: number}>} `evaluated` counts (user, listing) pairs.
 */
export async function evaluateForUsers({
  contexts,
  userIds,
  geocoder,
  regeocode = false,
  onlyUnevaluated = false,
  providerIds,
  now = Date.now(),
}) {
  const stats = { evaluated: 0, geocoded: 0, failed: 0 };
  const users = resolveContexts(contexts).filter((ctx) => !userIds || userIds.includes(ctx.userId));
  const select = (ctx) => selectRowsForEvaluation({ userId: ctx.userId, onlyUnevaluated, providerIds });

  // Phase 1, global: the place of every listing some user needs evaluated.
  const anchors = createCityAnchors(geocoder);
  const needed = new Map();
  for (const ctx of users) for (const row of select(ctx)) needed.set(row.id, row);
  const failedIds = new Set();
  for (const row of needed.values()) {
    if (!(regeocode || (row.lat === null && row.geo_precision === null))) continue;
    try {
      const { city, point } = await anchors.forUrl(row.search_url);
      const geo = await locateListing(
        { street: row.street, district: row.district },
        { geocoder, target: point, city },
      );
      updateListingGeo(row.id, geo);
      stats.geocoded++;
    } catch (e) {
      failedIds.add(row.id);
      stats.failed++;
      logger.error(`Geocoding listing ${row.provider_id} failed: ${e.message}`);
    }
  }

  // Phase 2, per user: the rows are read again so they carry the fresh coordinates.
  for (const ctx of users) {
    for (const row of select(ctx)) {
      if (failedIds.has(row.id)) continue;
      try {
        evaluateForUser(ctx, row, now);
        stats.evaluated++;
      } catch (e) {
        stats.failed++;
        logger.error(`Evaluation of listing ${row.provider_id} for ${ctx.userId} failed: ${e.message}`);
      }
    }
  }
  return stats;
}

/**
 * Re-evaluates stored listings for all users (the `wgg evaluate` command).
 * @param {Parameters<typeof evaluateForUsers>[0] & {all?: boolean}} deps
 */
export function evaluateStoredListings({ all = false, ...deps }) {
  return evaluateForUsers({ ...deps, onlyUnevaluated: !all });
}

/**
 * Evaluates what no user has an evaluation for yet (freshly stored listings, and listings that just came into a user's
 * view because they added a query). Used by the scrape cycle.
 * @param {Parameters<typeof evaluateForUsers>[0]} deps
 */
export function evaluatePending(deps) {
  return evaluateForUsers({ ...deps, onlyUnevaluated: true });
}

/**
 * Evaluates freshly stored listings for all users.
 * @param {{providerId: string}[]} listings
 * @param {Parameters<typeof evaluateForUsers>[0]} deps
 */
export function evaluateNewListings(listings, deps) {
  return evaluateForUsers({ ...deps, providerIds: listings.map((l) => l.providerId) });
}
