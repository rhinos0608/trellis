/**
 * Tests for checkpoint retention/compaction.
 *
 * Verifies:
 * - N distinct rebuilds produce at most CHECKPOINT_RETENTION rows
 * - A no-op rebuild (same cursor+checksum) adds zero rows
 * - The newest checkpoint restores correctly via getLatestCompatibleCheckpoint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDb,
  closeDb,
  appendEvents as appendEventsStore,
  rebuildProjection,
  getLatestCompatibleCheckpoint,
  deserializeProjectionState,
  CURRENT_PROJECTION_VERSION,
} from '../../src/store/index.js';
import { CHECKPOINT_RETENTION } from '../../src/store/checkpoints.js';
import { getDb } from '../../src/store/db.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import type { EventEnvelope, TrellisEventType } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';

// ── Helpers ────────────────────────────────────────────────────────

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

const nodeAddedHandler = (event: EventEnvelope, state: ProjectionState) => {
  const p = event.payload as { id: string; label: string };
  state.entities.set(p.id, {
    id: p.id,
    label: p.label,
    canonicalLabel: null,
    entityType: 'unknown',
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

function countCheckpoints(): number {
  const db = getDb()!;
  return (db.prepare('SELECT COUNT(*) AS n FROM projection_checkpoints').get() as { n: number }).n;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-checkpoint-retention-'));
  const db = initDb(path.join(tmpDir, 'test.db'));
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────

describe('checkpoint retention', () => {
  it('retains at most CHECKPOINT_RETENTION checkpoints after N distinct rebuilds', () => {
    let projection = rebuildProjection(HANDLERS);
    const totalRebuilds = CHECKPOINT_RETENTION + 7; // 10 total

    for (let i = 0; i < totalRebuilds; i++) {
      appendEvents([
        makeEvent({ eventType: 'NODE_ADDED', runId: `run-${i}`, entityId: `e-${i}`, payload: { id: `e-${i}`, label: `Entity ${i}` } }),
      ], projection);
      projection = rebuildProjection(HANDLERS);
    }

    const remaining = countCheckpoints();
    expect(remaining).toBe(CHECKPOINT_RETENTION);
  });

  it('no-op rebuild adds zero checkpoint rows', () => {
    let projection = rebuildProjection(HANDLERS);

    // First append + rebuild: creates a checkpoint
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-0', entityId: 'e0', payload: { id: 'e0', label: 'First' } }),
    ], projection);
    projection = rebuildProjection(HANDLERS);
    const before = countCheckpoints();
    expect(before).toBe(1);

    // Second rebuild with no new events
    projection = rebuildProjection(HANDLERS);
    expect(countCheckpoints()).toBe(before);
  });

  it('newest checkpoint restores correctly via getLatestCompatibleCheckpoint', () => {
    let projection = rebuildProjection(HANDLERS);

    for (let i = 0; i < 5; i++) {
      appendEvents([
        makeEvent({ eventType: 'NODE_ADDED', runId: `run-${i}`, entityId: `e-${i}`, payload: { id: `e-${i}`, label: `Entity ${i}` } }),
      ], projection);
      projection = rebuildProjection(HANDLERS);
    }

    const latest = getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION);
    expect(latest).not.toBeNull();
    expect(latest!.projectionVersion).toBe(CURRENT_PROJECTION_VERSION);
    expect(latest!.compatible).toBe(true);
    expect(latest!.snapshotJson).toBeDefined();
    expect(latest!.snapshotJson!.length).toBeGreaterThan(0);

    const snapshot = deserializeProjectionState(latest!.snapshotJson!);
    expect(snapshot.lastAppliedSeq).toBe(latest!.eventCursor);
  });
});
