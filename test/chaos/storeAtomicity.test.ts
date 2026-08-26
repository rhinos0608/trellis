/**
 * Chaos tests: append atomicity under exception and real process death.
 *
 * Sub-test A: handler throws mid-batch → entire transaction rolls back.
 * Sub-test B: SIGKILL during large append → DB file remains consistent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  initDb,
  closeDb,
  appendEvents as appendEventsStore,
  rebuildProjection,
  computeProjectionChecksum,
  queryEvents,
  getDb,
  createEmptyProjectionState,
} from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { rebuildKnowledgeReadModel, verifyKnowledgeReadModel, getKnowledgeReadModelStatus } from '../../src/store/readModel/index.js';

// ── Helpers ────────────────────────────────────────────────────────

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
let tmpDir: string;

function event(
  eventType: NewEventInput['eventType'],
  payload: unknown,
  runId = 'test-run',
): NewEventInput {
  return {
    eventType,
    eventVersion: 1,
    runId,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function appendEvents(events: readonly NewEventInput[], projection: ProjectionState): ReturnType<typeof appendEventsStore> {
  return appendEventsStore(events, { projection, handlers });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-atomicity-'));
  expect(initDb(path.join(tmpDir, 'test.db'))).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Sub-test A: handler exception mid-batch ───────────────────────

describe('append atomicity: handler exception mid-batch', () => {
  it('handler throws after first event insert → entire batch rolls back, no partial rows', () => {
    let projection = rebuildProjection(handlers);

    // Seed one event so we have known state
    appendEvents([
      event('NODE_ADDED', { id: 'seed', label: 'Seed', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'seed', lastUpdatedRunId: 'seed', metadata: {} }, 'seed'),
    ], projection);

    // Record pre-throw state
    const eventCountBefore = queryEvents().length;
    const latestSeqBefore = projection.lastAppliedSeq;
    const checksumBefore = computeProjectionChecksum(projection);
    const readModelBefore = getKnowledgeReadModelStatus();
    const rmDataBefore = {
      claims: (getDb()!.prepare('SELECT COUNT(*) AS n FROM rm_claims').get() as { n: number }).n,
      sources: (getDb()!.prepare('SELECT COUNT(*) AS n FROM rm_sources').get() as { n: number }).n,
    };

    // Install a handler that throws on the SECOND NODE_ADDED in the batch
    let callCount = 0;
    const origHandler = handlers['NODE_ADDED'];
    handlers['NODE_ADDED'] = (ev, state) => {
      callCount++;
      if (callCount > 1) throw new Error('simulated handler chaos');
      origHandler!(ev, state);
    };

    let threw = false;
    try {
      // Batch of 2 — first insert succeeds inside the transaction,
      // handler for second throws → better-sqlite3 rolls back entire txn.
      appendEvents([
        event('NODE_ADDED', { id: 'a1', label: 'A1', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'batch', lastUpdatedRunId: 'batch', metadata: {} }, 'batch'),
        event('NODE_ADDED', { id: 'a2', label: 'A2', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'batch', lastUpdatedRunId: 'batch', metadata: {} }, 'batch'),
      ], projection);
    } catch {
      threw = true;
    } finally {
      handlers['NODE_ADDED'] = origHandler;
    }

    expect(threw).toBe(true);

    // Event count unchanged — no partial batch rows
    expect(queryEvents().length).toBe(eventCountBefore);

    // Latest seq unchanged
    expect(projection.lastAppliedSeq).toBe(latestSeqBefore);

    // Hot projection checksum unchanged
    expect(computeProjectionChecksum(projection)).toBe(checksumBefore);

    // Read-model status unchanged
    const readModelAfter = getKnowledgeReadModelStatus();
    expect(readModelAfter.status).toBe(readModelBefore.status);

    // Read-model data unchanged
    const rmDataAfter = {
      claims: (getDb()!.prepare('SELECT COUNT(*) AS n FROM rm_claims').get() as { n: number }).n,
      sources: (getDb()!.prepare('SELECT COUNT(*) AS n FROM rm_sources').get() as { n: number }).n,
    };
    expect(rmDataAfter).toEqual(rmDataBefore);

    // PRAGMA integrity_check returns ok
    const integrity = getDb()!.pragma('integrity_check', { simple: true });
    expect(integrity).toBe('ok');

    // Force-genesis replay matches pre-crash checksum
    const genesisProjection = rebuildProjection(handlers, { forceGenesis: true });
    expect(computeProjectionChecksum(genesisProjection)).toBe(checksumBefore);

    // Subsequent normal append succeeds — DB not broken
    appendEvents([
      event('NODE_ADDED', { id: 'post', label: 'PostCrash', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'post', lastUpdatedRunId: 'post', metadata: {} }, 'post'),
    ], projection);
    expect(queryEvents().length).toBe(eventCountBefore + 1);
  });
});

// ── Sub-test B: real process crash via SIGKILL ─────────────────────

function createChildLineReader(child: ChildProcess): () => Promise<string> {
  let buf = '';
  let pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  const onData = (chunk: Buffer) => {
    buf += chunk.toString();
    while (true) {
      const idx = buf.indexOf('\n');
      if (idx < 0 || pending.length === 0) return;
      const waiter = pending.shift()!;
      waiter.resolve(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  };
  child.stdout?.on('data', onData);
  child.on('error', (error) => {
    const waiters = pending;
    pending = [];
    for (const waiter of waiters) waiter.reject(error);
  });
  return () => new Promise((resolve, reject) => {
    const idx = buf.indexOf('\n');
    if (idx >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      resolve(line);
      return;
    }
    pending.push({ resolve, reject });
  });
}

function sendToChild(child: ChildProcess, line: string): void {
  child.stdin?.write(line + '\n');
}

describe('append atomicity: real process crash', () => {
  let childDbPath: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    childDbPath = path.join(tmpDir, 'crash-child.db');
  });

  afterEach(async () => {
    if (child !== null && !child.killed) {
      child.kill('SIGKILL');
    }
    if (child !== null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn('cleanup: storeAtomicity child exit timeout — possible orphan');
          resolve();
        }, 3000);
        child!.on('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    child = null;
  });

  it('SIGKILL during large append → DB consistent, force-genesis replay succeeds, subsequent append works', async () => {
    const timeout = setTimeout(() => {
      if (child !== null && !child.killed) child.kill('SIGKILL');
    }, 15_000);

    try {
      // Spawn child in store-crash-test mode
      const scriptPath = path.resolve('test/fixtures/chaos/storeChild.ts');
      child = spawn(process.execPath, ['--import', 'tsx/esm', scriptPath, 'store-crash-test', childDbPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      });
      const readLine = createChildLineReader(child);

      // Wait for ready signal
      const readyLine = await readLine();
      const ready = JSON.parse(readyLine) as Record<string, unknown>;
      expect(ready.type).toBe('ready');
      const eventCountBefore = ready.eventCount as number;

      // Send go signal
      sendToChild(child, 'go');

      // Wait for append-started IPC signal — fires from within the
      // SQLite transaction handler, proving the txn is still open.
      const startedLine = await readLine();
      const started = JSON.parse(startedLine) as Record<string, unknown>;
      expect(started.type).toBe('append-started');

      // Kill immediately — transaction is open, not yet committed
      child.kill('SIGKILL');

      // Await actual process exit with bounded timeout
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.warn('SIGKILL exit timeout — possible orphan');
          resolve();
        }, 3000);
        child!.on('exit', () => { clearTimeout(timer); resolve(); });
      });
      child = null;

      // Reopen the same DB file fresh
      closeDb();
      const db = initDb(childDbPath);
      expect(db).not.toBeNull();

      // Strict either/or: full rollback (txn never committed) or full commit
      // (txn finished before SIGKILL landed). NEVER a partial value — that
      // would indicate real corruption, which is the invariant under test.
      const countRow = db!.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      const isFullRollback = countRow.n === eventCountBefore;
      const isFullCommit = countRow.n === eventCountBefore + 500;
      expect(isFullRollback || isFullCommit).toBe(true);

      // PRAGMA integrity_check returns ok
      const integrity = db!.pragma('integrity_check', { simple: true });
      expect(integrity).toBe('ok');

      // Force-genesis replay succeeds
      const projection = rebuildProjection(handlers, { forceGenesis: true });
      expect(projection.lastAppliedSeq).toBeGreaterThan(0);

      // Subsequent append against reopened DB succeeds
      const postProjection = rebuildProjection(handlers);
      appendEvents([
        event('NODE_ADDED', { id: 'post-crash', label: 'PostCrash', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'post', lastUpdatedRunId: 'post', metadata: {} }, 'post'),
      ], postProjection);
      expect(queryEvents().length).toBeGreaterThanOrEqual(eventCountBefore + 1);

    } finally {
      clearTimeout(timeout);
    }
  }, 15_000);
});
