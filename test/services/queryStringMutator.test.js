import { describe, expect, it } from 'vitest';
import mutate from '../../lib/services/queryStringMutator.js';

const BASE = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';

describe('queryStringMutator', () => {
  it('returns the url untouched when there is nothing to merge', () => {
    expect(mutate(BASE, null)).toBe(BASE);
    expect(mutate(`${BASE}?a=1#frag`, undefined)).toBe(`${BASE}?a=1#frag`);
  });

  it('adds parameters to a bare url', () => {
    expect(mutate(BASE, 'sort_column=0&sort_order=0')).toBe(`${BASE}?sort_column=0&sort_order=0`);
  });

  it('keeps the existing parameters', () => {
    expect(mutate(`${BASE}?rent_type=0`, 'sort_column=0')).toBe(`${BASE}?rent_type=0&sort_column=0`);
  });

  it('lets the merged value win', () => {
    expect(mutate(`${BASE}?sort_column=5&x=1`, 'sort_column=0')).toBe(`${BASE}?sort_column=0&x=1`);
  });

  it('orders keys alphabetically', () => {
    expect(mutate(BASE, 'z=1&a=2')).toBe(`${BASE}?a=2&z=1`);
  });

  it('drops a fragment and percent-encodes values', () => {
    expect(mutate(`${BASE}#top`, 'q=a b')).toBe(`${BASE}?q=a%20b`);
  });
});
