import Db from './Db.js';
import logger from '../logger.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function expiryOf(session, now) {
  const cookie = session?.cookie ?? {};
  if (cookie.expires != null) {
    const at = new Date(cookie.expires).getTime();
    if (Number.isFinite(at)) return at;
  }
  for (const candidate of [cookie.originalMaxAge, cookie.maxAge]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return now + candidate;
  }
  return now + THIRTY_DAYS_MS;
}

// @fastify/session expects its callbacks to fire asynchronously.
const later = (fn) => queueMicrotask(fn);

/** Session store for @fastify/session, persisted in the `sessions` table. */
export class SqliteSessionStore {
  set(sessionId, session, callback) {
    try {
      Db.execute(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (@sid, @data, @expiresAt)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
        { sid: sessionId, data: JSON.stringify(session), expiresAt: expiryOf(session, Date.now()) },
      );
      later(() => callback());
    } catch (error) {
      logger.error(`Could not save session: ${error.message}`);
      later(() => callback(error));
    }
  }

  get(sessionId, callback) {
    try {
      const [row] = Db.query('SELECT data, expires_at FROM sessions WHERE sid = @sid', {
        sid: sessionId,
      });
      if (!row) return later(() => callback(null, null));
      if (row.expires_at <= Date.now()) {
        Db.execute('DELETE FROM sessions WHERE sid = @sid', { sid: sessionId });
        return later(() => callback(null, null));
      }
      const session = JSON.parse(row.data);
      later(() => callback(null, session));
    } catch (error) {
      logger.error(`Could not load session: ${error.message}`);
      later(() => callback(error));
    }
  }

  destroy(sessionId, callback) {
    try {
      Db.execute('DELETE FROM sessions WHERE sid = @sid', { sid: sessionId });
      later(() => callback());
    } catch (error) {
      logger.error(`Could not delete session: ${error.message}`);
      later(() => callback(error));
    }
  }
}

/** Removes every expired session row; returns how many were removed (0 on failure). */
export function sweepExpiredSessions(now = Date.now()) {
  try {
    return Db.execute('DELETE FROM sessions WHERE expires_at <= @now', { now }).changes;
  } catch (error) {
    logger.warn(`Could not sweep expired sessions: ${error.message}`);
    return 0;
  }
}
