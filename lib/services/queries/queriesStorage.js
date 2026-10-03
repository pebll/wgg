import Db from '../storage/Db.js';

const toApi = (row) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
});

/**
 * Adds a search query for a user. A user cannot have the same URL twice.
 * @param {string} userId
 * @param {{name?: string, url: string, enabled?: boolean}} query
 * @param {number} [now]
 * @returns {ReturnType<typeof toApi>|null} The new query, or null when the user already has that URL.
 */
export function addUserQuery(userId, { name = '', url, enabled = true }, now = Date.now()) {
  const info = Db.execute(
    `INSERT OR IGNORE INTO user_queries (user_id, name, url, enabled, created_at)
     VALUES (@userId, @name, @url, @enabled, @now)`,
    { userId, name, url, enabled: enabled ? 1 : 0, now },
  );
  if (info.changes !== 1) return null;
  return getUserQuery(userId, Number(info.lastInsertRowid));
}

/** @returns {ReturnType<typeof toApi>|null} One of the user's queries (never another user's). */
export function getUserQuery(userId, id) {
  const row = Db.query('SELECT * FROM user_queries WHERE user_id = @userId AND id = @id', {
    userId,
    id,
  })[0];
  return row ? toApi(row) : null;
}

/** @returns {ReturnType<typeof toApi>[]} The user's queries, oldest first. */
export function listUserQueries(userId) {
  return Db.query('SELECT * FROM user_queries WHERE user_id = @userId ORDER BY id ASC', { userId }).map(toApi);
}

/** The user already has a query for that URL. */
export class DuplicateQueryError extends Error {
  constructor() {
    super('You already have a query with this URL.');
    this.name = 'DuplicateQueryError';
  }
}

/**
 * Changes a user's own query (any of name, url, enabled).
 * @returns {ReturnType<typeof toApi>|null} The updated query; null when the user has no such query.
 * @throws {DuplicateQueryError} when the new URL is another query of the same user.
 */
export function updateUserQuery(userId, id, { name, url, enabled }) {
  return Db.withTransaction((db) => {
    const current = db.prepare('SELECT * FROM user_queries WHERE user_id = @userId AND id = @id').get({ userId, id });
    if (!current) return null;
    const next = {
      name: name ?? current.name,
      url: url ?? current.url,
      enabled: enabled === undefined ? current.enabled : enabled ? 1 : 0,
    };
    if (
      next.url !== current.url &&
      db.prepare('SELECT 1 FROM user_queries WHERE user_id = @userId AND url = @url AND id <> @id').get({
        userId,
        url: next.url,
        id,
      })
    ) {
      throw new DuplicateQueryError();
    }
    db.prepare(
      'UPDATE user_queries SET name = @name, url = @url, enabled = @enabled WHERE user_id = @userId AND id = @id',
    ).run({
      ...next,
      userId,
      id,
    });
    return toApi(db.prepare('SELECT * FROM user_queries WHERE id = ?').get(id));
  });
}

/** Deletes a user's own query. @returns {boolean} false when the user has no such query. */
export function deleteUserQuery(userId, id) {
  return Db.execute('DELETE FROM user_queries WHERE user_id = @userId AND id = @id', { userId, id }).changes === 1;
}

export function countUserQueries(userId) {
  return Db.query('SELECT COUNT(*) AS n FROM user_queries WHERE user_id = @userId', { userId })[0].n;
}

/**
 * The searches to fetch: the DISTINCT URLs of all users' enabled queries (two users with the same search cost one
 * request), oldest first, named after the first query that has the URL.
 * @returns {{name: string, url: string}[]}
 */
export function listEnabledSearches() {
  return Db.query(
    `SELECT url, name FROM user_queries WHERE enabled = 1 AND id IN (
       SELECT MIN(id) FROM user_queries WHERE enabled = 1 GROUP BY url) ORDER BY id ASC`,
  ).map((row) => ({ name: row.name || row.url, url: row.url }));
}

/** Records that a search URL was fetched now (also after a failed attempt: it had its turn). */
export function markQueryFetched(url, now = Date.now()) {
  Db.execute(
    `INSERT INTO query_fetches (url, fetched_at) VALUES (@url, @now)
     ON CONFLICT(url) DO UPDATE SET fetched_at = @now`,
    { url, now },
  );
}

/**
 * The searches for one cycle: the distinct enabled URLs, never fetched or fetched longest ago first (ties: oldest query
 * first), at most `max` of them, so many users can never multiply the requests to WG-Gesucht per cycle. The rest waits
 * for the next cycles.
 * @param {number} max
 * @returns {{searches: {name: string, url: string}[], skipped: number}}
 */
export function selectSearchesForCycle(max) {
  const all = Db.query(
    `SELECT q.url AS url, q.name AS name FROM user_queries q
     LEFT JOIN query_fetches f ON f.url = q.url
     WHERE q.enabled = 1 AND q.id IN (SELECT MIN(id) FROM user_queries WHERE enabled = 1 GROUP BY url)
     ORDER BY COALESCE(f.fetched_at, 0) ASC, q.id ASC`,
  ).map((row) => ({ name: row.name || row.url, url: row.url }));
  return { searches: all.slice(0, max), skipped: Math.max(0, all.length - max) };
}
