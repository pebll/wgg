import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Db from '../../lib/services/storage/Db.js';
import { main } from '../../lib/cli/main.js';
import net from 'net';
import { writeUsersFile, httpLogin } from '../helpers/auth.js';
import { openDbUpTo } from '../helpers/db.js';

const SEARCH = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';
const html = fs.readFileSync(new URL('../fixtures/wgGesucht.html', import.meta.url), 'utf8');
const geocoder = { geocode: async () => null };

const run = async (args, io = {}) => {
  const out = [];
  const err = [];
  const code = await main(args, { out: (s) => out.push(s), err: (s) => err.push(s), geocoder, ...io });
  Db.reset();
  return { code, out: out.join('\n'), err: err.join('\n') };
};
const query = (file, sql, params = []) => {
  Db.reset();
  Db.init(file);
  const rows = Db.query(sql, params);
  Db.reset();
  return rows;
};

afterEach(() => Db.reset());

async function project(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-multi-'));
  await writeUsersFile(dir, names);
  const cfgFile = path.join(dir, 'wgg.yaml');
  const dbFile = path.join(dir, 'x.db');
  fs.writeFileSync(cfgFile, `db: ${dbFile}\nsearches:\n  - name: Munich\n    url: ${SEARCH}\n`);
  return { dir, cfgFile, dbFile };
}

describe('#cli with several users', () => {
  it('scrape-once fetches the shared search once and every user gets the listings evaluated for them', async () => {
    const { dir, cfgFile, dbFile } = await project(['alice', 'bob']);
    let fetches = 0;
    const withFetcher = async (fn) =>
      fn(async () => {
        fetches++;
        return html;
      });
    const r = await run(['scrape-once', '--config', cfgFile], { withFetcher });
    expect(r.code).toBe(0);
    expect(fetches).toBe(1); // two users, one distinct search URL
    expect(r.out).toContain('28 new listing(s) in total');
    const per = query(dbFile, 'SELECT user_id, COUNT(*) AS n FROM user_listings GROUP BY user_id ORDER BY user_id');
    expect(per).toEqual([
      { user_id: 'alice', n: 28 },
      { user_id: 'bob', n: 28 },
    ]);
    expect(query(dbFile, 'SELECT COUNT(*) AS n FROM listings')[0].n).toBe(28);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a new user in users.yaml starts with a copy of the owner's queries and default settings; the owner's data stays", async () => {
    const { dir, cfgFile, dbFile } = await project(['alice']);
    await run(['scrape-once', '--config', cfgFile], { withFetcher: async (fn) => fn(async () => html) });
    await writeUsersFile(dir, ['alice', 'bob']);
    const r = await run(['evaluate', '--config', cfgFile]);
    expect(r.code).toBe(0);
    expect(query(dbFile, "SELECT url, enabled FROM user_queries WHERE user_id = 'bob'")).toEqual([
      { url: SEARCH, enabled: 1 },
    ]);
    expect(query(dbFile, "SELECT json FROM user_settings WHERE user_id = 'bob'")).toHaveLength(1);
    expect(
      query(dbFile, "SELECT COUNT(*) AS n FROM user_listings WHERE user_id = 'bob' AND evaluated_at IS NOT NULL")[0].n,
    ).toBe(28);
    expect(query(dbFile, "SELECT COUNT(*) AS n FROM user_listings WHERE user_id = 'alice'")[0].n).toBe(28);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upgrading a single-user database: backs it up first, the admin owns all previous state, nothing is lost', async () => {
    const { dir, cfgFile, dbFile } = await project(['alice', 'bob']);
    await openDbUpTo(13, dbFile);
    Db.execute(
      `INSERT INTO listings (provider_id, search_url, link, first_seen_at, overall_score, evaluated_at, llm_status, llm_json,
         dismissed_at, hidden_by, hidden_reason, messaged_at)
       VALUES ('1', @url, 'https://x/1', 1000, 7.5, 1000, 'done', '{"fitScore":8}', NULL, NULL, NULL, NULL),
              ('2', @url, 'https://x/2', 1000, 3, 1000, 'pending', NULL, 2000, 'user', 'Messaged', 2000)`,
      { url: SEARCH },
    );
    Db.reset();

    const r = await run(['evaluate', '--config', cfgFile]);
    expect(r.code).toBe(0);

    const backup = `${dbFile}.pre-multiuser.bak`;
    expect(fs.existsSync(backup)).toBe(true);
    expect(query(backup, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'user_listings'")[0].n).toBe(0); // as it was
    expect(query(backup, 'SELECT COUNT(*) AS n FROM listings')[0].n).toBe(2);

    const alice = query(
      dbFile,
      "SELECT l.provider_id AS p, u.overall_score, u.llm_status, u.llm_json, u.hidden_reason, u.messaged_at FROM user_listings u JOIN listings l ON l.id = u.listing_id WHERE u.user_id = 'alice' ORDER BY l.id",
    );
    expect(alice).toEqual([
      {
        p: '1',
        overall_score: expect.any(Number),
        llm_status: 'done',
        llm_json: '{"fitScore":8}',
        hidden_reason: null,
        messaged_at: null,
      },
      {
        p: '2',
        overall_score: expect.any(Number),
        llm_status: 'pending',
        llm_json: null,
        hidden_reason: 'Messaged',
        messaged_at: 2000,
      },
    ]);
    // bob sees the same listings (copy of the owner's queries) but starts without any of alice's decisions
    const bob = query(
      dbFile,
      "SELECT l.provider_id AS p, u.llm_status, u.hidden_reason, u.messaged_at FROM user_listings u JOIN listings l ON l.id = u.listing_id WHERE u.user_id = 'bob' ORDER BY l.id",
    );
    expect(bob).toEqual([
      { p: '1', llm_status: 'pending', hidden_reason: null, messaged_at: null },
      { p: '2', llm_status: 'pending', hidden_reason: null, messaged_at: null },
    ]);
    expect(query(dbFile, "SELECT value FROM app_meta WHERE key = 'legacy_adopted_by'")).toEqual([{ value: 'alice' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('every database command needs users.yaml and says how to create it (the database is not touched)', async () => {
    const { dir, cfgFile, dbFile } = await project([]);
    fs.rmSync(path.join(dir, 'users.yaml'), { force: true });
    for (const command of ['scrape-once', 'details', 'evaluate', 'notify', 'llm']) {
      const r = await run([command, '--config', cfgFile], { env: {} });
      expect(r.code, command).toBe(2);
      expect(r.err, command).toMatch(/hash-password/);
    }
    expect(fs.existsSync(dbFile)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a query added through the web app is fetched by the next cycle (one request per distinct URL), and removed ones are not', async () => {
    const port = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const { port: p } = srv.address();
        srv.close(() => resolve(p));
      });
    });
    const { dir, cfgFile } = await project(['alice', 'bob']);
    fs.appendFileSync(cfgFile, `server:\n  host: 127.0.0.1\n  port: ${port}\nqueries:\n  maxPerUser: 2\n`);
    const controller = new AbortController();
    const done = main(['serve', '--config', cfgFile], {
      out: () => {},
      err: () => {},
      geocoder,
      signal: controller.signal,
      withFetcher: async () => {
        throw new Error('serve does not scrape');
      },
    });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/api/health`).then(
        () => true,
        () => false,
      );
      if (!up) await new Promise((r) => setTimeout(r, 50));
    }
    const bob = await httpLogin(port, 'bob');
    const berlin = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';
    const created = await bob('/api/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Berlin', url: berlin }),
    });
    expect(created.status).toBe(201);
    controller.abort();
    expect(await done).toBe(0);

    const asked = [];
    const r = await run(['scrape-once', '--config', cfgFile], {
      withFetcher: async (fn) =>
        fn(async (u) => {
          asked.push(u.split('?')[0]);
          return html;
        }),
    });
    expect(r.code).toBe(0);
    expect(asked).toEqual([SEARCH, berlin]); // alice and bob share Munich: one request; Berlin is bob's alone
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a global cap on distinct URLs per cycle: more users with different searches never multiply the requests', async () => {
    const { dir, cfgFile } = await project(['alice', 'bob']);
    fs.appendFileSync(cfgFile, 'queries:\n  maxDistinctPerCycle: 1\n');
    const berlin = 'https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html';
    // bob's own second search (the data model allows several; the cap protects WG-Gesucht)
    await run(['evaluate', '--config', cfgFile]);
    Db.init(path.join(dir, 'x.db'));
    Db.execute("INSERT INTO user_queries (user_id, name, url, enabled, created_at) VALUES ('bob', 'B', @u, 1, 9)", {
      u: berlin,
    });
    Db.reset();
    const asked = [];
    const cycle = () =>
      run(['scrape-once', '--config', cfgFile], {
        withFetcher: async (fn) => fn(async (u) => (asked.push(u.split('?')[0]), html)),
      });
    await cycle();
    await cycle();
    expect(asked).toEqual([SEARCH, berlin]); // one URL per cycle, longest waiting first
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
