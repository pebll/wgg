import { describe, it, expect } from 'vitest';
import { buildListingsQuery, buildStatsQuery, DEFAULT_FILTERS } from '../../ui/src/services/listingsQuery.js';
import { hiddenAutomaticallyLabel, isShownWhenHidden } from '../../ui/src/services/format.js';

describe('#ui show switches', () => {
  it('are all off by default and send show= only for the switches that are on', () => {
    expect(DEFAULT_FILTERS).toMatchObject({ showNotInterested: false, showMessaged: false, showAuto: false });
    const get = (f) => new URLSearchParams(buildListingsQuery({ ...DEFAULT_FILTERS, ...f })).get('show');
    expect(get({})).toBeNull();
    expect(get({ showNotInterested: true })).toBe('not_interested');
    expect(get({ showMessaged: true })).toBe('messaged');
    expect(get({ showNotInterested: true, showMessaged: true })).toBe('not_interested,messaged');
    expect(get({ showAuto: true })).toBe('auto');
    expect(get({ showNotInterested: true, showMessaged: true, showAuto: true })).toBe('not_interested,messaged,auto');
  });

  it('never sends includeHidden any more; the stats get the same show value', () => {
    const q = new URLSearchParams(buildListingsQuery({ ...DEFAULT_FILTERS, includeHidden: true }));
    expect(q.has('includeHidden')).toBe(false);
    expect(new URLSearchParams(buildStatsQuery({ ...DEFAULT_FILTERS, showMessaged: true })).get('show')).toBe(
      'messaged',
    );
  });

  it('knows whether a just-hidden offer stays visible', () => {
    expect(isShownWhenHidden(DEFAULT_FILTERS, 'messaged')).toBe(false);
    expect(isShownWhenHidden({ ...DEFAULT_FILTERS, showMessaged: true }, 'messaged')).toBe(true);
    expect(isShownWhenHidden({ ...DEFAULT_FILTERS, showMessaged: true }, 'not_interested')).toBe(false);
    expect(isShownWhenHidden({ ...DEFAULT_FILTERS, showNotInterested: true }, 'not_interested')).toBe(true);
    expect(isShownWhenHidden({ ...DEFAULT_FILTERS, showAuto: true }, 'not_interested')).toBe(false);
  });

  it('words the muted toolbar line for automatically hidden offers', () => {
    expect(hiddenAutomaticallyLabel(0)).toBeNull();
    expect(hiddenAutomaticallyLabel(undefined)).toBeNull();
    expect(hiddenAutomaticallyLabel(1)).toBe('1 removed automatically');
    expect(hiddenAutomaticallyLabel(12)).toBe('12 removed automatically');
  });
});
