import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaimObservation, ClaimRelation } from '../../src/graph/types.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import {
  appendEvents,
  closeDb,
  EventReferenceInvalidError,
  initDb,
  rebuildProjection,
} from '../../src/store/index.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import type { EventEnvelope, TrellisEventType } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
let tempDir: string;

function event<T>(eventType: TrellisEventType, payload: T, timestamp = '2025-01-01T00:00:00.000Z'): NewEventInput {
  return { timestamp, eventType, eventVersion: eventType === 'EVIDENCE_LINKED' ? 2 : 1, runId: 'run-test', batchId: null, actor: 'user', actorId: 'operator', entityId: null, entityType: null, payload } as NewEventInput;
}

function assertion(subjectText: string, predicate = 'improves') {
  return { subjectText, predicate, objectText: 'research', polarity: 'asserted' as const, hedge: 'certain' as const, evidenceType: 'study' as const, canonicalKey: { subject: subjectText.toLowerCase(), predicate } };
}

function observation(id: string, claimId: string, confidence: number, observedAt: string, subjectText = claimId): ClaimObservation {
  return { ...assertion(subjectText), id, familyId: 'family-1', runId: 'run-test', observedAt, confidence, sourceIds: ['source-1'], extractionVersion: 'v1' };
}

function claimSeed(id: string): NewEventInput {
  return event('CLAIM_ACCEPTED', { ...assertion(id), id, familyId: 'family-1', confidence: 0.5, contradictionState: 'none', firstSeenRunId: 'run-test', lastSeenRunId: 'run-test' });
}

function observed(o: ClaimObservation, claimId: string, first = false): NewEventInput {
  return event('CLAIM_OBSERVED', { observation: o, reconciliation: { observationId: o.id, classification: first ? 'new_claim' : 'same_claim', canonicalClaimId: claimId, ...(first ? {} : { matchedClaimId: claimId }), score: 1, method: 'canonical_key_exact', rationale: 'test', reconcilerVersion: 1, candidates: [] } }, o.observedAt);
}

function source(): NewEventInput {
  return event('SOURCE_ADDED', { id: 'source-1', url: 'https://example.test/source', domain: 'example.test', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', contentHash: 'hash', retrievedAt: '2025-01-01T00:00:00.000Z', firstSeenRunId: 'run-test' });
}

function evidence(id: string, claimId: string, observationId: string, stance: 'supports' | 'opposes'): NewEventInput {
  return { ...event('EVIDENCE_LINKED', { id, claimId, sourceId: 'source-1', observationId, stance, runId: 'run-test' }), eventVersion: 2 };
}

function relation(id: string, fromClaimId: string, toClaimId: string): ClaimRelation {
  return { id, fromClaimId, toClaimId, relation: 'supports', strength: 'strong', score: 0.9, rationale: 'test', runId: 'run-test' };
}

function curation(reason = 'operator test') {
  return { commandId: `cmd-${reason.replaceAll(' ', '-')}`, reason, expectedSeq: 0 };
}

function append(inputs: readonly NewEventInput[]): void {
  appendEvents(inputs, { projection: rebuildProjection(handlers), handlers });
}

function projection(): ProjectionState {
  return rebuildProjection(handlers, { forceGenesis: true });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-curation-handlers-'));
  expect(initDb(path.join(tempDir, 'test.db'))).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('curation projection handler invariants', () => {
  it('merge preserves survivor identity and rehomes observations, evidence, and relations', () => {
    const a1 = observation('a-obs-1', 'claim-a', 0.6, '2025-01-01T00:00:01.000Z', 'A old');
    const b1 = observation('b-obs-1', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z', 'B current');
    const b2 = observation('b-obs-2', 'claim-b', 1, '2025-01-01T00:00:03.000Z', 'B latest');
    append([
      event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'),
      observed(a1, 'claim-a', true), observed(b1, 'claim-b', true), observed(b2, 'claim-b'),
      evidence('ev-a', 'claim-a', a1.id, 'supports'), evidence('ev-b', 'claim-b', b1.id, 'opposes'),
      event('CLAIM_RELATION_CURATED', { curation: curation('add relation'), relationId: 'rel-a-b', before: null, after: relation('rel-a-b', 'claim-a', 'claim-b') }),
      event('CLAIM_RELATION_CURATED', { curation: curation('add relation 2'), relationId: 'rel-b-a', before: null, after: relation('rel-b-a', 'claim-b', 'claim-a') }),
      event('CLAIM_MERGED', { curation: curation('merge'), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b', affectedObservationIds: [a1.id], affectedEvidenceIds: ['ev-a'], affectedRelationIds: ['rel-a-b', 'rel-b-a'], affectedContradictionIds: [], affectedGapIds: [] }),
    ]);
    const state = projection();
    const a = state.claims.get('claim-a')!;
    const b = state.claims.get('claim-b')!;
    expect(a.curationStatus).toBe('merged');
    expect(a.mergedIntoClaimId).toBe('claim-b');
    expect(b.subjectText).toBe('B latest');
    expect(b.familyId).toBe('family-1');
    expect(b.observationIds).toEqual(expect.arrayContaining([a1.id, b1.id, b2.id]));
    expect(state.observationToClaimId.get(a1.id)).toBe('claim-b');
    expect(state.evidence.get('ev-a')?.claimId).toBe('claim-b');
    expect([...state.evidenceByClaimId.get('claim-b')!]).toEqual(expect.arrayContaining(['ev-a', 'ev-b']));
    expect([...state.claimRelations.values()]).toEqual([]);
    expect(b.confidence).toBeGreaterThan(0);
  });

  it('split partitions every observation and evidence record without orphans', () => {
    const obs = [1, 2, 3, 4].map((n) => observation(`s-obs-${n}`, 'claim-s', n / 10, `2025-01-01T00:00:0${n}.000Z`, `S${n}`));
    append([
      event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-s'), observed(obs[0]!, 'claim-s', true), observed(obs[1]!, 'claim-s'), observed(obs[2]!, 'claim-s'), observed(obs[3]!, 'claim-s'),
      evidence('ev-1', 'claim-s', obs[0]!.id, 'supports'), evidence('ev-2', 'claim-s', obs[2]!.id, 'opposes'),
      event('CLAIM_SPLIT', { curation: curation('split'), sourceClaimId: 'claim-s', results: [
        { claimId: 'claim-x', currentObservationId: obs[1]!.id, observationIds: [obs[0]!.id, obs[1]!.id], evidenceIds: ['ev-1'] },
        { claimId: 'claim-y', currentObservationId: obs[3]!.id, observationIds: [obs[2]!.id, obs[3]!.id], evidenceIds: ['ev-2'] },
      ] }),
    ]);
    const state = projection();
    const sourceClaim = state.claims.get('claim-s')!;
    expect(sourceClaim.curationStatus).toBe('split');
    expect(sourceClaim.splitIntoClaimIds).toEqual(['claim-x', 'claim-y']);
    expect(state.claims.get('claim-x')?.observationIds).toEqual([obs[0]!.id, obs[1]!.id]);
    expect(state.claims.get('claim-y')?.observationIds).toEqual([obs[2]!.id, obs[3]!.id]);
    expect(state.claims.get('claim-x')?.observationCount).toBe(2);
    expect(state.claims.get('claim-y')?.observationCount).toBe(2);
    expect(state.evidence.get('ev-1')?.claimId).toBe('claim-x');
    expect(state.evidence.get('ev-2')?.claimId).toBe('claim-y');
    expect([...state.observationsByClaimId.get('claim-x')!]).toEqual(expect.arrayContaining(obs.slice(0, 2).map((o) => o.id)));
    expect([...state.observationsByClaimId.get('claim-y')!]).toEqual(expect.arrayContaining(obs.slice(2).map((o) => o.id)));
    expect([...state.evidenceByClaimId.get('claim-x')!]).toContain('ev-1');
    expect([...state.evidenceByClaimId.get('claim-y')!]).toContain('ev-2');
  });

  it('claim retraction retracts all observations and recomputes confidence', () => {
    const obs = [1, 2, 3].map((n) => observation(`r-obs-${n}`, 'claim-r', n / 10, `2025-01-01T00:00:0${n}.000Z`));
    append([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-r'), observed(obs[0]!, 'claim-r', true), observed(obs[1]!, 'claim-r'), observed(obs[2]!, 'claim-r'), event('CLAIM_RETRACTION_SET', { curation: curation('retract claim'), target: { kind: 'claim', id: 'claim-r' }, previousStatus: 'active', newStatus: 'retracted' }), event('CLAIM_RETRACTION_SET', { curation: curation('restore one observation'), target: { kind: 'claim', id: 'claim-r' }, previousStatus: 'retracted', newStatus: 'active', observationIds: [obs[0]!.id] })]);
    const state = projection();
    const claim = state.claims.get('claim-r')!;
    expect(claim.curationStatus).toBe('active');
    expect(state.claimObservations.get(obs[0]!.id)?.curationStatus).toBe('active');
    expect(state.claimObservations.get(obs[1]!.id)?.curationStatus).toBe('retracted');
    expect(state.claimObservations.get(obs[2]!.id)?.curationStatus).toBe('retracted');
    expect(claim.observationCount).toBe(1);
    expect(claim.confidence).toBeCloseTo(0.1);
  });

  it('observation retraction swaps current observation and assertion to prior active observation', () => {
    const first = observation('o-1', 'claim-o', 0.7, '2025-01-01T00:00:01.000Z', 'first assertion');
    const second = observation('o-2', 'claim-o', 0.9, '2025-01-01T00:00:02.000Z', 'second assertion');
    append([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-o'), observed(first, 'claim-o'), observed(second, 'claim-o')]);
    const state = projection();
    graphEventHandlers.CLAIM_RETRACTION_SET({ ...event('CLAIM_RETRACTION_SET', { curation: curation('retract observation'), target: { kind: 'observation', id: second.id }, previousStatus: 'active', newStatus: 'retracted' }), seq: 99, id: 'curation-observation', payloadHash: '' } as EventEnvelope, state);
    const claim = state.claims.get('claim-o')!;
    expect(state.claimObservations.get(second.id)?.curationStatus).toBe('retracted');
    expect(claim.currentObservationId).toBe(first.id);
    expect(claim.subjectText).toBe('first assertion');
    expect(claim.confidence).toBeGreaterThan(0);
  });

  it('curated relation add updates relation and both reverse indexes', () => {
    const a = observation('rel-obs-a', 'claim-a', 0.8, '2025-01-01T00:00:01.000Z');
    const b = observation('rel-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    const rel = relation('rel-1', 'claim-a', 'claim-b');
    append([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), observed(a, 'claim-a'), observed(b, 'claim-b'), event('CLAIM_RELATION_CURATED', { curation: curation('add'), relationId: rel.id, before: null, after: rel })]);
    const state = projection();
    expect(state.claimRelations.get(rel.id)).toEqual(rel);
    expect([...state.claimRelationsByFromClaimId.get('claim-a')!]).toContain(rel.id);
    expect([...state.claimRelationsByToClaimId.get('claim-b')!]).toContain(rel.id);
  });

  it('curated relation stale before snapshot throws EventReferenceInvalidError', () => {
    const a = observation('stale-obs-a', 'claim-a', 0.8, '2025-01-01T00:00:01.000Z');
    const b = observation('stale-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    const rel = relation('rel-stale', 'claim-a', 'claim-b');
    append([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), observed(a, 'claim-a'), observed(b, 'claim-b'), event('CLAIM_RELATION_CURATED', { curation: curation('add stale relation'), relationId: rel.id, before: null, after: rel })]);
    const staleBefore = { ...rel, score: 0.1 };
    expect(() => append([event('CLAIM_RELATION_CURATED', { curation: curation('stale update'), relationId: rel.id, before: staleBefore, after: { ...rel, score: 1 } })])).toThrow(EventReferenceInvalidError);
  });

  it('evidence stance override recomputes supporting and opposing counts', () => {
    const first = observation('ev-obs-1', 'claim-e', 0.8, '2025-01-01T00:00:01.000Z');
    const second = observation('ev-obs-2', 'claim-e', 0.8, '2025-01-01T00:00:02.000Z');
    append([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-e'), observed(first, 'claim-e'), observed(second, 'claim-e'), evidence('ev-supports', 'claim-e', first.id, 'supports'), evidence('ev-opposes', 'claim-e', second.id, 'opposes')]);
    const state = projection();
    graphEventHandlers.EVIDENCE_STANCE_OVERRIDDEN({ ...event('EVIDENCE_STANCE_OVERRIDDEN', { curation: curation('override stance'), evidenceId: 'ev-opposes', claimId: 'claim-e', previousStance: 'opposes', newStance: 'supports' }), seq: 99, id: 'curation-evidence', payloadHash: '' } as EventEnvelope, state);
    const claim = state.claims.get('claim-e')!;
    expect(state.evidence.get('ev-supports')?.stance).toBe('supports');
    expect(state.evidence.get('ev-opposes')?.stance).toBe('supports');
    expect(claim.supportingEvidenceCount).toBe(2);
    expect(claim.opposingEvidenceCount).toBe(0);
  });
});

