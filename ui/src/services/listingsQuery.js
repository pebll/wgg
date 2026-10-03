import { EMPTY_RANGES, hasRanges, rangeParams } from './rangeFilters.js';
import { tierMeta } from './tiers.js';

/** "Sort by" options: the listing order the server applies (Score and AI Score descending, Rent ascending). */
export const SORT_OPTIONS = [
  { value: 'overall', label: 'Score', dir: 'desc' },
  { value: 'ai', label: 'AI Score', dir: 'desc' },
  { value: 'price', label: 'Rent', dir: 'asc' },
];

/** "Recency" options: the age limit in hours. "New" is the same window as the blinking New tag. */
export const RECENCY_OPTIONS = [
  { hours: 1, label: 'New' },
  { hours: 24, label: '< 1 day' },
  { hours: 72, label: '< 3 days' },
];

export const DEFAULT_FILTERS = {
  sort: 'overall',
  dir: 'desc',
  maxAgeHours: 72, // every visit starts at Score, < 3 days, All: nothing is remembered between visits
  showNotInterested: false, // list the offers you hid with "Not interested" too
  showMessaged: false, // list the offers you marked as messaged too
  showAuto: false, // list the offers wgg removed automatically (excluded keyword, rent, AI verdict) too
  ranges: EMPTY_RANGES, // the distribution charts' range filters (click a bar)
  tier: null, // 'good' | 'fantastic' | null: only offers with that alert tier (excludes the range filters)
  page: 1,
  pageSize: 24,
};

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** The filters patch for choosing a sort option. */
export function sortPatch(sort) {
  const option = SORT_OPTIONS.find((o) => o.value === sort) ?? SORT_OPTIONS[0];
  return { sort: option.value, dir: option.dir };
}

/** `show=` value for the API from the three switches, or null when all are off. */
function showParam({ showNotInterested, showMessaged, showAuto }) {
  const parts = [showNotInterested && 'not_interested', showMessaged && 'messaged', showAuto && 'auto'].filter(Boolean);
  return parts.length > 0 ? parts.join(',') : null;
}

/** Builds the /api/listings query string; a null age limit is left out. */
export function buildListingsQuery({ sort, dir, maxAgeHours, page, pageSize, ranges, tier, ...rest }) {
  const params = new URLSearchParams({ sort, dir });
  if (isNumber(maxAgeHours)) params.set('maxAgeHours', String(maxAgeHours));
  if (tierMeta(tier)) params.set('tier', tier);
  const show = showParam(rest);
  if (show) params.set('show', show);
  for (const [name, value] of Object.entries(rangeParams(ranges))) params.set(name, value);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params.toString();
}

/** Query string for /api/stats: the same filters as the list, without sort or paging. */
export function buildStatsQuery({ maxAgeHours, ranges, tier, ...rest }) {
  const params = new URLSearchParams();
  if (isNumber(maxAgeHours)) params.set('maxAgeHours', String(maxAgeHours));
  if (tierMeta(tier)) params.set('tier', tier);
  const show = showParam(rest);
  if (show) params.set('show', show);
  for (const [name, value] of Object.entries(rangeParams(ranges))) params.set(name, value);
  return params.toString();
}

/**
 * The mode of the "Filter" control: All | Good | Fantastic | Custom. A tier decides it; else any chart range (or the
 * "Custom was picked, no bar clicked yet" hint) means custom.
 * @param {{tier: string|null, ranges: object}} filters
 * @param {boolean} customHint
 */
export function filterMode({ tier, ranges }, customHint) {
  if (tierMeta(tier)) return tier;
  return hasRanges(ranges) || customHint ? 'custom' : 'all';
}

/** The filters patch for choosing a mode: a tier and the chart ranges exclude each other. */
export function filterModePatch(mode) {
  if (mode === 'custom') return { tier: null };
  return { tier: tierMeta(mode) ? mode : null, ranges: EMPTY_RANGES };
}
