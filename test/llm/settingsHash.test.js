import { describe, it, expect } from 'vitest';
import { llmSettingsHash } from '../../lib/llm/settingsHash.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';

const base = { model: 'm', profile: 'p' };
const DEFAULT_NAME = defaultEvaluationConfig().target.name;

describe('#llmSettingsHash target name', () => {
  it('changes when the target name changes', () => {
    expect(llmSettingsHash({ ...base, targetName: 'Marienplatz' })).not.toBe(llmSettingsHash(base));
    expect(llmSettingsHash({ ...base, targetName: 'Marienplatz' })).not.toBe(
      llmSettingsHash({ ...base, targetName: 'Hauptbahnhof' }),
    );
  });

  it('stays the same for the default target, a blank name or surrounding spaces (no needless re-assessment)', () => {
    const plain = llmSettingsHash(base);
    expect(llmSettingsHash({ ...base, targetName: DEFAULT_NAME })).toBe(plain);
    expect(llmSettingsHash({ ...base, targetName: '' })).toBe(plain);
    expect(llmSettingsHash({ ...base, targetName: ` Marienplatz ` })).toBe(
      llmSettingsHash({ ...base, targetName: 'Marienplatz' }),
    );
  });
});
