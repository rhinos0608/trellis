/**
 * `trellis export <events.jsonl>` — export the event log as newline-delimited JSON.
 *
 * Streams under one read transaction in seq ASC order, writing through a
 * temporary sibling file. Atomic rename only on full success.
 */

import { existsSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SCHEMA_VERSION } from '../../store/migrations/index.js';
import type { EventRow } from '../../store/index.js';
import { requireCliRuntime, type CommandContext } from '../runtime.js';
import { UsageError, printResult, EXIT_CODES } from '../output.js';
import { TRELLIS_VERSION } from '../../version.js';

/** Error class for destination-already-exists — maps to exit code 4. */
export class ExportDestinationExistsError extends Error {
  readonly code = 'DESTINATION_EXISTS';
  constructor(message: string) {
    super(message);
    this.name = 'ExportDestinationExistsError';
  }
}

export async function runExport(ctx: CommandContext): Promise<number> {
  const destArg = ctx.positionals[0];
  if (destArg === undefined || ctx.positionals.length > 1) {
    throw new UsageError('Usage: trellis export <events.jsonl>');
  }

  const destPath = path.resolve(destArg);

  // 1. Refuse if destination exists
  if (existsSync(destPath)) {
    throw new ExportDestinationExistsError(`Destination already exists: ${destPath}`);
  }

  // 2. Create sibling temporary file
  const parentDir = path.dirname(destPath);
  const tempName = `.trellis-export-${String(Date.now())}-${crypto.randomUUID().slice(0, 8)}.jsonl`;
  const tempPath = path.join(parentDir, tempName);

  // 3. Stream events under one read snapshot
  const db = requireCliRuntime(ctx).db;

  // Use a read transaction to get a consistent snapshot
  const consistentRows = db.transaction(() => {
    return db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as EventRow[];
  })();
  const latestSeq = consistentRows.at(-1)?.seq ?? 0;

  const footerHash = crypto.createHash('sha256');

  try {
    const fd = createWriteStream(tempPath, { encoding: 'utf8' });

    // Header line
    const header = JSON.stringify({
      recordType: 'header',
      format: 'trellis-event-log',
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      trellisVersion: TRELLIS_VERSION,
      schemaVersion: SCHEMA_VERSION,
    });
    fd.write(header + '\n');
    footerHash.update(header);
    footerHash.update('\n');

    // Event lines — payloadJson is the RAW stored string, never re-parsed
    for (const row of consistentRows) {
      const eventLine = JSON.stringify({
        recordType: 'event',
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
        payloadJson: row.payload,
        payloadHash: row.payload_hash,
      });
      fd.write(eventLine + '\n');
      footerHash.update(eventLine);
      footerHash.update('\n');
    }

    // Footer
    const archiveSha256 = footerHash.digest('hex');
    const footer = JSON.stringify({
      recordType: 'footer',
      eventCount: consistentRows.length,
      latestSeq,
      archiveSha256,
    });
    fd.write(footer + '\n');

    // Close and wait for flush
    await new Promise<void>((resolve, reject) => {
      fd.on('finish', resolve);
      fd.on('error', reject);
      fd.end();
    });

    // 4. Atomic rename
    renameSync(tempPath, destPath);

    // Success
    const data = {
      output: destPath,
      format: 'trellis-event-log',
      formatVersion: 1,
      eventCount: consistentRows.length,
      latestSeq,
      archiveSha256,
    };

    printResult(ctx.io, data, 'export');
    return EXIT_CODES.OK;
  } catch (err) {
    // Cleanup temp file on failure
    try { rmSync(tempPath, { force: true }); } catch { /* best-effort: ignore cleanup errors */ }
    throw err;
  }
}
