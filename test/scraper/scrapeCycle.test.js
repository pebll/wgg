import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { runScrapeCycle, runCycleWithFetcher } from '../../lib/scraper/scrapeCycle.js';
import { getFetchStatus } from '../../lib/services/status/fetchStatus.js';
import { BotDetectedError, FetchError } from '../../lib/errors.js';

const html = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');

const A = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const B = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';

const makeConfig = (searches = [{ name: 'A', url: A }]) => ({
  searches,
  schedule: { delayBetweenSearchesSeconds: [5, 15] },
});

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});

afterEach(() => Db.reset());

describe('#runScrapeCycle', () => {
  it('stores new listings and reports them; a second run reports none', async () => {
    const fetchHtml = async () => html;
    const first = await runScrapeCycle({ config: makeConfig(), fetchHtml, sleep: async () => {} });
    expect(first.newListings).toHaveLength(28);
    expect(first.newListings[0].search).toEqual({ name: 'A', url: A });
    expect(first.newListings[0].listing.providerId).toBe('1000001');
    expect(first.errors).toEqual([]);
    expect(first.botDetected).toBe(false);

    const second = await runScrapeCycle({ config: makeConfig(), fetchHtml, sleep: async () => {} });
    expect(second.newListings).toEqual([]);
  });

  it('runs searches sequentially with a random delay in the configured range in between', async () => {
    const events = [];
    const sleeps = [];
    await runScrapeCycle({
      config: makeConfig([
        { name: 'A', url: A },
        { name: 'B', url: B },
      ]),
      fetchHtml: async (url) => {
        events.push(`start ${url}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`end ${url}`);
        return html;
      },
      sleep: async (ms) => sleeps.push(ms),
      random: () => 0.5,
    });
    expect(events.map((e) => e.split(' ')[0])).toEqual(['start', 'end', 'start', 'end']);
    expect(sleeps).toEqual([10_000]); // one delay between two searches, midpoint of 5..15 s
  });

  it('appends the date sort parameter to the search url', async () => {
    const seen = [];
    await runScrapeCycle({
      config: makeConfig(),
      fetchHtml: async (u) => (seen.push(u), html),
      sleep: async () => {},
    });
    expect(seen).toEqual([`${A}?sort_column=0&sort_order=0`]);
  });

  it('stops the cycle on bot detection and flags it', async () => {
    const calls = [];
    const result = await runScrapeCycle({
      config: makeConfig([
        { name: 'A', url: A },
        { name: 'B', url: B },
      ]),
      fetchHtml: async (url) => {
        calls.push(url);
        throw new BotDetectedError(url, 403);
      },
      sleep: async () => {},
    });
    expect(calls).toHaveLength(1);
    expect(result.botDetected).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].search.name).toBe('A');
  });

  it('records other fetch errors and continues with the next search', async () => {
    let n = 0;
    const result = await runScrapeCycle({
      config: makeConfig([
        { name: 'A', url: A },
        { name: 'B', url: B },
      ]),
      fetchHtml: async () => {
        if (n++ === 0) throw new FetchError('HTTP 500', { status: 500 });
        return html;
      },
      sleep: async () => {},
    });
    expect(result.errors).toHaveLength(1);
    expect(result.botDetected).toBe(false);
    expect(result.newListings).toHaveLength(28);
    expect(result.newListings[0].search.name).toBe('B');
  });

  it('records the cycle as a fetch run (counts, bot detection, error text)', async () => {
    await runScrapeCycle({ config: makeConfig(), fetchHtml: async () => html, sleep: async () => {} });
    let last = getFetchStatus().lastFetch;
    expect(last).toMatchObject({ newCount: 28, errorCount: 0, botDetected: false, error: null });
    expect(last.finishedAt).toBeGreaterThanOrEqual(last.startedAt);

    await runScrapeCycle({
      config: makeConfig(),
      fetchHtml: async () => {
        throw new BotDetectedError('captcha');
      },
      sleep: async () => {},
    });
    last = getFetchStatus().lastFetch;
    expect(last).toMatchObject({ newCount: 0, errorCount: 1, botDetected: true });
    expect(last.error).toContain('captcha');
  });
});

describe('#runScrapeCycle onSearched', () => {
  it('is called for every search that was tried, also when it failed', async () => {
    const seen = [];
    await runScrapeCycle({
      config: makeConfig([
        { name: 'A', url: A },
        { name: 'B', url: B },
      ]),
      fetchHtml: async (u) => {
        if (u.includes('Berlin')) throw new FetchError('HTTP 500');
        return html;
      },
      onSearched: (search) => seen.push(search.url),
      sleep: async () => {},
    });
    expect(seen).toEqual([A, B]);
  });
});

describe('#runCycleWithFetcher', () => {
  it('records a failed run when the fetcher cannot start (e.g. browser launch error)', async () => {
    const withFetcher = async () => {
      throw new Error('cannot launch browser');
    };
    await expect(runCycleWithFetcher({ config: makeConfig(), withFetcher })).rejects.toThrow('cannot launch browser');
    expect(getFetchStatus().lastFetch).toMatchObject({ errorCount: 1, error: 'cannot launch browser' });
    expect(getFetchStatus().lastFetch.finishedAt).not.toBeNull();
  });

  it('does not record a second run when the cycle itself started (it records its own)', async () => {
    const withFetcher = (fn) => fn(async () => html);
    const result = await runCycleWithFetcher({ config: makeConfig(), withFetcher, sleep: async () => {} });
    expect(result.newListings).toHaveLength(28);
    expect(Db.query('SELECT COUNT(*) AS n FROM fetch_runs')[0].n).toBe(1);
  });

  it('a cycle that crashes after it started is recorded once', async () => {
    const withFetcher = (fn) =>
      fn(async () => {
        throw new Error('boom');
      });
    // per-search errors do not throw; force a crash through an invalid config
    await expect(runCycleWithFetcher({ config: { searches: null, schedule: {} }, withFetcher })).rejects.toThrow();
    expect(Db.query('SELECT COUNT(*) AS n FROM fetch_runs')[0].n).toBe(1);
  });
});
