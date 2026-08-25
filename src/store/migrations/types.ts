import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  up(db: BetterSqliteDatabase): void;
}
