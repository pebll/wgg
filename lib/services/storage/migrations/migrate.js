import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Db from '../Db.js';
import logger from '../../logger.js';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql');

const FILE_PATTERN = /^(\d+)\.(.+)\.js$/;

/**
 * Lists the migration modules of a directory, ordered by their numeric prefix.
 * @param {string} [dir]
 * @returns {{id: number, name: string, label: string, path: string}[]}
 */
export function listMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];

  const found = [];
  for (const name of fs.readdirSync(dir)) {
    const match = FILE_PATTERN.exec(name);
    if (match) found.push({ id: Number(match[1]), name, label: match[2], path: path.join(dir, name) });
  }
  return found.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
}

async function loadUp(file) {
  const mod = await import(pathToFileURL(file).href);
  const up = typeof mod.up === 'function' ? mod.up : mod.default;
  if (typeof up !== 'function') {
    throw new Error(`Migration ${path.basename(file)} must export up(db) or a default function.`);
  }
  return up;
}

/**
 * Applies every pending migration exactly once. Each one runs in its own transaction together with its
 * bookkeeping row, so a failure leaves no trace of it.
 */
export async function runMigrations({ dir = MIGRATIONS_DIR } = {}) {
  const db = Db.getConnection();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL
  )`);

  const recorded = new Map(
    db
      .prepare('SELECT name, checksum FROM schema_migrations')
      .all()
      .map((r) => [r.name, r.checksum]),
  );
  let applied = 0;

  for (const migration of listMigrationFiles(dir)) {
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(migration.path)).digest('hex');

    if (recorded.has(migration.name)) {
      if (recorded.get(migration.name) !== checksum) {
        logger.warn(`Migration ${migration.name} changed after it was applied; updating its stored checksum.`);
        db.prepare('UPDATE schema_migrations SET checksum = @checksum WHERE name = @name').run({
          checksum,
          name: migration.name,
        });
      }
      continue;
    }

    logger.info(`Applying migration: ${migration.name}`);
    const up = await loadUp(migration.path);
    const started = Date.now();
    try {
      db.transaction(() => {
        up(db);
        db.prepare(
          `INSERT INTO schema_migrations (name, checksum, applied_at, duration_ms)
           VALUES (@name, @checksum, datetime('now'), @duration)`,
        ).run({ name: migration.name, checksum, duration: Date.now() - started });
      })();
    } catch (error) {
      logger.error(`Migration ${migration.name} failed: ${error.message}`);
      throw new Error(`Migration failed and was rolled back: ${migration.name}`, { cause: error });
    }
    applied += 1;
    logger.info(`Migration applied: ${migration.name} (${Date.now() - started} ms)`);
  }

  Db.optimize();
  if (applied > 0) logger.info('All migrations completed successfully.');
}
