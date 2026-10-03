import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Db from '../../lib/services/storage/Db.js';
import { runMigrations, listMigrationFiles } from '../../lib/services/storage/migrations/migrate.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-mig-'));
  Db.close();
  Db.init(':memory:');
});

afterEach(() => {
  Db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeMigration = (name, sql) =>
  fs.writeFileSync(path.join(dir, name), `export function up(db) { db.exec(${JSON.stringify(sql)}); }\n`);

describe('#Db', () => {
  it('opens an in-memory db and runs queries', () => {
    Db.execute('CREATE TABLE t (a INTEGER)');
    Db.execute('INSERT INTO t (a) VALUES (@a)', { a: 3 });
    expect(Db.query('SELECT a FROM t')).toEqual([{ a: 3 }]);
    expect(Db.tableExists('t')).toBe(true);
    expect(Db.tableExists('nope')).toBe(false);
  });

  it('creates the parent directory of a file db', () => {
    const file = path.join(dir, 'nested', 'x.db');
    Db.close();
    Db.init(file);
    Db.getConnection();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('throws when used before init', () => {
    Db.close();
    Db.reset();
    expect(() => Db.getConnection()).toThrow(/init/);
  });
});

describe('#migrations', () => {
  it('lists migration files in numeric order', () => {
    writeMigration('10.b.js', 'SELECT 1');
    writeMigration('2.a.js', 'SELECT 1');
    expect(listMigrationFiles(dir).map((m) => m.name)).toEqual(['2.a.js', '10.b.js']);
  });

  it('applies pending migrations once and records them', async () => {
    writeMigration('1.create-a.js', 'CREATE TABLE a (id INTEGER)');
    writeMigration('2.create-b.js', 'CREATE TABLE b (id INTEGER)');
    await runMigrations({ dir });
    await runMigrations({ dir }); // idempotent
    expect(Db.tableExists('a')).toBe(true);
    expect(Db.tableExists('b')).toBe(true);
    expect(Db.query('SELECT name FROM schema_migrations ORDER BY name').length).toBe(2);
  });

  it('rolls back a failing migration and throws', async () => {
    writeMigration('1.ok.js', 'CREATE TABLE a (id INTEGER)');
    writeMigration('2.bad.js', 'CREATE TABLE c (id INTEGER); THIS IS NOT SQL');
    await expect(runMigrations({ dir })).rejects.toThrow(/2\.bad\.js/);
    expect(Db.tableExists('a')).toBe(true);
    expect(Db.tableExists('c')).toBe(false);
  });
});

describe('#migration 18 (alert tier)', () => {
  it('adds user_listings.tier (NULL until computed)', async () => {
    await runMigrations();
    const cols = Db.query('PRAGMA table_info(user_listings)').map((c) => c.name);
    expect(cols).toContain('tier');
  });
});
