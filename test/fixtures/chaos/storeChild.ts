/**
 * Child process for chaos tests — modes:
 *   store-crash-test  — append events, signal readiness, wait for kill
 *   race-append       — compete with another child for optimistic concurrency
 *
 * IPC: line-based JSON on stdout (child→parent), stdin (parent→child).
 */

import { initDb, closeDb, appendEvents, rebuildProjection, queryEvents } from '../../../src/store/index.js';
import { StaleProjectionError } from '../../../src/store/eventErrors.js';
import { graphEventHandlers } from '../../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../../src/workspace/projectionHandlers.js';
import type { NewEventInput } from '../../../src/store/events.js';
import type { ProjectionState, EventHandlerRegistry } from '../../../src/store/projectionState.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };

// ── IPC helpers ──────────────────────────────────────────────────────

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx >= 0) resolve(buf.slice(0, idx));
    });
  });
}

// ── Event factory ────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<NewEventInput> & { eventType: string },
): NewEventInput {
  return {
    timestamp: new Date().toISOString(),
    eventVersion: 1,
    runId: 'crash-test',
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload: {},
    ...overrides,
    ...(overrides.eventType === 'NODE_ADDED' ? {
      payload: {
        id: 'node', label: 'node', canonicalLabel: null, entityType: 'unknown', aliases: [],
        extractionConfidence: null, firstSeenRunId: overrides.runId ?? 'crash-test',
        lastUpdatedRunId: overrides.runId ?? 'crash-test', metadata: {},
        ...(overrides.payload as Record<string, unknown>),
      },
    } : {}),
  } as NewEventInput;
}

function append(events: readonly NewEventInput[], projection: ProjectionState): ReturnType<typeof appendEvents> {
  return appendEvents(events, { projection, handlers });
}

// ── Mode: store-crash-test ───────────────────────────────────────────

async function handleCrashTest(): Promise<void> {
  let projection = rebuildProjection(handlers);

  // Seed
  append([
    makeEvent({ eventType: 'NODE_ADDED', runId: 'seed', entityId: 'e1', payload: { id: 'e1', label: 'Seed1' } }),
    makeEvent({ eventType: 'NODE_ADDED', runId: 'seed', entityId: 'e2', payload: { id: 'e2', label: 'Seed2' } }),
  ], projection);

  const eventCountBefore = queryEvents().length;

  send({ type: 'ready', eventCount: eventCountBefore });

  // Wait for go signal
  await readLine();

  // Wrap handler to signal parent when first event in batch is processed.
  // This fires INSIDE the SQLite transaction (see appendEvents txn block),
  // so the parent can SIGKILL while the transaction is still open.
  const origHandler = handlers['NODE_ADDED'];
  let signaled = false;
  handlers['NODE_ADDED'] = (ev, state) => {
    if (!signaled) {
      signaled = true;
      process.stdout.write(JSON.stringify({ type: 'append-started' }) + '\n');
    }
    origHandler!(ev, state);
  };

  // Large batch to widen the SIGKILL window
  const events: NewEventInput[] = [];
  for (let i = 0; i < 500; i++) {
    events.push(makeEvent({
      eventType: 'NODE_ADDED',
      runId: 'crash-target',
      entityId: `crash-${String(i)}`,
      payload: { id: `crash-${String(i)}`, label: `Crash ${String(i)}` },
    }));
  }
  append(events, projection);

  // Restore original handler
  handlers['NODE_ADDED'] = origHandler;

  send({ type: 'completed', eventCount: queryEvents().length });
}

// ── Mode: race-append ────────────────────────────────────────────────

async function handleRaceAppend(): Promise<void> {
  const projection = rebuildProjection(handlers);
  const lastSeq = projection.lastAppliedSeq;

  send({ type: 'ready', lastSeq });

  await readLine();

  const events: NewEventInput[] = [
    makeEvent({
      eventType: 'NODE_ADDED',
      runId: `race-${String(process.pid)}`,
      entityId: `entity-${String(process.pid)}`,
      payload: { id: `entity-${String(process.pid)}`, label: `Race ${String(process.pid)}` },
    }),
  ];

  try {
    append(events, projection);
    send({ type: 'result', success: true, eventCount: queryEvents().length });
  } catch (err: unknown) {
    send({
      type: 'result',
      success: false,
      isStale: err instanceof StaleProjectionError,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = process.argv[2];
  const dbPath = process.argv[3];

  if (!mode || !dbPath) {
    send({ type: 'error', message: 'Usage: storeChild.ts <mode> <dbPath>' });
    process.exit(1);
  }

  const db = initDb(dbPath);
  if (!db) {
    send({ type: 'error', message: 'Failed to open DB' });
    process.exit(1);
  }

  try {
    if (mode === 'store-crash-test') {
      await handleCrashTest();
    } else if (mode === 'race-append') {
      await handleRaceAppend();
    } else {
      send({ type: 'error', message: `Unknown mode: ${mode}` });
      process.exit(1);
    }
  } finally {
    closeDb();
  }
}

main().catch((err: unknown) => {
  send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
