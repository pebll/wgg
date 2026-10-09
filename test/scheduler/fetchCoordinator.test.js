import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { startFetchRun, finishFetchRun, setNextFetch, getFetchStatus } from '../../lib/services/status/fetchStatus.js';
import { createFetchCoordinator } from '../../lib/scheduler/fetchCoordinator.js';

const T = 1_700_000_000_000;
const config = { schedule: { intervalMinutes: 5, maxBackoffMinutes: 60, manualFetchMinGapSeconds: 120 } };
const okResult = { newListings: [], errors: [], botDetected: false, searchesRun: 1 };

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(() => Db.reset());

/** A mocked cycle whose completion the test controls. Never launches a browser. */
function controllableCycle() {
  let finish;
  const runCycle = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  return { runCycle, finish: (r = okResult) => finish(r) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('#fetchCoordinator.triggerNow (no scheduler in this process)', () => {
  it('accepts, runs one cycle asynchronously and frees the lock afterwards', async () => {
    const { runCycle, finish } = controllableCycle();
    let clock = T;
    const c = createFetchCoordinator({ config, runCycle, now: () => clock });

    const result = c.triggerNow();
    expect(result).toEqual({ ok: true, mode: 'one-off' });
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(c.isRunning()).toBe(true);

    finish();
    await flush();
    expect(c.isRunning()).toBe(false);
  });

  it('rejects with 409 while a cycle of this process is running', async () => {
    const { runCycle, finish } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    c.triggerNow();
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 409 });
    expect(runCycle).toHaveBeenCalledTimes(1);
    finish();
    await flush();
  });

  it('rejects with 409 when the database shows an unfinished run younger than 15 minutes', () => {
    startFetchRun(T - 10 * 60_000); // another process is fetching
    const { runCycle } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 409 });
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('ignores an unfinished run older than 15 minutes (crashed process)', () => {
    startFetchRun(T - 20 * 60_000);
    const { runCycle } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    expect(c.triggerNow()).toMatchObject({ ok: true });
  });

  it('rejects with 429 and retryAfterSeconds when the last fetch started less than the minimum gap ago', () => {
    const id = startFetchRun(T - 30_000);
    finishFetchRun(id, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T - 20_000);
    const { runCycle } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    expect(c.triggerNow()).toEqual({
      ok: false,
      status: 429,
      error: expect.stringMatching(/minimum/i),
      retryAfterSeconds: 90,
    });
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('accepts once the minimum gap has passed, and honours a configured gap of 0', () => {
    const id = startFetchRun(T - 121_000);
    finishFetchRun(id, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T - 100_000);
    const a = createFetchCoordinator({ config, runCycle: controllableCycle().runCycle, now: () => T });
    expect(a.triggerNow()).toMatchObject({ ok: true });

    const id2 = startFetchRun(T - 1000);
    finishFetchRun(id2, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T - 500);
    const zero = { schedule: { ...config.schedule, manualFetchMinGapSeconds: 0 } };
    const b = createFetchCoordinator({ config: zero, runCycle: controllableCycle().runCycle, now: () => T });
    expect(b.triggerNow()).toMatchObject({ ok: true });
  });

  it('rejects with 429 and the remaining time while the scheduler is in bot backoff', () => {
    setNextFetch({ nextFetchAt: T + 300_000, backoff: true }, T - 1000);
    const { runCycle } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 300 });
    expect(c.triggerNow().error).toMatch(/backoff/i);
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('without a live scheduler, a bot-detected last run also blocks until the first backoff interval has passed', () => {
    const id = startFetchRun(T - 200_000);
    finishFetchRun(id, { newCount: 0, errorCount: 1, botDetected: true, error: 'bot' }, T - 190_000);
    const { runCycle } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    // first backoff = 5 min * 2 = 10 min after the run finished -> 600 - 190 = 410 s left
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 410 });
    const later = createFetchCoordinator({ config, runCycle, now: () => T + 420_000 });
    expect(later.triggerNow()).toMatchObject({ ok: true });
  });

  it('a crashing cycle frees the lock and does not throw to the caller', async () => {
    const runCycle = vi.fn(async () => {
      throw new Error('boom');
    });
    const c = createFetchCoordinator({ config, runCycle, now: () => T, log: { error: () => {} } });
    expect(c.triggerNow()).toMatchObject({ ok: true });
    await flush();
    expect(c.isRunning()).toBe(false);
  });
});

describe('#fetchCoordinator with a scheduler in this process', () => {
  it('wakes the sleeping scheduler instead of running its own cycle', () => {
    const { runCycle } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    const wake = vi.fn();
    c.attachScheduler();
    c.registerWake(wake);
    expect(c.triggerNow()).toEqual({ ok: true, mode: 'scheduler' });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('is busy (409) when the scheduler is attached but not waiting', () => {
    const { runCycle } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    c.attachScheduler();
    c.registerWake(null);
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 409 });
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('the scheduled-cycle wrapper holds the lock while the scheduler runs a cycle', async () => {
    const { runCycle, finish } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    c.attachScheduler();
    const pending = c.runScheduledCycle();
    expect(c.isRunning()).toBe(true);
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 409 });
    finish();
    await pending;
    expect(c.isRunning()).toBe(false);
  });

  it('still applies the minimum gap and backoff guards before waking', () => {
    const id = startFetchRun(T - 10_000);
    finishFetchRun(id, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T - 5_000);
    const c = createFetchCoordinator({ config, runCycle: vi.fn(), now: () => T });
    const wake = vi.fn();
    c.attachScheduler();
    c.registerWake(wake);
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 110 });
    expect(wake).not.toHaveBeenCalled();
  });
});

describe('#fetchCoordinator shared lock for detail fetches', () => {
  it('runs detail work one at a time, in order', async () => {
    const c = createFetchCoordinator({ config, runCycle: vi.fn(), now: () => T });
    const log = [];
    let release;
    const first = c.runExclusive(async () => {
      log.push('a:start');
      await new Promise((r) => (release = r));
      log.push('a:end');
    });
    const second = c.runExclusive(async () => {
      log.push('b:start');
    });
    await flush();
    expect(log).toEqual(['a:start']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('a failing detail task frees the lock for the next one', async () => {
    const c = createFetchCoordinator({ config, runCycle: vi.fn(), now: () => T });
    await expect(
      c.runExclusive(async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    await expect(c.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('a search cycle waits for a detail fetch that is in flight', async () => {
    const runCycle = vi.fn(async () => okResult);
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    let release;
    const detail = c.runExclusive(() => new Promise((r) => (release = r)));
    const cycle = c.runScheduledCycle();
    await flush();
    expect(runCycle).not.toHaveBeenCalled();
    release();
    await Promise.all([detail, cycle]);
    expect(runCycle).toHaveBeenCalledTimes(1);
  });

  it('a detail fetch waits for a running search cycle', async () => {
    const { runCycle, finish } = controllableCycle();
    const c = createFetchCoordinator({ config, runCycle, now: () => T });
    const cycle = c.runScheduledCycle();
    const task = vi.fn(async () => 1);
    const detail = c.runExclusive(task);
    await flush();
    expect(task).not.toHaveBeenCalled();
    finish();
    await Promise.all([cycle, detail]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('refuses a manual fetch with 409 while a detail page is being fetched', async () => {
    const c = createFetchCoordinator({ config, runCycle: vi.fn(), now: () => T });
    let release;
    const detail = c.runExclusive(() => new Promise((r) => (release = r)));
    await flush();
    expect(c.triggerNow()).toMatchObject({ ok: false, status: 409 });
    release();
    await detail;
  });

  it('backoffRemainingMs reports the bot backoff after a detail bot wall (no scheduler in this process)', () => {
    const c = createFetchCoordinator({ config, runCycle: vi.fn(), now: () => T });
    expect(c.backoffRemainingMs()).toBe(0);
    c.reportBotDetected(new Error('wall'));
    // first backoff interval: 2 x 5 min
    expect(c.backoffRemainingMs()).toBe(10 * 60_000);
    expect(getFetchStatus(T).lastFetch).toMatchObject({ botDetected: true });
  });

  it('reportBotDetected tells the scheduler to back off', () => {
    const c = createFetchCoordinator({ config, runCycle: vi.fn(), now: () => T });
    const penalty = vi.fn();
    c.registerPenalty(penalty);
    c.reportBotDetected(new Error('wall'));
    expect(penalty).toHaveBeenCalledTimes(1);
  });
});

describe('#fetchCoordinator.manualFetchState (what the Fetch now button shows)', () => {
  const idle = { runCycle: vi.fn() };
  const make = (clock = T) => createFetchCoordinator({ config, runCycle: idle.runCycle, now: () => clock });

  it('is available now when nothing was fetched yet', () => {
    expect(make().manualFetchState()).toEqual({
      minGapSeconds: 120,
      availableAt: null,
      running: false,
      nightPause: false,
    });
  });

  it('counts the gap from the last fetch start, scheduled or manual (the coordinator cannot tell them apart)', () => {
    const id = startFetchRun(T - 30_000);
    finishFetchRun(id, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T - 20_000);
    expect(make().manualFetchState()).toEqual({
      minGapSeconds: 120,
      availableAt: T - 30_000 + 120_000,
      running: false,
      nightPause: false,
    });
    expect(make(T + 90_001).manualFetchState().availableAt).toBeNull();
  });

  it('a scheduled cycle of this process blocks the button the same way', async () => {
    const { runCycle, finish } = controllableCycle();
    const c = createFetchCoordinator({
      config,
      runCycle: async () => {
        const id = startFetchRun(T);
        const r = await runCycle();
        finishFetchRun(id, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T + 1000);
        return r;
      },
      now: () => T + 5000,
    });
    const done = c.runScheduledCycle();
    expect(c.manualFetchState()).toMatchObject({ running: true });
    finish();
    await done;
    expect(c.manualFetchState()).toEqual({
      minGapSeconds: 120,
      availableAt: T + 120_000,
      running: false,
      nightPause: false,
    });
  });

  it('reports running while a cycle runs, also one of another process', () => {
    startFetchRun(T - 10_000);
    expect(make().manualFetchState().running).toBe(true);
  });

  it('uses the later of the gap end and the end of the bot backoff', () => {
    const id = startFetchRun(T - 60_000);
    finishFetchRun(id, { newCount: 0, errorCount: 1, botDetected: true, error: 'bot' }, T - 50_000);
    // no scheduler: first backoff interval = 2 x 5 min after the run finished
    expect(make().manualFetchState().availableAt).toBe(T - 50_000 + 10 * 60_000);
  });

  it('a gap of 0 is always available', () => {
    const zero = { schedule: { ...config.schedule, manualFetchMinGapSeconds: 0 } };
    const id = startFetchRun(T - 1000);
    finishFetchRun(id, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T - 500);
    const c = createFetchCoordinator({ config: zero, runCycle: vi.fn(), now: () => T });
    expect(c.manualFetchState().availableAt).toBeNull();
  });
});

describe('#fetchCoordinator night pause (fetch window)', () => {
  const at = (h, m = 0) => new Date(2026, 9, 2, h, m).getTime();
  const window = { from: 7, to: 23 };
  const make = (clock, extra = {}) => {
    const runCycle = vi.fn(async () => okResult);
    const c = createFetchCoordinator({ config, runCycle, now: () => clock, fetchWindow: () => window, ...extra });
    return { c, runCycle };
  };

  it('refuses a manual fetch at night with a clear 429 until the window opens', () => {
    const { c, runCycle } = make(at(3));
    expect(c.triggerNow()).toEqual({
      ok: false,
      status: 429,
      error: 'Fetching pauses at night (until 07:00).',
      retryAfterSeconds: 4 * 3600,
    });
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('accepts a manual fetch inside the window', () => {
    const { c } = make(at(12));
    expect(c.triggerNow()).toEqual({ ok: true, mode: 'one-off' });
  });

  it('reflects the pause in manualFetchState: available at the window start', () => {
    const { c } = make(at(23, 30));
    expect(c.manualFetchState()).toMatchObject({ availableAt: new Date(2026, 9, 3, 7).getTime(), nightPause: true });
  });

  it('manualFetchState has no night pause inside the window', () => {
    const { c } = make(at(12));
    expect(c.manualFetchState()).toMatchObject({ availableAt: null, nightPause: false });
  });

  it('exposes the remaining pause for the detail worker', () => {
    expect(make(at(5)).c.pauseRemainingMs()).toBe(2 * 3_600_000);
    expect(make(at(9)).c.pauseRemainingMs()).toBe(0);
  });

  it('never pauses without a fetch window (CLI commands)', () => {
    const c = createFetchCoordinator({ config, runCycle: async () => okResult, now: () => at(3) });
    expect(c.pauseRemainingMs()).toBe(0);
    expect(c.triggerNow()).toEqual({ ok: true, mode: 'one-off' });
  });
});
