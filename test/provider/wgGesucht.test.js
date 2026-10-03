import { describe, it, expect } from 'vitest';
import fs from 'fs';
import {
  parseListings,
  fetchListings,
  parseAvailability,
  parseOnlineAge,
  parseDetails,
} from '../../lib/provider/wgGesucht.js';
import { BotDetectedError } from '../../lib/errors.js';
import { extractNumber } from '../../lib/utils/extract-number.js';

const html = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');

describe('#wgGesucht parseListings (offline fixture)', () => {
  const listings = parseListings(html);

  it('parses all real cards and skips partner ads (no data-id)', () => {
    expect(listings).toHaveLength(28);
    expect(new Set(listings.map((l) => l.providerId)).size).toBe(28);
  });

  it('uses the card data-id as providerId (not hashed with price)', () => {
    expect(listings[0].providerId).toBe('1000001');
  });

  it('parses the first card completely', () => {
    expect(listings[0]).toMatchObject({
      providerId: '1000001',
      link: 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen-Beispielviertel.1000001.html',
      title: 'Sunny room in a friendly 3-person flat #7',
      price: 525,
      priceRaw: '525 €',
      size: 22,
      sizeRaw: '22 m²',
      flatmatesRaw: '6er WG',
      wgSize: 6,
      district: 'München Beispielviertel',
      street: 'Musterstraße 12',
      availableFrom: '2026-11-01',
      availableUntil: null,
      availabilityRaw: '01.11.2026',
      onlineRaw: 'Online: 23 Stunden',
      onlineMinutes: 1380,
    });
    expect(listings[0].image).toMatch(/^https:\/\/img\.wg-gesucht\.de\/.*\.large\.jpg$/);
  });

  it('parses availability ranges', () => {
    const l = listings.find((x) => x.providerId === '1000006');
    expect(l.availableFrom).toBe('2026-10-01');
    expect(l.availableUntil).toBe('2028-10-30');
    expect(l.availabilityRaw).toBe('01.10.2026 - 30.10.2028');
  });

  it('parses hour-based online age', () => {
    const l = listings.find((x) => x.providerId === '1000005');
    expect(l.onlineRaw).toBe('Online: 5 Stunden');
    expect(l.onlineMinutes).toBe(300);
  });

  it('returns an empty list for pages without cards', () => {
    expect(parseListings('<html><body><p>nothing</p></body></html>')).toEqual([]);
  });
});

describe('#wgGesucht helpers', () => {
  it('parseAvailability', () => {
    expect(parseAvailability('01.08.2026')).toEqual({ from: '2026-08-01', until: null });
    expect(parseAvailability('26.07.2026 - 30.06.2027')).toEqual({ from: '2026-07-26', until: '2027-06-30' });
    expect(parseAvailability('ab sofort')).toEqual({ from: null, until: null });
    expect(parseAvailability(null)).toEqual({ from: null, until: null });
  });

  it('parseAvailability treats "ab sofort - <date>" as open start with an end date', () => {
    expect(parseAvailability('ab sofort - 31.12.2026')).toEqual({ from: null, until: '2026-12-31' });
    expect(parseAvailability('ab sofort')).toEqual({ from: null, until: null });
    expect(parseAvailability('ab 01.11.2026')).toEqual({ from: '2026-11-01', until: null });
  });

  it('parseOnlineAge', () => {
    expect(parseOnlineAge('Online: 3 Minuten')).toBe(3);
    expect(parseOnlineAge('Online: 1 Minute')).toBe(1);
    expect(parseOnlineAge('Online: 1 Stunde')).toBe(60);
    expect(parseOnlineAge('Online: 2 Tage')).toBe(2880);
    expect(parseOnlineAge('Online: 1 Tag')).toBe(1440);
    expect(parseOnlineAge('whatever')).toBeNull();
    expect(parseOnlineAge(null)).toBeNull();
  });

  it('parseOnlineAge handles the date form shown for older listings', () => {
    const now = new Date(2026, 9, 2, 12, 0).getTime(); // 02.10.2026 12:00 local
    expect(parseOnlineAge('Online: 01.10.2026', now)).toBe(36 * 60);
    expect(parseOnlineAge('Online: 02.10.2026', now)).toBe(12 * 60);
    expect(parseOnlineAge('Online: 03.10.2026', now)).toBe(0); // clock skew: never negative
  });

  it('parseDetails splits "<wg> | <district> | <street>"', () => {
    expect(parseDetails('3er WG | München Maxvorstadt | Schellingstr. 5')).toEqual({
      flatmatesRaw: '3er WG',
      wgSize: 3,
      district: 'München Maxvorstadt',
      street: 'Schellingstr. 5',
    });
    expect(parseDetails('2er WG | München')).toMatchObject({ district: 'München', street: null });
    expect(parseDetails(null)).toEqual({ flatmatesRaw: null, wgSize: null, district: null, street: null });
  });

  it('extractNumber handles German formats', () => {
    expect(extractNumber('1.234 €')).toBe(1234);
    expect(extractNumber('3,5 Zi.')).toBe(3.5);
    expect(extractNumber(null)).toBeNull();
  });
});

describe('#wgGesucht fetchListings', () => {
  const url = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';

  it('fetches and parses via the injected fetcher', async () => {
    const seen = [];
    const listings = await fetchListings(url, {
      fetchHtml: async (u) => {
        seen.push(u);
        return html;
      },
    });
    expect(listings).toHaveLength(28);
    expect(seen).toEqual([`${url}?sort_column=0&sort_order=0`]);
  });

  it('surfaces bot detection from the fetcher', async () => {
    await expect(
      fetchListings(url, {
        fetchHtml: async () => {
          throw new BotDetectedError(url);
        },
      }),
    ).rejects.toBeInstanceOf(BotDetectedError);
  });

  it('surfaces a bot wall page returned as HTML', async () => {
    await expect(
      fetchListings(url, { fetchHtml: async () => '<html>Please verify you are human</html>' }),
    ).rejects.toBeInstanceOf(BotDetectedError);
  });
});

describe('#wgGesucht flatmates on the search cards', () => {
  const listings = parseListings(html);

  it('every real card carries its flatmates from the title attribute', () => {
    expect(listings.every((l) => l.flatmates !== null)).toBe(true);
    expect(listings[0].flatmates).toEqual({
      wgSize: 6,
      female: 0,
      male: 4,
      diverse: 0,
      unspecified: 0,
      raw: '6er WG (0w,4m,0d,0n)',
    });
  });

  it('the flatmates agree with the "<N>er WG" text of the card', () => {
    for (const l of listings) expect(l.flatmates.wgSize).toBe(l.wgSize);
  });

  it('a card without the title has flatmates null (the plain WG size stays)', () => {
    const bare = html.replace(/ title="\d+er WG \([^"]*\)"/g, '');
    const parsed = parseListings(bare);
    expect(parsed).toHaveLength(28);
    expect(parsed.every((l) => l.flatmates === null)).toBe(true);
    expect(parsed[0].wgSize).toBe(6);
  });
});
