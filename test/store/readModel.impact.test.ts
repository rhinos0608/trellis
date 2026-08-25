import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../src/store/eventTypes.js';
import { createEmptyProjectionState } from '../../src/store/index.js';
import { READ_MODEL_IMPACT } from '../../src/store/readModel/index.js';

const envelope = (eventType: EventEnvelope['eventType'], id: string, payload: unknown): EventEnvelope => ({
  seq: 1,
  id,
  timestamp: '2025-01-01T00:00:00.000Z',
  eventType,
  eventVersion: 1,
  runId: 'run-test',
  batchId: null,
  actor: 'system',
  entityId: null,
  entityType: null,
  payload,
  payloadHash: 'hash',
});

describe('read-model impact resolvers', () => {
  it('marks curation events dirty until read-model handlers exist', () => {
    for (const eventType of ['CLAIM_MERGED', 'CLAIM_SPLIT', 'CLAIM_RETRACTION_SET', 'CLAIM_RELATION_CURATED', 'EVIDENCE_STANCE_OVERRIDDEN'] as const) {
      expect(READ_MODEL_IMPACT[eventType](envelope(eventType, `event-${eventType}`, {}), createEmptyProjectionState()).dirty).toBe(true);
    }
  });

  it('returns multi-collection impacts for observed claims and linked evidence', () => {
    const state = createEmptyProjectionState();
    const observed = envelope('CLAIM_OBSERVED', 'event-observed', {
      observation: { id: 'observation-1' },
      reconciliation: { canonicalClaimId: 'claim-canonical', matchedClaimId: 'claim-matched', classification: 'near_duplicate' },
    });
    expect(READ_MODEL_IMPACT.CLAIM_OBSERVED(observed, state)).toEqual({
      claimIds: ['claim-canonical', 'claim-matched'],
      observationIds: ['observation-1'],
      relationIds: ['rel_event-observed'],
    });

    const linked = envelope('EVIDENCE_LINKED', 'event-evidence', { id: 'evidence-1', claimId: 'claim-canonical' });
    expect(READ_MODEL_IMPACT.EVIDENCE_LINKED(linked, state)).toEqual({
      evidenceIds: ['evidence-1'],
      claimIds: ['claim-canonical'],
    });
  });
});
