/**
 * Address used for rate limiting. fastify only honours X-Forwarded-For for peers matched by `trustProxy`,
 * so the header itself is never read here.
 */
export function getClientIp(request) {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

/**
 * In-memory fixed-window attempt counter. Stale records are pruned on every hit, so no timer is needed.
 *
 * @param {number} windowMs
 * @param {() => number} [now]
 */
export function createWindowLimiter(windowMs, now = Date.now) {
  /** @type {Map<string, {count: number, firstAttempt: number}>} */
  const records = new Map();

  function prune() {
    const current = now();
    for (const [key, record] of records) {
      if (current - record.firstAttempt > windowMs) records.delete(key);
    }
  }

  return {
    /** Counts an attempt; true when the key is over `max`. */
    hit(key, max) {
      prune();
      const record = records.get(key);
      if (!record) {
        records.set(key, { count: 1, firstAttempt: now() });
        return 1 > max;
      }
      record.count += 1;
      return record.count > max;
    },

    retryAfterSeconds(key) {
      const record = records.get(key);
      if (!record) return 1;
      const remainingMs = record.firstAttempt + windowMs - now();
      return Math.max(1, Math.ceil(remainingMs / 1000));
    },

    release(key) {
      const record = records.get(key);
      if (!record) return;
      record.count -= 1;
      if (record.count <= 0) records.delete(key);
    },

    clear(key) {
      records.delete(key);
    },
  };
}
