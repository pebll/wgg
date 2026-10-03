import { describe, expect, it } from 'vitest';
import { extractNumber } from '../../lib/utils/extract-number.js';

describe('extractNumber', () => {
  it.each([
    ['590 €', 590],
    ['1.234 €', 1234],
    ['1.234.567', 1234567],
    ['3,5 Zi.', 3.5],
    ['3.5 Zimmer', 3.5],
    ['1.2345', 1.2345],
    ['  24 m²', 24],
    ['590 € 24 m²', 590],
    ['819€', 819],
    ['0€', 0],
  ])('parses %j as %j', (input, expected) => {
    expect(extractNumber(input)).toBe(expected);
  });

  it.each(['n.a.', '', '   ', 'ab 590'])('returns null for %j', (input) => {
    expect(extractNumber(input)).toBeNull();
  });

  it('handles null, undefined and numbers', () => {
    expect(extractNumber(null)).toBeNull();
    expect(extractNumber(undefined)).toBeNull();
    expect(extractNumber(7)).toBe(7);
  });
});
