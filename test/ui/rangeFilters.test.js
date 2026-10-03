import { describe, it, expect } from 'vitest';
import {
  EMPTY_RANGES,
  clearRange,
  hasRanges,
  isActiveBin,
  rangeChips,
  rangeParams,
  restoreRanges,
  toggleBin,
} from '../../ui/src/services/rangeFilters.js';
import { DEFAULT_FILTERS, buildListingsQuery, buildStatsQuery } from '../../ui/src/services/listingsQuery.js';

const bin = (from, to) => ({ from, to, count: 1 });

describe('#range filters from bar clicks', () => {
  it('start empty', () => {
    expect(hasRanges(EMPTY_RANGES)).toBe(false);
    expect(DEFAULT_FILTERS.ranges).toEqual(EMPTY_RANGES);
  });

  it('a click on a bar sets that chart range [from, to)', () => {
    const r = toggleBin(EMPTY_RANGES, 'score', bin(7, 8), { last: false });
    expect(r.score).toEqual({ min: 7, max: 8 });
    expect(r.rent).toEqual({ min: null, max: null });
    expect(hasRanges(r)).toBe(true);
  });

  it('the last bar has no upper bound (it also holds everything above, and 10 itself)', () => {
    expect(toggleBin(EMPTY_RANGES, 'score', bin(9, 10), { last: true }).score).toEqual({ min: 9, max: null });
    expect(toggleBin(EMPTY_RANGES, 'rent', bin(3000, 3050), { last: true }).rent).toEqual({ min: 3000, max: null });
  });

  it('another bar of the same chart replaces its range; other charts keep theirs (AND)', () => {
    let r = toggleBin(EMPTY_RANGES, 'score', bin(7, 8), { last: false });
    r = toggleBin(r, 'rent', bin(600, 650), { last: false });
    r = toggleBin(r, 'score', bin(5, 6), { last: false });
    expect(r.score).toEqual({ min: 5, max: 6 });
    expect(r.rent).toEqual({ min: 600, max: 650 });
  });

  it('clicking the active bar again clears the range', () => {
    const r = toggleBin(EMPTY_RANGES, 'ai', bin(8, 9), { last: false });
    expect(isActiveBin(r, 'ai', bin(8, 9), { last: false })).toBe(true);
    expect(isActiveBin(r, 'ai', bin(7, 8), { last: false })).toBe(false);
    expect(isActiveBin(r, 'score', bin(8, 9), { last: false })).toBe(false);
    expect(toggleBin(r, 'ai', bin(8, 9), { last: false })).toEqual(EMPTY_RANGES);
    const last = toggleBin(EMPTY_RANGES, 'ai', bin(9, 10), { last: true });
    expect(isActiveBin(last, 'ai', bin(9, 10), { last: true })).toBe(true);
    expect(toggleBin(last, 'ai', bin(9, 10), { last: true })).toEqual(EMPTY_RANGES);
  });

  it('does not mutate its input', () => {
    toggleBin(EMPTY_RANGES, 'score', bin(7, 8), { last: false });
    expect(EMPTY_RANGES.score).toEqual({ min: null, max: null });
  });
});

describe('#range chips', () => {
  it('has one removable chip per active range, in chart order, with units', () => {
    const r = {
      score: { min: 7, max: 8 },
      ai: { min: null, max: null },
      rent: { min: 600, max: 650 },
      dist: { min: 0, max: 1 },
    };
    expect(rangeChips(r)).toEqual([
      { key: 'score', label: 'Score 7–8' },
      { key: 'rent', label: 'Rent 600–650 €' },
      { key: 'dist', label: 'Distance 0–1 km' },
    ]);
  });

  it('words an open end with a plus', () => {
    expect(rangeChips({ ...EMPTY_RANGES, ai: { min: 9, max: null } })).toEqual([{ key: 'ai', label: 'AI score 9+' }]);
    expect(rangeChips({ ...EMPTY_RANGES, rent: { min: null, max: 500 } })).toEqual([
      { key: 'rent', label: 'Rent below 500 €' },
    ]);
  });

  it('removing a chip clears only that range', () => {
    const r = toggleBin(toggleBin(EMPTY_RANGES, 'score', bin(7, 8), {}), 'rent', bin(600, 650), {});
    expect(clearRange(r, 'score')).toEqual({ ...EMPTY_RANGES, rent: { min: 600, max: 650 } });
  });
});

describe('#range filters in the API queries', () => {
  const ranges = {
    score: { min: 7, max: 8 },
    ai: { min: 9, max: null },
    rent: { min: null, max: 650 },
    dist: { min: 0, max: 1 },
  };

  it('are sent for the list and the stats, only for the bounds that are set', () => {
    expect(rangeParams(EMPTY_RANGES)).toEqual({});
    expect(rangeParams(ranges)).toEqual({
      scoreMin: '7',
      scoreMax: '8',
      aiMin: '9',
      rentMax: '650',
      distMin: '0',
      distMax: '1',
    });
    for (const build of [buildListingsQuery, buildStatsQuery]) {
      const q = new URLSearchParams(build({ ...DEFAULT_FILTERS, ranges }));
      expect(Object.fromEntries(q)).toMatchObject({ scoreMin: '7', aiMin: '9', rentMax: '650', distMax: '1' });
      expect(q.has('aiMax')).toBe(false);
    }
    expect(new URLSearchParams(buildListingsQuery(DEFAULT_FILTERS)).has('scoreMin')).toBe(false);
  });

  it('ignore remembered garbage', () => {
    expect(restoreRanges(null)).toEqual(EMPTY_RANGES);
    expect(restoreRanges({ score: { min: 'x', max: 5 }, bogus: { min: 1 }, rent: 'no' })).toEqual({
      ...EMPTY_RANGES,
      score: { min: null, max: 5 },
    });
  });
});
