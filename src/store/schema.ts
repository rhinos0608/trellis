/**
 * Re-export migration-based schema management.
 * The old DDL / __schema_version convention is gone.
 * schema_migrations is the sole source of schema-version truth.
 */

export { initializeSchema, SCHEMA_VERSION } from './migrations/index.js';
