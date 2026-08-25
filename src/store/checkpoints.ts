/**
 * Projection checkpoint management.
 * Checkpoints allow incremental rebuilds: start from latest compatible
 * checkpoint, process only events after its cursor.
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { getDb } from './db.js';
import { SCHEMA_VERSION } from './schema.js';
import type { EventCursor } from './eventTypes.js';
import type { ProjectionState } from './projectionState.js';
import { canonicalSerializeProjectionState } from './projectionState.js';

// v5: Phase 9 Stage 1 — Claim/ClaimObservation gain optional curation lifecycle
// fields (curationStatus, mergedIntoClaimId, splitIntoClaimIds, lastCuration);
// five curation event types added. Conventions: v3 Phase 2 (claim codecs),
// v4 Phase 3.
export const CURRENT_PROJECTION_VERSION = 5;

export interface ProjectionCheckpoint {
  id: string;
  createdAt: string;
  eventCursor: EventCursor;
  projectionVersion: number;
  schemaVersion: number;
  eventCount: number;
  checksum: string;
  compatible: boolean;
  snapshotJson?: string;
  rolledBackRunIds?: string[];
}

const INSERT_CHECKPOINT_SQL = `
  INSERT INTO projection_checkpoints
    (id, created_at, event_cursor, projection_version, schema_version,
     event_count, checksum, compatible, snapshot_json, rolled_back_run_ids)
  VALUES
    (@id, @createdAt, @eventCursor, @projectionVersion, @schemaVersion,
     @eventCount, @checksum, @compatible, @snapshotJson, @rolledBackRunIds)
`;

const LATEST_COMPATIBLE_SQL = `
  SELECT * FROM projection_checkpoints
  WHERE compatible = 1 AND projection_version = @projectionVersion
  ORDER BY event_cursor DESC, created_at DESC, id DESC
  LIMIT 1
`;

function rowToCheckpoint(row: Record<string, unknown>): ProjectionCheckpoint {
  const cp: ProjectionCheckpoint = {
    id: row.id as string,
    createdAt: row.created_at as string,
    eventCursor: Number(row.event_cursor),
    projectionVersion: Number(row.projection_version),
    schemaVersion: Number(row.schema_version),
    eventCount: Number(row.event_count),
    checksum: row.checksum as string,
    compatible: Boolean(row.compatible),
  };
  if (row.snapshot_json != null && row.snapshot_json !== '') {
    cp.snapshotJson = row.snapshot_json as string;
  }
  if (row.rolled_back_run_ids != null && row.rolled_back_run_ids !== '') {
    cp.rolledBackRunIds = JSON.parse(row.rolled_back_run_ids as string) as string[];
  }
  return cp;
}

export const PROJECTION_CHECKSUM_VERSION = 1;

/**
 * Compute a deterministic checksum of the entire projection state.
 * Uses canonical serialization (sorted Maps/Sets, sorted object keys)
 * so identical logical state always produces the same hash regardless
 * of Map/Set insertion order.
 */
export function computeProjectionChecksum(state: ProjectionState): string {
  const canonical = canonicalSerializeProjectionState(state);
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256:projection-v${String(PROJECTION_CHECKSUM_VERSION)}:${digest}`;
}

export function createCheckpoint(
  eventCursor: EventCursor,
  eventCount: number,
  checksum: string,
  snapshotJson?: string,
  rolledBackRunIds?: string[],
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
      snapshotJson: snapshotJson ?? null,
      rolledBackRunIds: rolledBackRunIds !== undefined ? JSON.stringify(rolledBackRunIds) : null,
    };

    db.prepare(INSERT_CHECKPOINT_SQL).run(row);

    const cp: ProjectionCheckpoint = {
      id: row.id,
      createdAt: row.createdAt,
      eventCursor: row.eventCursor,
      projectionVersion: row.projectionVersion,
      schemaVersion: row.schemaVersion,
      eventCount: row.eventCount,
      checksum: row.checksum,
      compatible: true,
    };
    if (snapshotJson !== undefined) cp.snapshotJson = snapshotJson;
    if (rolledBackRunIds !== undefined) cp.rolledBackRunIds = rolledBackRunIds;
    return cp;
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
    db.prepare('UPDATE projection_checkpoints SET compatible = 0').run();
    logger.info('store: all projection checkpoints invalidated');
  } catch (err) {
    logger.warn({ err }, 'store: invalidateAllCheckpoints failed');
  }
}
