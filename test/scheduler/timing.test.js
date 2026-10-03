import { describe, it, expect } from 'vitest';
import { backoffMinutes, jitterMs, computeWaitMs } from '../../lib/scheduler/timing.js';

describe('#backoffMinutes', () => {
  it('returns the base interval with no failures', () => {
    expect(backoffMinutes({ baseMinutes: 5, maxMinutes: 60, failures: 0 })).toBe(5);
  });

  it('doubles per consecutive failure', () => {
    const f = (failures) => backoffMinutes({ baseMinutes: 5, maxMinutes: 60, failures });
    expect([1, 2, 3].map(f)).toEqual([10, 20, 40]);
  });

  it('is capped at the maximum', () => {
    expect(backoffMinutes({ baseMinutes: 5, maxMinutes: 60, failures: 4 })).toBe(60);
    expect(backoffMinutes({ baseMinutes: 5, maxMinutes: 60, failures: 50 })).toBe(60);
  });

  it('never goes below the base interval even if max < base', () => {
    expect(backoffMinutes({ baseMinutes: 10, maxMinutes: 5, failures: 3 })).toBe(10);
  });
});

describe('#jitterMs', () => {
  it('spans +/- percent around the base', () => {
    expect(jitterMs(100_000, 20, () => 0)).toBe(80_000);
    expect(jitterMs(100_000, 20, () => 0.5)).toBe(100_000);
    expect(jitterMs(100_000, 20, () => 1)).toBe(120_000);
  });

  it('is exact with 0 percent', () => {
    expect(jitterMs(100_000, 0, () => 0.9)).toBe(100_000);
  });
});

describe('#computeWaitMs', () => {
  it('combines backoff and jitter', () => {
    const ms = computeWaitMs({
      baseMinutes: 5,
      maxMinutes: 60,
      failures: 1,
      jitterPercent: 20,
      random: () => 0.5,
    });
    expect(ms).toBe(10 * 60_000);
  });

  it('stays within the jitter bounds of the capped interval', () => {
    for (let i = 0; i < 100; i++) {
      const ms = computeWaitMs({ baseMinutes: 5, maxMinutes: 60, failures: 9, jitterPercent: 20 });
      expect(ms).toBeGreaterThanOrEqual(48 * 60_000);
      expect(ms).toBeLessThanOrEqual(72 * 60_000);
    }
  });
});
