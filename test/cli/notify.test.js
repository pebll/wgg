import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { writeUsersFile, SECRET } from '../helpers/auth.js';
import Db from '../../lib/services/storage/Db.js';
import { main } from '../../lib/cli/main.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { storeNewListings } from '../../lib/services/listings/listingsStorage.js';

const geocoder = { geocode: async () => null };
const detailHtml = fs.readFileSync(new URL('../fixtures/wgGesucht_detail.html', import.meta.url), 'utf8');
const searchHtml = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');

const SMTP = {
  SMTP_HOST: 'smtp.private-host.example',
  SMTP_PORT: '587',
  SMTP_USER: 'private-user@example.org',
  SMTP_PASS: 'private-pass-123',
  MAIL_FROM: 'wgg@example.org',
  MAIL_TO: 'me@example.org',
  LLM_MODEL: 'test-model', // part of the AI settings hash: every command of a test must see the same model
};
const LLM = {
  LLM_BASE_URL: 'https://gw.example/api',
  LLM_API_KEY: 'sk-x',
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
    eligible: true,
    ...o,
  });
const llmFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: answer() } }] }),
});

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** A config with alert rules that only look at the AI score (the rule-based score depends on geocoding). */
async function seeded(n, notify = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-notify-'));
  const cfgFile = path.join(dir, 'wgg.yaml');
  const port = await freePort();
  await writeUsersFile(dir);
  fs.writeFileSync(
    cfgFile,
    `db: ${path.join(dir, 'x.db')}\nsearches:\n  - url: https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html\nserver:\n  host: 127.0.0.1\n  port: ${port}\n${notify}`,
  );
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
const transportTo = (sent) => () => ({ sendMail: async (m) => void sent.push(m) });
const noTransport = () => {
  throw new Error('must not connect to SMTP');
};
const cli = (args, extra = {}) => {
  const lines = [];
  const errs = [];
  const promise = main(args, { out: (s) => lines.push(s), err: (s) => errs.push(s), geocoder, ...extra });
  return promise.then((code) => ({ code, out: lines.join('\n'), err: errs.join('\n') }));
};
const fetchDetails = (cfgFile) =>
  main(['details', '--config', cfgFile], {
    out: () => {},
    withFetcher: async (fn) => fn(async () => detailHtml),
    geocoder,
    detailSleep: async () => {},
    env: {},
  });

afterEach(() => Db.reset());

describe('#cli test-mail', () => {
  it('needs MAIL_TO as the recipient of the test mail (user alerts use the addresses from Options)', async () => {
    const { MAIL_TO: _unused, ...withoutTo } = SMTP;
    const r = await cli(['test-mail'], { env: withoutTo, createTransport: noTransport });
    expect(r.code).toBe(1);
    expect(r.err).toContain('MAIL_TO');
  });

  it('reports the missing variables by name, never values, and sends nothing', async () => {
    const r = await cli(['test-mail'], {
      env: { SMTP_HOST: 'smtp.private-host.example', SMTP_PASS: 'private-pass-123' },
      createTransport: noTransport,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('SMTP_PORT');
    expect(r.err).not.toContain('private-host');
    expect(r.err).not.toContain('private-pass');
    expect(r.out + r.err).not.toContain('private-pass');
  });

  it('sends one test email when SMTP is complete and prints no values', async () => {
    const sent = [];
    const r = await cli(['test-mail'], { env: SMTP, createTransport: transportTo(sent) });
    expect(r.code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/test/i);
    for (const value of Object.values(SMTP)) expect(r.out + r.err).not.toContain(value);
  });

  it('exits 1 with the redacted reason when the server refuses', async () => {
    const r = await cli(['test-mail'], {
      env: SMTP,
      createTransport: () => ({
        sendMail: async () => {
          throw new Error('535 bad login private-pass-123');
        },
      }),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('535 bad login');
    expect(r.err).not.toContain('private-pass-123');
  });
});

describe('#cli notify and the alert triggers', () => {
  const rules = (priority, bulk) => `notify:\n  priority:\n    rules: ${priority}\n  bulk:\n    rules: ${bulk}\n`;

  it('notify --dry-run prints what would go out and marks nothing', async () => {
    const { dir, cfgFile } = await seeded(2, rules('[{ ai: { gt: 7 } }]', '[]'));
    await fetchDetails(cfgFile);
    await cli(['llm', '--config', cfgFile], { env: { ...LLM }, llmFetch, llmSleep: async () => {} });
    const r = await cli(['notify', '--dry-run', '--config', cfgFile], { env: SMTP, createTransport: noTransport });
    expect(r.code).toBe(0);
    expect(r.out).toContain('would send');
    expect(r.out).toContain('AI 8');
    expect(r.out).toMatch(/2 fantastic/);
    expect(query(dir, 'SELECT COUNT(*) AS n FROM user_listings WHERE notified_at IS NOT NULL')[0].n).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('notify sends the pending alerts once and never again', async () => {
    const { dir, cfgFile } = await seeded(2, rules('[]', '[{ ai: { gt: 5 } }]'));
    await fetchDetails(cfgFile);
    await cli(['llm', '--config', cfgFile], { env: { ...LLM }, llmFetch, llmSleep: async () => {} });
    const sent = [];
    const first = await cli(['notify', '--config', cfgFile], { env: SMTP, createTransport: transportTo(sent) });
    expect(first.code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('2 good offers — WG Gefunden!');
    const second = await cli(['notify', '--config', cfgFile], { env: SMTP, createTransport: transportTo(sent) });
    expect(second.code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(query(dir, "SELECT COUNT(*) AS n FROM user_listings WHERE notified_kind = 'bulk'")[0].n).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('without SMTP settings alerts are only printed and nothing is marked', async () => {
    const { dir, cfgFile } = await seeded(1, rules('[]', '[{ ai: { gt: 5 } }]'));
    await fetchDetails(cfgFile);
    await cli(['llm', '--config', cfgFile], { env: { ...LLM }, llmFetch, llmSleep: async () => {} });
    const r = await cli(['notify', '--config', cfgFile], {
      env: { LLM_MODEL: 'test-model' },
      createTransport: noTransport,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('would send');
    expect(r.out).toContain('SMTP_HOST');
    expect(query(dir, 'SELECT COUNT(*) AS n FROM user_listings WHERE notified_at IS NOT NULL')[0].n).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('llm: priority mails go out right after each assessment, then no digest repeats them', async () => {
    const { dir, cfgFile } = await seeded(2, rules('[{ ai: { gt: 7 } }]', '[{ ai: { gt: 5 } }]'));
    await fetchDetails(cfgFile);
    const sent = [];
    const r = await cli(['llm', '--config', cfgFile], {
      env: { ...LLM, ...SMTP },
      llmFetch,
      llmSleep: async () => {},
      createTransport: transportTo(sent),
    });
    expect(r.code).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.subject.includes('AI 8'))).toBe(true);
    expect(query(dir, "SELECT COUNT(*) AS n FROM user_listings WHERE notified_kind = 'priority'")[0].n).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('llm: one digest at the end of the run when only bulk rules match', async () => {
    const { dir, cfgFile } = await seeded(3, rules('[]', '[{ ai: { gt: 5 } }]'));
    await fetchDetails(cfgFile);
    const sent = [];
    await cli(['llm', '--config', cfgFile], {
      env: { ...LLM, ...SMTP },
      llmFetch,
      llmSleep: async () => {},
      createTransport: transportTo(sent),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('3 good offers — WG Gefunden!');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('details: no digest while AI assessments are still pending', async () => {
    const { dir, cfgFile } = await seeded(2, rules('[]', '[{ ai: { gt: 5 } }]'));
    const sent = [];
    await main(['details', '--config', cfgFile], {
      out: () => {},
      withFetcher: async (fn) => fn(async () => detailHtml),
      geocoder,
      detailSleep: async () => {},
      env: { ...LLM, ...SMTP },
      createTransport: transportTo(sent),
    });
    expect(sent).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runWith = async (cfgFile, extra, args = []) => {
    const controller = new AbortController();
    let llmCalls = 0;
    const counting = async (...a) => {
      const r = await llmFetch(...a);
      if (++llmCalls >= 2) controller.abort();
      return r;
    };
    return cli(['run', '--config', cfgFile, ...args], {
      withFetcher: async (fn) =>
        fn(async (url) => (url.includes('wg-zimmer-in-Muenchen.90') ? searchHtml : detailHtml)),
      signal: controller.signal,
      detailSleep: async () => {},
      llmSleep: async () => {},
      llmFetch: counting,
      ...extra,
    });
  };

  it('run --dry-run never connects to SMTP and marks nothing', async () => {
    const { dir, cfgFile } = await seeded(2, rules('[{ ai: { gt: 7 } }]', '[{ ai: { gt: 5 } }]'));
    const r = await runWith(cfgFile, { env: { ...LLM, ...SMTP }, createTransport: noTransport }, ['--dry-run']);
    expect(r.code).toBe(0);
    expect(query(dir, 'SELECT COUNT(*) AS n FROM user_listings WHERE notified_at IS NOT NULL')[0].n).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('run: sends a priority mail per assessed listing', async () => {
    const { dir, cfgFile } = await seeded(2, rules('[{ ai: { gt: 7 } }]', '[]'));
    const sent = [];
    const r = await runWith(cfgFile, { env: { ...LLM, ...SMTP }, createTransport: transportTo(sent) });
    expect(r.code).toBe(0);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent.map((m) => m.subject)).size).toBeGreaterThanOrEqual(1);
    const marked = query(dir, "SELECT COUNT(*) AS n FROM user_listings WHERE notified_kind = 'priority'")[0].n;
    expect(marked).toBe(sent.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
