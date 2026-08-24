/**
 * Projection checkpoint management.
 * Checkpoints allow incremental rebuilds: start from latest compatible
 * checkpoint, process only events after its cursor.
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { getDb } from './db.js';
import { SCHEMA_VERSION } from './schema.js';

export const CURRENT_PROJECTION_VERSION = 1;

export interface ProjectionCheckpoint {
  id: string;
  createdAt: string;
  eventCursor: string;
  projectionVersion: number;
  schemaVersion: number;
  eventCount: number;
  checksum: string;
  compatible: boolean;
}

const INSERT_CHECKPOINT_SQL = `
  INSERT INTO projection_checkpoints
    (id, created_at, event_cursor, projection_version, schema_version,
     event_count, checksum, compatible)
  VALUES
    (@id, @createdAt, @eventCursor, @projectionVersion, @schemaVersion,
     @eventCount, @checksum, @compatible)
`;

const LATEST_COMPATIBLE_SQL = `
  SELECT * FROM projection_checkpoints
  WHERE compatible = 1 AND projection_version = @projectionVersion
  ORDER BY created_at DESC
  LIMIT 1
`;

function rowToCheckpoint(row: Record<string, unknown>): ProjectionCheckpoint {
  return {
    id: row.id as string,
    createdAt: row.created_at as string,
    eventCursor: row.event_cursor as string,
    projectionVersion: Number(row.projection_version),
    schemaVersion: Number(row.schema_version),
    eventCount: Number(row.event_count),
    checksum: row.checksum as string,
    compatible: Boolean(row.compatible),
  };
}

/**
 * Compute a deterministic checksum of the current projection.
 * sha256(sorted entity ids + '|' + sorted claim ids) — mirrors
 * search-mcp's sha256(sorted_node_ids + '|' + sorted_edge_ids).
 */
export function computeProjectionChecksum(state: {
  entities: Map<string, { id: string }>;
  claims: Map<string, { id: string }>;
}): string {
  const entityIds = JSON.stringify([...state.entities.keys()].sort());
  const claimIds = JSON.stringify([...state.claims.keys()].sort());
  const hash = crypto.createHash('sha256');
  hash.update(entityIds);
  hash.update('|');
  hash.update(claimIds);
  return hash.digest('hex');
}

export function createCheckpoint(
  eventCursor: string,
  eventCount: number,
  checksum: string,
): ProjectionCheckpoint | null {
  const db = getDb();
  if (db === null) {
    logger.warn('store: createCheckpoint called before database initialised');
    return null;
  }

  try {
    const now = new Date().toISOString();
    const row = {
      id: `${now}-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: now,
      eventCursor,
      projectionVersion: CURRENT_PROJECTION_VERSION,
      schemaVersion: SCHEMA_VERSION,
      eventCount,
      checksum,
      compatible: 1,
    };

    db.prepare(INSERT_CHECKPOINT_SQL).run(row);

    return {
      id: row.id,
      createdAt: row.createdAt,
      eventCursor: row.eventCursor,
      projectionVersion: row.projectionVersion,
      schemaVersion: row.schemaVersion,
      eventCount: row.eventCount,
      checksum: row.checksum,
      compatible: true,
    };
  } catch (err) {
    logger.warn({ err, eventCursor }, 'store: createCheckpoint failed');
    return null;
  }
}

export function getLatestCompatibleCheckpoint(
  projectionVersion: number,
): ProjectionCheckpoint | null {
  const db = getDb();
  if (db === null) return null;

  try {
    const row = db.prepare(LATEST_COMPATIBLE_SQL).get({
      projectionVersion,
    }) as Record<string, unknown> | undefined;

    if (row === undefined) return null;
    return rowToCheckpoint(row);
  } catch (err) {
    logger.warn({ err, projectionVersion }, 'store: getLatestCompatibleCheckpoint failed');
    return null;
  }
}

export function invalidateAllCheckpoints(): void {
  const db = getDb();
  if (db === null) return;

  try {
    db.prepare('UPDATE projection_checkpoints SET compatible = 0 WHERE id != ?').run('__schema_version');
    logger.info('store: all projection checkpoints invalidated');
  } catch (err) {
    logger.warn({ err }, 'store: invalidateAllCheckpoints failed');
  }
}
