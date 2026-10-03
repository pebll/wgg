import { describe, it, expect } from 'vitest';
import { resolveTheme, nextTheme } from '../../ui/src/services/theme.js';

describe('#ui theme', () => {
  it('uses the stored choice, otherwise the system preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme('garbage', false)).toBe('light');
  });
  it('toggles', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
  });
});
