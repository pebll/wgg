import { describe, it, expect } from 'vitest';
import { detailStatusLabel, formatFact, groupFacts, excerpt, formatCost } from '../../ui/src/services/format.js';

describe('#detailStatusLabel', () => {
  it('is null once the details are fetched or when there is no detail info', () => {
    expect(detailStatusLabel({ status: 'fetched' })).toBeNull();
    expect(detailStatusLabel(undefined)).toBeNull();
  });
  it('names pending, skipped and failed (with the reason)', () => {
    expect(detailStatusLabel({ status: 'pending', attempts: 0 })).toBe('Details pending');
    expect(detailStatusLabel({ status: 'pending', attempts: 1, error: 'HTTP 500' })).toBe(
      'Details pending (attempt 1 failed: HTTP 500)',
    );
    expect(detailStatusLabel({ status: 'skipped' })).toBe('Details skipped (listing too old)');
    expect(detailStatusLabel({ status: 'failed', attempts: 3, error: 'HTTP 500' })).toBe('Details failed: HTTP 500');
    expect(detailStatusLabel({ status: 'failed', attempts: 3, error: null })).toBe('Details failed');
  });
});

describe('#formatFact / #groupFacts', () => {
  it('shows "label: value" or just the text the page had', () => {
    expect(formatFact({ label: 'Wohnungsgröße', value: '84m²' })).toBe('Wohnungsgröße: 84m²');
    expect(formatFact({ label: null, value: '3er WG' })).toBe('3er WG');
    expect(formatFact({ label: 'möbliert', value: null })).toBe('möbliert');
  });
  it('groups consecutive WG facts by their group, keeping the page order; no group stays flat', () => {
    expect(
      groupFacts([
        { group: 'Die WG', label: null, value: 'a' },
        { group: 'Die WG', label: null, value: 'b' },
        { group: 'Gesucht wird', label: null, value: 'c' },
      ]),
    ).toEqual([
      { group: 'Die WG', facts: [expect.objectContaining({ value: 'a' }), expect.objectContaining({ value: 'b' })] },
      { group: 'Gesucht wird', facts: [expect.objectContaining({ value: 'c' })] },
    ]);
    expect(groupFacts([{ label: 'möbliert', value: null }])).toEqual([
      { group: null, facts: [{ label: 'möbliert', value: null }] },
    ]);
    expect(groupFacts(undefined)).toEqual([]);
  });
});

describe('#excerpt', () => {
  it('returns short text unchanged and cuts long text at a word boundary with an ellipsis', () => {
    expect(excerpt('kurz', 20)).toBe('kurz');
    expect(excerpt('eins zwei drei vier fünf', 14)).toBe('eins zwei…');
    expect(excerpt(null, 20)).toBe('');
  });
  it('collapses line breaks', () => {
    expect(excerpt('a\n\nb', 20)).toBe('a b');
  });
});

describe('#formatCost', () => {
  it('shows the page text, "n.a." as not given', () => {
    expect(formatCost({ raw: '819€', value: 819 })).toBe('819 €');
    expect(formatCost({ raw: '0€', value: 0 })).toBe('0 €');
    expect(formatCost({ raw: 'n.a.', value: null })).toBe('not given');
    expect(formatCost({ raw: 'nach Absprache', value: null })).toBe('nach Absprache');
  });
});
