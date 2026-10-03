import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import {
  startFetchRun,
  finishFetchRun,
  setNextFetch,
  clearNextFetch,
  getFetchStatus,
  SCHEDULER_GRACE_MS,
  recordFailedRun,
  hasRecentUnfinishedRun,
  UNFINISHED_RUN_MAX_AGE_MS,
} from '../../lib/services/status/fetchStatus.js';

beforeEach(async () => {
  Db.reset();
  Db.init(':memory:');
  await runMigrations();
});
afterEach(() => Db.reset());

const T = 1_000_000_000_000;

describe('#fetchStatus', () => {
  it('migration creates fetch_runs and scheduler_state', () => {
    const tables = Db.query("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    expect(tables).toContain('fetch_runs');
    expect(tables).toContain('scheduler_state');
  });

  it('is empty before anything was recorded', () => {
    expect(getFetchStatus(T)).toEqual({ lastFetch: null, nextFetchAt: null, backoff: false, schedulerRunning: false });
  });

  it('reports a running fetch with finishedAt null', () => {
    startFetchRun(T);
    expect(getFetchStatus(T + 1000).lastFetch).toEqual({
      id: 1,
      startedAt: T,
      finishedAt: null,
      newCount: 0,
      errorCount: 0,
      botDetected: false,
      error: null,
    });
  });

  it('records the result of a finished fetch and returns the latest run', () => {
    const first = startFetchRun(T);
    finishFetchRun(first, { newCount: 1, errorCount: 0, botDetected: false, error: null }, T + 10);
    const second = startFetchRun(T + 1000);
    finishFetchRun(second, { newCount: 3, errorCount: 2, botDetected: true, error: 'blocked' }, T + 2000);
    expect(getFetchStatus(T + 3000).lastFetch).toEqual({
      id: 2,
      startedAt: T + 1000,
      finishedAt: T + 2000,
      newCount: 3,
      errorCount: 2,
      botDetected: true,
      error: 'blocked',
    });
  });

  it('schedulerRunning: next fetch in the future (or just overdue within the grace period)', () => {
    setNextFetch({ nextFetchAt: T + 60_000, backoff: true }, T);
    expect(getFetchStatus(T)).toMatchObject({ nextFetchAt: T + 60_000, backoff: true, schedulerRunning: true });
    // a cycle that is currently running leaves the old value in the past for a while
    expect(getFetchStatus(T + 60_000 + SCHEDULER_GRACE_MS - 1).schedulerRunning).toBe(true);
    const stale = getFetchStatus(T + 60_000 + SCHEDULER_GRACE_MS + 1);
    expect(stale).toMatchObject({ nextFetchAt: null, backoff: false, schedulerRunning: false });
  });

  it('clearNextFetch marks the scheduler as stopped', () => {
    setNextFetch({ nextFetchAt: T + 60_000, backoff: false }, T);
    clearNextFetch(T + 1);
    expect(getFetchStatus(T + 2)).toMatchObject({ nextFetchAt: null, schedulerRunning: false });
  });

  it('recordFailedRun can flag bot detection (a bot wall met outside a search cycle)', () => {
    recordFailedRun(new Error('wall'), T, { botDetected: true });
    expect(getFetchStatus(T + 1).lastFetch).toMatchObject({ botDetected: true, errorCount: 1, error: 'wall' });
  });

  it('recordFailedRun stores a finished run with the error (a cycle that failed before it started)', () => {
    recordFailedRun(new Error('browser launch failed'), T);
    expect(getFetchStatus(T + 1).lastFetch).toMatchObject({
      startedAt: T,
      finishedAt: T,
      newCount: 0,
      errorCount: 1,
      botDetected: false,
      error: 'browser launch failed',
    });
  });

  it('hasRecentUnfinishedRun: only an unfinished run younger than the max age counts', () => {
    expect(hasRecentUnfinishedRun(T)).toBe(false);
    const id = startFetchRun(T);
    expect(hasRecentUnfinishedRun(T + 60_000)).toBe(true);
    expect(hasRecentUnfinishedRun(T + UNFINISHED_RUN_MAX_AGE_MS + 1)).toBe(false); // crashed process, stale row
    finishFetchRun(id, { newCount: 0, errorCount: 0, botDetected: false, error: null }, T + 10);
    expect(hasRecentUnfinishedRun(T + 60_000)).toBe(false);
  });
});
