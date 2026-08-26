/**
 * Chaos tests: real optimistic-concurrency contention — two real processes
 * racing appendEvents against the same DB file.
 *
 * Each child rebuilds projection → signals ready → waits for go → appends.
 * Exactly one succeeds; the other gets StaleProjectionError.
 * Loser retries and succeeds; final state is consistent.
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
  queryEvents,
  getDb,
  computeProjectionChecksum,
} from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-concurrency-'));
  expect(initDb(path.join(tmpDir, 'test.db'))).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── IPC helpers ─────────────────────────────────────────────────────

interface ChildResult {
  child: ChildProcess;
  waitForLine: () => Promise<string>;
  sendLine: (line: string) => void;
}

function spawnChild(mode: string, dbPath: string): ChildResult {
  const scriptPath = path.resolve('test/fixtures/chaos/storeChild.ts');
  const child = spawn(process.execPath, ['--import', 'tsx/esm', scriptPath, mode, dbPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });

  let lineBuf = '';
  const waitForLine = (): Promise<string> => new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const idx = lineBuf.indexOf('\n');
      if (idx >= 0) {
        child.stdout?.off('data', onData);
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        resolve(line);
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
  });

  const sendLine = (line: string) => {
    child.stdin?.write(line + '\n');
  };

  return { child, waitForLine, sendLine };
}

function killClean(child: ChildProcess): Promise<void> {
  if (child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn('cleanup: concurrency child exit timeout — possible orphan');
      resolve();
    }, 3000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGKILL');
  });
}

// ── Test ────────────────────────────────────────────────────────────

describe('concurrency: two real processes racing appendEvents', () => {
  let childA: ChildProcess | null = null;
  let childB: ChildProcess | null = null;

  afterEach(async () => {
    if (childA !== null) await killClean(childA);
    if (childB !== null) await killClean(childB);
    childA = null;
    childB = null;
  });

  it('exactly one child succeeds, loser retries, final event log consistent', async () => {
    const raceDbPath = path.join(tmpDir, 'race.db');
    const timeout = setTimeout(() => {
      if (childA !== null && !childA.killed) childA.kill('SIGKILL');
      if (childB !== null && !childB.killed) childB.kill('SIGKILL');
    }, 15_000);

    try {
      // Seed the DB with initial data so both children have something to read
      let projection = rebuildProjection(handlers);
      appendEvents([
        event('NODE_ADDED', { id: 'seed1', label: 'Seed', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'seed', lastUpdatedRunId: 'seed', metadata: {} }, 'seed'),
      ], projection);

      // Build the race DB — copy the initialized DB to a temp location
      // so children can open it independently. Checkpoint WAL first so all
      // data is in the main file (copy doesn't include -wal/-shm).
      const raceDbSrc = path.join(tmpDir, 'test.db');
      getDb()!.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(raceDbSrc, raceDbPath);

      // Spawn two children
      const a = spawnChild('race-append', raceDbPath);
      childA = a.child;
      const b = spawnChild('race-append', raceDbPath);
      childB = b.child;

      // Wait for both ready signals
      const [readyA, readyB] = await Promise.all([a.waitForLine(), b.waitForLine()]);
      const parsedA = JSON.parse(readyA) as Record<string, unknown>;
      const parsedB = JSON.parse(readyB) as Record<string, unknown>;
      expect(parsedA.type).toBe('ready');
      expect(parsedB.type).toBe('ready');

      // Both should have the same lastSeq
      expect(parsedA.lastSeq).toBe(parsedB.lastSeq);

      // Release both simultaneously
      a.sendLine('go');
      b.sendLine('go');

      // Collect results
      const [resultA, resultB] = await Promise.all([a.waitForLine(), b.waitForLine()]);
      const resA = JSON.parse(resultA) as Record<string, unknown>;
      const resB = JSON.parse(resultB) as Record<string, unknown>;

      // Exactly one succeeded
      const successCount = [resA.success, resB.success].filter(Boolean).length;
      expect(successCount).toBe(1);

      // The loser got StaleProjectionError
      const loser = resA.success === false ? resA : resB;
      expect(loser.isStale).toBe(true);

      // Kill children — no longer needed
      await killClean(childA);
      await killClean(childB);
      childA = null;
      childB = null;

      // Reopen DB in parent and verify
      closeDb();
      const db = initDb(raceDbPath);
      expect(db).not.toBeNull();

      // After the race: exactly ONE new row from the children's batch
      // (plus the original seed event)
      const totalEvents = (db!.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
      // Seed (1) + exactly one race child's event (1) = 2
      expect(totalEvents).toBe(2);

      // The winning event is a NODE_ADDED from a race-* run
      const raceEvents = db!.prepare("SELECT * FROM events WHERE run_id LIKE 'race-%'").all() as Array<{ run_id: string }>;
      expect(raceEvents).toHaveLength(1);

      // PRAGMA integrity_check
      const integrity = db!.pragma('integrity_check', { simple: true });
      expect(integrity).toBe('ok');

      // Force-genesis replay succeeds
      const replayed = rebuildProjection(handlers, { forceGenesis: true });
      const replayChecksum = computeProjectionChecksum(replayed);
      expect(replayChecksum).toBeTruthy();

      // Loser retry: reopen with fresh projection, should succeed
      const freshProjection = rebuildProjection(handlers);
      appendEvents([
        event('NODE_ADDED', { id: 'retry-ok', label: 'RetryOk', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'retry', lastUpdatedRunId: 'retry', metadata: {} }, 'retry'),
      ], freshProjection);

      // Final event log: seed + one race + retry = 3
      const finalCount = (db!.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
      expect(finalCount).toBe(3);

    } finally {
      clearTimeout(timeout);
    }
  }, 15_000);
});
