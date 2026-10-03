import { refusalMessage } from './format.js';

// Limits mirror lib/settings/validate.js and lib/queries (the server stays the authority; this saves a round trip).
const MAX_PROFILE_LENGTH = 4000;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_LENGTH = 80;
const MAX_QUERY_NAME_LENGTH = 100;
const MAX_AGE_HOURS = 24 * 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// ---- notification thresholds <-> rules ----

const onlyGt = (condition) => isObject(condition) && Object.keys(condition).join() === 'gt' && isNum(condition.gt);

/**
 * The two "Score >" / "AI score >" fields of a rule list. Only the shape the form can write back is "simple": no rule,
 * or one rule with `overall` and/or `ai` conditions that are all `gt`. Anything else is shown read-only.
 * @param {unknown} rules
 * @returns {{simple: true, score: number|null, ai: number|null}|{simple: false}}
 */
export function rulesToThresholds(rules) {
  if (!Array.isArray(rules)) return { simple: false };
  if (rules.length === 0) return { simple: true, score: null, ai: null };
  if (rules.length > 1 || !isObject(rules[0])) return { simple: false };
  const [rule] = rules;
  const fields = Object.keys(rule);
  if (fields.length === 0 || fields.some((f) => f !== 'overall' && f !== 'ai')) return { simple: false };
  if (!fields.every((f) => onlyGt(rule[f]))) return { simple: false };
  return { simple: true, score: rule.overall?.gt ?? null, ai: rule.ai?.gt ?? null };
}

/** The rule list for the two threshold fields; an empty field has no condition, no fields no rule (no alerts). */
export function thresholdsToRules({ score, ai }) {
  const rule = {};
  if (isNum(score)) rule.overall = { gt: score };
  if (isNum(ai)) rule.ai = { gt: ai };
  return Object.keys(rule).length > 0 ? [rule] : [];
}

// ---- validation: each returns user-readable messages ----

/** @returns {string|null} */
export function validateQueryForm({ url, name = '' }) {
  const text = String(url ?? '').trim();
  if (text === '') return 'Paste the address of your WG-Gesucht search result page.';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return 'This is not a web address. Paste the full address of a wg-gesucht.de results page.';
  }
  if (parsed.protocol !== 'https:') return 'The address must start with https://.';
  if (parsed.hostname !== 'www.wg-gesucht.de') return 'Only www.wg-gesucht.de addresses work.';
  if (String(name).trim().length > MAX_QUERY_NAME_LENGTH) {
    return `The name can have at most ${MAX_QUERY_NAME_LENGTH} characters.`;
  }
  return null;
}

/** @returns {string|null} */
export function validateProfile(text) {
  return String(text ?? '').trim().length > MAX_PROFILE_LENGTH
    ? `The profile can have at most ${MAX_PROFILE_LENGTH} characters.`
    : null;
}

/** @returns {string[]} */
export function validateNotifyForm({ email, maxAgeHours, priority, bulk }) {
  const errors = [];
  const mail = String(email ?? '').trim();
  if (mail !== '' && (mail.length > 254 || !EMAIL.test(mail))) errors.push('Enter a valid email address.');
  if (!isNum(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > MAX_AGE_HOURS) {
    errors.push(`Maximum age must be between 1 and ${MAX_AGE_HOURS} hours.`);
  }
  for (const [name, section] of [
    ['Fantastic', priority],
    ['Good', bulk],
  ]) {
    if (section?.simple === false) continue;
    for (const value of [section?.score, section?.ai]) {
      if (isNum(value) && (value < 0 || value > 10)) {
        errors.push(`${name} thresholds must be between 0 and 10.`);
        break;
      }
    }
  }
  return errors;
}

const SCALES = [
  ['Rent', 'rent', 'best', 'worst'],
  ['Size', 'sizeM2', 'best', 'worst'],
  ['Distance', 'distanceKm', 'best', 'worst'],
  ['Recency', 'recencyHours', 'best', 'worst'],
];

/** @returns {string[]} */
export function validateScoringForm({ target, rent, sizeM2, distanceKm, recencyHours, stayLength, weights, keywords }) {
  const errors = [];
  if (String(target?.address ?? '').trim() === '') errors.push('Enter a target address.');
  const ranges = { rent, sizeM2, distanceKm, recencyHours };
  for (const [label, key, best, worst] of SCALES) {
    const range = ranges[key] ?? {};
    if (!isNum(range[best]) || !isNum(range[worst])) errors.push(`${label}: best and worst must be numbers.`);
    else if (range[best] === range[worst]) errors.push(`${label}: best and worst must differ.`);
  }
  const w = Object.values(weights ?? {});
  if (w.some((v) => !isNum(v) || v < 0)) errors.push('Weights must be numbers >= 0.');
  else if (!w.some((v) => v > 0)) errors.push('At least one weight must be greater than 0.');
  const { minStayDays, minimumDays } = stayLength ?? {};
  if (!isNum(minStayDays) || !isNum(minimumDays)) errors.push('Stay length: both values must be numbers.');
  else if (minimumDays >= minStayDays) errors.push('Stay length: the minimum must be smaller than the wanted stay.');
  if ((keywords ?? []).length > MAX_KEYWORDS) errors.push(`At most ${MAX_KEYWORDS} keywords.`);
  if ((keywords ?? []).some((k) => String(k).length > MAX_KEYWORD_LENGTH)) {
    errors.push(`Keywords can have at most ${MAX_KEYWORD_LENGTH} characters each.`);
  }
  return errors;
}

// ---- auto-reject ----

/** Slider bounds of the auto-reject section (the server enforces the same limits). */
export const AUTO_REJECT_SLIDERS = {
  threshold: { min: 0.3, max: 0.95, step: 0.05 },
  months: { min: 1, max: 24, step: 1 },
};

/** PUT /api/settings body for the auto-reject form (its state is the settings section itself). */
export function autoRejectBody(form) {
  return { autoReject: form };
}

/** @returns {string[]} */
export function validateAutoRejectForm({ verbindung, shortTerm }) {
  const errors = [];
  const { min: tMin, max: tMax } = AUTO_REJECT_SLIDERS.threshold;
  if (!isNum(verbindung?.aiThreshold) || verbindung.aiThreshold < tMin || verbindung.aiThreshold > tMax) {
    errors.push(`The AI confidence must be between ${Math.round(tMin * 100)} % and ${Math.round(tMax * 100)} %.`);
  }
  const { min: mMin, max: mMax } = AUTO_REJECT_SLIDERS.months;
  if (!Number.isInteger(shortTerm?.minMonths) || shortTerm.minMonths < mMin || shortTerm.minMonths > mMax) {
    errors.push(`The minimum stay must be a whole number of months between ${mMin} and ${mMax}.`);
  }
  return errors;
}

// ---- fetch after a query change ----

/**
 * What to tell the user when the automatic first fetch of a new or changed query was refused. The guards (a fetch is
 * already running, fetched too recently) are no failure: the query is saved and the scheduler fetches it anyway.
 * @param {{status?: number, json?: {error?: string, retryAfterSeconds?: number}}} rejection
 * @returns {{level: 'info'|'error', message: string}}
 */
export function queryFetchNotice(rejection) {
  const message = refusalMessage(rejection);
  if (rejection?.status === 409 || rejection?.status === 429) {
    return { level: 'info', message: `${message} Your query is saved and is fetched automatically.` };
  }
  return { level: 'error', message };
}

// ---- settings documents <-> form state ----

/** The notification fields of GET /api/settings as form state. */
export function notifyToForm(notify) {
  return {
    email: notify.email ?? '',
    enabled: Boolean(notify.enabled),
    maxAgeHours: notify.maxAgeHours,
    priority: rulesToThresholds(notify.priority?.rules),
    bulk: rulesToThresholds(notify.bulk?.rules),
    priorityEnabled: notify.priority?.enabled !== false,
    bulkEnabled: notify.bulk?.enabled !== false,
  };
}

/** PUT /api/settings body for the notification form; rules the form cannot express are not sent (they stay as they are). */
export function notifyBody(form) {
  const notify = {
    email: form.email.trim() === '' ? null : form.email.trim(),
    enabled: form.enabled,
    maxAgeHours: form.maxAgeHours,
  };
  notify.priority = { enabled: form.priorityEnabled };
  notify.bulk = { enabled: form.bulkEnabled };
  if (form.priority.simple) notify.priority.rules = thresholdsToRules(form.priority);
  if (form.bulk.simple) notify.bulk.rules = thresholdsToRules(form.bulk);
  return { notify };
}

/** The scoring parameters that carry a weight (the weights form and the pie chart use this order). */
export const WEIGHT_KEYS = ['rent', 'distance', 'recency', 'size', 'stayLength'];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

// ---- scoring sliders ----

/**
 * Range sliders of the scoring form. A range has two handles: `low` and `high` name the settings behind the left and
 * the right handle ("best" is the left one for rent, distance and recency: less is better; the right one for size).
 */
export const SLIDER_SPECS = {
  rent: { min: 200, max: 1500, step: 10, unit: '€', low: 'best', high: 'worst' },
  sizeM2: { min: 5, max: 40, step: 1, unit: 'm²', low: 'worst', high: 'best' },
  distanceKm: { min: 0, max: 30, step: 0.5, unit: 'km', low: 'best', high: 'worst' },
  recencyHours: { min: 1, max: 168, step: 1, unit: 'h', low: 'best', high: 'worst' },
  stayLength: { min: 0, max: 1095, step: 30, unit: 'days', low: 'minimumDays', high: 'minStayDays' },
};

/** Weights are single sliders. */
export const WEIGHT_SLIDER = { min: 0, max: 5, step: 0.5 };

const LABELS = { best: 'best', worst: 'worst', minimumDays: 'shortest acceptable', minStayDays: 'wanted' };
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * The handle positions `[left, right]` of a range: ordered and clamped into the slider's bounds (a stored value outside
 * them shows at the nearest end; it is kept until the user moves the handle).
 */
export function rangeToSlider(range, { min, max, low, high }) {
  const at = (key, fallback) => (isNum(range?.[key]) ? clamp(range[key], min, max) : fallback);
  const [a, b] = [at(low, min), at(high, max)];
  return a <= b ? [a, b] : [b, a];
}

/** The two settings a slider position stands for. */
export function sliderToRange([left, right], { low, high }) {
  return { [low]: left, [high]: right };
}

/** "Best 450 €, worst 750 €" for the text next to a range slider. */
export function describeRange(range, { low, high, unit }) {
  const part = (key) => `${LABELS[key]} ${isNum(range?.[key]) ? `${range[key]} ${unit}` : '-'}`;
  const text = `${part(low)}, ${part(high)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The editable scoring fields as form state (a copy; coordinates are not edited here, removed settings are dropped). */
export function scoringToForm(scoring) {
  return {
    target: { name: scoring.target.name ?? '', address: scoring.target.address ?? '' },
    rent: pick(scoring.rent, ['best', 'worst']),
    sizeM2: { ...scoring.sizeM2 },
    distanceKm: { ...scoring.distanceKm },
    recencyHours: { ...scoring.recencyHours },
    stayLength: { ...scoring.stayLength },
    weights: pick(scoring.weights, WEIGHT_KEYS),
    keywords: [...scoring.keywords],
  };
}

/** PUT /api/settings body for the scoring form. The coordinates come from the server (it geocodes the address). */
export function scoringBody(form) {
  const target = { address: form.target.address.trim() };
  if (form.target.name.trim() !== '') target.name = form.target.name.trim();
  return {
    scoring: {
      target,
      rent: form.rent,
      sizeM2: form.sizeM2,
      distanceKm: form.distanceKm,
      recencyHours: form.recencyHours,
      stayLength: form.stayLength,
      weights: form.weights,
      keywords: form.keywords.map((k) => k.trim()).filter((k) => k !== ''),
    },
  };
}
