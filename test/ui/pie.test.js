import { describe, it, expect } from 'vitest';
import { WEIGHT_COLORS, describePie, pieSlices } from '../../ui/src/services/pie.js';

const entries = (o) => Object.entries(o).map(([key, value]) => ({ key, value }));

describe('#pie slices', () => {
  it('gives every positive weight its share and an angle range that tiles the circle from the top', () => {
    const slices = pieSlices(entries({ rent: 3, distance: 3, recency: 2, size: 1 }));
    expect(slices.map((s) => s.key)).toEqual(['rent', 'distance', 'recency', 'size']);
    expect(slices.map((s) => s.share)).toEqual([3 / 9, 3 / 9, 2 / 9, 1 / 9]);
    expect(slices[0].startAngle).toBe(0);
    for (let i = 1; i < slices.length; i++) expect(slices[i].startAngle).toBeCloseTo(slices[i - 1].endAngle, 10);
    expect(slices.at(-1).endAngle).toBeCloseTo(360, 10);
    expect(slices[0].endAngle).toBeCloseTo(120, 10);
  });

  it('omits zero, negative and non-numeric weights', () => {
    const slices = pieSlices(entries({ rent: 1, distance: 0, recency: -2, size: null, stayLength: 'x' }));
    expect(slices.map((s) => s.key)).toEqual(['rent']);
  });

  it('is empty when every weight is zero', () => {
    expect(pieSlices(entries({ rent: 0, distance: 0 }))).toEqual([]);
    expect(pieSlices([])).toEqual([]);
  });

  it('draws a single slice as a full circle (an arc from a point to itself is invisible)', () => {
    const [only] = pieSlices(entries({ rent: 2, distance: 0 }), { cx: 50, cy: 50, radius: 40 });
    expect(only.share).toBe(1);
    expect(only.full).toBe(true);
    const [a, b] = pieSlices(entries({ rent: 1, distance: 1 }), { cx: 50, cy: 50, radius: 40 });
    expect(a.full).toBe(false);
    expect(a.path).toBe('M 50 50 L 50 10 A 40 40 0 0 1 50 90 Z');
    expect(b.path).toBe('M 50 50 L 50 90 A 40 40 0 0 1 50 10 Z');
  });

  it('uses the large-arc flag above half the circle', () => {
    const [big] = pieSlices(entries({ rent: 3, distance: 1 }), { cx: 0, cy: 0, radius: 10 });
    expect(big.path).toMatch(/A 10 10 0 1 1 /);
  });

  it('keeps one color per parameter and a readable summary without the zero weights', () => {
    expect(Object.keys(WEIGHT_COLORS).sort()).toEqual(['distance', 'recency', 'rent', 'size', 'stayLength']);
    expect(new Set(Object.values(WEIGHT_COLORS)).size).toBe(5);
    const labels = { rent: 'Rent', distance: 'Distance', size: 'Size' };
    expect(describePie(pieSlices(entries({ rent: 2, distance: 1, size: 0 })), labels)).toBe(
      'Share of the total weight: Rent 67%, Distance 33%.',
    );
    expect(describePie([], labels)).toBe('No weights set.');
  });
});
