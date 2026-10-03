import { describe, it, expect } from 'vitest';
import { barGeometry, binLabel, describeHistogram, sideCounts } from '../../ui/src/services/histogram.js';
import { buildStatsQuery, DEFAULT_FILTERS } from '../../ui/src/services/listingsQuery.js';

const bins = [
  { from: 0, to: 1, count: 2 },
  { from: 1, to: 2, count: 0 },
  { from: 2, to: 3, count: 4 },
];

describe('#ui barGeometry', () => {
  const g = barGeometry(bins, { width: 300, height: 100, margin: { top: 10, right: 0, bottom: 20, left: 0 } });

  it('scales bar heights to the largest count within the plot area', () => {
    expect(g.maxCount).toBe(4);
    expect(g.plot).toEqual({ x: 0, y: 10, width: 300, height: 70 });
    expect(g.bars.map((b) => b.height)).toEqual([35, 0, 70]);
    // bars sit on the baseline (plot bottom = 80)
    expect(g.bars.map((b) => b.y + b.height)).toEqual([80, 80, 80]);
  });

  it('spreads bars evenly with a gap and keeps the bin data', () => {
    expect(g.bars).toHaveLength(3);
    expect(g.bars[0].x).toBeLessThan(g.bars[1].x);
    expect(g.bars[0].width).toBeGreaterThan(0);
    expect(g.bars[0].x + g.bars[0].width).toBeLessThan(g.bars[1].x); // gap
    expect(g.bars[2]).toMatchObject({ from: 2, to: 3, count: 4 });
  });

  it('is safe for no bins and for all-zero bins', () => {
    expect(barGeometry([], { width: 100, height: 50 }).bars).toEqual([]);
    const zero = barGeometry([{ from: 0, to: 1, count: 0 }], { width: 100, height: 50 });
    expect(zero.maxCount).toBe(0);
    expect(zero.bars[0].height).toBe(0);
  });
});

describe('#ui binLabel', () => {
  it('formats the bin range per chart kind with an en dash', () => {
    expect(binLabel({ from: 5, to: 6 }, 'score')).toBe('5–6');
    expect(binLabel({ from: 400, to: 450 }, 'rent')).toBe('400–450 €');
    expect(binLabel({ from: 2, to: 3 }, 'distance')).toBe('2–3 km');
  });
});

describe('#ui describeHistogram', () => {
  it('summarises counts, the fullest bin and the side counts for screen readers', () => {
    const text = describeHistogram('Distance', bins, 'distance', { unknown: 3 });
    expect(text).toContain('Distance');
    expect(text).toContain('6 offers');
    expect(text).toContain('most in 2–3 km (4)');
    expect(text).toContain('3 unknown');
  });

  it('names the unassessed offers of the AI chart', () => {
    expect(describeHistogram('AI score', bins, 'score', { unassessed: 2 })).toContain('2 not assessed');
    expect(sideCounts({ unscored: 1, unassessed: 2, unknown: 3 })).toEqual([
      '1 not scored',
      '2 not assessed',
      '3 unknown',
    ]);
    expect(sideCounts({ unscored: 0 })).toEqual([]);
  });

  it('mentions the bar that is selected', () => {
    expect(describeHistogram('Rent', bins, 'rent', {}, { from: 1, to: 2 })).toContain('selected: 1–2 €');
  });

  it('says so when there is no data', () => {
    expect(describeHistogram('Rent', [], 'rent', {})).toBe('Rent: no data');
  });
});

describe('#ui buildStatsQuery', () => {
  it('carries the filters but no sort or paging', () => {
    const q = new URLSearchParams(buildStatsQuery({ ...DEFAULT_FILTERS, showMessaged: true, page: 3 }));
    expect(Object.fromEntries(q)).toEqual({ maxAgeHours: '72', show: 'messaged' });
  });
});
