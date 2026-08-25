/**
 * Trellis event-store database — singleton lazy-init SQLite via better-sqlite3.
 * Schema management delegated to schema.ts.
 */

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { logger } from '../logger.js';
import { loadConfig } from '../config/index.js';
import { initializeSchema } from './schema.js';

let _db: BetterSqliteDatabase | null = null;
let _dbPath: string | null = null;

function ensureDir(filePath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return true;
  } catch (err) {
    logger.warn({ err, filePath }, 'store: failed to create database directory');
    return false;
  }
}

function openDb(
  databasePath: string,
  options: { readonly?: boolean } = {},
): BetterSqliteDatabase | null {
  try {
    // Read-only open: no directory creation, no pragmas that write, no
    // schema initialization — used by `doctor`/`verify` so inspection can
    // never mutate the store.
    if (options.readonly === true) {
      _dbPath = databasePath;
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      _db = db;
      logger.info({ databasePath }, 'store: database opened (read-only)');
      return db;
    }

    if (!ensureDir(databasePath)) return null;

    _dbPath = databasePath;
    const db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    initializeSchema(db);
    _db = db;
    logger.info({ databasePath }, 'store: database opened');
    return db;
  } catch (err) {
    logger.warn({ err, databasePath }, 'store: failed to open database');
    return null;
  }
}

/**
 * Open DB at the path from config().storage.dbPath.
 * Call once at server startup.
 *
 * `options.readonly` opens the file with better-sqlite3's `readonly: true`
 * constructor option and skips initializeSchema — any write attempt then
 * fails at the SQLite layer instead of silently mutating the store.
 */
export function initDb(
  databasePath?: string,
  options: { readonly?: boolean } = {},
): BetterSqliteDatabase | null {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
  const dbPath = databasePath ?? loadConfig().storage.dbPath;
  return openDb(dbPath, options);
}

/** Get singleton handle, lazy-init from config on first call. */
export function getDb(): BetterSqliteDatabase | null {
  if (_db !== null) return _db;
  return initDb();
}

/** Close gracefully. Safe to call multiple times. */
export function closeDb(): void {
  try {
    if (_db !== null) {
      _db.close();
      _db = null;
      _dbPath = null;
      logger.info('store: database closed');
    }
  } catch (err) {
    logger.warn({ err }, 'store: error closing database');
  }
}

export function getDbPath(): string | null {
  return _dbPath;
}
