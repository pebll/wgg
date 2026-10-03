import { describe, it, expect } from 'vitest';
import { computePublishedAt, parseOnlineAge } from '../../lib/provider/onlineAge.js';

const FIRST_SEEN = new Date(2026, 9, 2, 12, 0, 0).getTime();

describe('#computePublishedAt', () => {
  it('subtracts minutes, hours and days from first_seen_at', () => {
    expect(computePublishedAt('Online: 5 Minuten', FIRST_SEEN)).toBe(FIRST_SEEN - 5 * 60_000);
    expect(computePublishedAt('Online: 1 Stunde', FIRST_SEEN)).toBe(FIRST_SEEN - 60 * 60_000);
    expect(computePublishedAt('Online: 2 Tage', FIRST_SEEN)).toBe(FIRST_SEEN - 2 * 1440 * 60_000);
  });

  it('treats seconds as "just now"', () => {
    expect(computePublishedAt('Online: 39 Sekunden', FIRST_SEEN)).toBe(FIRST_SEEN);
    expect(parseOnlineAge('Online: 39 Sekunden')).toBe(0);
  });

  it('uses local midnight of an explicit date', () => {
    expect(computePublishedAt('Online: 27.08.2026', FIRST_SEEN)).toBe(new Date(2026, 7, 27).getTime());
  });

  it('falls back to the stored online_minutes when the text is not understood', () => {
    expect(computePublishedAt(null, FIRST_SEEN, 10)).toBe(FIRST_SEEN - 10 * 60_000);
  });

  it('returns null when the age is unknown', () => {
    expect(computePublishedAt(null, FIRST_SEEN)).toBeNull();
    expect(computePublishedAt('whatever', FIRST_SEEN)).toBeNull();
  });
});
