import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { getStoredSettings, saveSettings } from '../../lib/services/settings/userSettingsStorage.js';

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(() => Db.reset());

describe('#stored user settings', () => {
  it('ignores the removed rent cap, WG size range and WG size weight of settings saved earlier', () => {
    saveSettings('alice', {
      scoring: {
        rent: { best: 400, worst: 700, hardMax: 820 },
        wgSize: { best: 3, worst: 8 },
        weights: { rent: 3, wgSize: 0 },
        keywords: ['Corps'],
      },
      llm: { profile: 'x' },
    });
    expect(getStoredSettings('alice')).toEqual({
      scoring: { rent: { best: 400, worst: 700 }, weights: { rent: 3 }, keywords: ['Corps'] },
      llm: { profile: 'x' },
    });
  });

  it('leaves settings without those keys, and a missing row, alone', () => {
    saveSettings('bob', { llm: { profile: 'y' } });
    expect(getStoredSettings('bob')).toEqual({ llm: { profile: 'y' } });
    expect(getStoredSettings('nobody')).toBeNull();
  });
});
