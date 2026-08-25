import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  initDb, closeDb, getDbPath, appendEvents, rebuildProjection, countEvents,
  createEmptyProjectionState, rollbackRun,
  StaleProjectionError, EventReferenceInvalidError,
} from '../../src/store/index.js';
import { hashPayload } from '../../src/store/events.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import type { NewEventInput } from '../../src/store/events.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { handleRunStarted, handleRunCompleted } from '../../src/store/exampleHandlers.js';

let tmpDir: string;
const HANDLERS: EventHandlerRegistry = {
  ...graphEventHandlers,
  ...workspaceEventHandlers,
  RUN_STARTED: handleRunStarted,
  RUN_COMPLETED: handleRunCompleted,
};

function event(eventType: NewEventInput['eventType'], payload: unknown, runId = 'run-test'): NewEventInput {
  return {
    timestamp: new Date().toISOString(), eventType, eventVersion: 1, runId,
    batchId: null, actor: 'system', entityId: null, entityType: null, payload,
  };
}

const family = (id: string) => event('FAMILY_CREATED', { family_id: id, label: id });
const source = (id: string) => event('SOURCE_ADDED', {
  id, url: `https://${id}.example`, domain: `${id}.example`, sourceType: 'web', isPrimary: true,
  extractionStatus: 'pending', contentHash: 'hash', retrievedAt: new Date().toISOString(), firstSeenRunId: 'run-test',
});
const claim = (id: string, familyId = 'family-1') => event('CLAIM_ACCEPTED', {
  id, familyId, subjectText: 'subject', predicate: 'supports', objectText: 'object', polarity: 'asserted',
  hedge: 'certain', evidenceType: 'study', confidence: 0.9, canonicalKey: { subject: 'subject', predicate: 'supports' },
  contradictionState: 'none', firstSeenRunId: 'run-test', lastSeenRunId: 'run-test',
});

function context() {
  const projection = rebuildProjection(HANDLERS);
  return { projection, handlers: HANDLERS };
}

function seedValidReferences(): void {
  appendEvents([
    family('family-1'), family('family-2'),
    event('THREAD_CREATED', { threadId: 'thread-1', familyId: 'family-1', label: 'thread' }),
    event('NODE_ADDED', {
      id: 'entity-1', label: 'entity', canonicalLabel: null, entityType: 'thing', aliases: [],
      extractionConfidence: null, firstSeenRunId: 'run-test', lastUpdatedRunId: 'run-test', metadata: {},
    }),
    source('source-1'), claim('claim-1'), claim('claim-2'),
  ], context());
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-validation-test-'));
  expect(initDb(path.join(tmpDir, 'test.db'))).not.toBeNull();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('referential validation', () => {
  const cases: { name: string; invalid: NewEventInput; valid: NewEventInput }[] = [
    {
      name: 'CLAIM_ACCEPTED family',
      invalid: claim('bad-claim', 'missing-family'),
      valid: claim('good-claim'),
    },
    {
      name: 'EVIDENCE_LINKED claim and source',
      invalid: event('EVIDENCE_LINKED', { id: 'evidence', claimId: 'missing-claim', sourceId: 'missing-source', runId: 'run-test' }),
      valid: event('EVIDENCE_LINKED', { id: 'evidence', claimId: 'claim-1', sourceId: 'source-1', runId: 'run-test' }),
    },
    {
      name: 'EDGE_ADDED claim endpoints',
      invalid: event('EDGE_ADDED', { id: 'edge', fromClaimId: 'missing-a', toClaimId: 'missing-b', relation: 'supports', strength: 'strong', score: 0.8, runId: 'run-test' }),
      valid: event('EDGE_ADDED', { id: 'edge', fromClaimId: 'claim-1', toClaimId: 'claim-2', relation: 'supports', strength: 'strong', score: 0.8, runId: 'run-test' }),
    },
    {
      name: 'CONTRADICTION_IDENTIFIED family claims',
      invalid: event('CONTRADICTION_IDENTIFIED', { id: 'contradiction', familyId: 'family-1', claimIdA: 'claim-1', claimIdB: 'missing', contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved', firstSeenRunId: 'run-test' }),
      valid: event('CONTRADICTION_IDENTIFIED', { id: 'contradiction', familyId: 'family-1', claimIdA: 'claim-1', claimIdB: 'claim-2', contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved', firstSeenRunId: 'run-test' }),
    },
    {
      name: 'THREAD_CREATED family',
      invalid: event('THREAD_CREATED', { threadId: 'bad-thread', familyId: 'missing-family', label: 'thread' }),
      valid: event('THREAD_CREATED', { threadId: 'thread-2', familyId: 'family-1', label: 'thread' }),
    },
    {
      name: 'THREAD_RESOLVED thread',
      invalid: event('THREAD_RESOLVED', { threadId: 'missing-thread', familyId: 'family-1' }),
      valid: event('THREAD_RESOLVED', { threadId: 'thread-1', familyId: 'family-1' }),
    },
    {
      name: 'RUN_STARTED family and thread',
      invalid: event('RUN_STARTED', { runId: 'run-bad', familyId: 'missing-family', query: 'q', strategy: 'agent' }, 'run-bad'),
      valid: event('RUN_STARTED', { runId: 'run-good', familyId: 'family-1', threadId: 'thread-1', query: 'q', strategy: 'agent' }, 'run-good'),
    },
    {
      name: 'FAMILY_RELATED families',
      invalid: event('FAMILY_RELATED', { relation_id: 'relation', family_a: 'family-1', family_b: 'missing-family', relation_type: 'adjacent' }),
      valid: event('FAMILY_RELATED', { relation_id: 'relation', family_a: 'family-1', family_b: 'family-2', relation_type: 'adjacent' }),
    },
  ];

  it.each(cases)('rejects $name and persists nothing', ({ invalid }) => {
    const before = countEvents();
    expect(() => appendEvents([invalid], context())).toThrow(EventReferenceInvalidError);
    expect(countEvents()).toBe(before);
  });

  it.each(cases)('accepts valid $name reference', ({ valid }) => {
    seedValidReferences();
    expect(() => appendEvents([valid], context())).not.toThrow();
  });
});

describe('append/replay hardening', () => {
  it('rejects an empty-string optional reference instead of silently skipping validation', () => {
    // Regression: truthiness checks like `if (payload.threadId)` previously let
    // threadId: '' bypass the thread-existence check entirely (empty string is
    // falsy). Seed a valid family-1 first so the family check can't be the
    // reason for the throw — only the empty threadId should trigger it.
    seedValidReferences();
    expect(() => appendEvents([
      event('RUN_STARTED', { runId: 'run-empty-thread', familyId: 'family-1', threadId: '', query: 'q', strategy: 'agent' }, 'run-empty-thread'),
    ], context())).toThrow(EventReferenceInvalidError);
  });

  it('accepts references created earlier in same batch', () => {
    expect(() => appendEvents([
      family('batch-family'),
      event('THREAD_CREATED', { threadId: 'batch-thread', familyId: 'batch-family', label: 'thread' }),
    ], context())).not.toThrow();
  });

  it('rejects append from stale projection and persists nothing', () => {
    const first = context();
    const second = context();
    appendEvents([family('fresh-family')], first);
    const before = countEvents();
    expect(() => appendEvents([family('stale-family')], second)).toThrow(StaleProjectionError);
    expect(countEvents()).toBe(before);
  });

  it('detects staleness caused by a writer that commits between check and insert (TOCTOU)', () => {
    // Regression for the stale-cursor check having previously run OUTSIDE the
    // write transaction: a second writer's commit landing between the read
    // and the insert must still be caught, not silently overwritten.
    const stale = context();
    // A different, independently-fetched context appends first, advancing the
    // real cursor past what `stale` observed when it was constructed.
    appendEvents([family('interloper-family')], context());
    const before = countEvents();
    expect(() => appendEvents([family('too-late-family')], stale)).toThrow(StaleProjectionError);
    expect(countEvents()).toBe(before);
  });

  it('fails replay on payload hash corruption', () => {
    const stored = appendEvents([family('hash-family')], context())[0]!;
    const db = new Database(getDbPath()!);
    db.prepare('UPDATE events SET payload_hash = ? WHERE seq = ?').run('0'.repeat(64), stored.seq);
    db.close();
    expect(() => rebuildProjection(HANDLERS)).toThrow(/Payload hash mismatch/);
  });

  it('fails replay on unknown event type', () => {
    const stored = appendEvents([family('unknown-family')], context())[0]!;
    const db = new Database(getDbPath()!);
    db.prepare('UPDATE events SET event_type = ? WHERE seq = ?').run('NOT_A_TRELLIS_EVENT', stored.seq);
    db.close();
    expect(() => rebuildProjection(HANDLERS)).toThrow(/Unknown event type/);
  });

  it('fails replay on invalid payload shape', () => {
    const stored = appendEvents([family('invalid-payload-family')], context())[0]!;
    const payload = JSON.stringify({ family_id: 'invalid-payload-family' });
    const db = new Database(getDbPath()!);
    db.prepare('UPDATE events SET payload = ?, payload_hash = ? WHERE seq = ?').run(payload, hashPayload(payload), stored.seq);
    db.close();
    expect(() => rebuildProjection(HANDLERS)).toThrow(/Invalid payload/);
  });

  it('uses full historical validation state while skipping rolled-back events', () => {
    const runId = 'run-rolled-back';
    appendEvents([
      { ...family('rolled-back-family'), runId },
      { ...claim('rolled-back-claim-a', 'rolled-back-family'), runId },
      { ...claim('rolled-back-claim-b', 'rolled-back-family'), runId },
      { ...event('EDGE_ADDED', {
        id: 'rolled-back-edge', fromClaimId: 'rolled-back-claim-a', toClaimId: 'rolled-back-claim-b',
        relation: 'supports', strength: 'strong', score: 0.8, runId,
      }), runId },
    ], context());
    const state = rebuildProjection(HANDLERS);
    rollbackRun(runId, state, { projection: state, handlers: HANDLERS });
    const rebuilt = rebuildProjection(HANDLERS);
    expect(rebuilt.rolledBackRuns.has(runId)).toBe(true);
    expect(rebuilt.families.has('rolled-back-family')).toBe(false);
    expect(rebuilt.claims.has('rolled-back-claim-a')).toBe(false);
    expect(rebuilt.claimRelations.has('rolled-back-edge')).toBe(false);
  });
});
