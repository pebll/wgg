import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WINDOW,
  DEFAULT_INTERVAL_HOURS,
  isValidWindow,
  isValidInterval,
  inWindow,
  slotHours,
  dueSlot,
  nextSlot,
  nextWindowStart,
  closedHours,
  formatHour,
  formatTime,
  summarizePriority,
  summarizeBulk,
} from '../../ui/src/services/schedule.js';

const at = (h, m = 0, day = 2) => new Date(2026, 9, day, h, m, 0, 0).getTime();
const W = { from: 7, to: 23 };

describe('#defaults and validation', () => {
  it('defaults are 7-23 and one hour', () => {
    expect(DEFAULT_WINDOW).toEqual({ from: 7, to: 23 });
    expect(DEFAULT_INTERVAL_HOURS).toBe(1);
  });
  it('accepts whole hours with from < to inside 0..24', () => {
    expect(isValidWindow({ from: 0, to: 24 })).toBe(true);
    expect(isValidWindow({ from: 7, to: 23 })).toBe(true);
    for (const bad of [
      { from: 7, to: 7 },
      { from: 8, to: 7 },
      { from: -1, to: 5 },
      { from: 5, to: 25 },
      { from: 7.5, to: 20 },
      { from: '7', to: 20 },
      null,
      [],
      {},
    ]) {
      expect(isValidWindow(bad)).toBe(false);
    }
  });
  it('accepts intervals of 1..24 whole hours', () => {
    expect(isValidInterval(1)).toBe(true);
    expect(isValidInterval(24)).toBe(true);
    for (const bad of [0, 25, 1.5, '2', null, NaN]) expect(isValidInterval(bad)).toBe(false);
  });
});

describe('#window and slots', () => {
  it('inWindow is from <= hour < to in local time', () => {
    expect(inWindow(W, at(6, 59))).toBe(false);
    expect(inWindow(W, at(7, 0))).toBe(true);
    expect(inWindow(W, at(22, 59))).toBe(true);
    expect(inWindow(W, at(23, 0))).toBe(false);
  });
  it('lists the send slots from the window start, last one at most at the window end', () => {
    expect(slotHours(W, 1)).toHaveLength(17);
    expect(slotHours(W, 1)[0]).toBe(7);
    expect(slotHours(W, 1).at(-1)).toBe(23);
    expect(slotHours(W, 3)).toEqual([7, 10, 13, 16, 19, 22]);
    expect(slotHours({ from: 0, to: 24 }, 6)).toEqual([0, 6, 12, 18]);
    expect(slotHours({ from: 0, to: 24 }, 1)).toHaveLength(24); // 24:00 is tomorrow's 0:00, not a slot
    expect(slotHours({ from: 7, to: 23 }, 24)).toEqual([7]);
  });
  it('dueSlot is the latest slot of today that has been reached, else null', () => {
    expect(dueSlot(W, 1, at(6, 59))).toBeNull();
    expect(dueSlot(W, 1, at(7, 0))).toBe(at(7));
    expect(dueSlot(W, 1, at(10, 30))).toBe(at(10));
    expect(dueSlot(W, 3, at(12, 59))).toBe(at(10));
    expect(dueSlot(W, 1, at(23, 40))).toBe(at(23));
  });
  it('nextSlot is the first slot after now, else tomorrow morning', () => {
    expect(nextSlot(W, 1, at(6, 0))).toBe(at(7));
    expect(nextSlot(W, 1, at(10, 30))).toBe(at(11));
    expect(nextSlot(W, 1, at(10, 0))).toBe(at(11));
    expect(nextSlot(W, 3, at(23, 30))).toBe(at(7, 0, 3));
  });
  it('nextWindowStart is the next time the window opens', () => {
    expect(nextWindowStart(W, at(3, 0))).toBe(at(7));
    expect(nextWindowStart(W, at(7, 0))).toBe(at(7, 0, 3));
    expect(nextWindowStart(W, at(23, 30))).toBe(at(7, 0, 3));
  });
  it('closedHours is the time outside the window', () => {
    expect(closedHours(W)).toBe(8);
    expect(closedHours({ from: 0, to: 24 })).toBe(0);
  });
});

describe('#text', () => {
  it('formats hours and clock times', () => {
    expect(formatHour(7)).toBe('07:00');
    expect(formatHour(24)).toBe('24:00');
    expect(formatTime(at(7, 5))).toBe('07:05');
  });
  it('summarizes the Fantastic window', () => {
    expect(summarizePriority(W)).toBe('Instant between 07:00 and 23:00; otherwise one morning email at 07:00.');
    expect(summarizePriority({ from: 0, to: 24 })).toBe('Instant, at any time of day.');
  });
  it('summarizes the Good schedule', () => {
    expect(summarizeBulk(W, 1)).toBe('Every 1 h between 07:00 and 23:00 (17 slots); otherwise one morning email.');
    expect(summarizeBulk(W, 3)).toBe('Every 3 h between 07:00 and 23:00 (6 slots); otherwise one morning email.');
    expect(summarizeBulk({ from: 7, to: 23 }, 24)).toBe(
      'Every 24 h between 07:00 and 23:00 (1 slot); otherwise one morning email.',
    );
    expect(summarizeBulk({ from: 0, to: 24 }, 6)).toBe('Every 6 h, at any time of day (4 slots).');
  });
});
