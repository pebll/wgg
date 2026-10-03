import { describe, it, expect } from 'vitest';
import { EMPTY_RANGES } from '../../ui/src/services/rangeFilters.js';
import {
  buildListingsQuery,
  buildStatsQuery,
  DEFAULT_FILTERS,
  SORT_OPTIONS,
  RECENCY_OPTIONS,
  sortPatch,
} from '../../ui/src/services/listingsQuery.js';

describe('#ui buildListingsQuery', () => {
  it('encodes sort, recency and paging; the default is Score and "< 3 days"', () => {
    expect(buildListingsQuery(DEFAULT_FILTERS)).toBe('sort=overall&dir=desc&maxAgeHours=72&page=1&pageSize=24');
  });

  it('has exactly the sort options Score, AI Score, Rent and the recency options New, < 1 day, < 3 days', () => {
    expect(SORT_OPTIONS.map((o) => o.label)).toEqual(['Score', 'AI Score', 'Rent']);
    expect(RECENCY_OPTIONS.map((o) => [o.label, o.hours])).toEqual([
      ['New', 1],
      ['< 1 day', 24],
      ['< 3 days', 72],
    ]);
    expect(DEFAULT_FILTERS.maxAgeHours).toBe(72);
  });

  it('maps a sort option to its direction: score and AI score descending, rent ascending', () => {
    expect(sortPatch('overall')).toEqual({ sort: 'overall', dir: 'desc' });
    expect(sortPatch('ai')).toEqual({ sort: 'ai', dir: 'desc' });
    expect(sortPatch('price')).toEqual({ sort: 'price', dir: 'asc' });
    expect(new URLSearchParams(buildListingsQuery({ ...DEFAULT_FILTERS, ...sortPatch('price') })).get('dir')).toBe(
      'asc',
    );
  });

  it('no longer sends max rent or min score', () => {
    const q = new URLSearchParams(buildListingsQuery({ ...DEFAULT_FILTERS, minScore: 7.5, maxRent: 500 }));
    expect(q.has('minScore')).toBe(false);
    expect(q.has('maxRent')).toBe(false);
  });

  it('omits the age limit when it is null', () => {
    expect(new URLSearchParams(buildListingsQuery({ ...DEFAULT_FILTERS, maxAgeHours: null })).has('maxAgeHours')).toBe(
      false,
    );
  });
});

describe('#ui buildStatsQuery', () => {
  it('carries the recency filter but no sort or paging', () => {
    const q = new URLSearchParams(buildStatsQuery({ ...DEFAULT_FILTERS, showMessaged: true, page: 3 }));
    expect(Object.fromEntries(q)).toEqual({ maxAgeHours: '72', show: 'messaged' });
  });
});

describe('#ui default filters', () => {
  it('every visit starts at Score, < 3 days and Filter All, with the hidden switches off', () => {
    expect(DEFAULT_FILTERS).toMatchObject({
      sort: 'overall',
      dir: 'desc',
      maxAgeHours: 72,
      tier: null,
      ranges: EMPTY_RANGES,
      showNotInterested: false,
      showMessaged: false,
      showAuto: false,
    });
  });
});
