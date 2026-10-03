import { ConfigError } from '../errors.js';

/**
 * The alert rule engine. A rule is an object of conditions that must ALL hold (AND); a list of rules matches when ANY
 * rule matches (OR). A condition is `{field: {op: number, ...}}`, e.g.
 *   [{overall: {gt: 7}, ai: {gt: 7}}, {overall: {gt: 5}, rent: {lt: 700}}]
 * A field without a value (null, undefined, NaN) makes its condition false.
 */

/** Values a rule can look at (see `notifyValues` in lib/notify/notifier.js). */
export const RULE_FIELDS = ['overall', 'ai', 'rent', 'size', 'distanceKm', 'verbindungProbability'];

const OPERATORS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
};
export const RULE_OPS = Object.keys(OPERATORS);

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates a rule list from the config and returns it (normalized: plain copies).
 * @param {unknown} raw
 * @param {string} path Config path used in error messages, e.g. "notify.priority.rules".
 * @returns {Array<Record<string, Record<string, number>>>}
 * @throws {ConfigError}
 */
export function parseRules(raw, path) {
  if (!Array.isArray(raw)) throw new ConfigError(`${path} must be a list of rules`);
  return raw.map((rule, i) => {
    const at = `${path}[${i}]`;
    if (!isPlainObject(rule)) throw new ConfigError(`${at} must be an object of conditions`);
    const fields = Object.keys(rule);
    if (fields.length === 0) throw new ConfigError(`${at} needs at least one condition`);
    const parsed = {};
    for (const field of fields) {
      if (!RULE_FIELDS.includes(field)) {
        throw new ConfigError(`${at}.${field}: unknown field (use ${RULE_FIELDS.join(', ')})`);
      }
      const ops = rule[field];
      if (!isPlainObject(ops)) throw new ConfigError(`${at}.${field} must be an object like {gt: 7}`);
      const opNames = Object.keys(ops);
      if (opNames.length === 0) throw new ConfigError(`${at}.${field} needs at least one operator`);
      parsed[field] = {};
      for (const op of opNames) {
        if (!RULE_OPS.includes(op)) {
          throw new ConfigError(`${at}.${field}.${op}: unknown operator (use ${RULE_OPS.join(', ')})`);
        }
        if (typeof ops[op] !== 'number' || !Number.isFinite(ops[op])) {
          throw new ConfigError(`${at}.${field}.${op} must be a number`);
        }
        parsed[field][op] = ops[op];
      }
    }
    return parsed;
  });
}

const hasValue = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {Array<Record<string, Record<string, number>>>} rules Parsed rules.
 * @param {Partial<Record<(typeof RULE_FIELDS)[number], number|null>>} values
 * @returns {boolean} True when any rule has all its conditions met.
 */
export function matchesRules(rules, values) {
  return rules.some((rule) =>
    Object.entries(rule).every(([field, ops]) => {
      const value = values[field];
      if (!hasValue(value)) return false;
      return Object.entries(ops).every(([op, limit]) => OPERATORS[op](value, limit));
    }),
  );
}
