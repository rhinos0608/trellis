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

function openDb(databasePath: string): BetterSqliteDatabase | null {
  try {
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
 */
export function initDb(databasePath?: string): BetterSqliteDatabase | null {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
  const dbPath = databasePath ?? loadConfig().storage.dbPath;
  return openDb(dbPath);
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
