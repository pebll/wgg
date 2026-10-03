import { describe, it, expect } from 'vitest';
import { parseFlatmates, describeFlatmates } from '../../lib/provider/flatmates.js';

describe('#parseFlatmates', () => {
  it('reads the WG-Gesucht title "<N>er WG (<w>w,<m>m,<d>d,<n>n)"', () => {
    expect(parseFlatmates('3er WG (1w,1m,0d,0n)')).toEqual({
      wgSize: 3,
      female: 1,
      male: 1,
      diverse: 0,
      unspecified: 0,
      raw: '3er WG (1w,1m,0d,0n)',
    });
    expect(parseFlatmates('4er WG (1w,2m,1d,0n)')).toMatchObject({ wgSize: 4, female: 1, male: 2, diverse: 1 });
    expect(parseFlatmates('2er WG (0w,0m,0d,0n)')).toMatchObject({ wgSize: 2, female: 0, male: 0 });
  });

  it('keeps the "n" count as unspecified (its meaning is not verified) and is lenient about spaces and case', () => {
    expect(parseFlatmates('  5er  WG ( 1w, 2m, 0d, 2n ) ')).toMatchObject({
      wgSize: 5,
      female: 1,
      male: 2,
      unspecified: 2,
    });
    expect(parseFlatmates('3ER WG (1W,1M,0D,0N)')).toMatchObject({ wgSize: 3, female: 1 });
  });

  it.each([null, undefined, '', 'WG', '3er WG', '3er WG (1w,1m)', '3er WG (aw,1m,0d,0n)', 'Zimmer in 2er WG (1w', 42])(
    'is null for malformed or missing input %j',
    (input) => {
      expect(parseFlatmates(input)).toBeNull();
    },
  );

  it('describeFlatmates names the known flatmates, not the zero counts', () => {
    expect(describeFlatmates(parseFlatmates('3er WG (1w,1m,0d,0n)'))).toBe('1 woman, 1 man');
    expect(describeFlatmates(parseFlatmates('4er WG (2w,0m,1d,0n)'))).toBe('2 women, 1 diverse');
    expect(describeFlatmates(parseFlatmates('3er WG (0w,0m,0d,0n)'))).toBeNull();
    expect(describeFlatmates(null)).toBeNull();
  });
});
