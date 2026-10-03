import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Db from '../../lib/services/storage/Db.js';
import { main } from '../../lib/cli/main.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { storeNewListings } from '../../lib/services/listings/listingsStorage.js';
import { recordFailedRun } from '../../lib/services/status/fetchStatus.js';
import net from 'net';
import { writeUsersFile, httpLogin, SECRET } from '../helpers/auth.js';

// Never touch the network from tests: a geocoder that knows nothing.
const geocoder = { geocode: async () => null };
import { formatListing } from '../../lib/cli/format.js';

const listing = {
  providerId: '1',
  link: 'https://www.wg-gesucht.de/x.1.html',
  title: 'Nice room',
  price: 600,
  priceRaw: '600 €',
  size: 20,
  sizeRaw: '20 m²',
  wgSize: 3,
  flatmatesRaw: '3er WG',
  district: 'München Maxvorstadt',
  street: 'Teststr. 1',
  availableFrom: '2026-08-01',
  availableUntil: '2027-01-31',
  onlineRaw: 'Online: 3 Minuten',
};

describe('#cli', () => {
  it('formats a listing with all fields', () => {
    const out = formatListing(listing);
    expect(out).toContain('Nice room');
    expect(out).toContain('600 €');
    expect(out).toContain('20 m²');
    expect(out).toContain('München Maxvorstadt, Teststr. 1');
    expect(out).toContain('available 2026-08-01 - 2027-01-31');
    expect(out).toContain('3er WG');
    expect(out).toContain('https://www.wg-gesucht.de/x.1.html');
  });

  it('formats a sparse listing without crashing', () => {
    const out = formatListing({ providerId: '2', link: 'https://x', title: 'T' });
    expect(out).toContain('T');
    expect(out).toContain('https://x');
  });

  it('prints help and returns 0', async () => {
    const lines = [];
    const code = await main(['--help'], { out: (s) => lines.push(s) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/scrape-once/);
    expect(lines.join('\n')).toMatch(/run/);
  });

  it('rejects unknown commands with exit code 2', async () => {
    const lines = [];
    const code = await main(['bogus'], { out: (s) => lines.push(s), err: (s) => lines.push(s) });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/Unknown command/);
  });
});

describe('#cli scrape-once (mocked fetcher, no network)', () => {
  const html = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');
  afterEach(() => Db.reset());

  it('prints new listings on the first run and none on the second', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-cli-'));
    await writeUsersFile(dir);
    const cfgFile = path.join(dir, 'wgg.yaml');
    fs.writeFileSync(
      cfgFile,
      `db: ${path.join(dir, 'x.db')}\nsearches:\n  - name: Test\n    url: https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html\n`,
    );
    const withFetcher = async (fn) => fn(async () => html);
    const run = async () => {
      const lines = [];
      const code = await main(['scrape-once', '--config', cfgFile], {
        out: (s) => lines.push(s),
        withFetcher,
        geocoder,
      });
      Db.reset();
      return { code, text: lines.join('\n') };
    };

    const first = await run();
    expect(first.code).toBe(0);
    expect(first.text).toContain('28 new');
    expect(first.text).toContain('Sunny room in a friendly 3-person flat #7');
    expect(first.text).toContain('https://www.wg-gesucht.de/wg-zimmer-in-Muenchen-Beispielviertel.1000001.html');

    const second = await run();
    expect(second.code).toBe(0);
    expect(second.text).toContain('0 new');
    expect(second.text).not.toContain('Beispielviertel.1000001');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 with a clear message when bot detection hits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-cli-'));
    await writeUsersFile(dir);
    const cfgFile = path.join(dir, 'wgg.yaml');
    fs.writeFileSync(
      cfgFile,
      `db: ${path.join(dir, 'x.db')}\nsearches:\n  - url: https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html\n`,
    );
    const { BotDetectedError } = await import('../../lib/errors.js');
    const withFetcher = async (fn) =>
      fn(async (u) => {
        throw new BotDetectedError(u, 403);
      });
    const lines = [];
    const code = await main(['scrape-once', '--config', cfgFile], {
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
      withFetcher,
      geocoder,
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/[Bb]ot detection/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('run: executes cycles until aborted and prints new listings', async () => {
    const { dir, cfgFile } = await writeConfig(await freePort(), 'schedule:\n  intervalMinutes: 60\n');
    const controller = new AbortController();
    const lines = [];
    const withFetcher = async (fn) => {
      const result = await fn(async () => html);
      controller.abort(); // stop after the first cycle, the 60 min wait ends immediately
      return result;
    };
    const code = await main(['run', '--config', cfgFile], {
      out: (s) => lines.push(s),
      withFetcher,
      geocoder,
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('28 new listing(s)');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const writeConfig = async (port, extra = '') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-cli-'));
  await writeUsersFile(dir);
  const cfgFile = path.join(dir, 'wgg.yaml');
  fs.writeFileSync(
    cfgFile,
    `db: ${path.join(dir, 'x.db')}\nsearches:\n  - url: https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html\nserver:\n  host: 127.0.0.1\n  port: ${port}\n${extra}`,
  );
  return { dir, cfgFile };
};

const waitForHealth = async (port) => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      return await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('server did not come up');
};

describe('#cli serve / run with web server', () => {
  afterEach(() => Db.reset());

  it('help lists serve', async () => {
    const lines = [];
    await main(['--help'], { out: (s) => lines.push(s) });
    expect(lines.join('\n')).toMatch(/serve/);
  });

  it('serve: serves the API on the configured port and stops on abort without scraping', async () => {
    const port = await freePort();
    const { dir, cfgFile } = await writeConfig(port);
    const controller = new AbortController();
    const withFetcher = async () => {
      throw new Error('serve must not scrape');
    };
    const done = main(['serve', '--config', cfgFile], { out: () => {}, withFetcher, signal: controller.signal });
    expect(await waitForHealth(port)).toEqual({ status: 'ok' });
    const listings = await (await (await httpLogin(port))('/api/listings')).json();
    expect(listings).toMatchObject({ items: [], total: 0 });
    controller.abort();
    expect(await done).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serve: exits 1 when the port is already taken', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const { port } = blocker.address();
    const { dir, cfgFile } = await writeConfig(port);
    const code = await main(['serve', '--config', cfgFile], {
      out: () => {},
      err: () => {},
      signal: new AbortController().signal,
    });
    expect(code).toBe(1);
    blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('run: serves the UI API while the scheduler runs and closes both on shutdown', async () => {
    const html = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');
    const port = await freePort();
    const { dir, cfgFile } = await writeConfig(port, 'schedule:\n  intervalMinutes: 60\n');
    const controller = new AbortController();
    let health;
    const withFetcher = async (fn) => {
      const result = await fn(async () => html);
      health = await waitForHealth(port);
      const body = await (await (await httpLogin(port))('/api/listings?includeHidden=1')).json();
      expect(body.total).toBe(28); // rule-excluded ones are hidden by default, hence includeHidden
      controller.abort();
      return result;
    };
    const code = await main(['run', '--config', cfgFile], {
      out: () => {},
      withFetcher,
      geocoder,
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(health).toEqual({ status: 'ok' });
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('#cli POST /api/fetch wiring (fake fetcher, no browser, no network)', () => {
  afterEach(() => Db.reset());
  const html = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');
  const post = async (port) => (await httpLogin(port))('/api/fetch', { method: 'POST' });

  it('serve: a manual fetch runs one cycle in the server process, then the minimum gap refuses another', async () => {
    const port = await freePort();
    const { dir, cfgFile } = await writeConfig(port);
    const controller = new AbortController();
    let launches = 0;
    const withFetcher = async (fn) => {
      launches++;
      return fn(async () => html);
    };
    const done = main(['serve', '--config', cfgFile], {
      out: () => {},
      withFetcher,
      geocoder,
      signal: controller.signal,
    });
    await waitForHealth(port);

    const api = await httpLogin(port);
    const first = await post(port);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'started', mode: 'one-off' });
    for (let i = 0; i < 100; i++) {
      const body = await (await api('/api/listings')).json();
      if (body.total === 28) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const status = await (await api('/api/status')).json();
    expect(status.lastFetch).toMatchObject({ newCount: 28 });

    const second = await post(port);
    expect(second.status).toBe(429);
    expect((await second.json()).retryAfterSeconds).toBeGreaterThan(0);
    expect(launches).toBe(1);

    controller.abort();
    expect(await done).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serve: a browser that cannot launch is recorded as a failed run', async () => {
    const port = await freePort();
    const { dir, cfgFile } = await writeConfig(port);
    const controller = new AbortController();
    const withFetcher = async () => {
      throw new Error('cannot launch browser');
    };
    const done = main(['serve', '--config', cfgFile], {
      out: () => {},
      withFetcher,
      geocoder,
      signal: controller.signal,
    });
    await waitForHealth(port);
    expect((await post(port)).status).toBe(202);
    const api = await httpLogin(port);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await (await api('/api/status')).json();
      if (status.lastFetch) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status.lastFetch).toMatchObject({ errorCount: 1, error: 'cannot launch browser' });
    controller.abort();
    await done;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('run: a manual fetch wakes the scheduler, which then runs its next cycle immediately', async () => {
    const port = await freePort();
    const { dir, cfgFile } = await writeConfig(
      port,
      'schedule:\n  intervalMinutes: 60\n  manualFetchMinGapSeconds: 0\n',
    );
    const controller = new AbortController();
    let cycles = 0;
    let mode;
    const withFetcher = async (fn) => {
      // Only search pages count as cycles; the detail queue (drained after each cycle) uses the fetcher too.
      let searched = false;
      const result = await fn(async (url) => {
        if (url.includes('Muenchen.90')) {
          searched = true;
          cycles++;
        }
        return html;
      });
      if (!searched) return result;
      if (cycles === 1) {
        // Once this cycle has returned the scheduler sleeps for ~60 min: wake it from there.
        setTimeout(async () => {
          mode = (await (await post(port)).json()).mode;
        }, 200);
      } else {
        while (!mode) await new Promise((r) => setTimeout(r, 10)); // let the 202 reach the client first
        controller.abort();
      }
      return result;
    };
    const code = await main(['run', '--config', cfgFile], {
      out: () => {},
      withFetcher,
      geocoder,
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(cycles).toBe(2);
    expect(mode).toBe('scheduler');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('#cli evaluate (fake geocoder, no network)', () => {
  afterEach(() => Db.reset());

  it('evaluates stored listings and reports counts; --all re-runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-cli-'));
    await writeUsersFile(dir);
    const cfgFile = path.join(dir, 'wgg.yaml');
    const dbFile = path.join(dir, 'x.db');
    fs.writeFileSync(
      cfgFile,
      `db: ${dbFile}\nsearches:\n  - url: https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html\n`,
    );
    const html = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');
    const asked = [];
    const fake = { geocode: async (q) => (asked.push(q), null) };
    const run = async (args) => {
      const lines = [];
      const code = await main([...args, '--config', cfgFile], {
        out: (s) => lines.push(s),
        withFetcher: async (fn) => fn(async () => html),
        geocoder: fake,
      });
      Db.reset();
      return { code, text: lines.join('\n') };
    };

    await run(['scrape-once']); // already evaluates the 28 new listings
    const none = await run(['evaluate']);
    expect(none.code).toBe(0);
    expect(none.text).toContain('Evaluated 0 listing(s)');
    const all = await run(['evaluate', '--all']);
    expect(all.code).toBe(0);
    expect(all.text).toContain('Evaluated 28 listing(s)');
    const regeo = await run(['evaluate', '--regeocode']);
    expect(regeo.text).toContain('Evaluated 28 listing(s), geocoded 28');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('#cli details (fake fetcher, no browser, no network)', () => {
  afterEach(() => Db.reset());
  const detailHtml = fs.readFileSync(new URL('../fixtures/wgGesucht_detail.html', import.meta.url), 'utf8');
  const searchHtml = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');

  /** A config + database holding `n` fresh pending listings (no network, no scrape). */
  async function seeded(n, extra = '') {
    const { dir, cfgFile } = await writeConfig(await freePort(), extra);
    Db.reset();
    Db.init(path.join(dir, 'x.db'));
    await runMigrations();
    storeNewListings(
      Array.from({ length: n }, (_, i) => ({
        providerId: String(100 + i),
        link: `https://www.wg-gesucht.de/x.${100 + i}.html`,
        title: `Room ${i}`,
        price: 500,
        district: 'München Beispielviertel',
        street: 'Musterstraße',
      })),
      'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html', // the config's search: in the admin's view
      Date.now() - 1000,
    );
    Db.reset();
    return { dir, cfgFile };
  }

  const counts = (dir) => {
    Db.reset();
    Db.init(path.join(dir, 'x.db'));
    const rows = Db.query('SELECT details_status AS s, COUNT(*) AS n FROM listings GROUP BY 1');
    Db.reset();
    return Object.fromEntries(rows.map((r) => [r.s, r.n]));
  };

  it('help lists the details command', async () => {
    const lines = [];
    await main(['--help'], { out: (s) => lines.push(s) });
    expect(lines.join('\n')).toMatch(/details/);
  });

  it('drains the queue once and reports the result', async () => {
    const { dir, cfgFile } = await seeded(3);
    const waits = [];
    const lines = [];
    const code = await main(['details', '--config', cfgFile], {
      out: (s) => lines.push(s),
      withFetcher: async (fn) => fn(async () => detailHtml),
      geocoder,
      detailSleep: async (ms) => waits.push(ms),
    });
    expect(code).toBe(0);
    expect(counts(dir)).toEqual({ fetched: 3 });
    expect(waits).toHaveLength(2);
    expect(lines.join('\n')).toMatch(/3 fetched/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--limit N stops after N listings', async () => {
    const { dir, cfgFile } = await seeded(4);
    const code = await main(['details', '--limit', '2', '--config', cfgFile], {
      out: () => {},
      withFetcher: async (fn) => fn(async () => detailHtml),
      geocoder,
      detailSleep: async () => {},
    });
    expect(code).toBe(0);
    expect(counts(dir)).toEqual({ fetched: 2, pending: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a bad --limit with exit code 2', async () => {
    const lines = [];
    const code = await main(['details', '--limit', 'abc'], { out: (s) => lines.push(s), err: (s) => lines.push(s) });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/--limit/);
  });

  it('exits 1 with a clear message on bot detection and leaves the listing pending', async () => {
    const { dir, cfgFile } = await seeded(2);
    const { BotDetectedError } = await import('../../lib/errors.js');
    const lines = [];
    const code = await main(['details', '--config', cfgFile], {
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
      withFetcher: async (fn) =>
        fn(async (u) => {
          throw new BotDetectedError(u, 403);
        }),
      geocoder,
      detailSleep: async () => {},
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/[Bb]ot detection/);
    expect(counts(dir)).toEqual({ pending: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses while the last fetch was a bot wall (backoff), without launching a browser', async () => {
    const { dir, cfgFile } = await seeded(1);
    Db.init(path.join(dir, 'x.db'));
    recordFailedRun(new Error('wall'), Date.now(), { botDetected: true });
    Db.reset();
    let launched = false;
    const lines = [];
    const code = await main(['details', '--config', cfgFile], {
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
      withFetcher: async (fn) => {
        launched = true;
        return fn(async () => detailHtml);
      },
      geocoder,
    });
    expect(code).toBe(1);
    expect(launched).toBe(false);
    expect(lines.join('\n')).toMatch(/backoff/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('run: drains the detail queue in the background after the search cycle and stops on shutdown', async () => {
    const { dir, cfgFile } = await writeConfig(await freePort(), 'schedule:\n  intervalMinutes: 60\n');
    const controller = new AbortController();
    let detailFetches = 0;
    const withFetcher = async (fn) =>
      fn(async (url) => {
        if (url.includes('wg-zimmer-in-Muenchen.90')) return searchHtml;
        if (++detailFetches === 3) controller.abort();
        return detailHtml;
      });
    const code = await main(['run', '--config', cfgFile], {
      out: () => {},
      withFetcher,
      geocoder,
      signal: controller.signal,
      detailSleep: async () => {},
    });
    expect(code).toBe(0);
    expect(counts(dir)).toEqual({ fetched: 3, pending: 20, skipped: 5 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('#cli details --ids and llm (fake fetcher, fake gateway, no network)', () => {
  afterEach(() => Db.reset());
  const detailHtml = fs.readFileSync(new URL('../fixtures/wgGesucht_detail.html', import.meta.url), 'utf8');
  const KEY = 'sk-cli-test-key';
  const env = {
    LLM_BASE_URL: 'https://gw.example/api',
    LLM_API_KEY: KEY,
    LLM_MODEL: 'test-model',
    SESSION_SECRET: SECRET,
  };
  const answer = (o = {}) =>
    JSON.stringify({
      verbindungProbability: 0.1,
      verbindungSignals: [],
      fitScore: 8,
      summary: 'Fine.',
      positives: [],
      redFlags: [],
      ...o,
    });
  const gateway =
    (replies, calls = []) =>
    async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: replies.shift() ?? answer() } }] }),
      };
    };

  async function seeded(n) {
    const { dir, cfgFile } = await writeConfig(await freePort(), '');
    Db.reset();
    Db.init(path.join(dir, 'x.db'));
    await runMigrations();
    storeNewListings(
      Array.from({ length: n }, (_, i) => ({
        providerId: String(100 + i),
        link: `https://www.wg-gesucht.de/x.${100 + i}.html`,
        title: `Room ${i}`,
        price: 500,
        district: 'München Beispielviertel',
        street: 'Musterstraße',
      })),
      'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html', // the config's search: in the admin's view
      Date.now() - 1000,
    );
    Db.reset();
    return { dir, cfgFile };
  }
  const query = (dir, sql) => {
    Db.reset();
    Db.init(path.join(dir, 'x.db'));
    const rows = Db.query(sql);
    Db.reset();
    return rows;
  };
  const fetchDetails = (cfgFile, args = []) =>
    main(['details', ...args, '--config', cfgFile], {
      out: () => {},
      withFetcher: async (fn) => fn(async () => detailHtml),
      geocoder,
      detailSleep: async () => {},
      env,
    });

  it('details --ids fetches only the named listings', async () => {
    const { dir, cfgFile } = await seeded(3);
    expect(await fetchDetails(cfgFile, ['--ids', '101'])).toBe(0);
    expect(
      query(dir, 'SELECT provider_id AS p, details_status AS s FROM listings ORDER BY id').map((r) => `${r.p}:${r.s}`),
    ).toEqual(['100:pending', '101:fetched', '102:pending']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a bad --ids with exit code 2', async () => {
    const lines = [];
    const code = await main(['llm', '--ids', 'abc'], { out: (s) => lines.push(s), err: (s) => lines.push(s), env });
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/--ids/);
  });

  it('llm assesses fetched listings and stores the result; the key never reaches output or the database', async () => {
    const { dir, cfgFile } = await seeded(2);
    await fetchDetails(cfgFile);
    const calls = [];
    const lines = [];
    const code = await main(['llm', '--config', cfgFile], {
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
      geocoder,
      env,
      llmFetch: gateway([answer(), answer({ verbindungProbability: 0.9, verbindungSignals: ['"Kneipe"'] })], calls),
      llmSleep: async () => {},
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/2 assessed/);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://gw.example/api/chat/completions');
    expect(JSON.parse(calls[0].init.body).model).toBe('test-model');
    const rows = query(dir, 'SELECT llm_status, llm_model, excluded_reason, llm_json, scores_json FROM user_listings');
    expect(rows.every((r) => r.llm_status === 'done' && r.llm_model === 'test-model')).toBe(true);
    expect(rows.filter((r) => r.excluded_reason?.startsWith('LLM: likely'))).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain(KEY);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('llm --ids limits the run and --force repeats finished listings', async () => {
    const { dir, cfgFile } = await seeded(2);
    await fetchDetails(cfgFile);
    const calls = [];
    const io = { out: () => {}, err: () => {}, geocoder, env, llmSleep: async () => {} };
    await main(['llm', '--ids', '101', '--config', cfgFile], { ...io, llmFetch: gateway([], calls) });
    expect(calls).toHaveLength(1);
    await main(['llm', '--ids', '101', '--config', cfgFile], { ...io, llmFetch: gateway([], calls) });
    expect(calls).toHaveLength(1); // already done
    await main(['llm', '--ids', '101', '--force', '--config', cfgFile], { ...io, llmFetch: gateway([], calls) });
    expect(calls).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('llm exits 1 and says why when the LLM is not configured', async () => {
    const { dir, cfgFile } = await seeded(1);
    const lines = [];
    const code = await main(['llm', '--config', cfgFile], {
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
      env: {},
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/LLM_BASE_URL/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a gateway failure stores the redacted error and exits 1', async () => {
    const { dir, cfgFile } = await seeded(1);
    await fetchDetails(cfgFile);
    const lines = [];
    const code = await main(['llm', '--config', cfgFile], {
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
      geocoder,
      env,
      llmSleep: async () => {},
      llmFetch: async () => ({ ok: false, status: 500, text: async () => `oops Bearer ${KEY}` }),
    });
    expect(code).toBe(1);
    const [row] = query(dir, 'SELECT llm_status, llm_error FROM user_listings');
    expect(row.llm_status).toBe('failed');
    expect(row.llm_error).toContain('500');
    expect(row.llm_error).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain(KEY);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('run: assesses listings after the detail queue was drained', async () => {
    const { dir, cfgFile } = await seeded(2);
    const controller = new AbortController();
    const calls = [];
    const searchHtml = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');
    let llmCalls = 0;
    const llmFetch = async (...args) => {
      const r = await gateway([], calls)(...args);
      if (++llmCalls >= 2) controller.abort();
      return r;
    };
    const code = await main(['run', '--config', cfgFile], {
      out: () => {},
      withFetcher: async (fn) =>
        fn(async (url) => (url.includes('wg-zimmer-in-Muenchen.90') ? searchHtml : detailHtml)),
      geocoder,
      signal: controller.signal,
      detailSleep: async () => {},
      llmSleep: async () => {},
      env,
      llmFetch,
    });
    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const rows = query(dir, "SELECT COUNT(*) AS n FROM user_listings WHERE llm_status = 'done'");
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('run: assesses a listing as soon as its details are stored, while the detail queue still waits for the next page', async () => {
    const { dir, cfgFile } = await seeded(2);
    const controller = new AbortController();
    let detailPages = 0; // detail pages fetched so far
    let assessedBeforeQueueEnded = 0;
    let llmCalls = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const llmFetch = async (...args) => {
      if (detailPages < 2) assessedBeforeQueueEnded++; // the second page has not even been requested yet
      release();
      if (++llmCalls >= 2) controller.abort();
      return gateway([], [])(...args);
    };
    const code = await main(['run', '--config', cfgFile], {
      out: () => {},
      withFetcher: async (fn) =>
        fn(async (url) => {
          if (url.includes('wg-zimmer-in-Muenchen.90')) return '<html></html>';
          detailPages++;
          return detailHtml;
        }),
      geocoder,
      signal: controller.signal,
      // The pause between two detail pages (30-90 s in real life) lasts until the AI was called (or 4 s, then the test fails).
      detailSleep: async () => {
        await Promise.race([gate, new Promise((r) => setTimeout(r, 4000))]);
      },
      llmSleep: async () => {},
      env,
      llmFetch,
    });
    expect(code).toBe(0);
    // Chained after the whole detail queue, the first AI call could only come after the second page.
    expect(assessedBeforeQueueEnded).toBeGreaterThanOrEqual(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
