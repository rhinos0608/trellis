import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDb,
  closeDb,
  appendEvents as appendEventsStore,
  queryEvents,
  rebuildProjection,
  rollbackRun,
  rollbackCrossRunMutation,
  handleRunStarted,
  handleRunCompleted,
  createEmptyProjectionState,
  countEvents,
} from '../src/store/index.js';
import type { EventHandlerRegistry } from '../src/store/projectionState.js';
import type { EventEnvelope, TrellisEventType } from '../src/store/eventTypes.js';
import type { EntityMergedPayload } from '../src/store/eventTypes.js';
import type { NewEventInput } from '../src/store/events.js';
import { graphEventHandlers } from '../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../src/workspace/projectionHandlers.js';

// ── Test helpers ────────────────────────────────────────────────────

let tmpDir: string;

const ALL_HANDLERS: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers, RUN_STARTED: handleRunStarted, RUN_COMPLETED: handleRunCompleted };
function appendEvents(events: readonly NewEventInput[]): ReturnType<typeof appendEventsStore> {
  const projection = rebuildProjection(ALL_HANDLERS);
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const familyId = typeof payload.familyId === 'string' ? payload.familyId : undefined;
    if (familyId && !projection.families.has(familyId)) projection.families.set(familyId, { id: familyId, label: familyId, manifest: { scopeQuery: familyId }, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), relatedFamilies: [] } as never);
    if (event.eventType === 'ENTITY_MERGED') {
      const p = payload as { survivorId?: string; mergedIds?: string[] };
      for (const id of [p.survivorId, ...(p.mergedIds ?? [])]) if (id) projection.entities.set(id, { id, label: id, canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: event.runId, lastUpdatedRunId: event.runId, metadata: {} } as never);
    }
    if (event.eventType === 'NODE_RELABELED') {
      const id = typeof payload.targetId === 'string' ? payload.targetId : undefined;
      if (id) projection.entities.set(id, { id, label: id, canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: event.runId, lastUpdatedRunId: event.runId, metadata: {} } as never);
    }
  }
  return appendEventsStore(events, { projection, handlers: ALL_HANDLERS });
}

function normalizeNodePayload(payload: Record<string, unknown>, runId: string): Record<string, unknown> {
  const { type, ...rest } = payload;
  return { id: 'node', label: 'node', canonicalLabel: null, entityType: rest.entityType ?? type ?? 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: runId, lastUpdatedRunId: runId, metadata: {}, ...rest };
}

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
    ...(overrides.eventType === 'NODE_ADDED' ? { payload: normalizeNodePayload(overrides.payload as Record<string, unknown>, overrides.runId ?? 'run-test') } : {}),
    ...(overrides.eventType === 'RUN_STARTED' ? { payload: {
      runId: overrides.runId ?? 'run-test', familyId: 'fixture-family', query: 'fixture', strategy: 'agent',
      ...(overrides.payload as Record<string, unknown>),
    } } : {}),
    ...(overrides.eventType === 'RUN_COMPLETED' ? { payload: { runId: overrides.runId ?? 'run-test', ...(overrides.payload as Record<string, unknown>) } } : {}),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDb(dbPath);
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Event store: append + query ─────────────────────────────────────

describe('event store: append + query', () => {
  it('appends events and queries them back', () => {
    const events = appendEvents([
      makeEvent({ eventType: 'RUN_STARTED', runId: 'run-1', payload: { runId: 'run-1', familyId: 'f1', query: 'test', strategy: 'agent' } }),
      makeEvent({ eventType: 'RUN_COMPLETED', runId: 'run-1', payload: { runId: 'run-1' } }),
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBeTruthy();
    expect(events[1]!.id).toBeTruthy();
    expect(events[0]!.payloadHash).toBeTruthy();

    const queried = queryEvents({ runId: 'run-1' });
    expect(queried).toHaveLength(2);
    const types = queried.map((e) => e.eventType).sort();
    expect(types).toEqual(['RUN_COMPLETED', 'RUN_STARTED']);
  });

  it('filters by eventType', () => {
    appendEvents([
      makeEvent({ eventType: 'RUN_STARTED', runId: 'r1' }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'r1', payload: { id: 'n1', label: 'test' } }),
      makeEvent({ eventType: 'RUN_COMPLETED', runId: 'r1' }),
    ]);

    const nodeEvents = queryEvents({ eventType: 'NODE_ADDED' });
    expect(nodeEvents).toHaveLength(1);
    expect(nodeEvents[0]!.eventType).toBe('NODE_ADDED');
  });

  it('filters by since timestamp', () => {
    const t1 = '2024-01-01T00:00:00.000Z';
    const t2 = '2024-06-01T00:00:00.000Z';
    appendEvents([
      makeEvent({ eventType: 'RUN_STARTED', runId: 'r1', timestamp: t1 }),
      makeEvent({ eventType: 'RUN_COMPLETED', runId: 'r1', timestamp: t2 }),
    ]);

    const after = queryEvents({ since: t2 });
    expect(after).toHaveLength(1);
    expect(after[0]!.eventType).toBe('RUN_COMPLETED');
  });

  it('filters by entityId', () => {
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', entityId: 'e1', payload: { id: 'e1' } }),
      makeEvent({ eventType: 'NODE_ADDED', entityId: 'e2', payload: { id: 'e2' } }),
    ]);

    const e1Events = queryEvents({ entityId: 'e1' });
    expect(e1Events).toHaveLength(1);
  });
});

// ── Example handlers (direct call, not through rebuild) ─────────────

describe('example handlers: direct dispatch', () => {
  it('handleRunStarted creates a running ResearchRun in state', () => {
    const state = createEmptyProjectionState();
    const event = makeEvent({
      eventType: 'RUN_STARTED',
      runId: 'run-xyz',
      payload: { runId: 'run-xyz', familyId: 'f1', query: 'test query', strategy: 'agent', topic: 'topic' },
    });

    handleRunStarted(event as EventEnvelope, state);

    expect(state.researchRuns.size).toBe(1);
    const run = state.researchRuns.get('run-xyz')!;
    expect(run).toBeDefined();
    expect(run.status).toBe('running');
    expect(run.query).toBe('test query');
    expect(run.topic).toBe('topic');
  });

  it('handleRunCompleted marks the run completed', () => {
    const state = createEmptyProjectionState();
    const startEvent = makeEvent({
      eventType: 'RUN_STARTED',
      runId: 'run-xyz',
      payload: { runId: 'run-xyz', familyId: 'f1', query: 'q', strategy: 'agent' },
    });
    handleRunStarted(startEvent as EventEnvelope, state);

    const completeEvent = makeEvent({
      eventType: 'RUN_COMPLETED',
      runId: 'run-xyz',
      payload: { runId: 'run-xyz', entityCount: 5, claimCount: 3 },
    });
    handleRunCompleted(completeEvent as EventEnvelope, state);

    const run = state.researchRuns.get('run-xyz')!;
    expect(run.status).toBe('completed');
    expect(run.entityCount).toBe(5);
    expect(run.claimCount).toBe(3);
  });
});

// ── Rebuild projection with non-audit events ────────────────────────

describe('rebuildProjection: end-to-end dispatch', () => {
  it('dispatches NODE_ADDED events through registry into state.entities', () => {
    appendEvents([
      makeEvent({
        eventType: 'NODE_ADDED',
        runId: 'run-1',
        entityId: 'ent-1',
        entityType: 'entity',
        payload: { id: 'ent-1', label: 'Alpha', type: 'protocol', aliases: [], firstSeenRunId: 'run-1', lastUpdatedRunId: 'run-1', metadata: {} },
      }),
      makeEvent({
        eventType: 'NODE_ADDED',
        runId: 'run-1',
        entityId: 'ent-2',
        entityType: 'entity',
        payload: { id: 'ent-2', label: 'Beta', type: 'package', aliases: [], firstSeenRunId: 'run-1', lastUpdatedRunId: 'run-1', metadata: {} },
      }),
    ]);

    // Minimal handler that stores NODE_ADDED into state.entities
    const handlers: EventHandlerRegistry = {
      NODE_ADDED: (event, state) => {
        const p = event.payload as { id: string; label: string; type: string; aliases: string[]; firstSeenRunId: string; lastUpdatedRunId: string; metadata: Record<string, unknown> };
        state.entities.set(p.id, {
          id: p.id,
          label: p.label,
          canonicalLabel: null,
          entityType: p.type ?? (event.payload as { entityType?: string }).entityType ?? 'unknown',
          aliases: p.aliases,
          extractionConfidence: null,
          firstSeenRunId: p.firstSeenRunId,
          lastUpdatedRunId: p.lastUpdatedRunId,
          metadata: p.metadata,
        });
      },
    };

    const state = rebuildProjection(handlers);
    expect(state.entities.size).toBe(2);
    expect(state.entities.get('ent-1')!.label).toBe('Alpha');
    expect(state.entities.get('ent-2')!.label).toBe('Beta');
  });

  it('empty store returns empty state', () => {
    const state = rebuildProjection({});
    expect(state.entities.size).toBe(0);
    expect(state.researchRuns.size).toBe(0);
    expect(countEvents()).toBe(0);
  });
});

// ── Rollback: pure_run_local ────────────────────────────────────────

describe('rollback: pure_run_local run', () => {
  it('persists RUN_ROLLED_BACK; rebuild skips that run', () => {
    // Two runs with NODE_ADDED events (pure_run_local)
    appendEvents([
      makeEvent({
        eventType: 'NODE_ADDED',
        runId: 'run-good',
        entityId: 'e1',
        entityType: 'entity',
        payload: { id: 'e1', label: 'Keep' },
      }),
      makeEvent({
        eventType: 'NODE_ADDED',
        runId: 'run-bad',
        entityId: 'e2',
        entityType: 'entity',
        payload: { id: 'e2', label: 'Remove' },
      }),
    ]);

    // Store handler
    const handlers: EventHandlerRegistry = {
      NODE_ADDED: (event, state) => {
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
      },
    };

    // Build initial state — both entities present
    const state1 = rebuildProjection(handlers);
    expect(state1.entities.size).toBe(2);

    // Roll back run-bad
    rollbackRun('run-bad', state1, { projection: state1, handlers: handlers });

    // Rebuild — run-bad events should be skipped
    const state2 = rebuildProjection(handlers);
    expect(state2.rolledBackRuns.has('run-bad')).toBe(true);
    expect(state2.entities.has('e1')).toBe(true);
    expect(state2.entities.has('e2')).toBe(false);
  });
});

// ── Rollback: cross_run_mutation ENTITY_MERGED ──────────────────────

describe('rollback: cross_run_mutation ENTITY_MERGED', () => {
  it('appends compensating ENTITY_SPLIT when no later interference', () => {
    const t1 = '2024-01-01T00:00:00.000Z';

    appendEvents([
      makeEvent({
        eventType: 'ENTITY_MERGED',
        runId: 'run-merge',
        timestamp: t1,
        entityId: 'ent-a',
        entityType: 'entity',
        payload: {
          survivorId: 'ent-a',
          mergedIds: ['ent-b'],
          mergedSnapshots: [{ id: 'ent-b', label: 'Entity B', aliases: [], metadata: {}, claimIds: [], evidenceIds: [] }],
        } satisfies EntityMergedPayload,
      }),
    ]);

    const state = createEmptyProjectionState();
    state.lastAppliedSeq = queryEvents({}).at(-1)?.seq ?? 0;
    state.entities.set('ent-a', { id: 'ent-a', label: 'Entity A', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'run-merge', lastUpdatedRunId: 'run-merge', metadata: {} });
    const countBefore = countEvents();

    const mergeEvent = queryEvents({ eventType: 'ENTITY_MERGED' })[0]!;
    const outcome = rollbackCrossRunMutation(mergeEvent, state, { projection: state, handlers: ALL_HANDLERS });

    expect(outcome.kind).toBe('executed');
    if (outcome.kind === 'executed') {
      expect(outcome.inverseEventId).toBeTruthy();
    }

    // A new event was appended
    expect(countEvents()).toBe(countBefore + 1);

    // The new event is an ENTITY_SPLIT with rollback actor
    const allEvents = queryEvents({});
    const splitEvent = allEvents.find((e) => e.eventType === 'ENTITY_SPLIT');
    expect(splitEvent).toBeDefined();
    expect(splitEvent!.actor).toBe('rollback');
  });

  it('returns blocked when another run modified the merged scope', () => {
    const t1 = '2024-01-01T00:00:00.000Z';
    const t2 = '2024-06-01T00:00:00.000Z';

    appendEvents([
      makeEvent({
        eventType: 'ENTITY_MERGED',
        runId: 'run-merge',
        timestamp: t1,
        entityId: 'ent-a',
        entityType: 'entity',
        payload: {
          survivorId: 'ent-a',
          mergedIds: ['ent-b'],
          mergedSnapshots: [],
        } satisfies EntityMergedPayload,
      }),
      // Later run modifies ent-b
      makeEvent({
        eventType: 'NODE_RELABELED',
        runId: 'run-other',
        timestamp: t2,
        entityId: 'ent-a',
        entityType: 'entity',
        payload: { targetId: 'ent-a', oldLabel: 'old', newLabel: 'new' },
      }),
    ]);

    const state = createEmptyProjectionState();
    state.lastAppliedSeq = queryEvents({}).at(-1)?.seq ?? 0;
    state.entities.set('ent-a', { id: 'ent-a', label: 'Entity A', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'run-merge', lastUpdatedRunId: 'run-merge', metadata: {} });
    const mergeEvent = queryEvents({ eventType: 'ENTITY_MERGED' })[0]!;

    const outcome = rollbackCrossRunMutation(mergeEvent, state, { projection: state, handlers: ALL_HANDLERS });

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.reason).toContain('interference');
    }
  });
});

// ── Rollback: non-cross_run_mutation event ──────────────────────────

describe('rollback: non-cross_run_mutation event', () => {
  it('returns blocked for pure_run_local event type', () => {
    const event = makeEvent({ eventType: 'NODE_ADDED', runId: 'r1', payload: {} });
    const state = createEmptyProjectionState();

    const outcome = rollbackCrossRunMutation(event, state, { projection: state, handlers: ALL_HANDLERS });
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.reason).toContain('cross_run_mutation');
    }
  });
});
