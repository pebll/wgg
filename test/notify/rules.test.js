import { describe, it, expect } from 'vitest';
import { parseRules, matchesRules, RULE_FIELDS, RULE_OPS } from '../../lib/notify/rules.js';
import { parseConfig, ConfigError } from '../../lib/config.js';

const URL1 = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const cfg = (notify) => parseConfig({ searches: [{ url: URL1 }], notify });

describe('#notify rules', () => {
  it('lists the supported fields and operators', () => {
    expect(RULE_FIELDS).toEqual(['overall', 'ai', 'rent', 'size', 'distanceKm', 'verbindungProbability']);
    expect(RULE_OPS).toEqual(['gt', 'gte', 'lt', 'lte', 'eq']);
  });

  it('ANDs the conditions of a rule', () => {
    const rules = parseRules([{ overall: { gt: 7 }, ai: { gt: 7 } }], 'x');
    expect(matchesRules(rules, { overall: 8, ai: 8 })).toBe(true);
    expect(matchesRules(rules, { overall: 8, ai: 7 })).toBe(false);
    expect(matchesRules(rules, { overall: 7, ai: 9 })).toBe(false);
  });

  it('ORs the rules', () => {
    const rules = parseRules(
      [
        { overall: { gt: 7 }, ai: { gt: 7 } },
        { overall: { gt: 5 }, rent: { lt: 700 } },
      ],
      'x',
    );
    expect(matchesRules(rules, { overall: 6, ai: 1, rent: 650 })).toBe(true);
    expect(matchesRules(rules, { overall: 6, ai: 1, rent: 750 })).toBe(false);
  });

  it('supports gt, gte, lt, lte and eq, and several ops on one field', () => {
    const v = { rent: 700 };
    const m = (cond) => matchesRules(parseRules([{ rent: cond }], 'x'), v);
    expect(m({ gt: 700 })).toBe(false);
    expect(m({ gte: 700 })).toBe(true);
    expect(m({ lt: 700 })).toBe(false);
    expect(m({ lte: 700 })).toBe(true);
    expect(m({ eq: 700 })).toBe(true);
    expect(m({ gte: 600, lt: 800 })).toBe(true);
    expect(m({ gte: 600, lt: 700 })).toBe(false);
  });

  it('treats a missing field value as a failed condition', () => {
    const rules = parseRules([{ overall: { gt: 5 }, distanceKm: { lt: 3 } }], 'x');
    expect(matchesRules(rules, { overall: 9 })).toBe(false);
    expect(matchesRules(rules, { overall: 9, distanceKm: null })).toBe(false);
    expect(matchesRules(rules, { overall: 9, distanceKm: Number.NaN })).toBe(false);
  });

  it('an empty rule list never matches', () => {
    expect(matchesRules(parseRules([], 'x'), { overall: 10 })).toBe(false);
  });

  it('names the path in validation errors', () => {
    const bad = (rules, text) => expect(() => parseRules(rules, 'notify.priority.rules')).toThrow(text);
    bad('x', 'notify.priority.rules must be a list');
    bad([5], 'notify.priority.rules[0] must be an object');
    bad([{}], 'notify.priority.rules[0] needs at least one condition');
    bad([{ colour: { gt: 1 } }], 'notify.priority.rules[0].colour: unknown field');
    bad([{ rent: 5 }], 'notify.priority.rules[0].rent must be an object');
    bad([{ rent: {} }], 'notify.priority.rules[0].rent needs at least one operator');
    bad([{ rent: { gtt: 5 } }], 'notify.priority.rules[0].rent.gtt: unknown operator');
    bad([{ rent: { gt: '5' } }], 'notify.priority.rules[0].rent.gt must be a number');
    bad([{ overall: { gt: 1 } }, { rent: { lt: Infinity } }], 'notify.priority.rules[1].rent.lt must be a number');
    expect(() => parseRules('x', 'notify.priority.rules')).toThrow(ConfigError);
  });
});

describe('#notify config', () => {
  it('defaults', () => {
    expect(cfg(undefined).notify).toEqual({
      enabled: true,
      dryRun: false,
      maxAgeHours: 24,
      priority: { rules: [{ overall: { gt: 7 }, ai: { gt: 7 } }], window: { from: 7, to: 23 } },
      bulk: { rules: [{ overall: { gt: 5 }, ai: { gt: 5 } }], window: { from: 7, to: 23 }, intervalHours: 1 },
    });
  });

  it('keeps explicit values and replaces the rules of a section', () => {
    const n = cfg({
      enabled: false,
      dryRun: true,
      maxAgeHours: 6,
      bulk: { rules: [{ overall: { gt: 5 }, rent: { lt: 700 } }] },
    }).notify;
    expect(n).toMatchObject({ enabled: false, dryRun: true, maxAgeHours: 6 });
    expect(n.bulk.rules).toEqual([{ overall: { gt: 5 }, rent: { lt: 700 } }]);
    expect(n.priority.rules).toEqual([{ overall: { gt: 7 }, ai: { gt: 7 } }]);
  });

  it('an explicit empty rule list switches that alert kind off', () => {
    expect(cfg({ priority: { rules: [] } }).notify.priority.rules).toEqual([]);
  });

  it('rejects invalid values naming the path', () => {
    expect(() => cfg('x')).toThrow('"notify" must be an object');
    expect(() => cfg({ enabled: 'yes' })).toThrow('notify.enabled must be true or false');
    expect(() => cfg({ dryRun: 1 })).toThrow('notify.dryRun must be true or false');
    expect(() => cfg({ maxAgeHours: 0 })).toThrow('notify.maxAgeHours must be a number greater than 0');
    expect(() => cfg({ priority: [] })).toThrow('notify.priority must be an object');
    expect(() => cfg({ bulk: { rules: [{ foo: { gt: 1 } }] } })).toThrow('notify.bulk.rules[0].foo: unknown field');
  });
});
