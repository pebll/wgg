import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuleBasedEvaluator } from '../../lib/evaluation/ruleBasedEvaluator.js';
import { mergeLlm } from '../../lib/evaluation/llmEvaluator.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { defaultUserSettings, mergeSettings, buildEvaluationConfig } from '../../lib/settings/defaults.js';
import { formatDuration } from '../../lib/evaluation/scorers.js';
import { evaluateForUsers } from '../../lib/evaluation/pipeline.js';
import { createUserDirectory } from '../../lib/users/directory.js';
import { saveSettings } from '../../lib/services/settings/userSettingsStorage.js';
import { getUserListing, restoreListing } from '../../lib/services/listings/listingsStorage.js';
import { parseConfig } from '../../lib/config.js';
import { ALICE, BOB, SEARCH, NOW, openDb, giveQuery, seedListing, Db } from '../helpers/db.js';

const base = defaultEvaluationConfig();
const notify = parseConfig({ searches: [{ url: 'https://www.wg-gesucht.de/x.html' }] }).notify;
const defaults = () => defaultUserSettings({ evaluation: base, notify });
const autoReject = (over = {}) => mergeSettings(defaults(), { autoReject: over }).autoReject;
const evaluator = (over = {}) => new RuleBasedEvaluator({ ...base, autoReject: autoReject(over) });

// NOW = 2026-10-02 12:00 local
const evaluate = (listing, over, now = NOW) => evaluator(over).evaluate({ title: 'Room', ...listing }, { now });
const shortTerm = { shortTerm: { enabled: true, minMonths: 6 } };

describe('#auto-reject defaults', () => {
  it('keep the behaviour of today: Verbindung on (word list, AI at the configured threshold), short-term off', () => {
    expect(defaults().autoReject).toEqual({
      verbindung: { enabled: true, keywords: true, ai: true, aiThreshold: base.llm.excludeThreshold },
      shortTerm: { enabled: false, minMonths: 6 },
    });
  });

  it('are filled in for a user whose stored settings predate the switches', () => {
    const merged = mergeSettings(defaults(), { llm: { profile: 'x' }, scoring: { keywords: ['Corps'] } });
    expect(merged.autoReject).toEqual(defaults().autoReject);
    expect(buildEvaluationConfig(base, merged).autoReject).toEqual(defaults().autoReject);
  });

  it('a config without the section (direct construction) behaves as today', () => {
    const ev = new RuleBasedEvaluator(base);
    expect(ev.evaluate({ title: 'Corps Haus' }, { now: NOW }).excluded).toMatch(/excluded keyword "Corps"/);
    expect(ev.evaluate({ availableUntil: '2026-10-20' }, { now: NOW }).excluded).toBeUndefined();
  });
});

describe('#auto-reject word list', () => {
  const corps = { title: 'WG im Corps Haus' };
  it('excludes when Verbindung and the word list are on', () => {
    const r = evaluate(corps, {});
    expect(r.excluded).toBe('excluded keyword "Corps"');
    expect(r.overall).toBe(1);
  });
  it('does nothing with the word list off', () => {
    expect(evaluate(corps, { verbindung: { keywords: false } }).excluded).toBeUndefined();
  });
  it('does nothing with the Verbindung switch off, whatever the sub-switch says', () => {
    expect(evaluate(corps, { verbindung: { enabled: false, keywords: true } }).excluded).toBeUndefined();
  });
});

describe('#auto-reject AI check', () => {
  const rule = { scores: { rent: 8 }, overall: 8, missing: [], details: {} };
  const assessment = (p) => ({
    verbindungProbability: p,
    verbindungSignals: ['"Aktivitas"'],
    fitScore: 5,
    summary: 's',
    eligible: true,
  });
  const merge = (p, over) => mergeLlm(rule, assessment(p), { ...base, autoReject: autoReject(over) });

  it('excludes at or above the user threshold, not below (boundary)', () => {
    expect(merge(0.6, {}).excluded).toMatch(/Studentenverbindung \(p=0.60\)/);
    expect(merge(0.59, {}).excluded).toBeUndefined();
    expect(merge(0.45, { verbindung: { aiThreshold: 0.45 } }).excluded).toBeDefined();
    expect(merge(0.7, { verbindung: { aiThreshold: 0.75 } }).excluded).toBeUndefined();
    expect(merge(0.75, { verbindung: { aiThreshold: 0.75 } }).excluded).toBeDefined();
  });
  it('the user threshold replaces the global one', () => {
    const cfg = { ...base, llm: { ...base.llm, excludeThreshold: 0.9 }, autoReject: autoReject({}) };
    expect(mergeLlm(rule, assessment(0.7), cfg).excluded).toBeDefined(); // user: 0.6 (default setting), global 0.9
  });
  it('does nothing with the AI check off or the Verbindung switch off', () => {
    expect(merge(0.95, { verbindung: { ai: false } }).excluded).toBeUndefined();
    expect(merge(0.95, { verbindung: { enabled: false } }).excluded).toBeUndefined();
    expect(merge(0.95, { verbindung: { ai: false } }).overall).toBe(merge(0.1, {}).overall); // still scored
  });
  it('an ineligible assessment still excludes (separate switch, hideIneligible)', () => {
    const r = mergeLlm(
      rule,
      { ...assessment(0.1), eligible: false, eligibilityReason: 'women only' },
      {
        ...base,
        autoReject: autoReject({ verbindung: { enabled: false } }),
      },
    );
    expect(r.excluded).toBe('LLM: not eligible: women only');
  });
});

describe('#auto-reject short-term rentals', () => {
  it('is off by default', () => {
    expect(evaluate({ availableUntil: '2026-10-20' }, {}).excluded).toBeUndefined();
  });
  it('excludes a known end date with a stay below the minimum, with the reason and a human duration', () => {
    const r = evaluate({ availableFrom: '2026-11-01', availableUntil: '2026-12-06' }, shortTerm);
    expect(r.excluded).toBe('Short-term: 5 weeks (< 6 months)');
    expect(r.overall).toBe(1);
    expect(evaluate({ availableFrom: '2026-10-15', availableUntil: '2027-02-15' }, shortTerm).excluded).toBe(
      'Short-term: 4 months (< 6 months)',
    );
  });
  it('keeps a stay of exactly the minimum (calendar months) and longer', () => {
    expect(evaluate({ availableFrom: '2026-11-01', availableUntil: '2027-05-01' }, shortTerm).excluded).toBeUndefined();
    expect(evaluate({ availableFrom: '2026-11-01', availableUntil: '2027-04-30' }, shortTerm).excluded).toBeDefined();
    expect(evaluate({ availableFrom: '2026-11-01', availableUntil: '2027-09-01' }, shortTerm).excluded).toBeUndefined();
  });
  it('never rejects an open-ended offer (no end date)', () => {
    expect(evaluate({ availableFrom: '2026-11-01', availableUntil: null }, shortTerm).excluded).toBeUndefined();
    expect(evaluate({}, shortTerm).excluded).toBeUndefined();
  });
  it('counts from today when the move-in date is past or unknown', () => {
    // from 2026-01-01 to 2027-01-01 is a year, but only 3 months are left from 2026-10-02
    expect(evaluate({ availableFrom: '2026-01-01', availableUntil: '2027-01-02' }, shortTerm).excluded).toBe(
      'Short-term: 3 months (< 6 months)',
    );
    expect(evaluate({ availableUntil: '2026-10-16' }, shortTerm).excluded).toBe('Short-term: 2 weeks (< 6 months)');
  });
  it('uses the injectable now', () => {
    const later = new Date(2027, 2, 1, 12).getTime();
    expect(evaluate({ availableUntil: '2027-04-01' }, shortTerm, later).excluded).toBe(
      'Short-term: 4 weeks (< 6 months)',
    );
    expect(evaluate({ availableUntil: '2027-04-02' }, shortTerm).excluded).toBeUndefined(); // 6 months from NOW
  });
  it('follows the configured minimum', () => {
    const l = { availableFrom: '2026-11-01', availableUntil: '2027-04-01' }; // 5 months
    expect(evaluate(l, { shortTerm: { enabled: true, minMonths: 6 } }).excluded).toBeDefined();
    expect(evaluate(l, { shortTerm: { enabled: true, minMonths: 5 } }).excluded).toBeUndefined();
  });
  it('combines with a keyword exclusion in one reason', () => {
    const r = evaluate({ title: 'Corps', availableUntil: '2026-10-20' }, shortTerm);
    expect(r.excluded).toBe('excluded keyword "Corps"; Short-term: 3 weeks (< 6 months)');
  });
});

describe('#formatDuration', () => {
  it.each([
    [0, '0 days'],
    [1, '1 day'],
    [10, '10 days'],
    [14, '2 weeks'],
    [35, '5 weeks'],
    [60, '9 weeks'],
    [61, '2 months'],
    [122, '4 months'],
    [335, '11 months'],
    [366, '12 months'],
  ])('%i days is %s', (days, text) => {
    expect(formatDuration(days)).toBe(text);
  });
});

describe('#re-evaluation on a settings change (per user)', () => {
  const PROVIDER = { short: '1', long: '2', open: '3' };
  let ids;
  beforeEach(async () => {
    await openDb();
    giveQuery(ALICE, SEARCH);
    giveQuery(BOB, SEARCH);
    ids = {
      short: seedListing(1, SEARCH, { availableUntil: '2026-11-15', availableFrom: '2026-10-20' }),
      long: seedListing(2, SEARCH, { availableUntil: '2027-12-31' }),
      open: seedListing(3, SEARCH),
    };
  });
  afterEach(() => Db.reset());

  const directory = () =>
    createUserDirectory({ users: [{ username: ALICE }, { username: BOB }], evaluation: base, notify });
  const run = (userIds) =>
    evaluateForUsers({
      contexts: directory().contexts(),
      userIds,
      geocoder: { geocode: async () => null },
      now: NOW,
    });
  const state = (user, key) => {
    const r = getUserListing(user, PROVIDER[key]);
    return { hidden: r.hidden_by, reason: r.hidden_reason, excluded: r.excluded_reason };
  };

  it('turning the short-term rule on hides the short offer for that user only; off again brings it back', async () => {
    await run();
    expect(state(ALICE, 'short').hidden).toBeNull();
    saveSettings(ALICE, { autoReject: { shortTerm: { enabled: true, minMonths: 6 } } });
    await run([ALICE]);
    expect(state(ALICE, 'short')).toMatchObject({ hidden: 'program', reason: 'Short-term: 4 weeks (< 6 months)' });
    expect(state(ALICE, 'long').hidden).toBeNull();
    expect(state(ALICE, 'open').hidden).toBeNull();
    expect(state(BOB, 'short').hidden).toBeNull(); // two-user isolation
    saveSettings(ALICE, { autoReject: { shortTerm: { enabled: false } } });
    await run([ALICE]);
    expect(state(ALICE, 'short').hidden).toBeNull();
  });

  it('a restored offer (hide_override) stays visible even though the rule still matches', async () => {
    saveSettings(ALICE, { autoReject: { shortTerm: { enabled: true, minMonths: 6 } } });
    await run([ALICE]);
    restoreListing(ALICE, ids.short);
    await run([ALICE]);
    expect(state(ALICE, 'short').hidden).toBeNull();
    expect(state(ALICE, 'short').excluded).toMatch(/^Short-term/);
  });

  it('switching Verbindung off un-hides a keyword exclusion for that user only', async () => {
    Db.execute("UPDATE listings SET title = 'Corps Zimmer' WHERE id = ?", [ids.open]);
    await run();
    expect(state(ALICE, 'open').hidden).toBe('program');
    saveSettings(ALICE, { autoReject: { verbindung: { enabled: false } } });
    await run([ALICE]);
    expect(state(ALICE, 'open').hidden).toBeNull();
    expect(state(BOB, 'open').hidden).toBe('program');
  });
});
