import { describe, it, expect } from 'vitest';
import {
  scoreToStars,
  aiScore,
  formatClock,
  formatUntil,
  describeLastFetch,
  describeNextFetch,
  describeDetailsQueue,
  selectedListing,
  selectionAfterDismiss,
  isFetchRunning,
  fetchOutcome,
  formatRetryAfter,
  fetchNowState,
  refusalMessage,
} from '../../ui/src/services/format.js';

const at = (h, m) => new Date(2026, 9, 2, h, m, 0).getTime();

describe('#scoreToStars', () => {
  it('maps the 1-10 score to 0-5 stars in 0.5 steps', () => {
    expect(scoreToStars(10)).toBe(5);
    expect(scoreToStars(8.4)).toBe(4);
    expect(scoreToStars(8.6)).toBe(4.5);
    expect(scoreToStars(7)).toBe(3.5);
    expect(scoreToStars(1)).toBe(0.5);
  });
  it('clamps and returns null for missing scores', () => {
    expect(scoreToStars(null)).toBeNull();
    expect(scoreToStars(undefined)).toBeNull();
    expect(scoreToStars(12)).toBe(5);
    expect(scoreToStars(-3)).toBe(0);
  });
});

describe('#fetch status formatting', () => {
  it('formatClock gives local HH:MM', () => {
    expect(formatClock(at(9, 5))).toBe('09:05');
  });

  it('formatUntil words a future time', () => {
    expect(formatUntil(at(12, 0) + 30_000, at(12, 0))).toBe('any moment');
    expect(formatUntil(at(12, 5), at(12, 0))).toBe('in 5 min');
    expect(formatUntil(at(14, 10), at(12, 0))).toBe('in 2 h');
  });

  it('describeLastFetch covers none, running, ok, errors and bot detection', () => {
    const now = at(12, 10);
    expect(describeLastFetch(null, now)).toBe('no fetch recorded yet');
    expect(describeLastFetch({ startedAt: at(12, 9), finishedAt: null }, now)).toBe('fetching now...');
    const ok = { startedAt: at(12, 0), finishedAt: at(12, 1), newCount: 3, errorCount: 0, botDetected: false };
    expect(describeLastFetch(ok, now)).toBe('9 min ago (12:01, 3 new)');
    expect(describeLastFetch({ ...ok, errorCount: 2 }, now)).toBe('9 min ago (12:01, 3 new, 2 errors)');
    expect(describeLastFetch({ ...ok, errorCount: 1, botDetected: true }, now)).toBe(
      '9 min ago (12:01, 3 new, bot detection)',
    );
  });

  it('describeNextFetch covers running, backoff and stopped scheduler', () => {
    const now = at(12, 0);
    expect(describeNextFetch(null, now)).toBe('unknown');
    expect(describeNextFetch({ schedulerRunning: false, nextFetchAt: null }, now)).toBe('scheduler not running');
    expect(describeNextFetch({ schedulerRunning: true, nextFetchAt: at(12, 5), backoff: false }, now)).toBe(
      'in 5 min (12:05)',
    );
    expect(describeNextFetch({ schedulerRunning: true, nextFetchAt: at(12, 20), backoff: true }, now)).toBe(
      'backing off: in 20 min (12:20)',
    );
  });
});

describe('#selectedListing', () => {
  const items = [{ id: 1 }, { id: 2 }];
  it('keeps the selection while present, else the first listing, else null', () => {
    expect(selectedListing(items, 2)).toBe(items[1]);
    expect(selectedListing(items, 99)).toBe(items[0]);
    expect(selectedListing(items, null)).toBe(items[0]);
    expect(selectedListing([], 1)).toBeNull();
  });
});

describe('#selectionAfterDismiss', () => {
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
  it('moves to the next tile, else the previous one, else nothing', () => {
    expect(selectionAfterDismiss(items, 1)).toBe(2);
    expect(selectionAfterDismiss(items, 2)).toBe(3);
    expect(selectionAfterDismiss(items, 3)).toBe(2);
    expect(selectionAfterDismiss([{ id: 1 }], 1)).toBeNull();
    expect(selectionAfterDismiss(items, 99)).toBeNull();
  });
});

describe('#isFetchRunning', () => {
  const now = at(12, 0);
  it('is true for an unfinished run younger than 15 minutes', () => {
    expect(isFetchRunning({ lastFetch: { startedAt: now - 60_000, finishedAt: null } }, now)).toBe(true);
  });
  it('is false for finished, stale (crashed) or missing runs', () => {
    expect(isFetchRunning({ lastFetch: { startedAt: now - 60_000, finishedAt: now - 1000 } }, now)).toBe(false);
    expect(isFetchRunning({ lastFetch: { startedAt: now - 16 * 60_000, finishedAt: null } }, now)).toBe(false);
    expect(isFetchRunning({ lastFetch: null }, now)).toBe(false);
    expect(isFetchRunning(null, now)).toBe(false);
  });
});

describe('#fetchOutcome', () => {
  const run = (patch) => ({
    lastFetch: {
      id: 5,
      startedAt: 1,
      finishedAt: 2,
      newCount: 0,
      errorCount: 0,
      botDetected: false,
      error: null,
      ...patch,
    },
  });
  it('waits until a new finished run shows up', () => {
    expect(fetchOutcome(5, run({}))).toBeNull(); // still the previous run
    expect(fetchOutcome(4, run({ finishedAt: null }))).toBeNull(); // new run still going
    expect(fetchOutcome(4, null)).toBeNull();
    expect(fetchOutcome(null, { lastFetch: null })).toBeNull();
  });
  it('reports the number of new offers', () => {
    expect(fetchOutcome(4, run({ newCount: 3 }))).toEqual({ type: 'success', message: '3 new offers' });
    expect(fetchOutcome(4, run({ newCount: 1 }))).toEqual({ type: 'success', message: '1 new offer' });
    expect(fetchOutcome(null, run({ newCount: 0 }))).toEqual({ type: 'success', message: '0 new offers' });
  });
  it('reports errors and bot detection', () => {
    expect(fetchOutcome(4, run({ errorCount: 1, error: 'cannot launch browser' }))).toEqual({
      type: 'error',
      message: 'Fetch failed: cannot launch browser',
    });
    expect(fetchOutcome(4, run({ errorCount: 2 }))).toEqual({
      type: 'error',
      message: 'Fetch finished with 2 errors.',
    });
    expect(fetchOutcome(4, run({ botDetected: true, errorCount: 1 })).message).toMatch(/bot detection/i);
  });
});

describe('#formatRetryAfter / #refusalMessage', () => {
  it('formats the waiting time', () => {
    expect(formatRetryAfter(45)).toBe('45 s');
    expect(formatRetryAfter(60)).toBe('1 min');
    expect(formatRetryAfter(90)).toBe('2 min');
    expect(formatRetryAfter(3600)).toBe('60 min');
  });
  it('appends the retry time to a refusal', () => {
    expect(refusalMessage({ json: { error: 'Too soon.', retryAfterSeconds: 90 } })).toBe(
      'Too soon. Try again in 2 min.',
    );
    expect(refusalMessage({ json: { error: 'A fetch is already running.' } })).toBe('A fetch is already running.');
    expect(refusalMessage(undefined)).toBe('Could not start a fetch.');
  });
});

describe('#describeDetailsQueue', () => {
  const now = at(12, 0);
  it('is null without detail numbers (older server)', () => {
    expect(describeDetailsQueue(undefined, now)).toBeNull();
    expect(describeDetailsQueue(null, now)).toBeNull();
  });
  it('names the pending count', () => {
    expect(describeDetailsQueue({ pending: 12, fetched: 3, failed: 0, running: false, nextAt: null }, now)).toBe(
      '12 pending',
    );
  });
  it('says when the queue is empty', () => {
    expect(describeDetailsQueue({ pending: 0, fetched: 3, failed: 0, running: false, nextAt: null }, now)).toBe(
      'up to date',
    );
  });
  it('adds the time of the next request while the worker waits, and the failed count', () => {
    expect(describeDetailsQueue({ pending: 2, fetched: 3, failed: 1, running: true, nextAt: now + 45_000 }, now)).toBe(
      '2 pending (next in 45 s), 1 failed',
    );
  });
  it('shows "fetching" while a request is in flight', () => {
    expect(describeDetailsQueue({ pending: 2, fetched: 0, failed: 0, running: true, nextAt: null }, now)).toBe(
      '2 pending (fetching)',
    );
  });
});

describe('#aiScore', () => {
  it('returns the fit score of a finished assessment', () => {
    expect(aiScore({ status: 'done', result: { fitScore: 7 } })).toBe(7);
  });
  it('returns null while pending, failed, skipped or missing', () => {
    expect(aiScore({ status: 'pending' })).toBeNull();
    expect(aiScore({ status: 'failed', error: 'x' })).toBeNull();
    expect(aiScore({ status: 'skipped' })).toBeNull();
    expect(aiScore(null)).toBeNull();
    expect(aiScore(undefined)).toBeNull();
    expect(aiScore({ status: 'done', result: {} })).toBeNull();
  });
});

describe('#fetchNowState', () => {
  const now = at(14, 25);
  const status = (manualFetch) => ({ manualFetch });

  it('is enabled when the server says a fetch is allowed now', () => {
    expect(fetchNowState(status({ minGapSeconds: 600, availableAt: null, running: false }), now)).toEqual({
      enabled: true,
      label: 'Fetch now',
      tooltip: '',
    });
  });

  it('is enabled before the first status arrives or for an older server (the server stays the authority)', () => {
    expect(fetchNowState(null, now).enabled).toBe(true);
    expect(fetchNowState({}, now).enabled).toBe(true);
    expect(fetchNowState(status(null), now).enabled).toBe(true);
  });

  it('is disabled with the remaining minutes and the 24 h clock time', () => {
    const state = fetchNowState(status({ minGapSeconds: 600, availableAt: at(14, 32), running: false }), now);
    expect(state).toEqual({ enabled: false, label: 'Fetch now', tooltip: 'Available in 7 min (14:32)' });
  });

  it('words the last seconds as "less than a minute"', () => {
    const state = fetchNowState(status({ minGapSeconds: 600, availableAt: now + 20_000, running: false }), now);
    expect(state.enabled).toBe(false);
    expect(state.tooltip).toBe('Available in less than a minute (14:25)');
  });

  it('re-enables once availableAt has passed', () => {
    expect(fetchNowState(status({ minGapSeconds: 600, availableAt: at(14, 25), running: false }), now).enabled).toBe(
      true,
    );
  });

  it('shows "Fetching..." while a fetch runs', () => {
    const state = fetchNowState(status({ minGapSeconds: 600, availableAt: null, running: true }), now);
    expect(state).toMatchObject({ enabled: false, label: 'Fetching...' });
  });
});
