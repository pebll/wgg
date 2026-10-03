import { ConfigError } from '../errors.js';
import { parseEvaluationConfig, EvaluationConfigError } from '../evaluation/config.js';
import { parseRules } from '../notify/rules.js';
import { mergeSettings } from './defaults.js';

/** A rejected settings update; the message is shown to the user. */
export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
  }
}

export const MAX_PROFILE_LENGTH = 4000;
export const MAX_KEYWORDS = 50;
export const MAX_KEYWORD_LENGTH = 80;
export const MAX_RULES = 10;
const MAX_NAME_LENGTH = 100;
const MAX_ADDRESS_LENGTH = 200;
const MAX_NUMBER = 1_000_000;
const MAX_AGE_HOURS = 24 * 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Every key of `body` must exist in `known` (recursively for nested objects; arrays and values are left to the checks). */
function assertKnownKeys(body, known, path) {
  for (const [key, value] of Object.entries(body)) {
    const at = path ? `${path}.${key}` : key;
    if (!(key in known)) throw new SettingsError(`unknown setting "${at}"`);
    if (isObject(known[key]) && isObject(value)) assertKnownKeys(value, known[key], at);
  }
}

/** Numbers of the scoring section stay within a sane range (the evaluator only checks that they are finite). */
function assertSaneNumbers(value, path) {
  if (typeof value === 'number' && Math.abs(value) > MAX_NUMBER) throw new SettingsError(`${path} is out of range`);
  if (isObject(value)) for (const [k, v] of Object.entries(value)) assertSaneNumbers(v, `${path}.${k}`);
}

function checkScoring(scoring, evaluation) {
  assertSaneNumbers({ ...scoring, target: { lat: 0, lng: 0 } }, 'scoring');
  const { target } = scoring;
  if (typeof target.address !== 'string') throw new SettingsError('target.address must be text');
  if (target.address.length > MAX_ADDRESS_LENGTH)
    throw new SettingsError(`target.address must be at most ${MAX_ADDRESS_LENGTH} characters`);
  if (typeof target.name === 'string' && target.name.length > MAX_NAME_LENGTH) {
    throw new SettingsError(`target.name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  const { keywords } = scoring;
  if (Array.isArray(keywords)) {
    if (keywords.length > MAX_KEYWORDS) throw new SettingsError(`keywords: at most ${MAX_KEYWORDS} entries`);
    if (keywords.some((k) => typeof k === 'string' && k.length > MAX_KEYWORD_LENGTH)) {
      throw new SettingsError(`keywords: at most ${MAX_KEYWORD_LENGTH} characters each`);
    }
  }
  // The same validation as config/evaluation.yaml (ranges, weights, stay length, keywords).
  const parsed = parseEvaluationConfig({
    target: { name: target.name, lat: target.lat, lng: target.lng },
    weights: scoring.weights,
    rent: scoring.rent,
    distanceKm: scoring.distanceKm,
    sizeM2: scoring.sizeM2,
    recencyHours: scoring.recencyHours,
    stayLength: scoring.stayLength,
    exclusions: { keywords: scoring.keywords },
    llm: evaluation.llm,
    autoHide: evaluation.autoHide,
  });
  return {
    target: {
      name: parsed.target.name,
      address: target.address.trim(),
      lat: parsed.target.lat,
      lng: parsed.target.lng,
    },
    weights: parsed.weights,
    rent: parsed.rent,
    distanceKm: parsed.distanceKm,
    sizeM2: parsed.sizeM2,
    recencyHours: parsed.recencyHours,
    stayLength: parsed.stayLength,
    keywords: parsed.exclusions.keywords,
  };
}

function checkLlm(llm) {
  if (typeof llm.profile !== 'string') throw new SettingsError('llm.profile must be text');
  const profile = llm.profile.trim();
  if (profile.length > MAX_PROFILE_LENGTH)
    throw new SettingsError(`llm.profile must be at most ${MAX_PROFILE_LENGTH} characters`);
  if (typeof llm.hideIneligible !== 'boolean') throw new SettingsError('llm.hideIneligible must be true or false');
  return { profile, hideIneligible: llm.hideIneligible };
}

const MIN_STAY_MONTHS = [1, 24];
const bool = (v, path) => {
  if (typeof v !== 'boolean') throw new SettingsError(`${path} must be true or false`);
  return v;
};

function checkAutoReject(ar) {
  if (!isObject(ar.verbindung) || !isObject(ar.shortTerm)) throw new SettingsError('autoReject is incomplete');
  const { verbindung: v, shortTerm: s } = ar;
  const t = v.aiThreshold;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0.3 || t > 0.95) {
    throw new SettingsError('autoReject.verbindung.aiThreshold must be a number between 0.3 and 0.95');
  }
  const m = s.minMonths;
  if (!Number.isInteger(m) || m < MIN_STAY_MONTHS[0] || m > MIN_STAY_MONTHS[1]) {
    throw new SettingsError(`autoReject.shortTerm.minMonths must be a whole number of months between 1 and 24`);
  }
  return {
    verbindung: {
      enabled: bool(v.enabled, 'autoReject.verbindung.enabled'),
      keywords: bool(v.keywords, 'autoReject.verbindung.keywords'),
      ai: bool(v.ai, 'autoReject.verbindung.ai'),
      aiThreshold: Math.round(t * 100) / 100,
    },
    shortTerm: { enabled: bool(s.enabled, 'autoReject.shortTerm.enabled'), minMonths: m },
  };
}

function checkRules(section, name) {
  if (!isObject(section)) throw new SettingsError(`notify.${name} must be an object with rules`);
  if (Array.isArray(section.rules) && section.rules.length > MAX_RULES) {
    throw new SettingsError(`notify.${name}.rules: at most ${MAX_RULES} rules`);
  }
  try {
    return { rules: parseRules(section.rules, `notify.${name}.rules`) };
  } catch (e) {
    if (e instanceof ConfigError) throw new SettingsError(e.message);
    throw e;
  }
}

function checkNotify(notify) {
  let email = notify.email;
  if (email === undefined || email === null || (typeof email === 'string' && email.trim() === '')) email = null;
  else if (typeof email !== 'string' || email.trim().length > 254 || !EMAIL.test(email.trim())) {
    throw new SettingsError('notify.email is not a valid email address');
  } else email = email.trim();
  if (typeof notify.enabled !== 'boolean') throw new SettingsError('notify.enabled must be true or false');
  const age = notify.maxAgeHours;
  if (typeof age !== 'number' || !Number.isFinite(age) || age <= 0 || age > MAX_AGE_HOURS) {
    throw new SettingsError(`notify.maxAgeHours must be a number of hours between 0 and ${MAX_AGE_HOURS}`);
  }
  return {
    email,
    enabled: notify.enabled,
    priority: checkRules(notify.priority, 'priority'),
    bulk: checkRules(notify.bulk, 'bulk'),
    maxAgeHours: age,
  };
}

/**
 * Validates a settings update (a partial document, e.g. `{llm: {profile: "..."}}`) and returns the complete new
 * settings. Unknown keys are rejected. The target's latitude and longitude cannot be set here: they come from
 * geocoding the target address (done by the caller when the address changed). Nothing is mutated.
 *
 * @param {object} params
 * @param {unknown} params.body
 * @param {ReturnType<import('./defaults.js').defaultUserSettings>} params.current The user's current settings.
 * @param {ReturnType<import('../evaluation/config.js').defaultEvaluationConfig>} params.evaluation Global evaluation
 *   config (LLM and auto-hide sections are not editable per user).
 * @returns {ReturnType<import('./defaults.js').defaultUserSettings>}
 * @throws {SettingsError}
 */
export function validateSettingsUpdate({ body, current, evaluation }) {
  if (!isObject(body)) throw new SettingsError('The settings must be an object.');
  assertKnownKeys(body, current, '');
  const merged = mergeSettings(current, body);
  merged.scoring.target.lat = current.scoring.target.lat;
  merged.scoring.target.lng = current.scoring.target.lng;
  try {
    return {
      scoring: checkScoring(merged.scoring, evaluation),
      llm: checkLlm(merged.llm),
      autoReject: checkAutoReject(merged.autoReject),
      notify: checkNotify(merged.notify),
    };
  } catch (e) {
    if (e instanceof EvaluationConfigError) throw new SettingsError(e.message);
    throw e;
  }
}
