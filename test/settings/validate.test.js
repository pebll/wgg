import { describe, it, expect } from 'vitest';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { defaultUserSettings } from '../../lib/settings/defaults.js';
import { validateSettingsUpdate, SettingsError } from '../../lib/settings/validate.js';
import { parseConfig } from '../../lib/config.js';

const evaluation = defaultEvaluationConfig();
const notify = parseConfig({ searches: [{ url: 'https://www.wg-gesucht.de/x.html' }] }).notify;
const current = () => defaultUserSettings({ evaluation, notify, email: 'me@example.org' });
const update = (body) => validateSettingsUpdate({ body, current: current(), evaluation });
const fails = (body, message) => {
  expect(() => update(body)).toThrow(SettingsError);
  expect(() => update(body)).toThrow(message);
};

describe('#validateSettingsUpdate', () => {
  it('merges a partial update into the current settings and returns the full document', () => {
    const next = update({ scoring: { rent: { best: 400 } }, llm: { profile: 'New profile.' } });
    expect(next.scoring.rent).toEqual({ best: 400, worst: 750 });
    expect(next.scoring.weights).toEqual(current().scoring.weights);
    expect(next.llm).toEqual({ profile: 'New profile.', hideIneligible: true });
    expect(next.notify.email).toBe('me@example.org');
  });

  it('an empty update changes nothing; the current settings are not mutated', () => {
    const before = current();
    // the only normalisation of an unchanged document: the profile text is trimmed
    const same = { ...current(), llm: { ...current().llm, profile: current().llm.profile.trim() } };
    expect(validateSettingsUpdate({ body: {}, current: before, evaluation })).toEqual(same);
    validateSettingsUpdate({ body: { scoring: { rent: { best: 1 } } }, current: before, evaluation });
    expect(before).toEqual(current());
  });

  it('rejects unknown settings so typos are not silently dropped', () => {
    fails({ scoringg: {} }, /unknown setting "scoringg"/);
    fails({ scoring: { rent: { cheap: 1 } } }, /unknown setting "scoring\.rent\.cheap"/);
    fails({ scoring: { rent: { hardMax: 800 } } }, /unknown setting "scoring\.rent\.hardMax"/);
    fails({ scoring: { wgSize: { best: 3, worst: 8 } } }, /unknown setting "scoring\.wgSize"/);
    fails({ notify: { sms: true } }, /unknown setting "notify\.sms"/);
    fails('text', /object/);
    fails([], /object/);
  });

  describe('scoring', () => {
    it.each([
      [{ scoring: { rent: { best: 600, worst: 600 } } }, /rent: best and worst must differ/],
      [{ scoring: { rent: { best: 'cheap' } } }, /rent\.best must be a number/],
      [{ scoring: { weights: { rent: -1 } } }, /weights\.rent must be a number >= 0/],
      [{ scoring: { weights: { rent: 0, distance: 0, recency: 0, size: 0, stayLength: 0 } } }, /at least one weight/],
      [{ scoring: { stayLength: { minStayDays: 30, minimumDays: 60 } } }, /minimumDays must be smaller/],
      [{ scoring: { target: { name: 5 } } }, /target\.name must be a string/],
      [{ scoring: { keywords: 'Corps' } }, /keywords must be a list/],
      [{ scoring: { keywords: ['ok', ''] } }, /keywords must be a list/],
      [{ scoring: { rent: { best: 1e12 } } }, /rent\.best/],
    ])('rejects %j', (body, message) => fails(body, message));

    it('limits the keyword list and the length of one keyword', () => {
      fails({ scoring: { keywords: Array.from({ length: 51 }, (_, i) => `k${i}`) } }, /at most 50/);
      fails({ scoring: { keywords: ['x'.repeat(81)] } }, /at most 80/);
    });

    it('trims keywords and limits name and address', () => {
      expect(update({ scoring: { keywords: ['  Corps ', 'Aktivitas'] } }).scoring.keywords).toEqual([
        'Corps',
        'Aktivitas',
      ]);
      fails({ scoring: { target: { address: 'x'.repeat(201) } } }, /address/);
      fails({ scoring: { target: { name: 'x'.repeat(101) } } }, /name/);
    });

    it('latitude and longitude of the target stay what the geocoder found (they cannot be set directly)', () => {
      const next = update({ scoring: { target: { lat: 1, lng: 2, name: 'Home' } } });
      expect(next.scoring.target).toMatchObject({ name: 'Home', lat: 48.1488833, lng: 11.5677668 });
    });
  });

  describe('llm', () => {
    it('accepts a profile text (trimmed) and hideIneligible', () => {
      expect(update({ llm: { profile: '  Anna, 22  ', hideIneligible: false } }).llm).toEqual({
        profile: 'Anna, 22',
        hideIneligible: false,
      });
    });
    it.each([
      [{ llm: { profile: 5 } }, /profile must be text/],
      [{ llm: { profile: 'x'.repeat(4001) } }, /at most 4000/],
      [{ llm: { hideIneligible: 'yes' } }, /hideIneligible must be true or false/],
    ])('rejects %j', (body, message) => fails(body, message));
  });

  describe('notify', () => {
    it('accepts an email (trimmed), clearing it with null or an empty string, enabled and the age limit', () => {
      expect(update({ notify: { email: ' anna@example.org ' } }).notify.email).toBe('anna@example.org');
      expect(update({ notify: { email: null } }).notify.email).toBeNull();
      expect(update({ notify: { email: '' } }).notify.email).toBeNull();
      expect(update({ notify: { enabled: false, maxAgeHours: 48 } }).notify).toMatchObject({
        enabled: false,
        maxAgeHours: 48,
      });
    });

    it('accepts the per-tier switches, defaulting to on, and rejects non-booleans', () => {
      expect(current().notify.priority.enabled).toBe(true);
      const next = update({ notify: { priority: { enabled: false } } }).notify;
      expect(next.priority.enabled).toBe(false);
      expect(next.priority.rules).toEqual(current().notify.priority.rules);
      expect(next.bulk.enabled).toBe(true);
      expect(update({ notify: { bulk: { enabled: false } } }).notify.bulk.enabled).toBe(false);
      fails({ notify: { priority: { enabled: 'no' } } }, /notify\.priority\.enabled must be true or false/);
      fails({ notify: { bulk: { enabled: 1 } } }, /notify\.bulk\.enabled must be true or false/);
    });

    it('validates alert rules like the config does: fields, operators, numbers', () => {
      const next = update({
        notify: { priority: { rules: [{ overall: { gt: 8 }, ai: { gte: 7 } }] }, bulk: { rules: [] } },
      });
      expect(next.notify.priority.rules).toEqual([{ overall: { gt: 8 }, ai: { gte: 7 } }]);
      expect(next.notify.bulk.rules).toEqual([]);
      fails({ notify: { priority: { rules: [{ colour: { gt: 1 } }] } } }, /unknown field/);
      fails({ notify: { priority: { rules: [{ overall: { above: 1 } }] } } }, /unknown operator/);
      fails({ notify: { priority: { rules: [{ overall: { gt: 'high' } }] } } }, /must be a number/);
      fails({ notify: { bulk: { rules: 'all' } } }, /list of rules/);
      fails({ notify: { bulk: { rules: Array.from({ length: 11 }, () => ({ overall: { gt: 1 } })) } } }, /at most 10/);
    });

    it.each([
      [{ notify: { email: 'not-an-email' } }, /email/],
      [{ notify: { email: 'a'.repeat(250) + '@example.org' } }, /email/],
      [{ notify: { email: 'a@b.c\nBcc: x@y.z' } }, /email/],
      [{ notify: { enabled: 'yes' } }, /enabled must be true or false/],
      [{ notify: { maxAgeHours: 0 } }, /maxAgeHours/],
      [{ notify: { maxAgeHours: 1000 } }, /maxAgeHours/],
    ])('rejects %j', (body, message) => fails(body, message));
  });
});

describe('#autoReject settings', () => {
  it('defaults are part of the document and a partial update merges into them', () => {
    expect(current().autoReject.shortTerm).toEqual({ enabled: false, minMonths: 6 });
    const next = update({ autoReject: { shortTerm: { enabled: true } } });
    expect(next.autoReject.shortTerm).toEqual({ enabled: true, minMonths: 6 });
    expect(next.autoReject.verbindung).toEqual(current().autoReject.verbindung);
  });

  it.each([
    [{ autoReject: { verbindung: { aiThreshold: 0.29 } } }, /aiThreshold must be a number between 0.3 and 0.95/],
    [{ autoReject: { verbindung: { aiThreshold: 0.96 } } }, /aiThreshold/],
    [{ autoReject: { verbindung: { aiThreshold: '0.5' } } }, /aiThreshold/],
    [{ autoReject: { shortTerm: { minMonths: 0 } } }, /minMonths must be a whole number of months between 1 and 24/],
    [{ autoReject: { shortTerm: { minMonths: 25 } } }, /minMonths/],
    [{ autoReject: { shortTerm: { minMonths: 2.5 } } }, /minMonths/],
    [{ autoReject: { verbindung: { enabled: 'yes' } } }, /autoReject\.verbindung\.enabled must be true or false/],
    [{ autoReject: { shortTerm: { enabled: 1 } } }, /autoReject\.shortTerm\.enabled must be true or false/],
    [{ autoReject: { verbindung: { sub: true } } }, /unknown setting "autoReject\.verbindung\.sub"/],
    [{ autoReject: { other: {} } }, /unknown setting "autoReject\.other"/],
  ])('rejects %j', (body, message) => fails(body, message));

  it('accepts the range ends', () => {
    const next = update({ autoReject: { verbindung: { aiThreshold: 0.95 }, shortTerm: { minMonths: 24 } } });
    expect(next.autoReject.verbindung.aiThreshold).toBe(0.95);
    expect(next.autoReject.shortTerm.minMonths).toBe(24);
    expect(
      update({ autoReject: { verbindung: { aiThreshold: 0.3 }, shortTerm: { minMonths: 1 } } }).autoReject.shortTerm
        .minMonths,
    ).toBe(1);
  });
});
