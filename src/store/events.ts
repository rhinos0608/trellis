/**
 * Event store — append-only events operations.
 * Events are the single source of truth. No updates, no deletes.
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { getDb } from './db.js';
import type { EventEnvelope, TrellisEventType } from './eventTypes.js';

// ── ULID generation ─────────────────────────────────────────────────

let _lastUlidTs = 0;
let _ulidCounter = 0;

/**
 * Chronologically-sortable ID: base36 timestamp + 16 hex chars + monotonic counter.
 * Pure JS, no native ULID dependency.
 */
export function generateUlid(): string {
  const now = Date.now();
  if (now === _lastUlidTs) {
    _ulidCounter++;
  } else {
    _lastUlidTs = now;
    _ulidCounter = 0;
  }
  const ts = now.toString(36);
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${ts}-${rand}-${String(_ulidCounter).padStart(3, '0')}`;
}

// ── Payload hash ────────────────────────────────────────────────────

function hashPayload(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── DB row shape ────────────────────────────────────────────────────

interface EventRow {
  id: string;
  timestamp: string;
  event_type: string;
  event_version: number;
  run_id: string;
  batch_id: string | null;
  actor: string;
  entity_id: string | null;
  entity_type: string | null;
  payload: string;
  payload_hash: string | null;
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.event_type as TrellisEventType,
    eventVersion: row.event_version,
    runId: row.run_id,
    batchId: row.batch_id,
    actor: row.actor as EventEnvelope['actor'],
    entityId: row.entity_id,
    entityType: row.entity_type,
    payload: JSON.parse(row.payload) as unknown,
    payloadHash: row.payload_hash,
  };
}

// ── Append ──────────────────────────────────────────────────────────

export type NewEventInput = Omit<EventEnvelope, 'id' | 'payloadHash'>;

const INSERT_SQL = `
  INSERT INTO events (id, timestamp, event_type, event_version, run_id, batch_id,
    actor, entity_id, entity_type, payload, payload_hash)
  VALUES (@id, @timestamp, @eventType, @eventVersion, @runId, @batchId,
    @actor, @entityId, @entityType, @payload, @payloadHash)
`;

/** Append multiple events in a single transaction. Returns fully-populated envelopes. */
export function appendEvents(events: NewEventInput[]): EventEnvelope[] {
  const db = getDb();
  if (db === null) {
    logger.warn('store: appendEvents called before database initialised');
    return [];
  }

  try {
    const insert = db.prepare(INSERT_SQL);
    const result: EventEnvelope[] = [];

    const txn = db.transaction(() => {
      for (const ev of events) {
        const id = generateUlid();
        const payloadStr = JSON.stringify(ev.payload);
        const payloadHash = hashPayload(payloadStr);

        insert.run({
          id,
          timestamp: ev.timestamp,
          eventType: ev.eventType,
          eventVersion: ev.eventVersion,
          runId: ev.runId,
          batchId: ev.batchId,
          actor: ev.actor,
          entityId: ev.entityId,
          entityType: ev.entityType,
          payload: payloadStr,
          payloadHash,
        });

        result.push({
          id,
          timestamp: ev.timestamp,
          eventType: ev.eventType,
          eventVersion: ev.eventVersion,
          runId: ev.runId,
          batchId: ev.batchId,
          actor: ev.actor,
          entityId: ev.entityId,
          entityType: ev.entityType,
          payload: ev.payload,
          payloadHash,
        });
      }
    });

    txn();
    return result;
  } catch (err) {
    logger.error({ err, count: events.length }, 'store: appendEvents failed');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Append a single event. Convenience wrapper. */
export function appendEvent(event: NewEventInput): EventEnvelope | null {
  const results = appendEvents([event]);
  return results[0] ?? null;
}

// ── Query ───────────────────────────────────────────────────────────

export interface QueryEventsOpts {
  runId?: string;
  eventType?: TrellisEventType;
  entityId?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}

const QUERY_BASE = 'SELECT * FROM events WHERE 1=1';
const QUERY_ORDER = 'ORDER BY timestamp ASC, id ASC';

/**
 * Query events with optional filters.
 * Cursor is the `id` of the last event in the previous page.
 * `since` is a timestamp (ISO string) — events with timestamp >= since.
 */
export function queryEvents(opts: QueryEventsOpts = {}): EventEnvelope[] {
  const db = getDb();
  if (db === null) {
    logger.warn('store: queryEvents called before database initialised');
    return [];
  }

  try {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.runId !== undefined) {
      clauses.push('run_id = @runId');
      params.runId = opts.runId;
    }
    if (opts.eventType !== undefined) {
      clauses.push('event_type = @eventType');
      params.eventType = opts.eventType;
    }
    if (opts.entityId !== undefined) {
      clauses.push('entity_id = @entityId');
      params.entityId = opts.entityId;
    }
    if (opts.since !== undefined) {
      clauses.push('timestamp >= @since');
      params.since = opts.since;
    }
    if (opts.cursor !== undefined) {
      clauses.push('id > @cursor');
      params.cursor = opts.cursor;
    }

    const where = clauses.length > 0 ? ' AND ' + clauses.join(' AND ') : '';
    let limit = '';
    if (opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0) {
      limit = ` LIMIT ${String(opts.limit)}`;
    }

    const sql = `${QUERY_BASE}${where} ${QUERY_ORDER}${limit}`;
    const rows = db.prepare(sql).all(params) as EventRow[];
    return rows.map(rowToEnvelope);
  } catch (err) {
    logger.error({ err, opts }, 'store: queryEvents failed');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ── Utilities ───────────────────────────────────────────────────────

export function getLatestEventCursor(): string | null {
  const db = getDb();
  if (db === null) return null;
  const row = db
    .prepare('SELECT id FROM events ORDER BY timestamp DESC, id DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function countEvents(): number {
  const db = getDb();
  if (db === null) return 0;
  const row = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}
