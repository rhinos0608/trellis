import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDb,
  closeDb,
  appendEvents as appendEventsStore,
  rebuildProjection,
  rollbackRun,
  computeProjectionChecksum,
  getLatestCompatibleCheckpoint,
  createEmptyProjectionState,
  CURRENT_PROJECTION_VERSION,
} from '../../src/store/index.js';
import type { EventEnvelope, TrellisEventType } from '../../src/store/eventTypes.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import type { NewEventInput } from '../../src/store/events.js';

// ── Test helpers ────────────────────────────────────────────────────

let tmpDir: string;

function makeEvent(
  overrides: Partial<NewEventInput> & { eventType: TrellisEventType },
): NewEventInput {
  return {
    timestamp: new Date().toISOString(),
    eventVersion: 1,
    runId: 'run-test',
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload: {},
    ...overrides,
    ...(overrides.eventType === 'NODE_ADDED' ? {
      payload: {
        id: 'node', label: 'node', canonicalLabel: null, entityType: 'unknown', aliases: [],
        extractionConfidence: null, firstSeenRunId: overrides.runId ?? 'run-test', lastUpdatedRunId: overrides.runId ?? 'run-test', metadata: {},
        ...(overrides.payload as Record<string, unknown>),
      },
    } : {}),
  };
}

// Minimal NODE_ADDED handler — stores into state.entities
const nodeAddedHandler = (event: EventEnvelope, state: import('../../src/store/projectionState.js').ProjectionState) => {
  const p = event.payload as { id: string; label: string; type?: string };
  state.entities.set(p.id, {
    id: p.id,
    label: p.label,
    canonicalLabel: null,
    entityType: p.type ?? 'unknown',
    aliases: [],
    extractionConfidence: null,
    firstSeenRunId: event.runId,
    lastUpdatedRunId: event.runId,
    metadata: {},
  });
};

const HANDLERS: EventHandlerRegistry = { NODE_ADDED: nodeAddedHandler };
function appendEvents(events: readonly NewEventInput[], projection: ProjectionState): EventEnvelope[] {
  return appendEventsStore(events, { projection, handlers: HANDLERS });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-incr-test-'));
  const db = initDb(path.join(tmpDir, 'test.db'));
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test a: incremental matches full genesis ────────────────────────

describe('incremental rebuild: matches genesis', () => {
  it('append N, rebuild, append M more, incremental rebuild — matches full genesis of N+M', () => {
    // Batch 1: N events (3 entities from run-1)
    let projection = rebuildProjection(HANDLERS);
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e1', payload: { id: 'e1', label: 'Alpha' } }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e2', payload: { id: 'e2', label: 'Beta' } }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e3', payload: { id: 'e3', label: 'Gamma' } }),
    ], projection);

    // First rebuild — creates checkpoint
    projection = rebuildProjection(HANDLERS);
    expect(projection.entities.size).toBe(3);
    expect(computeProjectionChecksum(projection)).toBeTruthy();

    // Verify checkpoint was written
    const cp1 = getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION);
    expect(cp1).not.toBeNull();
    expect(cp1!.snapshotJson).toBeTruthy();

    // Batch 2: M more events (2 entities from run-2)
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-2', entityId: 'e4', payload: { id: 'e4', label: 'Delta' } }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-2', entityId: 'e5', payload: { id: 'e5', label: 'Epsilon' } }),
    ], projection);

    // Incremental rebuild
    projection = rebuildProjection(HANDLERS);
    expect(projection.entities.size).toBe(5);

    // Verify checksums match across rebuilds
    const expectedChecksum = computeProjectionChecksum(projection);

    // Rebuild again — still incremental, should be identical
    projection = rebuildProjection(HANDLERS);
    expect(computeProjectionChecksum(projection)).toBe(expectedChecksum);
    expect(projection.entities.size).toBe(5);

    // Verify specific entities survived
    expect(projection.entities.get('e1')!.label).toBe('Alpha');
    expect(projection.entities.get('e5')!.label).toBe('Epsilon');

    // Genesis-path created a checkpoint
    expect(getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION)).not.toBeNull();
  });
});

// ── Test b: rollback after checkpoint causes stale fallback ──────────

describe('incremental rebuild: rollback staleness detection', () => {
  it('rollback after checkpoint forces genesis fallback, rolled-back data disappears', () => {
    // Append events for run A (pure_run_local)
    let projection = rebuildProjection(HANDLERS);
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-A', entityId: 'eA1', payload: { id: 'eA1', label: 'FromA' } }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-A', entityId: 'eA2', payload: { id: 'eA2', label: 'FromA2' } }),
    ], projection);

    // Rebuild — checkpoint now includes run A's data
    projection = rebuildProjection(HANDLERS);
    expect(projection.entities.size).toBe(2);
    expect(projection.entities.has('eA1')).toBe(true);

    // Rollback run A
    rollbackRun('run-A', projection, { projection, handlers: HANDLERS });

    // Append unrelated events
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-B', entityId: 'eB1', payload: { id: 'eB1', label: 'FromB' } }),
    ], projection);

    // Rebuild — checkpoint is stale (run-A was rolled back after checkpoint cursor
    // but run-A's events were before cursor). Must fallback to genesis.
    projection = rebuildProjection(HANDLERS);

    // run A's data must be GONE
    expect(projection.entities.has('eA1')).toBe(false);
    expect(projection.entities.has('eA2')).toBe(false);
    expect(projection.rolledBackRuns.has('run-A')).toBe(true);

    // run B's data must be present
    expect(projection.entities.has('eB1')).toBe(true);
    expect(projection.entities.get('eB1')!.label).toBe('FromB');
    expect(projection.entities.size).toBe(1);
  });
});

// ── Test c: rollback before any checkpoint works on genesis rebuild ──

describe('incremental rebuild: rollback without prior checkpoint', () => {
  it('rollback before first rebuild still works correctly', () => {
    let projection = rebuildProjection(HANDLERS);

    // Append events for run A
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-A', entityId: 'eA', payload: { id: 'eA', label: 'RemoveMe' } }),
    ], projection);

    // Rollback run A BEFORE any rebuild/checkpoint
    projection = rebuildProjection(HANDLERS);
    rollbackRun('run-A', projection, { projection, handlers: HANDLERS });

    // Append some good events
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-B', entityId: 'eB', payload: { id: 'eB', label: 'KeepMe' } }),
    ], projection);

    // First rebuild — must skip run-A's events entirely
    projection = rebuildProjection(HANDLERS);
    expect(projection.rolledBackRuns.has('run-A')).toBe(true);
    expect(projection.entities.has('eA')).toBe(false);
    expect(projection.entities.has('eB')).toBe(true);
    expect(projection.entities.size).toBe(1);
  });
});

// ── Test d: second rebuild with zero new events is a no-op ───────────

describe('incremental rebuild: no-op on zero delta', () => {
  it('second rebuild with no new events returns identical state', () => {
    let projection = rebuildProjection(HANDLERS);
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e1', payload: { id: 'e1', label: 'Alpha' } }),
    ], projection);

    projection = rebuildProjection(HANDLERS);
    const checksum1 = computeProjectionChecksum(projection);

    // Rebuild with zero new events
    projection = rebuildProjection(HANDLERS);
    const checksum2 = computeProjectionChecksum(projection);

    expect(checksum2).toBe(checksum1);
    expect(projection.entities.size).toBe(projection.entities.size);
    expect(projection.entities.get('e1')!.label).toBe('Alpha');
  });
});
