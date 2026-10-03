import { describe, it, expect } from 'vitest';
import {
  SLIDER_SPECS,
  WEIGHT_SLIDER,
  describeRange,
  rangeToSlider,
  sliderToRange,
  notifyBody,
  notifyToForm,
  queryFetchNotice,
  scoringBody,
  scoringToForm,
  rulesToThresholds,
  thresholdsToRules,
  validateNotifyForm,
  validateProfile,
  validateQueryForm,
  validateScoringForm,
  AUTO_REJECT_SLIDERS,
  autoRejectBody,
  validateAutoRejectForm,
} from '../../ui/src/services/options.js';

describe('#notification thresholds <-> rules', () => {
  it('reads the simple shape', () => {
    expect(rulesToThresholds([{ overall: { gt: 7 }, ai: { gt: 6.5 } }])).toEqual({ simple: true, score: 7, ai: 6.5 });
    expect(rulesToThresholds([{ overall: { gt: 5 } }])).toEqual({ simple: true, score: 5, ai: null });
    expect(rulesToThresholds([{ ai: { gt: 5 } }])).toEqual({ simple: true, score: null, ai: 5 });
    expect(rulesToThresholds([])).toEqual({ simple: true, score: null, ai: null });
  });

  it('calls everything else complex (several rules, other fields or operators)', () => {
    expect(rulesToThresholds([{ overall: { gt: 7 } }, { ai: { gt: 7 } }]).simple).toBe(false);
    expect(rulesToThresholds([{ overall: { gt: 7 }, rent: { lt: 700 } }]).simple).toBe(false);
    expect(rulesToThresholds([{ overall: { gte: 7 } }]).simple).toBe(false);
    expect(rulesToThresholds([{ overall: { gt: 7, lt: 9 } }]).simple).toBe(false);
    expect(rulesToThresholds('nonsense').simple).toBe(false);
  });

  it('builds the rules from the two fields; no threshold means no rule', () => {
    expect(thresholdsToRules({ score: 7, ai: 6 })).toEqual([{ overall: { gt: 7 }, ai: { gt: 6 } }]);
    expect(thresholdsToRules({ score: 7, ai: null })).toEqual([{ overall: { gt: 7 } }]);
    expect(thresholdsToRules({ score: null, ai: 4 })).toEqual([{ ai: { gt: 4 } }]);
    expect(thresholdsToRules({ score: null, ai: null })).toEqual([]);
    expect(thresholdsToRules({ score: '', ai: undefined })).toEqual([]);
  });
});

describe('#client-side validation mirrors the server', () => {
  it('query: only wg-gesucht.de result addresses', () => {
    expect(validateQueryForm({ url: '' })).toMatch(/paste/i);
    expect(validateQueryForm({ url: 'https://example.com/x.1.0.1.0.html' })).toMatch(/wg-gesucht\.de/);
    expect(validateQueryForm({ url: 'not a url' })).toMatch(/wg-gesucht\.de/);
    expect(validateQueryForm({ url: 'http://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html' })).toMatch(/https/);
    expect(validateQueryForm({ url: 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html' })).toBeNull();
    expect(validateQueryForm({ url: 'https://www.wg-gesucht.de/', name: 'x'.repeat(101) })).toMatch(/name/i);
  });

  const notify = {
    email: 'a@b.de',
    enabled: true,
    maxAgeHours: 24,
    priority: { score: 7, ai: 7 },
    bulk: { score: 5, ai: 5 },
  };
  it('notifications: email, age and thresholds', () => {
    expect(validateNotifyForm(notify)).toEqual([]);
    expect(validateNotifyForm({ ...notify, email: 'nope' })).toEqual([expect.stringMatching(/email/i)]);
    expect(validateNotifyForm({ ...notify, email: '' })).toEqual([]);
    expect(validateNotifyForm({ ...notify, maxAgeHours: 0 })).toEqual([expect.stringMatching(/hours/i)]);
    expect(validateNotifyForm({ ...notify, maxAgeHours: 1000 })).toEqual([expect.stringMatching(/hours/i)]);
    expect(validateNotifyForm({ ...notify, priority: { score: 11, ai: 7 } })).toEqual([
      expect.stringMatching(/fantastic.*0 and 10/i),
    ]);
    expect(validateNotifyForm({ ...notify, bulk: { score: 5, ai: -1 } })).toEqual([
      expect.stringMatching(/good.*0 and 10/i),
    ]);
    // complex rules are not edited here, so they are not validated here either
    expect(validateNotifyForm({ ...notify, priority: { simple: false } })).toEqual([]);
  });

  it('profile: length limit', () => {
    expect(validateProfile('hello')).toBeNull();
    expect(validateProfile('x'.repeat(4001))).toMatch(/4000/);
  });

  const scoring = {
    target: { name: 'Home', address: 'Main St 1, Berlin' },
    rent: { best: 450, worst: 750 },
    sizeM2: { worst: 9, best: 20 },
    distanceKm: { best: 1.5, worst: 10 },
    recencyHours: { best: 0, worst: 72 },
    stayLength: { minStayDays: 730, minimumDays: 180 },
    weights: { rent: 3, distance: 3, recency: 2, size: 1.5, stayLength: 1.5 },
    keywords: ['Corps'],
  };
  it('scoring: accepts the defaults', () => {
    expect(validateScoringForm(scoring)).toEqual([]);
  });
  it('scoring: needs an address, numbers, distinct best/worst, sane weights and stay length', () => {
    expect(validateScoringForm({ ...scoring, target: { name: '', address: '  ' } })).toContainEqual(
      expect.stringMatching(/address/i),
    );
    expect(validateScoringForm({ ...scoring, rent: { best: 450, worst: 450 } })).toContainEqual(
      expect.stringMatching(/rent.*differ/i),
    );
    expect(validateScoringForm({ ...scoring, rent: { best: 450, worst: null } })).toContainEqual(
      expect.stringMatching(/rent.*number/i),
    );
    expect(validateScoringForm({ ...scoring, weights: { ...scoring.weights, rent: -1 } })).toContainEqual(
      expect.stringMatching(/weights.*>= 0/i),
    );
    expect(
      validateScoringForm({
        ...scoring,
        weights: { rent: 0, distance: 0, recency: 0, size: 0, stayLength: 0 },
      }),
    ).toContainEqual(expect.stringMatching(/at least one weight/i));
    expect(validateScoringForm({ ...scoring, stayLength: { minStayDays: 100, minimumDays: 100 } })).toContainEqual(
      expect.stringMatching(/minimum.*smaller/i),
    );
    expect(validateScoringForm({ ...scoring, keywords: Array(51).fill('a') })).toContainEqual(
      expect.stringMatching(/50 keywords/i),
    );
  });
});

describe('#fetch after a query change', () => {
  it('shows the guards (409/429) as information, other failures as errors', () => {
    expect(queryFetchNotice({ status: 409, json: { error: 'A fetch is already running.' } })).toEqual({
      level: 'info',
      message: 'A fetch is already running. Your query is saved and is fetched automatically.',
    });
    expect(queryFetchNotice({ status: 429, json: { error: 'Too soon.', retryAfterSeconds: 90 } })).toEqual({
      level: 'info',
      message: 'Too soon. Try again in 2 min. Your query is saved and is fetched automatically.',
    });
    expect(queryFetchNotice({ status: 503, json: {} })).toEqual({
      level: 'error',
      message: 'Could not start a fetch.',
    });
  });
});

describe('#settings forms <-> API documents', () => {
  const notify = {
    email: null,
    enabled: true,
    priority: { rules: [{ overall: { gt: 7 }, ai: { gt: 7 } }] },
    bulk: { rules: [{ overall: { gt: 5 }, rent: { lt: 600 } }] },
    maxAgeHours: 24,
  };

  it('turns notification settings into form fields (empty email shown as empty text)', () => {
    expect(notifyToForm(notify)).toEqual({
      email: '',
      enabled: true,
      maxAgeHours: 24,
      priority: { simple: true, score: 7, ai: 7 },
      bulk: { simple: false },
      priorityEnabled: true,
      bulkEnabled: true,
    });
    const off = notifyToForm({ ...notify, priority: { ...notify.priority, enabled: false } });
    expect(off).toMatchObject({ priorityEnabled: false, bulkEnabled: true });
  });

  it('sends only what the form can express: complex rules are left alone', () => {
    const form = { ...notifyToForm(notify), email: ' a@b.de ', priority: { simple: true, score: 8, ai: null } };
    expect(notifyBody(form)).toEqual({
      notify: {
        email: 'a@b.de',
        enabled: true,
        maxAgeHours: 24,
        priority: { enabled: true, rules: [{ overall: { gt: 8 } }] },
        bulk: { enabled: true },
      },
    });
    expect(notifyBody({ ...form, email: '  ' }).notify.email).toBeNull();
    expect(notifyBody({ ...form, bulkEnabled: false }).notify.bulk).toEqual({ enabled: false });
  });

  const scoring = {
    target: { name: 'Home', address: 'Main St 1', lat: 1, lng: 2 },
    weights: { rent: 3 },
    rent: { best: 1, worst: 2 },
    distanceKm: { best: 1, worst: 2 },
    sizeM2: { worst: 9, best: 20 },
    recencyHours: { best: 0, worst: 72 },
    stayLength: { minStayDays: 730, minimumDays: 180 },
    keywords: ['Corps'],
  };

  it('drops the removed rent cap and WG size parameter even when stored settings still carry them', () => {
    const legacy = {
      ...scoring,
      weights: { rent: 3, wgSize: 1 },
      rent: { best: 1, worst: 2, hardMax: 3 },
      wgSize: { best: 3, worst: 8 },
    };
    const form = scoringToForm(legacy);
    expect(form.rent).toEqual({ best: 1, worst: 2 });
    expect(form.weights).toEqual({ rent: 3 });
    const { scoring: body } = scoringBody(form);
    expect(body.rent).toEqual({ best: 1, worst: 2 });
    expect(body.weights).toEqual({ rent: 3 });
  });

  it('copies the editable scoring fields into a form and back, without coordinates', () => {
    const form = scoringToForm(scoring);
    expect(form.target).toEqual({ name: 'Home', address: 'Main St 1' });
    form.target.address = ' Other 2 ';
    form.keywords = [...form.keywords, 'Verbindung'];
    const { scoring: body } = scoringBody(form);
    expect(body.target).toEqual({ name: 'Home', address: 'Other 2' });
    expect(body.keywords).toEqual(['Corps', 'Verbindung']);
    expect(body).not.toHaveProperty('wgSize');
    expect(scoring.keywords).toEqual(['Corps']); // the stored settings are not mutated
  });

  it('leaves the name out when it is empty (the server then names the target by its address)', () => {
    const form = scoringToForm(scoring);
    form.target.name = '  ';
    expect(scoringBody(form).scoring.target).toEqual({ address: 'Main St 1' });
  });
});

describe('#scoring sliders', () => {
  it('has sensible bounds and steps for every range', () => {
    expect(SLIDER_SPECS.rent).toMatchObject({ min: 200, max: 1500, step: 10 });
    expect(SLIDER_SPECS.sizeM2).toMatchObject({ min: 5, max: 40, step: 1 });
    expect(SLIDER_SPECS.distanceKm).toMatchObject({ min: 0, max: 30, step: 0.5 });
    expect(SLIDER_SPECS.recencyHours).toMatchObject({ min: 1, max: 168, step: 1 });
    expect(SLIDER_SPECS.stayLength).toMatchObject({ min: 0, max: 1095, step: 30 });
    expect(WEIGHT_SLIDER).toEqual({ min: 0, max: 5, step: 0.5 });
  });

  it('maps best/worst to the low and high handle by the direction of the parameter', () => {
    expect(rangeToSlider({ best: 450, worst: 750 }, SLIDER_SPECS.rent)).toEqual([450, 750]);
    expect(rangeToSlider({ worst: 9, best: 20 }, SLIDER_SPECS.sizeM2)).toEqual([9, 20]);
    expect(rangeToSlider({ minStayDays: 730, minimumDays: 180 }, SLIDER_SPECS.stayLength)).toEqual([180, 730]);
    expect(sliderToRange([450, 750], SLIDER_SPECS.rent)).toEqual({ best: 450, worst: 750 });
    expect(sliderToRange([9, 20], SLIDER_SPECS.sizeM2)).toEqual({ worst: 9, best: 20 });
    expect(sliderToRange([180, 730], SLIDER_SPECS.stayLength)).toEqual({ minimumDays: 180, minStayDays: 730 });
  });

  it('shows values outside the bounds at the nearest end, and tolerates missing values', () => {
    expect(rangeToSlider({ best: 0, worst: 72 }, SLIDER_SPECS.recencyHours)).toEqual([1, 72]);
    expect(rangeToSlider({ best: 100, worst: 5000 }, SLIDER_SPECS.rent)).toEqual([200, 1500]);
    expect(rangeToSlider({}, SLIDER_SPECS.rent)).toEqual([200, 1500]);
  });

  it('describes the current values next to the slider', () => {
    expect(describeRange({ best: 450, worst: 750 }, SLIDER_SPECS.rent)).toBe('Best 450 €, worst 750 €');
    expect(describeRange({ best: 1.5, worst: 10 }, SLIDER_SPECS.distanceKm)).toBe('Best 1.5 km, worst 10 km');
    expect(describeRange({ minStayDays: 730, minimumDays: 180 }, SLIDER_SPECS.stayLength)).toBe(
      'Shortest acceptable 180 days, wanted 730 days',
    );
    expect(describeRange({ best: null, worst: 10 }, SLIDER_SPECS.distanceKm)).toBe('Best -, worst 10 km');
  });
});

describe('#auto-reject form', () => {
  const form = {
    verbindung: { enabled: true, keywords: true, ai: true, aiThreshold: 0.6 },
    shortTerm: { enabled: false, minMonths: 6 },
  };

  it('sends the whole section as it is', () => {
    expect(autoRejectBody(form)).toEqual({ autoReject: form });
  });

  it('has the slider ranges of the server limits', () => {
    expect(AUTO_REJECT_SLIDERS.threshold).toEqual({ min: 0.3, max: 0.95, step: 0.05 });
    expect(AUTO_REJECT_SLIDERS.months).toEqual({ min: 1, max: 24, step: 1 });
  });

  it('accepts the defaults and the range ends, refuses values outside', () => {
    expect(validateAutoRejectForm(form)).toEqual([]);
    expect(
      validateAutoRejectForm({
        ...form,
        verbindung: { ...form.verbindung, aiThreshold: 0.95 },
        shortTerm: { enabled: true, minMonths: 24 },
      }),
    ).toEqual([]);
    expect(validateAutoRejectForm({ ...form, verbindung: { ...form.verbindung, aiThreshold: 0.2 } })).toHaveLength(1);
    expect(validateAutoRejectForm({ ...form, shortTerm: { enabled: true, minMonths: 0 } })).toHaveLength(1);
    expect(validateAutoRejectForm({ ...form, shortTerm: { enabled: true, minMonths: 2.5 } })).toHaveLength(1);
  });
});
