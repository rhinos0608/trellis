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
  countEvents,
  initDb,
  queryEvents,
  rebuildProjection,
} from '../../src/store/index.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import type { TrellisEventType } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';
import { createCurationApplicationService } from '../../src/app/curationService.js';
import {
  CurationConflictError,
  CurationPreconditionError,
  IdempotencyConflictError,
  StaleProjectionError,
} from '../../src/app/errors.js';

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

function seed(inputs: readonly NewEventInput[]): void {
  appendEvents(inputs, { projection: rebuildProjection(handlers), handlers });
}

function currentSeq(): number {
  return rebuildProjection(handlers, { forceGenesis: true }).lastAppliedSeq;
}

function service() {
  return createCurationApplicationService({ handlers });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-curation-service-'));
  expect(initDb(path.join(tempDir, 'test.db'))).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('curation application service', () => {
  it('mergeClaims appends CLAIM_MERGED and survivor absorbs source observations/evidence/relations', () => {
    const a1 = observation('m-obs-a', 'claim-a', 0.6, '2025-01-01T00:00:01.000Z');
    const b1 = observation('m-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    seed([
      event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'),
      observed(a1, 'claim-a', true), observed(b1, 'claim-b', true),
      evidence('ev-a', 'claim-a', a1.id, 'supports'),
      event('CLAIM_RELATION_CURATED', { curation: { commandId: 'seed-rel', reason: 'seed', expectedSeq: 0 }, relationId: 'rel-a-b', before: null, after: relation('rel-a-b', 'claim-a', 'claim-b') }),
    ]);
    const result = service().mergeClaims({ commandId: 'merge-1', actorId: 'op-1', reason: 'duplicate claims', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' });
    expect(result.deduplicated).toBe(false);
    expect(result.eventType).toBe('CLAIM_MERGED');

    const appended = queryEvents({ runId: 'curation:merge-1' })[0]!;
    const payload = appended.payload as Record<string, unknown>;
    expect(payload.sourceClaimId).toBe('claim-a');
    expect(payload.survivorClaimId).toBe('claim-b');
    expect(payload.affectedObservationIds).toEqual([a1.id]);
    expect(payload.affectedEvidenceIds).toEqual(['ev-a']);
    expect(payload.affectedRelationIds).toEqual(['rel-a-b']);

    const state = rebuildProjection(handlers, { forceGenesis: true });
    const a = state.claims.get('claim-a')!;
    const b = state.claims.get('claim-b')!;
    expect(a.curationStatus).toBe('merged');
    expect(a.mergedIntoClaimId).toBe('claim-b');
    expect(b.observationIds).toEqual(expect.arrayContaining([a1.id, b1.id]));
    expect(state.evidence.get('ev-a')?.claimId).toBe('claim-b');
    expect([...state.evidenceByClaimId.get('claim-b')!]).toContain('ev-a');
  });

  it('splitClaim appends CLAIM_SPLIT with the operator partition applied', () => {
    const obs = [1, 2, 3, 4].map((n) => observation(`sp-obs-${n}`, 'claim-s', n / 10, `2025-01-01T00:00:0${n}.000Z`, `S${n}`));
    seed([
      event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-s'),
      observed(obs[0]!, 'claim-s', true), observed(obs[1]!, 'claim-s'), observed(obs[2]!, 'claim-s'), observed(obs[3]!, 'claim-s'),
      evidence('ev-sp-1', 'claim-s', obs[0]!.id, 'supports'), evidence('ev-sp-2', 'claim-s', obs[2]!.id, 'opposes'),
    ]);
    const results = [
      { claimId: 'claim-x', currentObservationId: obs[1]!.id, observationIds: [obs[0]!.id, obs[1]!.id], evidenceIds: ['ev-sp-1'] },
      { claimId: 'claim-y', currentObservationId: obs[3]!.id, observationIds: [obs[2]!.id, obs[3]!.id], evidenceIds: ['ev-sp-2'] },
    ];
    const result = service().splitClaim({ commandId: 'split-1', actorId: 'op-1', reason: 'mixed topics', expectedSeq: currentSeq(), sourceClaimId: 'claim-s', results });
    expect(result.deduplicated).toBe(false);
    expect(queryEvents({ runId: 'curation:split-1' })[0]!.eventType).toBe('CLAIM_SPLIT');

    const state = rebuildProjection(handlers, { forceGenesis: true });
    expect(state.claims.get('claim-s')!.curationStatus).toBe('split');
    expect(state.claims.get('claim-x')!.observationIds).toEqual([obs[0]!.id, obs[1]!.id]);
    expect(state.claims.get('claim-y')!.observationIds).toEqual([obs[2]!.id, obs[3]!.id]);
    expect(state.evidence.get('ev-sp-1')?.claimId).toBe('claim-x');
    expect(state.evidence.get('ev-sp-2')?.claimId).toBe('claim-y');
  });

  it('setRetraction retracts a claim, its observations, and zeroes evidence counts', () => {
    const obs = [1, 2].map((n) => observation(`rt-obs-${n}`, 'claim-r', n / 10, `2025-01-01T00:00:0${n}.000Z`));
    seed([
      event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-r'),
      observed(obs[0]!, 'claim-r', true), observed(obs[1]!, 'claim-r'),
      evidence('ev-rt', 'claim-r', obs[0]!.id, 'supports'),
    ]);
    const result = service().setRetraction({ commandId: 'retract-1', actorId: 'op-1', reason: 'fabricated', expectedSeq: currentSeq(), target: { kind: 'claim', id: 'claim-r' }, retracted: true });
    expect(result.deduplicated).toBe(false);

    const state = rebuildProjection(handlers, { forceGenesis: true });
    const claim = state.claims.get('claim-r')!;
    expect(claim.curationStatus).toBe('retracted');
    expect(obs.every((o) => state.claimObservations.get(o.id)?.curationStatus === 'retracted')).toBe(true);
    expect(claim.supportingEvidenceCount).toBe(0);
    expect(claim.opposingEvidenceCount).toBe(0);
    expect(() =>
      service().setRetraction({ commandId: 'retract-2', actorId: 'op-1', reason: 'again', expectedSeq: currentSeq(), target: { kind: 'claim', id: 'claim-r' }, retracted: true }),
    ).toThrow(CurationConflictError);
  });

  it('curateRelation upsert adds a new relation visible in projection', () => {
    const a = observation('cr-obs-a', 'claim-a', 0.8, '2025-01-01T00:00:01.000Z');
    const b = observation('cr-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), observed(a, 'claim-a', true), observed(b, 'claim-b', true)]);
    const rel = relation('rel-cr-1', 'claim-a', 'claim-b');
    const result = service().curateRelation({ commandId: 'rel-add-1', actorId: 'op-1', reason: 'link', expectedSeq: currentSeq(), action: 'upsert', relation: rel });
    expect(result.deduplicated).toBe(false);
    const state = rebuildProjection(handlers, { forceGenesis: true });
    expect(state.claimRelations.get(rel.id)).toEqual(rel);
    expect([...state.claimRelationsByFromClaimId.get('claim-a')!]).toContain(rel.id);
  });

  it('curateRelation remove deletes an existing relation from projection', () => {
    const a = observation('rm-obs-a', 'claim-a', 0.8, '2025-01-01T00:00:01.000Z');
    const b = observation('rm-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    seed([
      event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), observed(a, 'claim-a', true), observed(b, 'claim-b', true),
      event('CLAIM_RELATION_CURATED', { curation: { commandId: 'seed-rel', reason: 'seed', expectedSeq: 0 }, relationId: 'rel-rm-1', before: null, after: relation('rel-rm-1', 'claim-a', 'claim-b') }),
    ]);
    service().curateRelation({ commandId: 'rel-remove-1', actorId: 'op-1', reason: 'wrong edge', expectedSeq: currentSeq(), action: 'remove', relationId: 'rel-rm-1' });
    const state = rebuildProjection(handlers, { forceGenesis: true });
    expect(state.claimRelations.has('rel-rm-1')).toBe(false);
    expect(state.claimRelationsByFromClaimId.get('claim-a')?.has('rel-rm-1') ?? true).toBe(false);
  });

  it('overrideEvidenceStance recomputes supporting/opposing counts', () => {
    const first = observation('st-obs-1', 'claim-e', 0.8, '2025-01-01T00:00:01.000Z');
    const second = observation('st-obs-2', 'claim-e', 0.8, '2025-01-01T00:00:02.000Z');
    seed([
      event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-e'),
      observed(first, 'claim-e', true), observed(second, 'claim-e'),
      evidence('ev-sup', 'claim-e', first.id, 'supports'), evidence('ev-opp', 'claim-e', second.id, 'opposes'),
    ]);
    const result = service().overrideEvidenceStance({ commandId: 'stance-1', actorId: 'op-1', reason: 'mislabelled', expectedSeq: currentSeq(), evidenceId: 'ev-opp', stance: 'supports' });
    expect(result.deduplicated).toBe(false);
    const state = rebuildProjection(handlers, { forceGenesis: true });
    expect(state.evidence.get('ev-opp')?.stance).toBe('supports');
    const claim = state.claims.get('claim-e')!;
    expect(claim.supportingEvidenceCount).toBe(2);
    expect(claim.opposingEvidenceCount).toBe(0);
  });

  it('throws StaleProjectionError when expectedSeq does not match projection cursor', () => {
    const obs = observation('sa-obs-1', 'claim-a', 0.7, '2025-01-01T00:00:01.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), observed(obs, 'claim-a', true)]);
    const staleSeq = currentSeq();
    seed([event('SOURCE_READ', { sourceId: 'source-1' })]);
    expect(() =>
      service().mergeClaims({ commandId: 'stale-1', actorId: 'op-1', reason: 'merge', expectedSeq: staleSeq, sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' }),
    ).toThrow(StaleProjectionError);
  });

  it('returns deduplicated prior result for repeated commandId + identical input without new events', () => {
    const a1 = observation('dd-obs-a', 'claim-a', 0.6, '2025-01-01T00:00:01.000Z');
    const b1 = observation('dd-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), observed(a1, 'claim-a', true), observed(b1, 'claim-b', true)]);
    const svc = service();
    const input = { commandId: 'dedup-1', actorId: 'op-1', reason: 'dup', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' } as const;
    const first = svc.mergeClaims(input);
    const before = countEvents();
    const second = svc.mergeClaims({ ...input });
    expect(second.deduplicated).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(second.seq).toBe(first.seq);
    expect(countEvents()).toBe(before);
  });

  it('throws IdempotencyConflictError when same commandId is reused with different input', () => {
    const a1 = observation('cf-obs-a', 'claim-a', 0.6, '2025-01-01T00:00:01.000Z');
    const b1 = observation('cf-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    const c1 = observation('cf-obs-c', 'claim-c', 0.9, '2025-01-01T00:00:03.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), claimSeed('claim-c'), observed(a1, 'claim-a', true), observed(b1, 'claim-b', true), observed(c1, 'claim-c', true)]);
    const svc = service();
    svc.mergeClaims({ commandId: 'conflict-1', actorId: 'op-1', reason: 'dup', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' });
    expect(() =>
      svc.mergeClaims({ commandId: 'conflict-1', actorId: 'op-1', reason: 'dup', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-c' }),
    ).toThrow(IdempotencyConflictError);
  });

  it('records actor identity on the appended event envelope', () => {
    const obs = observation('ac-obs-1', 'claim-a', 0.7, '2025-01-01T00:00:01.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), observed(obs, 'claim-a', true)]);
    service().setRetraction({ commandId: 'actor-1', actorId: 'operator-jane', reason: 'bad data', expectedSeq: currentSeq(), target: { kind: 'observation', id: obs.id }, retracted: true });
    const appended = queryEvents({ runId: 'curation:actor-1' })[0]!;
    expect(appended.actor).toBe('user');
    expect(appended.actorId).toBe('operator-jane');
    const state = rebuildProjection(handlers, { forceGenesis: true });
    expect(state.claimObservations.get(obs.id)?.curationStatus).toBe('retracted');
  });

  it('rejects precondition violations with typed errors (missing claim, invalid partition)', () => {
    expect(() =>
      service().mergeClaims({ commandId: 'pre-1', actorId: 'op-1', reason: 'x', expectedSeq: currentSeq(), sourceClaimId: 'ghost', survivorClaimId: 'also-ghost' }),
    ).toThrow(CurationPreconditionError);
  });

  it('throws IdempotencyConflictError when same commandId is reused by a different actorId', () => {
    const a1 = observation('ia-obs-a', 'claim-a', 0.6, '2025-01-01T00:00:01.000Z');
    const b1 = observation('ia-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), observed(a1, 'claim-a', true), observed(b1, 'claim-b', true)]);
    const svc = service();
    svc.mergeClaims({ commandId: 'actor-conflict-1', actorId: 'op-1', reason: 'dup', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' });
    expect(() =>
      svc.mergeClaims({ commandId: 'actor-conflict-1', actorId: 'op-2', reason: 'dup', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' }),
    ).toThrow(IdempotencyConflictError);
  });

  it('still deduplicates when only expectedSeq differs — concurrency guard is not part of command identity', () => {
    const a1 = observation('es-obs-a', 'claim-a', 0.6, '2025-01-01T00:00:01.000Z');
    const b1 = observation('es-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), observed(a1, 'claim-a', true), observed(b1, 'claim-b', true)]);
    const svc = service();
    const first = svc.mergeClaims({ commandId: 'seq-dedup-1', actorId: 'op-1', reason: 'dup', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' });
    seed([event('SOURCE_READ', { sourceId: 'source-1' })]); // projection moves on; expectedSeq now stale
    const second = svc.mergeClaims({ commandId: 'seq-dedup-1', actorId: 'op-1', reason: 'dup', expectedSeq: currentSeq() - 1, sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' });
    expect(second.deduplicated).toBe(true);
    expect(second.eventId).toBe(first.eventId);
  });

  it('merging an already-merged source is CurationConflictError, not CurationPreconditionError', () => {
    const a1 = observation('mm-obs-a', 'claim-a', 0.6, '2025-01-01T00:00:01.000Z');
    const b1 = observation('mm-obs-b', 'claim-b', 0.8, '2025-01-01T00:00:02.000Z');
    const c1 = observation('mm-obs-c', 'claim-c', 0.9, '2025-01-01T00:00:03.000Z');
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-a'), claimSeed('claim-b'), claimSeed('claim-c'), observed(a1, 'claim-a', true), observed(b1, 'claim-b', true), observed(c1, 'claim-c', true)]);
    const svc = service();
    svc.mergeClaims({ commandId: 'merged-src-1', actorId: 'op-1', reason: 'first merge', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-b' });
    let thrown: unknown;
    try {
      svc.mergeClaims({ commandId: 'merged-src-2', actorId: 'op-1', reason: 'second merge', expectedSeq: currentSeq(), sourceClaimId: 'claim-a', survivorClaimId: 'claim-c' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CurationConflictError);
    expect(thrown).not.toBeInstanceOf(CurationPreconditionError);
  });

  it('legacy-only claim keeps its observationCount and confidence after recompute', () => {
    seed([event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }), source(), claimSeed('claim-l')]);
    const svc = service();
    svc.setRetraction({ commandId: 'legacy-r-1', actorId: 'op-1', reason: 'retract', expectedSeq: currentSeq(), target: { kind: 'claim', id: 'claim-l' }, retracted: true });
    svc.setRetraction({ commandId: 'legacy-r-2', actorId: 'op-1', reason: 'restore', expectedSeq: currentSeq(), target: { kind: 'claim', id: 'claim-l' }, retracted: false });
    const state = rebuildProjection(handlers, { forceGenesis: true });
    const claim = state.claims.get('claim-l')!;
    expect(claim.observationCount).toBe(1);
    expect(claim.confidence).toBe(0.5);
  });
});
