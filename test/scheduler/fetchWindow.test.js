import { describe, it, expect } from 'vitest';
import { fetchWindowOf, isFetchOpen, msUntilFetchOpen } from '../../lib/scheduler/fetchWindow.js';

const dir = (windows) => ({
  users: windows.map((_, i) => ({ username: `u${i}` })),
  settings: (id) => ({ notify: { bulk: { enabled: true, window: windows[Number(id.slice(1))] } } }),
});

describe('#fetchWindowOf', () => {
  it('is the union (earliest from .. latest to) of all users Good windows', () => {
    expect(
      fetchWindowOf(
        dir([
          { from: 8, to: 20 },
          { from: 6, to: 18 },
          { from: 9, to: 22 },
        ]),
      ),
    ).toEqual({
      from: 6,
      to: 22,
    });
  });

  it('counts users whose Good alerts are disabled too', () => {
    const d = {
      users: [{ username: 'a' }, { username: 'b' }],
      settings: (id) => ({
        notify: { bulk: { enabled: id === 'a', window: id === 'a' ? { from: 8, to: 12 } : { from: 5, to: 9 } } },
      }),
    };
    expect(fetchWindowOf(d)).toEqual({ from: 5, to: 12 });
  });

  it('falls back to 7-23 without users or valid windows', () => {
    expect(fetchWindowOf(dir([]))).toEqual({ from: 7, to: 23 });
    expect(fetchWindowOf(dir([{ from: 9, to: 9 }, undefined]))).toEqual({ from: 7, to: 23 });
  });
});

describe('#isFetchOpen / msUntilFetchOpen', () => {
  const w = { from: 7, to: 23 };
  const at = (h, m = 0, day = 2) => new Date(2026, 9, day, h, m).getTime();
  it('is open inside the window and closed at night', () => {
    expect(isFetchOpen(w, at(7))).toBe(true);
    expect(isFetchOpen(w, at(22, 59))).toBe(true);
    expect(isFetchOpen(w, at(23))).toBe(false);
    expect(isFetchOpen(w, at(3))).toBe(false);
  });
  it('waits until the next window start', () => {
    expect(msUntilFetchOpen(w, at(12))).toBe(0);
    expect(msUntilFetchOpen(w, at(23, 30))).toBe(7.5 * 3_600_000);
    expect(msUntilFetchOpen(w, at(3))).toBe(4 * 3_600_000);
  });
});
