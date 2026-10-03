import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  storeNewListings,
  getListingByProviderId,
  getUserListing,
  dismissListing,
} from '../../lib/services/listings/listingsStorage.js';
import { giveQuery } from '../helpers/db.js';
import { getFetchStatus } from '../../lib/services/status/fetchStatus.js';
import { createFetchCoordinator } from '../../lib/scheduler/fetchCoordinator.js';
import { createDetailWorker } from '../../lib/details/detailWorker.js';
import { applyDetails } from '../../lib/details/applyDetails.js';
import { RuleBasedEvaluator } from '../../lib/evaluation/ruleBasedEvaluator.js';
import { defaultEvaluationConfig } from '../../lib/evaluation/config.js';
import { BotDetectedError, FetchError } from '../../lib/errors.js';

const html = fs.readFileSync(new URL('../fixtures/wgGesucht_detail.html', import.meta.url), 'utf8');
const SEARCH = 'https://www.wg-gesucht.de/x.html';
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const evalConfig = defaultEvaluationConfig();
const U = 'alice';
const log = { info: () => {}, warn: () => {}, error: () => {} };

const cfg = (details = {}) => ({
  schedule: { intervalMinutes: 30, maxBackoffMinutes: 60, manualFetchMinGapSeconds: 120 },
  details: { delaySeconds: 60, jitterPercent: 50, maxAgeDays: 7, maxAttempts: 3, ...details },
});

const addListing = (id, ageMs = 1000, extra = {}) =>
  storeNewListings(
    [
      {
        providerId: String(id),
        link: `https://www.wg-gesucht.de/x.${id}.html`,
        title: `Room ${id}`,
        price: 600,
        district: 'München Beispielviertel',
        street: 'Musterstraße 1',
        onlineRaw: null,
        ...extra,
      },
    ],
    SEARCH,
    NOW - ageMs,
  );

/** Everything faked: clock, sleep, random, fetcher, geocoder. Real DB (in memory), real coordinator and parser. */
function setup({ details, random = () => 0.5, fetchHtml, geocoder, now = () => NOW } = {}) {
  const sleeps = [];
  const fetched = [];
  const config = cfg(details);
  const coordinator = createFetchCoordinator({ config, runCycle: async () => ({}), now });
  const launches = { n: 0, open: 0 };
  const withFetcher = async (fn) => {
    launches.n++;
    launches.open++;
    try {
      return await fn(async (url) => {
        fetched.push(url);
        return fetchHtml ? fetchHtml(url) : html;
      });
    } finally {
      launches.open--;
    }
  };
  const geo = geocoder ?? { geocode: async () => null };
  const deps = {
    contexts: [{ userId: U, evaluator: new RuleBasedEvaluator(evalConfig), target: evalConfig.target }],
    geocoder: geo,
    now: NOW,
  };
  const options = {
    config,
    coordinator,
    withFetcher,
    apply: (row, page) => applyDetails(row, page, deps),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random,
    now,
    log,
  };
  return { worker: createDetailWorker(options), options, coordinator, sleeps, fetched, launches, config };
}

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
  giveQuery(U, SEARCH);
});
afterEach(() => Db.reset());

describe('#DetailWorker.drain', () => {
  it('fetches pending listings newest first, parses and stores them', async () => {
    addListing(1, 3000);
    addListing(2, 1000);
    addListing(3, 2000);
    const { worker, fetched } = setup();
    const result = await worker.drain({ signal: new AbortController().signal });
    expect(fetched).toEqual([
      'https://www.wg-gesucht.de/x.2.html',
      'https://www.wg-gesucht.de/x.3.html',
      'https://www.wg-gesucht.de/x.1.html',
    ]);
    expect(result).toMatchObject({ fetched: 3, failed: 0, botDetected: false, stopped: 'idle' });
    const row = getListingByProviderId('2');
    expect(row.details_status).toBe('fetched');
    expect(row.description_text).toContain('Beispielplatz');
    expect(JSON.parse(row.detail_page_json).costs[0]).toMatchObject({ label: 'Miete', value: 819 });
  });

  it('re-evaluates after storing: a description keyword excludes the listing', async () => {
    addListing(1);
    const verbindung = html.replace('Helles und ruhiges Wohnvergnügen', 'Unser Verbindungshaus bietet');
    const { worker } = setup({ fetchHtml: () => verbindung });
    await worker.drain({ signal: new AbortController().signal });
    expect(getUserListing(U, '1').excluded_reason).toMatch(/Verbindungshaus/);
  });

  it('waits delaySeconds +/- jitter between requests, not before the first or after the last', async () => {
    addListing(1, 3000);
    addListing(2, 2000);
    addListing(3, 1000);
    const { worker, sleeps } = setup({ random: () => 0.5 });
    await worker.drain({ signal: new AbortController().signal });
    expect(sleeps).toEqual([60_000, 60_000]);
  });

  it('keeps every wait inside 30-90 s for the default 60 s +/- 50 %', async () => {
    for (let i = 1; i <= 30; i++) addListing(i, i * 1000);
    let n = 0;
    const randoms = [0, 0.999999, 0.25, 0.75, 0.5];
    const { worker, sleeps } = setup({ random: () => randoms[n++ % randoms.length] });
    await worker.drain({ signal: new AbortController().signal });
    expect(sleeps).toHaveLength(29);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBeLessThanOrEqual(90_000);
    }
    expect(Math.min(...sleeps)).toBe(30_000);
    expect(Math.max(...sleeps)).toBeGreaterThan(89_990);
  });

  it('honours the configured delay and jitter', async () => {
    addListing(1, 2000);
    addListing(2, 1000);
    const { worker, sleeps } = setup({ details: { delaySeconds: 20, jitterPercent: 0 }, random: () => 0.9 });
    await worker.drain({ signal: new AbortController().signal });
    expect(sleeps).toEqual([20_000]);
  });

  it('does not launch a browser when nothing is pending', async () => {
    const { worker, launches } = setup();
    expect(await worker.drain({ signal: new AbortController().signal })).toMatchObject({ fetched: 0, stopped: 'idle' });
    expect(launches.n).toBe(0);
  });

  it('uses one browser for the whole drain and has closed it afterwards', async () => {
    addListing(1, 2000);
    addListing(2, 1000);
    const { worker, launches } = setup();
    await worker.drain({ signal: new AbortController().signal });
    expect(launches.n).toBe(1);
    expect(launches.open).toBe(0);
  });

  it('skips dismissed listings and marks listings older than maxAgeDays skipped', async () => {
    addListing(1, 1000);
    addListing(2, 2000);
    addListing(3, 8 * DAY);
    dismissListing(U, getListingByProviderId('1').id, NOW);
    const { worker, fetched } = setup({ now: () => NOW });
    await worker.drain({ signal: new AbortController().signal });
    expect(fetched).toEqual(['https://www.wg-gesucht.de/x.2.html']);
    expect(getListingByProviderId('1').details_status).toBe('pending');
    expect(getListingByProviderId('3').details_status).toBe('skipped');
  });

  it('stops after `limit` listings', async () => {
    for (let i = 1; i <= 4; i++) addListing(i, i * 1000);
    const { worker, fetched, sleeps } = setup();
    const result = await worker.drain({ signal: new AbortController().signal, limit: 2 });
    expect(fetched).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(result).toMatchObject({ fetched: 2, stopped: 'limit' });
  });

  it('stops right away when the signal aborts, also during the wait', async () => {
    addListing(1, 2000);
    addListing(2, 1000);
    const controller = new AbortController();
    const { options, fetched } = setup();
    const worker2 = createDetailWorker({
      ...options,
      sleep: async () => controller.abort(),
    });
    const result = await worker2.drain({ signal: controller.signal });
    expect(result.stopped).toBe('aborted');
    expect(fetched).toHaveLength(1);
  });

  describe('failures', () => {
    it('counts attempts, retries after the other listings, and fails after maxAttempts', async () => {
      addListing(1, 1000);
      const err = new FetchError('HTTP 500', { status: 500 });
      const { worker, fetched, sleeps } = setup({
        fetchHtml: () => {
          throw err;
        },
      });
      const result = await worker.drain({ signal: new AbortController().signal });
      expect(fetched).toHaveLength(3);
      expect(sleeps).toHaveLength(2);
      expect(result).toMatchObject({ fetched: 0, failed: 1, stopped: 'idle' });
      expect(getListingByProviderId('1')).toMatchObject({
        details_status: 'failed',
        details_attempts: 3,
        details_error: 'HTTP 500',
      });
    });

    it('serves a failed listing again only after the fresh ones', async () => {
      addListing(1, 1000); // newest, fails
      addListing(2, 2000);
      let calls = 0;
      const { worker, fetched } = setup({
        fetchHtml: (url) => {
          if (url.endsWith('x.1.html') && calls++ === 0) throw new FetchError('timeout');
          return html;
        },
      });
      await worker.drain({ signal: new AbortController().signal });
      expect(fetched.map((u) => u.match(/x\.(\d)\./)[1])).toEqual(['1', '2', '1']);
      expect(getListingByProviderId('1').details_status).toBe('fetched');
    });

    it('a page without any description or costs is a failed attempt (layout change, removed ad)', async () => {
      addListing(1);
      const { worker } = setup({ fetchHtml: () => '<html><body>Die Anzeige existiert nicht mehr</body></html>' });
      await worker.drain({ signal: new AbortController().signal });
      expect(getListingByProviderId('1').details_error).toMatch(/no description/i);
    });

    it('keeps the stored details when only the geocoding afterwards fails', async () => {
      addListing(1, 1000, { street: null });
      const { worker } = setup({
        geocoder: {
          geocode: async () => {
            throw new Error('nominatim down');
          },
        },
      });
      const result = await worker.drain({ signal: new AbortController().signal });
      expect(result.fetched).toBe(1);
      expect(getListingByProviderId('1')).toMatchObject({ details_status: 'fetched', details_error: null });
    });
  });

  describe('bot detection', () => {
    it('stops the worker, records the backoff and leaves the listing untouched', async () => {
      addListing(1, 1000);
      addListing(2, 2000);
      const { worker, fetched, sleeps, coordinator } = setup({
        fetchHtml: (url) => {
          throw new BotDetectedError(url, 403);
        },
      });
      const penalty = vi.fn();
      coordinator.registerPenalty(penalty);
      const result = await worker.drain({ signal: new AbortController().signal });
      expect(fetched).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(result).toMatchObject({ botDetected: true, stopped: 'bot' });
      expect(getListingByProviderId('1')).toMatchObject({ details_status: 'pending', details_attempts: 0 });
      expect(getFetchStatus(NOW).lastFetch).toMatchObject({ botDetected: true });
      expect(penalty).toHaveBeenCalledTimes(1);
    });

    it('does not start while in backoff after a bot wall (same backoff as the search cycles)', async () => {
      addListing(1);
      const { worker, coordinator, launches } = setup();
      coordinator.reportBotDetected(new Error('wall'));
      const result = await worker.drain({ signal: new AbortController().signal });
      expect(result).toMatchObject({ fetched: 0, stopped: 'backoff' });
      expect(launches.n).toBe(0);
    });

    it('may start again once the backoff has passed', async () => {
      addListing(1);
      let clock = NOW;
      const { worker, coordinator } = setup({ now: () => clock });
      coordinator.reportBotDetected(new Error('wall'));
      clock = NOW + 61 * 60_000;
      expect((await worker.drain({ signal: new AbortController().signal })).fetched).toBe(1);
    });
  });

  describe('shared lock', () => {
    it('does not fetch while a search cycle runs and waits for it', async () => {
      addListing(1);
      const { worker, coordinator, fetched } = setup();
      let release;
      const cycle = coordinator.runExclusive(() => new Promise((r) => (release = r)));
      const drain = worker.drain({ signal: new AbortController().signal });
      await new Promise((r) => setTimeout(r, 5));
      expect(fetched).toEqual([]);
      release();
      await Promise.all([cycle, drain]);
      expect(fetched).toHaveLength(1);
    });

    it('a search cycle that wants to start during a detail fetch waits for it', async () => {
      addListing(1);
      let release;
      const gate = new Promise((r) => (release = r));
      const { worker, coordinator } = setup({ fetchHtml: async () => (await gate, html) });
      const order = [];
      const drain = worker.drain({ signal: new AbortController().signal }).then(() => order.push('drain'));
      await new Promise((r) => setTimeout(r, 5));
      const cycle = coordinator.runExclusive(async () => order.push('cycle'));
      await new Promise((r) => setTimeout(r, 5));
      expect(order).toEqual([]);
      release();
      await Promise.all([drain, cycle]);
      expect(order).toEqual(['cycle', 'drain']);
    });

    it('never has two detail fetches in flight', async () => {
      for (let i = 1; i <= 3; i++) addListing(i, i * 1000);
      let inFlight = 0;
      let max = 0;
      const { worker } = setup({
        fetchHtml: async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight--;
          return html;
        },
      });
      await Promise.all([
        worker.drain({ signal: new AbortController().signal }),
        worker.drain({ signal: new AbortController().signal }),
      ]);
      expect(max).toBe(1);
    });
  });

  describe('state', () => {
    it('is running while draining and shows when the next request is due while waiting', async () => {
      addListing(1, 2000);
      addListing(2, 1000);
      const states = [];
      const ctx = setup({ random: () => 0.5 });
      const worker = createDetailWorker({
        ...ctx.options,
        sleep: async () => {
          states.push(worker.state());
        },
      });
      expect(worker.state()).toEqual({ running: false, nextAt: null });
      await worker.drain({ signal: new AbortController().signal });
      expect(states).toEqual([{ running: true, nextAt: NOW + 60_000 }]);
      expect(worker.state()).toEqual({ running: false, nextAt: null });
    });

    it('a second drain while one runs returns immediately as already running', async () => {
      addListing(1);
      let release;
      const gate = new Promise((r) => (release = r));
      const { worker } = setup({ fetchHtml: async () => (await gate, html) });
      const first = worker.drain({ signal: new AbortController().signal });
      await new Promise((r) => setTimeout(r, 5));
      expect(await worker.drain({ signal: new AbortController().signal })).toMatchObject({ stopped: 'running' });
      release();
      expect((await first).fetched).toBe(1);
    });
  });
});

describe('#DetailWorker.drain with ids (wgg details --ids)', () => {
  it('fetches only the named listings, re-queues skipped/failed ones and ignores the age limit', async () => {
    addListing(1, 1000);
    addListing(2, 1000);
    addListing(3, 30 * DAY); // far older than maxAgeDays
    const { worker, fetched } = setup();
    const result = await worker.drain({ signal: new AbortController().signal, ids: ['3', '1'] });
    expect(result).toMatchObject({ fetched: 2, stopped: 'idle' });
    expect(fetched.sort()).toEqual(['https://www.wg-gesucht.de/x.1.html', 'https://www.wg-gesucht.de/x.3.html']);
    expect(getListingByProviderId('2').details_status).toBe('pending');
    expect(getListingByProviderId('3').details_status).toBe('fetched');
  });

  it('re-queues a listing that was marked skipped earlier', async () => {
    addListing(1, 30 * DAY);
    const { worker } = setup();
    await worker.drain({ signal: new AbortController().signal }); // marks it skipped (too old)
    expect(getListingByProviderId('1').details_status).toBe('skipped');
    const result = await worker.drain({ signal: new AbortController().signal, ids: ['1'] });
    expect(result.fetched).toBe(1);
  });
});

describe('#DetailWorker onStored', () => {
  it('is called with the row after its page was stored and evaluated, once per listing, not for failures', async () => {
    addListing(1, 3000);
    addListing(2, 1000);
    const stored = [];
    const { options } = setup({
      fetchHtml: async (url) => {
        if (url.endsWith('x.1.html')) throw new FetchError('HTTP 500');
        return html;
      },
    });
    const worker = createDetailWorker({
      ...options,
      onStored: (row) => stored.push([row.provider_id, getListingByProviderId(row.provider_id).details_status]),
    });
    await worker.drain({ signal: new AbortController().signal });
    expect(stored).toEqual([['2', 'fetched']]);
  });

  it('a throwing hook never fails the fetch', async () => {
    addListing(1);
    const { options } = setup();
    const worker = createDetailWorker({
      ...options,
      onStored: () => {
        throw new Error('hook broke');
      },
    });
    const r = await worker.drain({ signal: new AbortController().signal });
    expect(r).toMatchObject({ fetched: 1, failed: 0 });
  });
});
