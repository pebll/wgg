import { describe, it, expect } from 'vitest';
import { runScheduler } from '../../lib/scheduler/scheduler.js';

const config = {
  searches: [{ name: 'A', url: 'https://www.wg-gesucht.de/x' }],
  schedule: { intervalMinutes: 5, jitterPercent: 0, maxBackoffMinutes: 60, delayBetweenSearchesSeconds: [0, 0] },
};

const ok = { newListings: [], errors: [], botDetected: false, searchesRun: 1 };
const bot = { newListings: [], errors: [{}], botDetected: true, searchesRun: 1 };
const httpErr = { newListings: [], errors: [{}], botDetected: false, searchesRun: 1 };

/** Runs the scheduler against scripted cycle results and records the waits. */
async function drive(results, { onCycle } = {}) {
  const controller = new AbortController();
  const waits = [];
  let i = 0;
  await runScheduler({
    config,
    signal: controller.signal,
    random: () => 0.5,
    runCycle: async () => {
      const r = results[i++];
      if (i >= results.length) controller.abort();
      onCycle?.(r);
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms) => {
      waits.push(ms / 60_000);
    },
  });
  return { waits, cycles: i };
}

describe('#runScheduler', () => {
  it('waits the base interval after successful cycles', async () => {
    const { waits, cycles } = await drive([ok, ok]);
    expect(cycles).toBe(2);
    expect(waits.slice(0, 1)).toEqual([5]);
  });

  it('backs off exponentially on bot detection and HTTP errors, and resets on success', async () => {
    const { waits } = await drive([bot, httpErr, bot, ok, ok]);
    expect(waits.slice(0, 4)).toEqual([10, 20, 40, 5]);
  });

  it('caps the backoff', async () => {
    const { waits } = await drive([bot, bot, bot, bot, bot, bot]);
    expect(Math.max(...waits)).toBe(60);
  });

  it('treats a thrown cycle (e.g. browser launch failure) as a failure', async () => {
    const { waits } = await drive([new Error('boom'), ok]);
    expect(waits[0]).toBe(10);
  });

  it('stops without another cycle once aborted', async () => {
    const controller = new AbortController();
    let cycles = 0;
    await runScheduler({
      config,
      signal: controller.signal,
      runCycle: async () => {
        cycles++;
        controller.abort();
        return ok;
      },
      sleep: async () => {},
    });
    expect(cycles).toBe(1);
  });

  it('does not start when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let cycles = 0;
    await runScheduler({
      config,
      signal: controller.signal,
      runCycle: async () => (cycles++, ok),
      sleep: async () => {},
    });
    expect(cycles).toBe(0);
  });

  it('reports the planned next fetch (after jitter/backoff) and clears it on stop', async () => {
    const controller = new AbortController();
    const planned = [];
    let stopped = 0;
    const results = [bot, ok];
    let i = 0;
    await runScheduler({
      config,
      signal: controller.signal,
      random: () => 0.5,
      now: () => 1_000_000,
      runCycle: async () => {
        const r = results[i++];
        if (i >= results.length) controller.abort();
        return r;
      },
      sleep: async () => {},
      onSchedule: (p) => planned.push(p),
      onStop: () => stopped++,
    });
    expect(planned[0]).toEqual({ nextFetchAt: 1_000_000 + 10 * 60_000, backoff: true });
    expect(stopped).toBe(1);
  });

  it('can be woken from its wait: the next cycle runs immediately and is re-planned normally', async () => {
    const controller = new AbortController();
    let wake = null;
    let cycles = 0;
    const plans = [];
    const waitingSleep = (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve, { once: true });
      });
    const done = runScheduler({
      config,
      signal: controller.signal,
      random: () => 0.5,
      registerWake: (fn) => {
        wake = fn;
      },
      onSchedule: (p) => plans.push(p),
      runCycle: async () => {
        cycles++;
        if (cycles === 2) controller.abort();
        return ok;
      },
      sleep: waitingSleep,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(cycles).toBe(1);
    expect(typeof wake).toBe('function'); // registered while waiting
    wake();
    await done;
    expect(cycles).toBe(2);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(wake).toBeNull(); // unregistered once the scheduler stopped
  });

  it('wake outside of a wait is not offered (registered function is cleared while a cycle runs)', async () => {
    const controller = new AbortController();
    const seen = [];
    await runScheduler({
      config,
      signal: controller.signal,
      random: () => 0.5,
      registerWake: (fn) => seen.push(fn === null ? 'cleared' : 'set'),
      runCycle: async () => {
        controller.abort();
        return ok;
      },
      sleep: async () => {},
    });
    expect(seen.at(-1)).toBe('cleared');
  });
});

describe('#runScheduler external backoff penalty (bot wall on a detail page)', () => {
  it('ends the current wait early, backs off once more and does not run a cycle for it', async () => {
    const controller = new AbortController();
    const waits = [];
    let penalty;
    let cycles = 0;
    await runScheduler({
      config,
      signal: controller.signal,
      random: () => 0.5,
      registerPenalty: (fn) => {
        penalty = fn;
      },
      runCycle: async () => {
        cycles++;
        if (cycles >= 2) controller.abort();
        return ok;
      },
      sleep: async (ms) => {
        waits.push(ms / 60_000);
        if (waits.length === 1) penalty(); // detail worker hits a bot wall during the first wait
      },
    });
    // wait 1: base 5 min; after the penalty the plan is redone with one failure (10 min) without a cycle in between.
    expect(waits.slice(0, 2)).toEqual([5, 10]);
    expect(cycles).toBe(2); // one before the first wait, one after the second
  });

  it('a penalty while no wait is running only counts the failure', async () => {
    const controller = new AbortController();
    const waits = [];
    let penalty;
    await runScheduler({
      config,
      signal: controller.signal,
      random: () => 0.5,
      registerPenalty: (fn) => {
        penalty = fn;
      },
      runCycle: async () => {
        penalty(); // not waiting: a cycle is running
        controller.abort();
        return { ...ok };
      },
      sleep: async (ms) => waits.push(ms),
    });
    expect(waits).toEqual([]); // aborted right after the cycle
  });
});
