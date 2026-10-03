import { describe, it, expect } from 'vitest';
import { EMPTY_RANGES } from '../../ui/src/services/rangeFilters.js';
import { TIER_META, tierMeta } from '../../ui/src/services/tiers.js';
import {
  DEFAULT_FILTERS,
  buildListingsQuery,
  buildStatsQuery,
  filterMode,
  filterModePatch,
} from '../../ui/src/services/listingsQuery.js';

describe('#ui tier metadata', () => {
  it('names the tiers Fantastic and Good, with the tooltip that explains the alert', () => {
    expect(tierMeta('fantastic')).toMatchObject({
      label: 'Fantastic',
      tooltip: 'Matches your Fantastic alert rule (sent immediately by email)',
    });
    expect(tierMeta('good')).toMatchObject({
      label: 'Good',
      tooltip: 'Matches your Good rule (sent in the bulk digest)',
    });
    expect(Object.keys(TIER_META)).toEqual(['fantastic', 'good']);
  });
  it('has no metadata without a (known) tier', () => {
    expect(tierMeta(null)).toBeNull();
    expect(tierMeta(undefined)).toBeNull();
    expect(tierMeta('priority')).toBeNull();
  });
});

describe('#ui tier filter query', () => {
  it('sends tier to the list and the stats, and nothing when there is none', () => {
    expect(new URLSearchParams(buildListingsQuery({ ...DEFAULT_FILTERS, tier: 'good' })).get('tier')).toBe('good');
    expect(new URLSearchParams(buildStatsQuery({ ...DEFAULT_FILTERS, tier: 'fantastic' })).get('tier')).toBe(
      'fantastic',
    );
    expect(new URLSearchParams(buildListingsQuery(DEFAULT_FILTERS)).has('tier')).toBe(false);
    expect(new URLSearchParams(buildStatsQuery(DEFAULT_FILTERS)).has('tier')).toBe(false);
  });
  it('is no tier by default', () => {
    expect(DEFAULT_FILTERS.tier).toBeNull();
  });
});

describe('#ui Filter control (All | Good | Fantastic | Custom)', () => {
  const ranges = { ...EMPTY_RANGES, rent: { min: 400, max: 500 } };
  it('shows the mode the filters describe', () => {
    expect(filterMode({ tier: null, ranges: EMPTY_RANGES }, false)).toBe('all');
    expect(filterMode({ tier: 'good', ranges: EMPTY_RANGES }, false)).toBe('good');
    expect(filterMode({ tier: 'fantastic', ranges: EMPTY_RANGES }, false)).toBe('fantastic');
    expect(filterMode({ tier: null, ranges }, false)).toBe('custom');
    expect(filterMode({ tier: null, ranges: EMPTY_RANGES }, true)).toBe('custom');
  });
  it('Good and Fantastic clear the ranges; All clears both; Custom clears the tier', () => {
    expect(filterModePatch('good')).toEqual({ tier: 'good', ranges: EMPTY_RANGES });
    expect(filterModePatch('fantastic')).toEqual({ tier: 'fantastic', ranges: EMPTY_RANGES });
    expect(filterModePatch('all')).toEqual({ tier: null, ranges: EMPTY_RANGES });
    expect(filterModePatch('custom')).toEqual({ tier: null });
  });
  it('a tier wins over the Custom hint (the hint is reset by choosing it)', () => {
    expect(filterMode({ tier: 'good', ranges: EMPTY_RANGES }, true)).toBe('good');
  });
});
