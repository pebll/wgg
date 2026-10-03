/**
 * Per-user settings: the defaults (derived from the global config files), merging a stored document over them, and the
 * evaluation config a user's settings produce.
 *
 * Shape (the document stored in user_settings, also what GET/PUT /api/settings exchange):
 *   scoring: { target: {name, address, lat, lng}, weights, rent: {best, worst}, distanceKm: {best, worst},
 *              sizeM2: {worst, best}, recencyHours: {best, worst},
 *              stayLength: {minStayDays, minimumDays}, keywords: string[] }
 *   llm:     { profile, hideIneligible }
 *   autoReject: { verbindung: {enabled, keywords, ai, aiThreshold}, shortTerm: {enabled, minMonths} }
 *   notify:  { email, enabled, priority: {enabled, rules, window: {from, to}},
 *            bulk: {enabled, rules, window: {from, to}, intervalHours}, maxAgeHours }
 * Everything not listed here (LLM model, thresholds, delays) stays global, in config/evaluation.yaml and .env.
 */

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * The settings a new user starts with: config/evaluation.yaml (which holds the admin's profile text) and the `notify`
 * section of config/wgg.yaml.
 * @param {{evaluation: ReturnType<import('../evaluation/config.js').defaultEvaluationConfig>,
 *   notify: ReturnType<import('../config.js').parseConfig>['notify'], email?: string|null}} sources
 */
export function defaultUserSettings({ evaluation, notify, email = null }) {
  const e = clone(evaluation);
  return {
    scoring: {
      target: { name: e.target.name, address: e.target.name, lat: e.target.lat, lng: e.target.lng },
      weights: e.weights,
      rent: e.rent,
      distanceKm: e.distanceKm,
      sizeM2: e.sizeM2,
      recencyHours: e.recencyHours,
      stayLength: e.stayLength,
      keywords: e.exclusions.keywords,
    },
    llm: { profile: e.llm.profile, hideIneligible: e.llm.hideIneligible },
    autoReject: {
      verbindung: { enabled: true, keywords: true, ai: true, aiThreshold: e.llm.excludeThreshold },
      shortTerm: { enabled: false, minMonths: 6 },
    },
    notify: {
      email,
      enabled: true,
      priority: { enabled: true, ...clone(notify.priority) },
      bulk: { enabled: true, ...clone(notify.bulk) },
      maxAgeHours: notify.maxAgeHours,
    },
  };
}

/** Deep-merges `stored` over `defaults` (objects merge, everything else, arrays included, is replaced). */
export function mergeSettings(defaults, stored) {
  if (!isObject(stored)) return clone(defaults);
  const out = {};
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(stored)])) {
    if (isObject(defaults[key]) && isObject(stored[key])) out[key] = mergeSettings(defaults[key], stored[key]);
    else out[key] = clone(stored[key] !== undefined ? stored[key] : defaults[key]);
  }
  return out;
}

/**
 * The evaluation config for one user: the global one with the user's scoring target / ranges / weights / keywords and
 * AI profile put in.
 * @param {ReturnType<import('../evaluation/config.js').defaultEvaluationConfig>} base
 * @param {ReturnType<typeof defaultUserSettings>} settings
 */
export function buildEvaluationConfig(base, settings) {
  const { scoring, llm, autoReject } = settings;
  const { name, lat, lng } = scoring.target;
  return {
    ...base,
    target: { name, lat, lng },
    weights: { ...scoring.weights },
    rent: { ...scoring.rent },
    distanceKm: { ...scoring.distanceKm },
    sizeM2: { ...scoring.sizeM2 },
    recencyHours: { ...scoring.recencyHours },
    stayLength: { ...scoring.stayLength },
    exclusions: { keywords: [...scoring.keywords] },
    llm: { ...base.llm, profile: llm.profile, hideIneligible: llm.hideIneligible },
    autoReject: { verbindung: { ...autoReject.verbindung }, shortTerm: { ...autoReject.shortTerm } },
  };
}
