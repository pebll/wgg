import { describe, it, expect } from 'vitest';
import {
  formatRent,
  queueHelp,
  flatmateParts,
  describeFlat,
  flatLabel,
  formatNotified,
  formatSize,
  formatAvailability,
  formatAvailableDate,
  formatOnlineAge,
  formatLocation,
  formatScore,
  safeLink,
  breakdownRows,
  formatRelativeTime,
  formatDistance,
  scoreBucket,
  postedAt,
  isNewListing,
} from '../../ui/src/services/format.js';

describe('#ui format helpers', () => {
  it('formats rent and size, with a placeholder for unknown values', () => {
    expect(formatRent(600)).toBe('600 €');
    expect(formatRent(612.5)).toBe('612.5 €');
    expect(formatRent(null)).toBe('---');
    expect(formatSize(20)).toBe('20 m²');
    expect(formatSize(null)).toBe('---');
  });

  it('formats availability in European text form, "immediately" for past dates', () => {
    const now = new Date(2026, 9, 2, 15, 30).getTime(); // 2 October 2026, local
    expect(formatAvailability('2026-11-01', null, now)).toBe('1 November 2026');
    expect(formatAvailability('2026-10-01', '2027-04-30', now)).toBe('immediately – 30 April 2027');
    expect(formatAvailability('2026-11-01', '2027-04-30', now)).toBe('1 November 2026 – 30 April 2027');
    expect(formatAvailability('2026-10-02', null, now)).toBe('immediately');
    expect(formatAvailability(null, '2027-01-31', now)).toBe('until 31 January 2027');
    expect(formatAvailability(null, null, now)).toBe('—');
  });

  it('formats a single available date', () => {
    const now = new Date(2026, 9, 2).getTime();
    expect(formatAvailableDate('2026-12-09', now)).toBe('9 December 2026');
    expect(formatAvailableDate('2026-10-03', now)).toBe('3 October 2026');
    expect(formatAvailableDate('2026-10-02', now)).toBe('immediately');
    expect(formatAvailableDate('2025-01-01', now)).toBe('immediately');
    expect(formatAvailableDate(null, now)).toBe('—');
    expect(formatAvailableDate('garbage', now)).toBe('garbage');
  });

  it('formats the online age', () => {
    expect(formatOnlineAge(3)).toBe('3 min');
    expect(formatOnlineAge(60)).toBe('1 h');
    expect(formatOnlineAge(150)).toBe('2 h');
    expect(formatOnlineAge(2880)).toBe('2 d');
    expect(formatOnlineAge(0)).toBe('0 min');
    expect(formatOnlineAge(null)).toBe('---');
  });

  it('joins district and street', () => {
    expect(formatLocation('München Maxvorstadt', 'Teststr. 1')).toBe('München Maxvorstadt, Teststr. 1');
    expect(formatLocation('München', null)).toBe('München');
    expect(formatLocation(null, 'Teststr. 1')).toBe('Teststr. 1');
    expect(formatLocation(null, null)).toBe('---');
  });

  it('formats scores', () => {
    expect(formatScore(8)).toBe('8');
    expect(formatScore(7.25)).toBe('7.3');
    expect(formatScore(null)).toBe('---');
  });

  it('only allows http(s) links', () => {
    expect(safeLink('https://www.wg-gesucht.de/x.1.html')).toBe('https://www.wg-gesucht.de/x.1.html');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('not a url')).toBeNull();
    expect(safeLink(null)).toBeNull();
  });

  it('builds breakdown rows from whatever shape the evaluation has', () => {
    expect(breakdownRows(null)).toEqual({ rows: [], missing: [], excludedReason: null, overall: null });
    const b = breakdownRows({
      overall: 7.5,
      scores: { price: 9, size: 6 },
      details: { price: 'cheap', commute: 'no data' },
      missing: ['size'],
      excludedReason: 'too far',
    });
    expect(b.overall).toBe(7.5);
    expect(b.missing).toEqual(['size']);
    expect(b.excludedReason).toBe('too far');
    expect(b.rows).toEqual([
      { param: 'price', score: 9, detail: 'cheap' },
      { param: 'size', score: 6, detail: null },
      { param: 'commute', score: null, detail: 'no data' },
    ]);
    expect(breakdownRows({ overall: 1 }).rows).toEqual([]);
  });
});

describe('#ui card helpers', () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  it('formats relative time', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatRelativeTime(now - 50 * 3_600_000, now)).toBe('2 d ago');
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now');
    expect(formatRelativeTime(null, now)).toBe('---');
  });

  it('prefers publishedAt, falls back to first seen and says so', () => {
    expect(postedAt({ publishedAt: now - 3_600_000, firstSeenAt: now - 10 }, now)).toBe('posted 1 h ago');
    expect(postedAt({ publishedAt: null, firstSeenAt: now - 7_200_000 }, now)).toBe('first seen 2 h ago');
    expect(postedAt({}, now)).toBe('---');
  });

  it('labels distance with precision hint and the user target', () => {
    expect(formatDistance(1.234, 'address', 'Marienplatz')).toBe('1.2 km to Marienplatz');
    expect(formatDistance(3.46, 'district', 'Marienplatz')).toBe('≈ 3.5 km to Marienplatz (district only)');
    expect(formatDistance(2, null, '  Uni  ')).toBe('2.0 km to Uni');
    expect(formatDistance(null, null, 'Marienplatz')).toBe('distance unknown');
  });

  it('falls back to a plain distance without a target name', () => {
    expect(formatDistance(1.234, 'address')).toBe('1.2 km');
    expect(formatDistance(3.46, 'district')).toBe('≈ 3.5 km (district only)');
    expect(formatDistance(2, null, '')).toBe('2.0 km');
    expect(formatDistance(2, null, '   ')).toBe('2.0 km');
    expect(formatDistance(2, null, null)).toBe('2.0 km');
    expect(formatDistance(null, null)).toBe('distance unknown');
  });

  it('buckets scores for badge colors', () => {
    expect(scoreBucket({ overall: 8.4 })).toBe('good');
    expect(scoreBucket({ overall: 8 })).toBe('good');
    expect(scoreBucket({ overall: 5 })).toBe('ok');
    expect(scoreBucket({ overall: 4.9 })).toBe('bad');
    expect(scoreBucket({ overall: 1, excludedReason: 'Verbindung' })).toBe('excluded');
    expect(scoreBucket({ overall: null })).toBe('none');
    expect(scoreBucket(null)).toBe('none');
  });

  it('marks listings posted less than one hour ago as new', () => {
    const now = new Date(2026, 9, 2, 15, 0).getTime();
    const min = 60_000;
    expect(isNewListing({ publishedAt: now - 59 * min }, now)).toBe(true);
    expect(isNewListing({ publishedAt: now - 60 * min }, now)).toBe(false);
    expect(isNewListing({ publishedAt: now + 2 * min }, now)).toBe(true); // small clock skew
    // posting time wins over first seen: an old ad found just now is not new
    expect(isNewListing({ publishedAt: now - 3 * 60 * min, firstSeenAt: now - min }, now)).toBe(false);
    expect(isNewListing({ publishedAt: null, firstSeenAt: now - 10 * min }, now)).toBe(true);
    expect(isNewListing({}, now)).toBe(false);
    expect(isNewListing(null, now)).toBe(false);
  });
});

describe('#photo failure state', () => {
  it('a failed image only counts for the url that failed (a new selection retries)', async () => {
    const { photoFailed } = await import('../../ui/src/services/format.js');
    expect(photoFailed('https://a/1.jpg', 'https://a/1.jpg')).toBe(true);
    expect(photoFailed('https://a/1.jpg', 'https://a/2.jpg')).toBe(false);
    expect(photoFailed(null, 'https://a/2.jpg')).toBe(false);
  });
});

describe('#formatNotified', () => {
  const at = new Date(2026, 9, 2, 14, 32).getTime();
  it('says which kind of alert was sent and when', () => {
    expect(formatNotified({ notified: true, notifiedKind: 'priority', notifiedAt: at })).toBe(
      'Fantastic alert sent · 14:32',
    );
    expect(
      formatNotified({ notified: true, notifiedKind: 'bulk', notifiedAt: new Date(2026, 9, 2, 9, 5).getTime() }),
    ).toBe('In Good digest · 09:05');
  });
  it('falls back to a plain label for older rows and is null when nothing was sent', () => {
    expect(formatNotified({ notified: true, notifiedKind: null, notifiedAt: at })).toBe('Alert sent · 14:32');
    expect(formatNotified({ notified: false, notifiedKind: null, notifiedAt: null })).toBeNull();
  });
});

describe('#queueHelp', () => {
  it('explains the queues: detail pace, AI right after details, one at a time across users', () => {
    const text = queueHelp();
    expect(text).toMatch(/30.{1,3}90 seconds/);
    expect(text).toMatch(/right after/i);
    expect(text).toMatch(/one at a time/i);
    expect(text).toMatch(/your/i);
  });
});

describe('#flatmates labels', () => {
  const f = { wgSize: 3, female: 1, male: 1, diverse: 0, unspecified: 0 };

  it('lists the non-zero genders in WG-Gesucht order with a symbol each', () => {
    expect(flatmateParts({ ...f, diverse: 1 })).toEqual([
      { key: 'female', symbol: '♀', count: 1, label: 'woman' },
      { key: 'male', symbol: '♂', count: 1, label: 'man' },
      { key: 'diverse', symbol: '⚧', count: 1, label: 'diverse' },
    ]);
    expect(flatmateParts({ ...f, female: 2, male: 0 }).map((p) => [p.key, p.count, p.label])).toEqual([
      ['female', 2, 'women'],
    ]);
    expect(flatmateParts({ wgSize: 3, female: 0, male: 0, diverse: 0, unspecified: 0 })).toEqual([]);
    expect(flatmateParts(null)).toEqual([]);
  });

  it('describes the flat for assistive technology', () => {
    expect(describeFlat({ wgSize: 3, flatmates: f })).toBe('3-person flat: 1 woman, 1 man');
    expect(describeFlat({ wgSize: 3, flatmates: { ...f, female: 2, male: 0, diverse: 1 } })).toBe(
      '3-person flat: 2 women, 1 diverse',
    );
    expect(describeFlat({ wgSize: 4, flatmates: null })).toBe('4-person flat');
    expect(describeFlat({ wgSize: 3, flatmates: { ...f, female: 0, male: 0 } })).toBe('3-person flat');
    expect(describeFlat({ wgSize: null, flatmates: null })).toBeNull();
  });

  it('labels the size like WG-Gesucht', () => {
    expect(flatLabel({ wgSize: 3 })).toBe('3er WG');
    expect(flatLabel({ wgSize: null })).toBeNull();
  });
});
