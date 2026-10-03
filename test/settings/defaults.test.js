import { describe, it, expect } from 'vitest';
import { defaultEvaluationConfig, parseEvaluationConfig } from '../../lib/evaluation/config.js';
import { defaultUserSettings, mergeSettings, buildEvaluationConfig } from '../../lib/settings/defaults.js';
import { llmSettingsHash } from '../../lib/llm/settingsHash.js';
import { PROMPT_VERSION } from '../../lib/llm/prompt.js';
import { parseConfig } from '../../lib/config.js';

const evaluation = () => ({
  ...defaultEvaluationConfig(),
  llm: { ...defaultEvaluationConfig().llm, profile: 'Leo: 24, male, looking for a long-term room.' },
});
const notify = () => parseConfig({ searches: [{ url: 'https://www.wg-gesucht.de/x.html' }] }).notify;

describe('#user settings defaults', () => {
  it("derive from the global evaluation config and notify defaults (the admin's profile text is the default profile)", () => {
    const s = defaultUserSettings({ evaluation: evaluation(), notify: notify(), email: 'leo@example.org' });
    expect(s.scoring.target).toEqual({
      name: 'TUM Universitätsbibliothek Stammgelände',
      address: 'TUM Universitätsbibliothek Stammgelände',
      lat: 48.1488833,
      lng: 11.5677668,
    });
    expect(s.scoring.rent).toEqual({ best: 450, worst: 750 });
    expect(s.scoring).not.toHaveProperty('wgSize');
    expect(s.scoring.weights).not.toHaveProperty('wgSize');
    expect(s.scoring.weights.rent).toBe(3);
    expect(s.scoring.keywords).toContain('Studentenverbindung');
    expect(s.llm).toEqual({ profile: 'Leo: 24, male, looking for a long-term room.', hideIneligible: true });
    expect(s.notify).toEqual({
      email: 'leo@example.org',
      enabled: true,
      priority: { enabled: true, rules: [{ overall: { gt: 7 }, ai: { gt: 7 } }], window: { from: 7, to: 23 } },
      bulk: {
        enabled: true,
        rules: [{ overall: { gt: 5 }, ai: { gt: 5 } }],
        window: { from: 7, to: 23 },
        intervalHours: 1,
      },
      maxAgeHours: 24,
    });
  });

  it("are independent copies (editing one user's settings never changes another's defaults)", () => {
    const a = defaultUserSettings({ evaluation: evaluation(), notify: notify() });
    const b = defaultUserSettings({ evaluation: evaluation(), notify: notify() });
    a.scoring.rent.best = 1;
    a.notify.priority.rules.push({ rent: { lt: 1 } });
    expect(b.scoring.rent.best).toBe(450);
    expect(b.notify.priority.rules).toHaveLength(1);
    expect(a.notify.email).toBeNull();
  });

  it('mergeSettings lays stored values over the defaults, so new default keys appear and arrays are replaced', () => {
    const defaults = defaultUserSettings({ evaluation: evaluation(), notify: notify() });
    const merged = mergeSettings(defaults, {
      scoring: { rent: { best: 400 }, keywords: ['Corps'] },
      notify: { bulk: { rules: [] } },
    });
    expect(merged.scoring.rent).toEqual({ best: 400, worst: 750 });
    expect(merged.scoring.keywords).toEqual(['Corps']);
    expect(merged.notify.bulk.rules).toEqual([]);
    expect(merged.notify.priority.rules).toHaveLength(1);
    expect(merged.llm.profile).toContain('long-term');
    expect(mergeSettings(defaults, null)).toEqual(defaults);
    expect(mergeSettings(defaults, 'junk')).toEqual(defaults);
  });

  it("buildEvaluationConfig puts the user's settings into a config the evaluator accepts", () => {
    const base = evaluation();
    const settings = defaultUserSettings({ evaluation: base, notify: notify() });
    settings.scoring.target = { name: 'Berlin Hbf', address: 'Berlin Hbf', lat: 52.52, lng: 13.37 };
    settings.scoring.rent.worst = 900;
    settings.scoring.keywords = ['Corps'];
    settings.llm = { profile: 'Anna', hideIneligible: false };
    const config = buildEvaluationConfig(base, settings);
    expect(config.target).toEqual({ name: 'Berlin Hbf', lat: 52.52, lng: 13.37 });
    expect(config.rent.worst).toBe(900);
    expect(config.exclusions.keywords).toEqual(['Corps']);
    expect(config.llm).toMatchObject({
      profile: 'Anna',
      hideIneligible: false,
      weight: base.llm.weight,
      enabled: true,
    });
    expect(config.autoHide).toEqual(base.autoHide);
    expect(() => parseEvaluationConfig(config)).not.toThrow(); // same shape as a parsed evaluation config
  });
});

describe('#llmSettingsHash', () => {
  it('changes with the profile, the model and the prompt version, and not with whitespace around the profile', () => {
    const base = llmSettingsHash({ model: 'm', profile: 'Leo' });
    expect(llmSettingsHash({ model: 'm', profile: 'Leo' })).toBe(base);
    expect(llmSettingsHash({ model: 'm', profile: '  Leo \n' })).toBe(base);
    expect(llmSettingsHash({ model: 'm2', profile: 'Leo' })).not.toBe(base);
    expect(llmSettingsHash({ model: 'm', profile: 'Anna' })).not.toBe(base);
    expect(llmSettingsHash({ model: 'm', profile: 'Leo', promptVersion: PROMPT_VERSION + 1 })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('#send schedule defaults', () => {
  it('start every user at 7-23 h, Good once an hour, and follow the config defaults', () => {
    const custom = parseConfig({
      searches: [{ url: 'https://www.wg-gesucht.de/x.html' }],
      notify: { priority: { window: { from: 8, to: 22 } }, bulk: { window: { from: 9, to: 21 }, intervalHours: 3 } },
    }).notify;
    const s = defaultUserSettings({ evaluation: evaluation(), notify: custom });
    expect(s.notify.priority.window).toEqual({ from: 8, to: 22 });
    expect(s.notify.bulk.window).toEqual({ from: 9, to: 21 });
    expect(s.notify.bulk.intervalHours).toBe(3);
  });

  it('are merged into the stored settings of users who saved before the schedule existed', () => {
    const defaults = defaultUserSettings({ evaluation: evaluation(), notify: notify() });
    const merged = mergeSettings(defaults, { notify: { priority: { enabled: false, rules: [] }, bulk: { rules: [] } } });
    expect(merged.notify.priority).toEqual({ enabled: false, rules: [], window: { from: 7, to: 23 } });
    expect(merged.notify.bulk.intervalHours).toBe(1);
  });
});
