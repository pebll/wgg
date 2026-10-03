import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseConfig, loadConfig, ConfigError, PROJECT_ROOT } from '../lib/config.js';

const URL1 = 'https://www.wg-gesucht.de/wg-zimmer-in-Muenchen.90.0.1.0.html';

describe('#config', () => {
  it('applies defaults for a minimal config', () => {
    const cfg = parseConfig({ searches: [{ url: URL1 }] });
    expect(cfg.dbPath).toBe(path.join(PROJECT_ROOT, 'db/wgg.db'));
    expect(cfg.searches).toEqual([{ name: 'search-1', url: URL1 }]);
    expect(cfg.schedule).toEqual({
      intervalMinutes: 30,
      jitterPercent: 20,
      maxBackoffMinutes: 60,
      delayBetweenSearchesSeconds: [5, 15],
      manualFetchMinGapSeconds: 600,
    });
    expect(cfg.server).toEqual({
      host: '127.0.0.1',
      port: 9998,
      publicPath: '/',
      publicUrl: null,
      trustProxy: 'loopback',
      sessionHours: 168,
    });
    expect(cfg.details).toEqual({ delaySeconds: 60, jitterPercent: 50, maxAgeDays: 7, maxAttempts: 3 });
  });

  describe('details', () => {
    const cfgWith = (details) => parseConfig({ searches: [{ url: URL1 }], details });
    it('keeps explicit values and fills the rest with defaults', () => {
      expect(cfgWith({ delaySeconds: 90, maxAgeDays: 3 }).details).toEqual({
        delaySeconds: 90,
        jitterPercent: 50,
        maxAgeDays: 3,
        maxAttempts: 3,
      });
      expect(cfgWith({ jitterPercent: 0 }).details.jitterPercent).toBe(0);
    });
    it.each([
      ['not an object', 5],
      ['delay 0', { delaySeconds: 0 }],
      ['delay below the 10 s politeness floor', { delaySeconds: 5 }],
      ['jitter > 100', { jitterPercent: 101 }],
      ['jitter < 0', { jitterPercent: -1 }],
      ['maxAgeDays 0', { maxAgeDays: 0 }],
      ['maxAttempts not an integer', { maxAttempts: 1.5 }],
      ['maxAttempts 0', { maxAttempts: 0 }],
    ])('rejects %s', (_label, details) => {
      expect(() => cfgWith(details)).toThrow(ConfigError);
    });
  });

  it('parses and validates server host/port', () => {
    const ok = parseConfig({ searches: [{ url: URL1 }], server: { host: '0.0.0.0', port: 8080 } });
    expect(ok.server).toMatchObject({ host: '0.0.0.0', port: 8080 });
    expect(parseConfig({ searches: [{ url: URL1 }], server: { port: 1234 } }).server).toMatchObject({
      host: '127.0.0.1',
      port: 1234,
    });
    for (const server of [
      { port: 0 },
      { port: 70000 },
      { port: '80' },
      { port: 1.5 },
      { host: '' },
      { host: 5 },
      'x',
    ]) {
      expect(() => parseConfig({ searches: [{ url: URL1 }], server })).toThrow(ConfigError);
    }
  });

  describe('server (subpath deployment, proxy, sessions)', () => {
    const serverWith = (server) => parseConfig({ searches: [{ url: URL1 }], server }).server;

    it('normalizes publicPath (leading slash, no trailing slash) and derives it from publicUrl', () => {
      expect(serverWith({ publicPath: '/wgg/' }).publicPath).toBe('/wgg');
      expect(serverWith({ publicPath: '/' }).publicPath).toBe('/');
      expect(serverWith({ publicUrl: 'https://xn--lo-bja.com/wgg/' })).toMatchObject({
        publicUrl: 'https://xn--lo-bja.com/wgg',
        publicPath: '/wgg',
      });
      expect(serverWith({ publicUrl: 'https://example.org' })).toMatchObject({
        publicUrl: 'https://example.org',
        publicPath: '/',
      });
      expect(serverWith({ publicUrl: 'https://example.org/a', publicPath: '/b' }).publicPath).toBe('/b');
    });

    it('accepts the trustProxy forms fastify understands', () => {
      expect(serverWith({ trustProxy: true }).trustProxy).toBe(true);
      expect(serverWith({ trustProxy: false }).trustProxy).toBe(false);
      expect(serverWith({ trustProxy: '10.0.0.0/8' }).trustProxy).toBe('10.0.0.0/8');
      expect(serverWith({ trustProxy: ['127.0.0.1', '::1'] }).trustProxy).toEqual(['127.0.0.1', '::1']);
      expect(serverWith({ trustProxy: 2 }).trustProxy).toBe(2);
    });

    it('sessionHours defaults to a week and must be positive', () => {
      expect(serverWith({ sessionHours: 12 }).sessionHours).toBe(12);
    });

    it.each([
      [{ publicPath: 'wgg' }],
      [{ publicPath: '/a//b' }],
      [{ publicPath: '/a/../b' }],
      [{ publicPath: '/a b' }],
      [{ publicPath: 5 }],
      [{ publicUrl: 'ftp://x.org' }],
      [{ publicUrl: 'not a url' }],
      [{ publicUrl: 'https://x.org/?q=1' }],
      [{ trustProxy: 'yes please' }],
      [{ trustProxy: {} }],
      [{ trustProxy: -1 }],
      [{ sessionHours: 0 }],
      [{ sessionHours: 'x' }],
    ])('rejects %j', (server) => {
      expect(() => serverWith(server)).toThrow(ConfigError);
    });
  });

  describe('queries limits', () => {
    const q = (queries) => parseConfig({ searches: [{ url: URL1 }], queries }).queries;
    it('default to 1 query per user and 5 distinct URLs per cycle', () => {
      expect(q(undefined)).toEqual({ maxPerUser: 1, maxDistinctPerCycle: 5 });
      expect(q({ maxPerUser: 3 })).toEqual({ maxPerUser: 3, maxDistinctPerCycle: 5 });
      expect(q({ maxDistinctPerCycle: 2 }).maxDistinctPerCycle).toBe(2);
    });
    it.each([[{ maxPerUser: 0 }], [{ maxPerUser: 1.5 }], [{ maxPerUser: '2' }], [{ maxDistinctPerCycle: 0 }], ['x']])(
      'rejects %j',
      (queries) => expect(() => q(queries)).toThrow(ConfigError),
    );
  });

  it('keeps explicit values', () => {
    const cfg = parseConfig({
      db: './x/y.db',
      searches: [{ name: 'Munich', url: URL1 }],
      schedule: { intervalMinutes: 10, jitterPercent: 0, maxBackoffMinutes: 30, delayBetweenSearchesSeconds: [1, 2] },
    });
    expect(cfg.dbPath).toBe(path.join(PROJECT_ROOT, 'x/y.db'));
    expect(cfg.searches[0].name).toBe('Munich');
    expect(cfg.schedule.intervalMinutes).toBe(10);
    expect(cfg.schedule.jitterPercent).toBe(0);
    expect(cfg.schedule.delayBetweenSearchesSeconds).toEqual([1, 2]);
  });

  it.each([
    ['not an object', null],
    ['no searches', {}],
    ['empty searches', { searches: [] }],
    ['search without url', { searches: [{ name: 'a' }] }],
    ['non-wg-gesucht url', { searches: [{ url: 'https://example.com/x' }] }],
    ['non-https url', { searches: [{ url: 'http://www.wg-gesucht.de/x' }] }],
    ['garbage url', { searches: [{ url: 'not a url' }] }],
    ['interval <= 0', { searches: [{ url: URL1 }], schedule: { intervalMinutes: 0 } }],
    ['jitter > 100', { searches: [{ url: URL1 }], schedule: { jitterPercent: 150 } }],
    ['bad delay range', { searches: [{ url: URL1 }], schedule: { delayBetweenSearchesSeconds: [10, 2] } }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
  });

  it('loads YAML from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-cfg-'));
    const file = path.join(dir, 'wgg.yaml');
    fs.writeFileSync(file, `searches:\n  - name: Munich\n    url: ${URL1}\nschedule:\n  intervalMinutes: 7\n`);
    const cfg = loadConfig(file);
    expect(cfg.searches[0].url).toBe(URL1);
    expect(cfg.schedule.intervalMinutes).toBe(7);
    fs.rmSync(dir, { recursive: true });
  });

  it('gives a helpful error when the file is missing', () => {
    expect(() => loadConfig('/nonexistent/wgg.yaml')).toThrow(/wgg\.example\.yaml/);
  });

  describe('db path resolution', () => {
    it('resolves a relative db path against the project root (package.json directory), not the cwd', () => {
      const cfg = parseConfig({ db: './data/w.db', searches: [{ url: URL1 }] }, { projectRoot: '/srv/wgg' });
      expect(cfg.dbPath).toBe('/srv/wgg/data/w.db');
      expect(parseConfig({ searches: [{ url: URL1 }] }, { projectRoot: '/srv/wgg' }).dbPath).toBe('/srv/wgg/db/wgg.db');
    });

    it('keeps absolute paths and :memory: as they are', () => {
      expect(parseConfig({ db: '/var/w.db', searches: [{ url: URL1 }] }).dbPath).toBe('/var/w.db');
      expect(parseConfig({ db: ':memory:', searches: [{ url: URL1 }] }).dbPath).toBe(':memory:');
    });

    it('PROJECT_ROOT is the directory that holds package.json', () => {
      expect(fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))).toBe(true);
    });
  });

  describe('schedule.manualFetchMinGapSeconds', () => {
    const cfgWith = (v) => parseConfig({ searches: [{ url: URL1 }], schedule: { manualFetchMinGapSeconds: v } });
    it('accepts 0 and positive numbers', () => {
      expect(cfgWith(0).schedule.manualFetchMinGapSeconds).toBe(0);
      expect(cfgWith(300).schedule.manualFetchMinGapSeconds).toBe(300);
    });
    it('rejects negative and non-numeric values', () => {
      expect(() => cfgWith(-1)).toThrow(ConfigError);
      expect(() => cfgWith('120')).toThrow(/manualFetchMinGapSeconds/);
      expect(() => cfgWith(Infinity)).toThrow(ConfigError);
    });
  });

  describe('notify send schedule defaults', () => {
    const notifyWith = (notify) => parseConfig({ searches: [{ url: URL1 }], notify }).notify;

    it('default to 7-23 h and a one hour Good interval', () => {
      const n = notifyWith({});
      expect(n.priority.window).toEqual({ from: 7, to: 23 });
      expect(n.bulk.window).toEqual({ from: 7, to: 23 });
      expect(n.bulk.intervalHours).toBe(1);
    });

    it('can be set per tier and are validated', () => {
      const n = notifyWith({ priority: { window: { from: 6, to: 24 } }, bulk: { intervalHours: 4 } });
      expect(n.priority.window).toEqual({ from: 6, to: 24 });
      expect(n.priority.rules).toEqual(notifyWith({}).priority.rules);
      expect(n.bulk.intervalHours).toBe(4);
      expect(() => notifyWith({ priority: { window: { from: 9, to: 9 } } })).toThrow(/notify\.priority\.window/);
      expect(() => notifyWith({ bulk: { intervalHours: 0 } })).toThrow(/notify\.bulk\.intervalHours/);
    });
  });
});
