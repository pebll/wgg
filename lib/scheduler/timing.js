/**
 * Pure timing helpers for the scheduler.
 */

const MINUTE_MS = 60_000;

/**
 * Interval after `failures` consecutive failed cycles: base * 2^failures, capped at maxMinutes
 * (but never below the base interval).
 * @param {{baseMinutes: number, maxMinutes: number, failures: number}} p
 * @returns {number} minutes
 */
export function backoffMinutes({ baseMinutes, maxMinutes, failures }) {
  const cap = Math.max(baseMinutes, maxMinutes);
  return Math.min(baseMinutes * 2 ** failures, cap);
}

/**
 * Apply +/- `percent` random jitter to `baseMs`.
 * @param {number} baseMs
 * @param {number} percent 0..100
 * @param {() => number} [random] returns [0, 1)
 */
export function jitterMs(baseMs, percent, random = Math.random) {
  return baseMs * (1 + (random() * 2 - 1) * (percent / 100));
}

/**
 * How long to wait before the next cycle.
 * @param {{baseMinutes: number, maxMinutes: number, failures: number, jitterPercent: number, random?: () => number}} p
 * @returns {number} milliseconds
 */
export function computeWaitMs({ baseMinutes, maxMinutes, failures, jitterPercent, random }) {
  const minutes = backoffMinutes({ baseMinutes, maxMinutes, failures });
  return Math.round(jitterMs(minutes * MINUTE_MS, jitterPercent, random));
}
