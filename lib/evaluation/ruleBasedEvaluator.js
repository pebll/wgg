import {
  findKeyword,
  shortTermReason,
  scoreDistance,
  scoreRecency,
  scoreRent,
  scoreSize,
  scoreStayLength,
} from './scorers.js';

/**
 * Evaluator interface. An evaluator turns one listing into a score breakdown. This is the extension
 * point for other scoring strategies (see the "Evaluator extension point" section of the README):
 * a future LLM evaluator would implement the same shape, receive the same listing, and have its
 * 1-10 result merged as an additional weighted parameter, e.g. `scores.llm` with a `weights.llm`
 * entry. No LLM is called anywhere today.
 *
 * @typedef {object} EvaluationResult
 * @property {Record<string, number>} scores Parameter -> 1..10.
 * @property {number|null} overall Weighted average 1..10, one decimal; null when nothing was scorable.
 * @property {string[]} missing Parameters that could not be scored (left out of the average).
 * @property {Record<string, string>} details Parameter -> short reason.
 * @property {string} [excluded] Hard-exclusion reason; then overall is 1 (scores are still computed).
 *
 * @typedef {object} EvaluationContext
 * @property {number} [now] Epoch ms the evaluation happens at (recency is relative to it).
 *
 * @typedef {object} Evaluator
 * @property {string} name
 * @property {(listing: EvaluatedListing, context?: EvaluationContext) => EvaluationResult} evaluate
 *
 * @typedef {object} EvaluatedListing Camel-case view of a stored listing (see rowToEvaluatedListing).
 * @property {string} [title]
 * @property {string|null} [detailsRaw]
 * @property {string|null} [description] Full description from the detail page (once fetched).
 * @property {number|null} [price]
 * @property {number|null} [size]
 * @property {number|null} [wgSize]
 * @property {string|null} [availableFrom] ISO date
 * @property {string|null} [availableUntil] ISO date
 * @property {number|null} [publishedAt] Epoch ms
 * @property {number|null} [firstSeenAt] Epoch ms
 * @property {number|null} [distanceKm]
 * @property {'address'|'district'|null} [geoPrecision]
 */

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Deterministic, config-driven evaluator. Pure: no I/O, no clock besides `context.now`.
 * @implements {Evaluator}
 */
export class RuleBasedEvaluator {
  name = 'rule-based';

  /** @param {ReturnType<import('./config.js').defaultEvaluationConfig>} config */
  constructor(config) {
    this.config = config;
  }

  /**
   * @param {EvaluatedListing} listing
   * @param {EvaluationContext} [context]
   * @returns {EvaluationResult}
   */
  evaluate(listing, { now = Date.now() } = {}) {
    const c = this.config;
    const results = {
      rent: () => scoreRent(listing.price, c.rent),
      distance: () => scoreDistance(listing.distanceKm, listing.geoPrecision, c.distanceKm),
      recency: () => scoreRecency(listing.publishedAt, listing.firstSeenAt, now, c.recencyHours),
      size: () => scoreSize(listing.size, c.sizeM2),
      stayLength: () => scoreStayLength(listing.availableFrom, listing.availableUntil, now, c.stayLength),
    };

    const scores = {};
    const details = {};
    const missing = [];
    let weighted = 0;
    let totalWeight = 0;
    for (const [param, score] of Object.entries(results)) {
      const weight = c.weights[param] ?? 0;
      if (weight <= 0) continue; // disabled parameter
      const r = score();
      if (r === null) {
        missing.push(param);
        continue;
      }
      scores[param] = r.score;
      details[param] = r.detail;
      weighted += r.score * weight;
      totalWeight += weight;
    }

    const reasons = [];
    // Per-user auto-reject switches (a config without them keeps the word list on and the short-term rule off).
    const { verbindung = { enabled: true, keywords: true }, shortTerm = { enabled: false } } = c.autoReject ?? {};
    if (verbindung.enabled && verbindung.keywords) {
      const keyword = findKeyword([listing.title, listing.detailsRaw, listing.description], c.exclusions.keywords);
      if (keyword) reasons.push(`excluded keyword "${keyword}"`);
    }
    if (shortTerm.enabled) {
      const short = shortTermReason(listing.availableFrom, listing.availableUntil, now, shortTerm.minMonths);
      if (short) reasons.push(short);
    }

    const result = {
      scores,
      overall: totalWeight > 0 ? round1(weighted / totalWeight) : null,
      missing,
      details,
    };
    if (reasons.length > 0) {
      result.overall = 1;
      result.excluded = reasons.join('; ');
    }
    return result;
  }
}
