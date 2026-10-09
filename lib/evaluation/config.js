import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import logger from '../services/logger.js';

export const DEFAULT_EVALUATION_CONFIG_PATH = 'config/evaluation.yaml';
export const EXAMPLE_EVALUATION_CONFIG_PATH = 'config/evaluation.example.yaml';

export class EvaluationConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvaluationConfigError';
  }
}

/**
 * The AI profile a new user starts with (`llm.defaultProfile`): deliberately generic, no age, gender, city or language.
 * `llm.profile` of config/evaluation.yaml is the owner's own text and is not used for other users.
 */
export const DEFAULT_PROFILE_TEXT =
  'Looking for a room in an active, social WG with real shared life, not a Zweck-WG. ' +
  'Open-minded and international flatmates are welcome.\n';

/**
 * The default scoring target: the library of the KIT in Karlsruhe. Coordinates: OpenStreetMap / Nominatim lookup of the
 * address "Straße am Forum 1, 76131 Karlsruhe" (way 167867872, Hörsaalgebäude am Forum), (c) OpenStreetMap contributors, ODbL.
 */
export const DEFAULT_TARGET = Object.freeze({
  name: 'KIT-Bibliothek Süd',
  address: 'Straße am Forum 1, 76131 Karlsruhe',
  lat: 49.0127803,
  lng: 8.4156386,
});

/** The built-in target of earlier versions (TUM, Munich): users still on exactly this one are moved to KIT. */
export const LEGACY_TUM_TARGET = Object.freeze({
  name: 'TUM Universitätsbibliothek Stammgelände',
  lat: 48.1488833,
  lng: 11.5677668,
});

/**
 * Built-in defaults; kept identical to config/evaluation.example.yaml (a test enforces that).
 * All values are placeholders the user is expected to tune.
 */
export function defaultEvaluationConfig() {
  return {
    target: { ...DEFAULT_TARGET },
    weights: { rent: 3, distance: 3, recency: 2, size: 1.5, stayLength: 1.5 },
    rent: { best: 450, worst: 750 },
    distanceKm: { best: 1.5, worst: 10 },
    sizeM2: { worst: 9, best: 20 },
    recencyHours: { best: 0, worst: 72 },
    stayLength: { minStayDays: 90, minimumDays: 30 },
    exclusions: {
      keywords: [
        'Studentenverbindung',
        'Verbindungshaus',
        'Burschenschaft',
        'Corps',
        'Landsmannschaft',
        'Bundesbrüder',
        'Aktivitas',
      ],
    },
    llm: {
      enabled: true,
      model: '',
      weight: 2,
      excludeThreshold: 0.6,
      badgeThreshold: 0.3,
      maxDescriptionChars: 12000,
      delaySeconds: 2,
      hideIneligible: true,
      profile: DEFAULT_PROFILE_TEXT,
      defaultProfile: DEFAULT_PROFILE_TEXT,
    },
    autoHide: { belowOverall: null },
  };
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function section(raw, key, defaults) {
  const value = raw[key];
  if (value === undefined) return { ...defaults };
  if (!isObject(value)) throw new EvaluationConfigError(`"${key}" must be a mapping`);
  return { ...defaults, ...value };
}

function numbers(obj, label, keys) {
  for (const k of keys) {
    if (!isNum(obj[k])) throw new EvaluationConfigError(`${label}.${k} must be a number`);
  }
}

function scale(obj, label, bestKey = 'best', worstKey = 'worst') {
  numbers(obj, label, [bestKey, worstKey]);
  if (obj[bestKey] === obj[worstKey]) {
    throw new EvaluationConfigError(`${label}: ${bestKey} and ${worstKey} must differ`);
  }
}

/**
 * Validate a raw (already parsed) evaluation config and merge it over the defaults.
 * @param {unknown} raw
 */
export function parseEvaluationConfig(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) throw new EvaluationConfigError('Evaluation config must be a YAML mapping');
  const d = defaultEvaluationConfig();

  // Removed settings (rent cap, WG size as a scoring parameter) in older files are ignored, not rejected.
  const cfg = {
    target: section(raw, 'target', d.target),
    weights: section(raw, 'weights', d.weights),
    rent: section(raw, 'rent', d.rent),
    distanceKm: section(raw, 'distanceKm', d.distanceKm),
    sizeM2: section(raw, 'sizeM2', d.sizeM2),
    recencyHours: section(raw, 'recencyHours', d.recencyHours),
    stayLength: section(raw, 'stayLength', d.stayLength),
    exclusions: section(raw, 'exclusions', d.exclusions),
    llm: section(raw, 'llm', d.llm),
    autoHide: section(raw, 'autoHide', d.autoHide),
  };

  if (typeof cfg.target.name !== 'string') throw new EvaluationConfigError('target.name must be a string');
  // A target of the user's own file without an address is shown under its name; only the built-in one has an address.
  if (isObject(raw.target) && raw.target.address === undefined) cfg.target.address = cfg.target.name;
  if (typeof cfg.target.address !== 'string') throw new EvaluationConfigError('target.address must be a string');
  numbers(cfg.target, 'target', ['lat', 'lng']);
  if (cfg.target.lat < -90 || cfg.target.lat > 90) throw new EvaluationConfigError('target.lat must be within -90..90');
  if (cfg.target.lng < -180 || cfg.target.lng > 180) {
    throw new EvaluationConfigError('target.lng must be within -180..180');
  }

  delete cfg.rent.hardMax;
  delete cfg.weights.wgSize;
  for (const [k, v] of Object.entries(cfg.weights)) {
    if (!isNum(v) || v < 0) throw new EvaluationConfigError(`weights.${k} must be a number >= 0`);
  }
  if (!Object.values(cfg.weights).some((w) => w > 0)) {
    throw new EvaluationConfigError('weights: at least one weight must be greater than 0');
  }

  scale(cfg.rent, 'rent');
  scale(cfg.distanceKm, 'distanceKm');
  scale(cfg.sizeM2, 'sizeM2');
  scale(cfg.recencyHours, 'recencyHours');

  numbers(cfg.stayLength, 'stayLength', ['minStayDays', 'minimumDays']);
  if (cfg.stayLength.minimumDays >= cfg.stayLength.minStayDays) {
    throw new EvaluationConfigError('stayLength.minimumDays must be smaller than stayLength.minStayDays');
  }

  const kw = cfg.exclusions.keywords;
  if (!Array.isArray(kw) || !kw.every((k) => typeof k === 'string' && k.trim() !== '')) {
    throw new EvaluationConfigError('exclusions.keywords must be a list of non-empty strings');
  }
  cfg.exclusions = { keywords: kw.map((k) => k.trim()) };

  validateLlm(cfg.llm);

  const below = cfg.autoHide.belowOverall;
  if (below !== null && (!isNum(below) || below < 1 || below > 10)) {
    throw new EvaluationConfigError('autoHide.belowOverall must be null (off) or a number between 1 and 10');
  }

  return cfg;
}

function validateLlm(llm) {
  if (typeof llm.enabled !== 'boolean') throw new EvaluationConfigError('llm.enabled must be true or false');
  if (typeof llm.model !== 'string') throw new EvaluationConfigError('llm.model must be a string');
  if (!isNum(llm.weight) || llm.weight < 0) throw new EvaluationConfigError('llm.weight must be a number >= 0');
  for (const k of ['excludeThreshold', 'badgeThreshold']) {
    if (!isNum(llm[k]) || llm[k] < 0 || llm[k] > 1) {
      throw new EvaluationConfigError(`llm.${k} must be a number between 0 and 1`);
    }
  }
  if (!isNum(llm.maxDescriptionChars) || llm.maxDescriptionChars < 1000) {
    throw new EvaluationConfigError('llm.maxDescriptionChars must be a number of at least 1000');
  }
  if (!isNum(llm.delaySeconds) || llm.delaySeconds < 0) {
    throw new EvaluationConfigError('llm.delaySeconds must be a number >= 0');
  }
  if (typeof llm.hideIneligible !== 'boolean') {
    throw new EvaluationConfigError('llm.hideIneligible must be true or false');
  }
  if (typeof llm.profile !== 'string') throw new EvaluationConfigError('llm.profile must be a string');
  if (typeof llm.defaultProfile !== 'string') {
    throw new EvaluationConfigError('llm.defaultProfile must be a string');
  }
}

function readYaml(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    return parseYaml(text) ?? {};
  } catch (e) {
    throw new EvaluationConfigError(`Invalid YAML in ${filePath}: ${e.message}`);
  }
}

/**
 * Load config/evaluation.yaml; when it does not exist, use config/evaluation.example.yaml and warn.
 * @param {string} [filePath]
 * @param {{warn?: (message: string) => void, examplePath?: string}} [options]
 */
export function loadEvaluationConfig(
  filePath = DEFAULT_EVALUATION_CONFIG_PATH,
  { warn = (m) => logger.warn(m), examplePath = EXAMPLE_EVALUATION_CONFIG_PATH } = {},
) {
  const raw = readYaml(filePath);
  if (raw !== undefined) return parseEvaluationConfig(raw);
  warn(`${filePath} not found: using ${examplePath}. Copy it to ${filePath} and tune it.`);
  return parseEvaluationConfig(readYaml(examplePath));
}
