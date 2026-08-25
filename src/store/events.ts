/**
 * Event store — append-only events operations.
 * Events are the single source of truth. No updates, no deletes.
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { getDb } from './db.js';
import type { EventEnvelope, EventCursor, TrellisEventType } from './eventTypes.js';
import type { ProjectionState, EventHandlerRegistry } from './projectionState.js';
import { serializeProjectionState, deserializeProjectionState } from './projectionState.js';
import { EVENT_CODECS } from './eventSchemas/registry.js';
import { decodeEventPayload, validateEventReferences, validateProjectionReferences } from './eventValidation.js';
import { EventTypeUnknownError, EventVersionUnsupportedError, StaleProjectionError } from './eventErrors.js';

// ── ULID generation ─────────────────────────────────────────────────

let _lastUlidTs = 0;
let _ulidCounter = 0;

/**
 * Opaque, roughly-sortable external identifier.
 * No longer used for ordering — seq is the authoritative ordering primitive.
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

export function hashPayload(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ── DB row shape ────────────────────────────────────────────────────

export interface EventRow {
  seq: number;
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
  payload_hash: string;
}

export function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    seq: row.seq,
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

export type NewEventInput = Omit<EventEnvelope, 'seq' | 'id' | 'payloadHash'>;
export interface AppendContext { projection: ProjectionState; handlers: EventHandlerRegistry; }

const INSERT_SQL = `
  INSERT INTO events (id, timestamp, event_type, event_version, run_id, batch_id,
    actor, entity_id, entity_type, payload, payload_hash)
  VALUES (@id, @timestamp, @eventType, @eventVersion, @runId, @batchId,
    @actor, @entityId, @entityType, @payload, @payloadHash)
`;

/** Append multiple events in a single transaction. Returns fully-populated envelopes. */
export function appendEvents(events: readonly NewEventInput[], context: AppendContext): EventEnvelope[] {
  const db = getDb();
  if (db === null) {
    logger.warn('store: appendEvents called before database initialised');
    return [];
  }

  try {
    const working = deserializeProjectionState(serializeProjectionState(context.projection));
    const insert = db.prepare(INSERT_SQL);
    const result: EventEnvelope[] = [];

    const txn = db.transaction(() => {
      const latest = getLatestEventCursor();
      const expected = context.projection.lastAppliedSeq;
      if ((latest ?? 0) !== expected) throw new StaleProjectionError(expected, latest);

      for (const ev of events) {
        const codec = EVENT_CODECS[ev.eventType];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!codec) throw new EventTypeUnknownError(ev.eventType);
        if (ev.eventVersion !== codec.latestVersion) throw new EventVersionUnsupportedError(ev.eventType, ev.eventVersion, codec.latestVersion);
        const decoded = decodeEventPayload(ev.eventType, ev.eventVersion, ev.payload);
        validateEventReferences(ev.eventType, decoded.payload, working);
        const id = generateUlid();
        const payloadStr = JSON.stringify(decoded.payload);
        const payloadHash = hashPayload(payloadStr);

        const info = insert.run({
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

        const seq = Number(info.lastInsertRowid);

        result.push({
          seq,
          id,
          timestamp: ev.timestamp,
          eventType: ev.eventType,
          eventVersion: ev.eventVersion,
          runId: ev.runId,
          batchId: ev.batchId,
          actor: ev.actor,
          entityId: ev.entityId,
          entityType: ev.entityType,
          payload: decoded.payload,
          payloadHash,
        });
        const handler = context.handlers[ev.eventType];
        const inserted = result[result.length - 1];
        if (handler && inserted) handler(inserted, working);
        working.lastAppliedSeq = seq;
      }
      validateProjectionReferences(working);
    });

    txn.immediate();
    Object.assign(context.projection, deserializeProjectionState(serializeProjectionState(working)));
    return result;
  } catch (err) {
    logger.error({ err, count: events.length }, 'store: appendEvents failed');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Append a single event. Convenience wrapper. */
export function appendEvent(event: NewEventInput, context: AppendContext): EventEnvelope | null {
  const results = appendEvents([event], context);
  return results[0] ?? null;
}

// ── Query ───────────────────────────────────────────────────────────

export interface QueryEventsOpts {
  runId?: string;
  eventType?: TrellisEventType;
  entityId?: string;
  /** Pure timestamp filter (timestamp >= since). No ordering semantics. */
  since?: string;
  /** Cursor: only return events with seq > afterSeq. */
  afterSeq?: EventCursor;
  limit?: number;
}

const QUERY_BASE = 'SELECT * FROM events WHERE 1=1';
const QUERY_ORDER = 'ORDER BY seq ASC';

/**
 * Query events with optional filters.
 * Ordering is always by seq ASC (insertion order).
 * `afterSeq` filters to events appended after the given seq.
 * `since` is a timestamp filter only — it does not affect ordering.
 */
export function queryStoredRows(opts: QueryEventsOpts = {}): EventRow[] {
  const db = getDb();
  if (db === null) return [];
  const where = opts.afterSeq !== undefined ? ' WHERE seq > @afterSeq' : '';
  const rows = db.prepare(`SELECT * FROM events${where} ORDER BY seq ASC`).all(opts.afterSeq === undefined ? {} : { afterSeq: opts.afterSeq }) as EventRow[];
  return rows;
}

export function queryStoredEvents(opts: QueryEventsOpts = {}): { envelope: EventEnvelope; rawPayload: string }[] {
  return queryStoredRows(opts).map((row) => ({ envelope: rowToEnvelope(row), rawPayload: row.payload }));
}

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
    if (opts.afterSeq !== undefined) {
      clauses.push('seq > @afterSeq');
      params.afterSeq = opts.afterSeq;
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

export function getLatestEventCursor(): EventCursor | null {
  const db = getDb();
  if (db === null) return null;
  const row = db
    .prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1')
    .get() as { seq: number } | undefined;
  return row?.seq ?? null;
}

export function countEvents(): number {
  const db = getDb();
  if (db === null) return 0;
  const row = db.prepare('SELECT COUNT(*) as cnt FROM events').get() as
    | { cnt: number }
    | undefined;
  return row?.cnt ?? 0;
}
