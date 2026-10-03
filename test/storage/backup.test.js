import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations } from '../../lib/services/storage/migrations/migrate.js';
import { backupBeforeMultiUser } from '../../lib/services/storage/backup.js';

let dir;
afterEach(() => {
  Db.reset();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('#backupBeforeMultiUser', () => {
  it('copies a database that has not got the multi-user migration yet, once', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-backup-'));
    const file = path.join(dir, 'wgg.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('13.create-sessions.js');
             CREATE TABLE listings (id INTEGER); INSERT INTO listings VALUES (1), (2);`);
    db.close();

    const backup = backupBeforeMultiUser(file);
    expect(backup).toBe(`${file}.pre-multiuser.bak`);
    const copy = new Database(backup, { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM listings').get().n).toBe(2);
    copy.close();

    // a second start never overwrites the first backup
    expect(backupBeforeMultiUser(file)).toBeNull();
  });

  it('does nothing for a new database, an in-memory one or one that is already migrated', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-backup-'));
    expect(backupBeforeMultiUser(':memory:')).toBeNull();
    expect(backupBeforeMultiUser(path.join(dir, 'new.db'))).toBeNull();
    expect(fs.existsSync(path.join(dir, 'new.db'))).toBe(false); // it did not even create the file

    const file = path.join(dir, 'done.db');
    const db = new Database(file);
    db.exec(
      `CREATE TABLE schema_migrations (name TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('14.create-multi-user.js');`,
    );
    db.close();
    expect(backupBeforeMultiUser(file)).toBeNull();
    expect(fs.existsSync(`${file}.pre-multiuser.bak`)).toBe(false);
  });

  it('is not needed for a real migration run: the runner applies 14 to a file the backup left readable', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-backup-'));
    const file = path.join(dir, 'wgg.db');
    Db.init(file);
    await runMigrations();
    expect(backupBeforeMultiUser(file)).toBeNull();
    Db.reset();
  });
});
