import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './errors.js';
import { parseRules } from './notify/rules.js';

export const DEFAULT_CONFIG_PATH = 'config/wgg.yaml';

/**
 * The project root: the directory that holds package.json, derived from where wgg is installed (not from
 * the working directory). A relative `db` path in the config is resolved against it, so the same database
 * is used no matter where `wgg` is started from.
 */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_HOSTS = ['www.wg-gesucht.de', 'wg-gesucht.de'];

const DEFAULTS = {
  dbPath: './db/wgg.db',
  schedule: {
    intervalMinutes: 30,
    jitterPercent: 20,
    maxBackoffMinutes: 60,
    delayBetweenSearchesSeconds: [5, 15],
    manualFetchMinGapSeconds: 600,
  },
  // Detail pages: one request at a time, delaySeconds +/- jitterPercent apart (30-90 s by default).
  details: { delaySeconds: 60, jitterPercent: 50, maxAgeDays: 7, maxAttempts: 3 },
  // Loopback by default; there is a login now (config/users.yaml), but expose it only behind an HTTPS reverse proxy.
  // publicPath: where the app is mounted (cookie path, links); trustProxy: whose X-Forwarded-* headers to believe
  // (client IP for the login rate limit, https for the Secure cookie); sessionHours: idle lifetime of a login.
  server: {
    host: '127.0.0.1',
    port: 9998,
    publicPath: '/',
    publicUrl: null,
    trustProxy: 'loopback',
    sessionHours: 168,
  },
  // Email alerts (lib/notify). A rule = AND of conditions, rules = OR. SMTP secrets live in .env, never here.
  // Politeness towards WG-Gesucht: every distinct enabled search URL is one request per cycle.
  queries: { maxPerUser: 1, maxDistinctPerCycle: 5 },
  notify: {
    enabled: true,
    dryRun: false,
    maxAgeHours: 24,
    priority: { rules: [{ overall: { gt: 7 }, ai: { gt: 7 } }] },
    bulk: { rules: [{ overall: { gt: 5 }, ai: { gt: 5 } }] },
  },
};

export { ConfigError };

function resolveDbPath(dbPath, projectRoot) {
  return dbPath === ':memory:' ? dbPath : path.resolve(projectRoot, dbPath);
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function parseSearch(entry, index) {
  if (!isPlainObject(entry) || typeof entry.url !== 'string') {
    throw new ConfigError(`searches[${index}]: "url" is required`);
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    throw new ConfigError(`searches[${index}]: "${entry.url}" is not a valid URL`);
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) {
    throw new ConfigError(`searches[${index}]: only https://www.wg-gesucht.de URLs are supported`);
  }
  return { name: entry.name ? String(entry.name) : `search-${index + 1}`, url: entry.url };
}

function positiveNumber(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`schedule.${label} must be a number greater than 0`);
  }
  return value;
}

function parseSchedule(raw = {}) {
  if (!isPlainObject(raw)) throw new ConfigError('"schedule" must be an object');
  const d = DEFAULTS.schedule;

  let jitterPercent = d.jitterPercent;
  if (raw.jitterPercent !== undefined) {
    const j = raw.jitterPercent;
    if (typeof j !== 'number' || !Number.isFinite(j) || j < 0 || j > 100) {
      throw new ConfigError('schedule.jitterPercent must be a number between 0 and 100');
    }
    jitterPercent = j;
  }

  let delay = d.delayBetweenSearchesSeconds;
  if (raw.delayBetweenSearchesSeconds !== undefined) {
    const r = raw.delayBetweenSearchesSeconds;
    const ok = Array.isArray(r) && r.length === 2 && r.every((n) => typeof n === 'number' && n >= 0) && r[0] <= r[1];
    if (!ok) throw new ConfigError('schedule.delayBetweenSearchesSeconds must be [min, max] with 0 <= min <= max');
    delay = r;
  }

  let manualGap = d.manualFetchMinGapSeconds;
  if (raw.manualFetchMinGapSeconds !== undefined) {
    const g = raw.manualFetchMinGapSeconds;
    if (typeof g !== 'number' || !Number.isFinite(g) || g < 0) {
      throw new ConfigError('schedule.manualFetchMinGapSeconds must be a number of seconds, 0 or more');
    }
    manualGap = g;
  }

  return {
    intervalMinutes: positiveNumber(raw.intervalMinutes, d.intervalMinutes, 'intervalMinutes'),
    jitterPercent,
    maxBackoffMinutes: positiveNumber(raw.maxBackoffMinutes, d.maxBackoffMinutes, 'maxBackoffMinutes'),
    delayBetweenSearchesSeconds: delay,
    manualFetchMinGapSeconds: manualGap,
  };
}

/** Never faster than this between two detail requests, whatever the config says (politeness floor). */
export const MIN_DETAIL_DELAY_SECONDS = 10;

function parseDetails(raw = {}) {
  if (!isPlainObject(raw)) throw new ConfigError('"details" must be an object');
  const d = DEFAULTS.details;

  const delaySeconds = raw.delaySeconds ?? d.delaySeconds;
  if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds) || delaySeconds < MIN_DETAIL_DELAY_SECONDS) {
    throw new ConfigError(`details.delaySeconds must be a number of at least ${MIN_DETAIL_DELAY_SECONDS} seconds`);
  }
  const jitterPercent = raw.jitterPercent ?? d.jitterPercent;
  if (
    typeof jitterPercent !== 'number' ||
    !Number.isFinite(jitterPercent) ||
    jitterPercent < 0 ||
    jitterPercent > 100
  ) {
    throw new ConfigError('details.jitterPercent must be a number between 0 and 100');
  }
  const maxAgeDays = raw.maxAgeDays ?? d.maxAgeDays;
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new ConfigError('details.maxAgeDays must be a number greater than 0');
  }
  const maxAttempts = raw.maxAttempts ?? d.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ConfigError('details.maxAttempts must be an integer of at least 1');
  }
  return { delaySeconds, jitterPercent, maxAgeDays, maxAttempts };
}

const PUBLIC_PATH = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

/** "/wgg/" -> "/wgg"; "/" stays. Throws for anything that is not a plain path. */
function normalizePublicPath(value, label) {
  if (typeof value !== 'string') throw new ConfigError(`${label} must be a path such as "/wgg"`);
  const trimmed = value.length > 1 ? value.replace(/\/+$/, '') : value;
  if (trimmed === '/') return '/';
  if (!PUBLIC_PATH.test(trimmed) || trimmed.split('/').some((part) => part === '.' || part === '..')) {
    throw new ConfigError(`${label} must be a path such as "/wgg" (letters, digits, ".", "_", "-", "~")`);
  }
  return trimmed;
}

function parsePublicUrl(value) {
  if (value === undefined || value === null) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new ConfigError('server.publicUrl must be a full URL such as "https://example.org/wgg"');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.search !== '' || url.hash !== '') {
    throw new ConfigError('server.publicUrl must be an http(s) URL without query or fragment');
  }
  return { href: url.href.replace(/\/+$/, ''), path: normalizePublicPath(url.pathname, 'server.publicUrl') };
}

const PROXY_TOKEN = /^(loopback|linklocal|uniquelocal|[0-9a-fA-F.:]+(\/\d{1,3})?)$/;
const isProxyList = (text) => text.split(',').every((t) => PROXY_TOKEN.test(t.trim()));

function parseTrustProxy(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && isProxyList(value)) return value.trim();
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && isProxyList(v))) {
    return value.map((v) => v.trim());
  }
  throw new ConfigError(
    'server.trustProxy must be true, false, a hop count, "loopback", an address / CIDR or a list of them',
  );
}

function parseServer(raw = {}) {
  if (!isPlainObject(raw)) throw new ConfigError('"server" must be an object');
  const d = DEFAULTS.server;
  if (raw.host !== undefined && (typeof raw.host !== 'string' || raw.host.trim() === '')) {
    throw new ConfigError('server.host must be a non-empty string');
  }
  if (raw.port !== undefined && (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)) {
    throw new ConfigError('server.port must be an integer between 1 and 65535');
  }
  const publicUrl = parsePublicUrl(raw.publicUrl);
  const publicPath =
    raw.publicPath !== undefined
      ? normalizePublicPath(raw.publicPath, 'server.publicPath')
      : (publicUrl?.path ?? d.publicPath);
  if (raw.sessionHours !== undefined && (typeof raw.sessionHours !== 'number' || !(raw.sessionHours > 0))) {
    throw new ConfigError('server.sessionHours must be a number of hours greater than 0');
  }
  return {
    host: raw.host?.trim() ?? d.host,
    port: raw.port ?? d.port,
    publicPath,
    publicUrl: publicUrl?.href ?? null,
    trustProxy: parseTrustProxy(raw.trustProxy, d.trustProxy),
    sessionHours: raw.sessionHours ?? d.sessionHours,
  };
}

function parseQueries(raw = {}) {
  if (!isPlainObject(raw)) throw new ConfigError('"queries" must be an object');
  const d = DEFAULTS.queries;
  for (const key of ['maxPerUser', 'maxDistinctPerCycle']) {
    if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || raw[key] < 1)) {
      throw new ConfigError(`queries.${key} must be an integer of at least 1`);
    }
  }
  return {
    maxPerUser: raw.maxPerUser ?? d.maxPerUser,
    maxDistinctPerCycle: raw.maxDistinctPerCycle ?? d.maxDistinctPerCycle,
  };
}

function parseNotifySection(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (!isPlainObject(raw)) throw new ConfigError(`notify.${name} must be an object`);
  if (raw.rules === undefined) return fallback;
  return { rules: parseRules(raw.rules, `notify.${name}.rules`) };
}

function parseNotify(raw = {}) {
  if (!isPlainObject(raw)) throw new ConfigError('"notify" must be an object');
  const d = DEFAULTS.notify;
  for (const key of ['enabled', 'dryRun']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      throw new ConfigError(`notify.${key} must be true or false`);
    }
  }
  const maxAgeHours = raw.maxAgeHours ?? d.maxAgeHours;
  if (typeof maxAgeHours !== 'number' || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new ConfigError('notify.maxAgeHours must be a number greater than 0');
  }
  return {
    enabled: raw.enabled ?? d.enabled,
    dryRun: raw.dryRun ?? d.dryRun,
    maxAgeHours,
    priority: parseNotifySection(raw.priority, 'priority', d.priority),
    bulk: parseNotifySection(raw.bulk, 'bulk', d.bulk),
  };
}

/**
 * Validate a raw (already parsed) config object and apply defaults.
 * @param {unknown} raw
 * @param {{projectRoot?: string}} [options] `projectRoot` resolves a relative `db` path (tests).
 */
export function parseConfig(raw, { projectRoot = PROJECT_ROOT } = {}) {
  if (!isPlainObject(raw)) throw new ConfigError('Config must be a YAML mapping');
  if (!Array.isArray(raw.searches) || raw.searches.length === 0) {
    throw new ConfigError('Config needs at least one entry under "searches"');
  }
  if (raw.db !== undefined && typeof raw.db !== 'string') throw new ConfigError('"db" must be a string path');

  return {
    dbPath: resolveDbPath(raw.db ?? DEFAULTS.dbPath, projectRoot),
    searches: raw.searches.map(parseSearch),
    schedule: parseSchedule(raw.schedule),
    details: parseDetails(raw.details),
    server: parseServer(raw.server),
    queries: parseQueries(raw.queries),
    notify: parseNotify(raw.notify),
  };
}

/**
 * Load and validate the YAML config file.
 * @param {string} [filePath]
 */
export function loadConfig(filePath = DEFAULT_CONFIG_PATH) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new ConfigError(
        `Config file not found: ${filePath}. Copy config/wgg.example.yaml to config/wgg.yaml and edit it.`,
      );
    }
    throw e;
  }
  let raw;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`Invalid YAML in ${filePath}: ${e.message}`);
  }
  return parseConfig(raw);
}
