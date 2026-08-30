import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NewEventInput } from '../../src/store/events.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import { appendEvents, closeDb, createEmptyProjectionState, getDb, initDb, queryEvents, rebuildProjection, rollbackRun } from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { getKnowledgeReadModelStatus, rebuildKnowledgeReadModel, verifyKnowledgeReadModel } from '../../src/store/readModel/index.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
let tempDir: string;
const event = (eventType: NewEventInput['eventType'], payload: unknown, runId = 'rollback-run', eventVersion = 1): NewEventInput => ({
  eventType, eventVersion, runId, batchId: null, actor: 'system', entityId: null, entityType: null,
  timestamp: new Date().toISOString(), payload,
});
const db = () => getDb()!;
const assertion = (subjectText: string, objectText = 'evidence') => ({
  subjectText, predicate: 'supports', objectText, polarity: 'asserted' as const, hedge: 'certain' as const,
  evidenceType: 'study' as const, canonicalKey: { subject: subjectText.toLowerCase(), predicate: 'supports' },
});
const observation = (id: string, subjectText: string, familyId: string, runId: string, objectText = 'evidence') => ({
  ...assertion(subjectText, objectText), id, familyId, runId, observedAt: new Date().toISOString(), confidence: 0.9,
  sourceIds: [], extractionVersion: 'v1',
});
const observed = (id: string, subjectText: string, familyId: string, runId: string, claimId: string, classification: 'new_claim' | 'same_claim' | 'supersedes' | 'contradiction' = 'new_claim', matchedClaimId?: string, previousObservationId?: string): NewEventInput => {
  const canonicalClaimId = classification === 'supersedes' ? `claim_${id}` : claimId;
  const reconciliation = {
    observationId: id, classification, canonicalClaimId, ...(classification !== 'new_claim' ? { matchedClaimId: matchedClaimId ?? claimId } : {}),
    score: 0.9, method: 'canonical_key_exact' as const, rationale: 'test', reconcilerVersion: 1 as const, candidates: [],
    ...(classification === 'supersedes' ? { supersedes: { previousObservationId: previousObservationId ?? 'missing', previousAssertion: assertion('old text') } } : {}),
  };
  return event('CLAIM_OBSERVED', { observation: observation(id, subjectText, familyId, runId), reconciliation }, runId);
};
const sourceObserved = (sourceId: string, runId: string, title: string, url = 'https://example.com/shared'): NewEventInput => event('SOURCE_OBSERVED', {
  sourceId, observedSourceId: `${sourceId}-${runId}`, canonicalUrl: url, url, title, domain: 'example.com', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId, observedAt: new Date().toISOString(),
}, runId);
const rebuildEmpty = () => rebuildKnowledgeReadModel(handlers);

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-read-model-rollback-'));
  expect(initDb(path.join(tempDir, 'rollback.db'))).not.toBeNull();
});
afterEach(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

describe('rollback read-model recovery', () => {
  it('marks model dirty during rollback append, then rebuilds to ready', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Rollback family' }), observed('obs-1', 'rollback claim', 'family-1', 'rollback-run', 'claim-1')], { projection: state, handlers });
    expect(getKnowledgeReadModelStatus().status).toBe('ready');
    const result = rollbackRun('rollback-run', state, { projection: state, handlers });
    expect(result.blocked).toHaveLength(0);
    expect(getKnowledgeReadModelStatus()).toMatchObject({ status: 'ready' });
    expect(db().prepare('SELECT id FROM rm_claims WHERE id = ?').get('claim-1')).toBeUndefined();
    expect(queryEvents({ eventType: 'RUN_ROLLED_BACK' })).toHaveLength(1);
    expect(verifyKnowledgeReadModel(state)).toEqual({ matches: true, mismatches: [] });
  });

  it('keeps committed rollback events when rebuild fails and leaves model dirty', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([sourceObserved('source-1', 'rollback-run', 'Rollback source'), event('SOURCE_CHANGED', { sourceId: 'source-1', oldContentHash: 'old', newContentHash: 'new' }, 'rollback-run')], { projection: state, handlers });
    // Corrupt historical payload after append. Hash validation makes rebuild fail,
    // while rollback append and its compensation remain committed.
    db().prepare("UPDATE events SET payload = ? WHERE event_type = 'SOURCE_CHANGED'").run('{"sourceId":"source-1","oldContentHash":"corrupt","newContentHash":"new"}');
    const result = rollbackRun('rollback-run', state, { projection: state, handlers });
    expect(result.executed).toBe(1);
    expect(result.readModelRebuilt).toBe(false);
    expect(result.readModelError).toBeTruthy();
    expect(getKnowledgeReadModelStatus().status).toBe('dirty');
    expect(queryEvents({ eventType: 'RUN_ROLLED_BACK' })).toHaveLength(1);
    expect(queryEvents({ eventType: 'SOURCE_CHANGED' })).toHaveLength(2);
  });

  it('maintains full parity across mixed reconciliation, contradiction, dedup, evidence, and rollback lifecycle', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([
      event('FAMILY_CREATED', { family_id: 'family-a', label: 'Family A' }, 'run-1'),
      event('FAMILY_CREATED', { family_id: 'family-b', label: 'Family B' }, 'run-2'),
      observed('obs-a1', 'alpha claim', 'family-a', 'run-1', 'claim-a'),
      observed('obs-b1', 'beta claim', 'family-b', 'run-2', 'claim-b'),
      observed('obs-a2', 'alpha claim', 'family-a', 'run-2', 'claim-a', 'same_claim', 'claim-a'),
      observed('obs-c1', 'gamma claim', 'family-a', 'run-2', 'claim-c', 'contradiction', 'claim-a'),
      sourceObserved('source-1', 'run-1', 'Shared source'),
      sourceObserved('source-1', 'run-2', 'Shared source'),
      event('EVIDENCE_LINKED', { id: 'evidence-1', claimId: 'claim-a', sourceId: 'source-1', observationId: 'obs-a1', stance: 'supports', runId: 'run-2' }, 'run-2', 2),
      event('CONTRADICTION_IDENTIFIED', { id: 'contradiction-1', familyId: 'family-a', claimIdA: 'claim-a', claimIdB: 'claim-c', contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved', firstSeenRunId: 'run-2' }, 'run-2'),
      observed('obs-rb', 'rolled back claim', 'family-a', 'run-rollback', 'claim-rb'),
    ], { projection: state, handlers });
    rollbackRun('run-rollback', state, { projection: state, handlers });
    expect(state.claims.has('claim-rb')).toBe(false);
    expect(state.sources.get('source-1')?.runCount).toBe(2);
    expect(state.claimObservations.has('obs-a2')).toBe(true);
    expect(state.contradictions.has('contradiction-1')).toBe(true);
    expect(verifyKnowledgeReadModel(state)).toEqual({ matches: true, mismatches: [] });
  });

  it('removes superseded claim and deleted source text from FTS indexes', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), observed('obs-old', 'old ghost token', 'family-1', 'run-1', 'claim-1'), sourceObserved('source-1', 'run-1', 'Old ghost title', 'https://example.com/old-ghost')], { projection: state, handlers });
    appendEvents([observed('obs-new', 'new living token', 'family-1', 'run-2', 'claim-1', 'supersedes', 'claim-1', 'obs-old')], { projection: state, handlers });
    db().prepare('DELETE FROM rm_sources WHERE id = ?').run('source-1');
    expect((db().prepare("SELECT COUNT(*) AS n FROM rm_claims_fts WHERE rm_claims_fts MATCH 'old'").get() as { n: number }).n).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM rm_claims_fts WHERE rm_claims_fts MATCH 'living'").get() as { n: number }).n).toBe(1);
    expect((db().prepare("SELECT COUNT(*) AS n FROM rm_sources_fts WHERE rm_sources_fts MATCH 'ghost'").get() as { n: number }).n).toBe(0);
  });

  it('combines family filter and FTS term filter', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([event('FAMILY_CREATED', { family_id: 'family-a', label: 'A' }), event('FAMILY_CREATED', { family_id: 'family-b', label: 'B' }), observed('obs-a', 'shared searchable term', 'family-a', 'run-a', 'claim-a'), observed('obs-b', 'shared searchable term', 'family-b', 'run-b', 'claim-b'), observed('obs-a2', 'different term', 'family-a', 'run-a', 'claim-a2')], { projection: state, handlers });
    const rows = db().prepare("SELECT c.id FROM rm_claims AS c JOIN rm_claims_fts AS f ON f.rowid = c.rowid WHERE c.family_id = ? AND rm_claims_fts MATCH ? ORDER BY c.id").all('family-a', 'shared') as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(['claim-a']);
  });

  it('recovers deleted read-model rows while preserving stale cursor state', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), observed('obs-1', 'recoverable claim', 'family-1', 'run-1', 'claim-1')], { projection: state, handlers });
    const before = getKnowledgeReadModelStatus();
    db().exec('DELETE FROM rm_claims');
    expect(getKnowledgeReadModelStatus()).toEqual(before);
    rebuildEmpty();
    expect(db().prepare('SELECT COUNT(*) AS n FROM rm_claims').get()).toEqual({ n: 1 });
    expect(verifyKnowledgeReadModel(rebuildProjection(handlers, { forceGenesis: true }))).toEqual({ matches: true, mismatches: [] });
  });

  it('keeps read-model tables independent from projection checkpoints', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), observed('obs-1', 'checkpoint independent claim', 'family-1', 'run-1', 'claim-1')], { projection: state, handlers });
    rebuildEmpty();
    const before = db().prepare('SELECT id, payload_json FROM rm_claims').all();
    db().exec('DELETE FROM projection_checkpoints');
    expect(getKnowledgeReadModelStatus().status).toBe('ready');
    expect(db().prepare('SELECT id, payload_json FROM rm_claims').all()).toEqual(before);
    expect(verifyKnowledgeReadModel(rebuildProjection(handlers, { forceGenesis: true }))).toEqual({ matches: true, mismatches: [] });
  });

  it('keeps event log and hot projection independent from read-model corruption', () => {
    const state = createEmptyProjectionState(); rebuildEmpty();
    appendEvents([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), observed('obs-1', 'source of truth claim', 'family-1', 'run-1', 'claim-1')], { projection: state, handlers });
    const eventCount = queryEvents().length;
    db().exec('DELETE FROM rm_evidence; DELETE FROM rm_claim_relations; DELETE FROM rm_claim_observations; DELETE FROM rm_claims; DELETE FROM rm_sources;');
    expect(queryEvents()).toHaveLength(eventCount);
    const rebuilt = rebuildProjection(handlers, { forceGenesis: true });
    expect(rebuilt.claims.has('claim-1')).toBe(true);
    expect(rebuilt.claimObservations.has('obs-1')).toBe(true);
    expect(getKnowledgeReadModelStatus().status).toBe('ready');
  });
});
