import fs from 'fs';
import Database from 'better-sqlite3';
import logger from '../logger.js';

const MULTI_USER_MIGRATION = '14.create-multi-user.js';

/**
 * One-time safety copy before the multi-user migration touches an existing database: `<db>.pre-multiuser.bak`
 * (a consistent snapshot made with VACUUM INTO, safe while the WAL is in use). Returns the backup path, or null when
 * nothing had to be done: in-memory or brand-new database, migration already applied, or a backup already exists
 * (the first one is never overwritten).
 *
 * @param {string} dbPath
 * @returns {string|null}
 */
export function backupBeforeMultiUser(dbPath) {
  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
  const backup = `${dbPath}.pre-multiuser.bak`;
  if (fs.existsSync(backup)) return null;

  const db = new Database(dbPath);
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!hasTable) return null; // never migrated: nothing worth saving
    const done = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(MULTI_USER_MIGRATION);
    if (done) return null;
    db.prepare('VACUUM INTO ?').run(backup);
  } finally {
    db.close();
  }
  logger.info(`Multi-user upgrade: backed up the database to ${backup} before migrating it.`);
  return backup;
}
