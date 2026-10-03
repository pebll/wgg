import { describe, expect, it } from 'vitest';
import { createWindowLimiter, getClientIp } from '../../lib/auth/rateLimiter.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('createWindowLimiter', () => {
  it('allows up to max attempts and flags the next one', () => {
    const c = clock();
    const limiter = createWindowLimiter(60_000, c.now);
    for (let i = 0; i < 3; i++) expect(limiter.hit('k', 3)).toBe(false);
    expect(limiter.hit('k', 3)).toBe(true);
  });

  it('counts keys independently', () => {
    const limiter = createWindowLimiter(60_000, clock().now);
    limiter.hit('a', 1);
    expect(limiter.hit('a', 1)).toBe(true);
    expect(limiter.hit('b', 1)).toBe(false);
  });

  it('starts fresh once the window has passed', () => {
    const c = clock();
    const limiter = createWindowLimiter(1000, c.now);
    limiter.hit('k', 1);
    expect(limiter.hit('k', 1)).toBe(true);
    c.advance(1001);
    expect(limiter.hit('k', 1)).toBe(false);
  });

  it('keeps a key whose window is exactly at its limit', () => {
    const c = clock();
    const limiter = createWindowLimiter(1000, c.now);
    limiter.hit('k', 1);
    c.advance(1000);
    expect(limiter.hit('k', 1)).toBe(true);
  });

  it('release takes one attempt back and drops empty records', () => {
    const limiter = createWindowLimiter(60_000, clock().now);
    limiter.hit('k', 1);
    limiter.release('k');
    expect(limiter.hit('k', 1)).toBe(false);
    limiter.release('k');
    limiter.release('k');
    limiter.release('unknown');
    expect(limiter.hit('k', 1)).toBe(false);
  });

  it('clear forgets a key', () => {
    const limiter = createWindowLimiter(60_000, clock().now);
    limiter.hit('k', 1);
    limiter.hit('k', 1);
    limiter.clear('k');
    expect(limiter.hit('k', 1)).toBe(false);
  });

  it('retryAfterSeconds rounds up, never goes below 1 and defaults to 1', () => {
    const c = clock();
    const limiter = createWindowLimiter(60_000, c.now);
    expect(limiter.retryAfterSeconds('nobody')).toBe(1);
    limiter.hit('k', 1);
    expect(limiter.retryAfterSeconds('k')).toBe(60);
    c.advance(59_500);
    expect(limiter.retryAfterSeconds('k')).toBe(1);
    c.advance(5000);
    expect(limiter.retryAfterSeconds('k')).toBe(1);
  });
});

describe('getClientIp', () => {
  it('prefers request.ip, then the socket address, then unknown', () => {
    expect(getClientIp({ ip: '1.2.3.4', socket: { remoteAddress: '9.9.9.9' } })).toBe('1.2.3.4');
    expect(getClientIp({ socket: { remoteAddress: '9.9.9.9' } })).toBe('9.9.9.9');
    expect(getClientIp({})).toBe('unknown');
  });
});
