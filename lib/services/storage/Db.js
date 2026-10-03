import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import logger from '../logger.js';

let dbPath = null;
let db = null;

function applyPragmas(conn) {
  try {
    conn.pragma('journal_mode = WAL');
    conn.pragma('synchronous = NORMAL');
    conn.pragma('foreign_keys = ON');
    conn.pragma('optimize');
  } catch (error) {
    logger.warn(`Could not apply SQLite pragmas: ${error.message}`);
  }
}

/** Process-wide handle to the SQLite database. Used through its static members only. */
export default class Db {
  static init(file) {
    if (db) {
      throw new Error('Db is already open: call close() before init() with another path.');
    }
    dbPath = file;
  }

  static reset() {
    Db.close();
    dbPath = null;
  }

  static getConnection() {
    if (db) return db;
    if (dbPath === null) {
      throw new Error('Db not configured: call Db.init(dbPath) first.');
    }
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const conn = new Database(dbPath);
    applyPragmas(conn);
    db = conn;
    return db;
  }

  static execute(sql, params = {}) {
    return Db.getConnection().prepare(sql).run(params);
  }

  static query(sql, params = {}) {
    return Db.getConnection().prepare(sql).all(params);
  }

  static tableExists(name) {
    const row = Db.getConnection()
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = @name")
      .get({ name });
    return Boolean(row);
  }

  static withTransaction(callback) {
    const conn = Db.getConnection();
    return conn.transaction(() => callback(conn))();
  }

  static optimize() {
    try {
      Db.getConnection().pragma('optimize');
    } catch (error) {
      logger.warn(`PRAGMA optimize failed: ${error.message}`);
    }
  }

  static close() {
    if (!db) return;
    try {
      db.pragma('optimize');
    } catch (error) {
      logger.debug(`PRAGMA optimize before close failed: ${error.message}`);
    }
    db.close();
    db = null;
  }
}
