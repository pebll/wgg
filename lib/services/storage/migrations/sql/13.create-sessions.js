/**
 * Login sessions (multi-user). One row per browser session: `sid` is the random session id (the cookie carries it signed
 * with SESSION_SECRET), `data` the JSON session payload (the username), `expires_at` epoch ms. Sessions live in the
 * database so a restart of wgg does not log everybody out; expired rows are deleted on read and on every login.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
  `);
}
