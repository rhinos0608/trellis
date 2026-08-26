/**
 * Canonical event-row digest — deterministic SHA-256 over event rows in seq
 * order. Shared by backup, export, and validation to ensure consistent
 * cross-command verification.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { EventRow } from './events.js';

/**
 * Canonical byte representation of one event row for digest purposes.
 * Includes raw `payload` string and `payload_hash` — the digest covers
 * exactly the bytes a restore/verify would check.
 *
 * Fixed-key canonical JSON, no whitespace, deterministic field order.
 */
export function canonicalEventRow(row: EventRow): string {
  return JSON.stringify({
    seq: row.seq,
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.event_type,
    eventVersion: row.event_version,
    runId: row.run_id,
    batchId: row.batch_id,
    actor: row.actor,
    actorId: row.actor_id,
    entityId: row.entity_id,
    entityType: row.entity_type,
    payload: row.payload,
    payloadHash: row.payload_hash,
  });
}

/**
 * Streaming SHA-256 digest over canonical event rows in seq ASC order.
 * Returns hex string.
 */
export function computeEventLogDigest(rows: readonly EventRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(canonicalEventRow(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * SHA-256 hex digest of a file on disk. Rejects if file cannot be read.
 */
export async function computeFileSha256(filePath: string): Promise<string> {

  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => { resolve(hash.digest('hex')); });
    stream.on('error', reject);
  });
}
