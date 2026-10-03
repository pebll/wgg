import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadEvaluationConfig,
  parseEvaluationConfig,
  defaultEvaluationConfig,
  EvaluationConfigError,
} from '../../lib/evaluation/config.js';

let dir;
const tmp = () => (dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-eval-')));
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('#evaluation config', () => {
  it('the committed example parses and equals the code defaults', () => {
    const cfg = loadEvaluationConfig('config/does-not-exist.yaml', { warn: () => {} });
    expect(cfg).toEqual(defaultEvaluationConfig());
    expect(cfg.target.lat).toBeCloseTo(48.1488833);
    expect(cfg.weights).toEqual({ rent: 3, distance: 3, recency: 2, size: 1.5, stayLength: 1.5 });
    expect(cfg.rent).toEqual({ best: 450, worst: 750 });
    expect(cfg).not.toHaveProperty('wgSize');
  });

  it('warns and falls back to the example when the real file is missing', () => {
    const warnings = [];
    loadEvaluationConfig(path.join(tmp(), 'nope.yaml'), { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/evaluation\.example\.yaml/);
  });

  it('merges a partial real file over the defaults', () => {
    const file = path.join(tmp(), 'evaluation.yaml');
    fs.writeFileSync(file, 'rent:\n  best: 400\nweights:\n  rent: 5\n');
    const cfg = loadEvaluationConfig(file);
    expect(cfg.rent).toEqual({ best: 400, worst: 750 });
    expect(cfg.weights.rent).toBe(5);
    expect(cfg.weights.distance).toBe(3);
  });

  it('ignores the removed rent cap, WG size range and WG size weight of older files', () => {
    const file = path.join(tmp(), 'evaluation.yaml');
    fs.writeFileSync(
      file,
      'rent:\n  best: 400\n  hardMax: 700\nwgSize:\n  best: 3\n  worst: 8\nweights:\n  rent: 5\n  wgSize: 2\n',
    );
    const cfg = loadEvaluationConfig(file);
    expect(cfg.rent).toEqual({ best: 400, worst: 750 });
    expect(cfg).not.toHaveProperty('wgSize');
    expect(cfg.weights).toEqual({ rent: 5, distance: 3, recency: 2, size: 1.5, stayLength: 1.5 });
  });

  it('rejects invalid values with a clear message', () => {
    const bad = (raw, re) => expect(() => parseEvaluationConfig(raw)).toThrow(re);
    bad({ weights: { rent: -1 } }, /weights\.rent/);
    bad({ weights: { rent: 'x' } }, /weights\.rent/);
    bad({ rent: { best: 500, worst: 500 } }, /rent/);
    bad({ target: { lat: 91, lng: 0 } }, /target\.lat/);
    bad({ target: { lat: 1, lng: 'x' } }, /target\.lng/);
    bad({ exclusions: { keywords: 'Verbindung' } }, /keywords/);
    bad({ weights: { rent: 0, distance: 0, recency: 0, size: 0, stayLength: 0 } }, /at least one/);
    bad({ stayLength: { minStayDays: 10, minimumDays: 30 } }, /minimumDays/);
    expect(() => parseEvaluationConfig('nope')).toThrow(EvaluationConfigError);
  });

  it('has llm defaults (model empty in the example) and validates the llm section', () => {
    const d = defaultEvaluationConfig();
    expect(d.llm).toEqual({
      enabled: true,
      model: '',
      weight: 2,
      excludeThreshold: 0.6,
      badgeThreshold: 0.3,
      maxDescriptionChars: 12000,
      delaySeconds: 2,
      hideIneligible: true,
      profile: expect.stringMatching(/\S/),
    });
    expect(parseEvaluationConfig({ llm: { model: 'x', weight: 3 } }).llm).toMatchObject({ model: 'x', weight: 3 });
    const bad = (raw, re) => expect(() => parseEvaluationConfig(raw)).toThrow(re);
    bad({ llm: 'x' }, /llm/);
    bad({ llm: { enabled: 'yes' } }, /llm\.enabled/);
    bad({ llm: { model: 3 } }, /llm\.model/);
    bad({ llm: { weight: -1 } }, /llm\.weight/);
    bad({ llm: { excludeThreshold: 1.5 } }, /llm\.excludeThreshold/);
    bad({ llm: { badgeThreshold: -0.1 } }, /llm\.badgeThreshold/);
    bad({ llm: { maxDescriptionChars: 100 } }, /llm\.maxDescriptionChars/);
    bad({ llm: { delaySeconds: -1 } }, /llm\.delaySeconds/);
    bad({ llm: { profile: 5 } }, /llm\.profile/);
    bad({ llm: { hideIneligible: 'yes' } }, /llm\.hideIneligible/);
  });

  it('autoHide defaults to off and validates belowOverall', () => {
    expect(defaultEvaluationConfig().autoHide).toEqual({ belowOverall: null });
    expect(parseEvaluationConfig({ autoHide: { belowOverall: 3 } }).autoHide.belowOverall).toBe(3);
    const bad = (raw) => expect(() => parseEvaluationConfig(raw)).toThrow(/autoHide\.belowOverall/);
    bad({ autoHide: { belowOverall: 'x' } });
    bad({ autoHide: { belowOverall: 0 } });
    bad({ autoHide: { belowOverall: 11 } });
  });
});
