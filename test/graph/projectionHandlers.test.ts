import { describe, it, expect } from 'vitest';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import type { ProjectionState } from '../../src/store/projectionState.js';
import type { EventEnvelope } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';

function makeEvent<T>(
  eventType: string,
  payload: T,
  overrides?: Partial<NewEventInput>,
): NewEventInput {
  return {
    timestamp: new Date().toISOString(),
    eventType: eventType as NewEventInput['eventType'],
    eventVersion: 1,
    runId: 'run-1',
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload,
    ...overrides,
  };
}

describe('projectionHandlers', () => {
  function freshState(): ProjectionState {
    return createEmptyProjectionState();
  }

  // ── NODE_ADDED ──────────────────────────────────────────────────────────
  describe('NODE_ADDED', () => {
    it('adds an entity to state', () => {
      const state = freshState();
      graphEventHandlers.NODE_ADDED(
        makeEvent('NODE_ADDED', {
          id: 'e1',
          label: 'React',
          canonicalLabel: null,
          entityType: 'package',
          aliases: [],
          extractionConfidence: 0.9,
          firstSeenRunId: 'run-1',
          lastUpdatedRunId: 'run-1',
          metadata: {},
        }) as EventEnvelope,
        state,
      );
      expect(state.entities.size).toBe(1);
      expect(state.entities.get('e1')!.label).toBe('React');
    });
  });

  // ── NODE_RELABELED ──────────────────────────────────────────────────────
  describe('NODE_RELABELED', () => {
    it('updates entity label', () => {
      const state = freshState();
      state.entities.set('e1', {
        id: 'e1',
        label: 'Old Label',
        canonicalLabel: null,
        entityType: 'package',
        aliases: [],
        extractionConfidence: 0.9,
        firstSeenRunId: 'run-1',
        lastUpdatedRunId: 'run-1',
        metadata: {},
      });
      graphEventHandlers.NODE_RELABELED(
        makeEvent('NODE_RELABELED', { targetId: 'e1', oldLabel: 'Old Label', newLabel: 'New Label' }),
        state,
      );
      expect(state.entities.get('e1')!.label).toBe('New Label');
    });
  });

  // ── NODE_METADATA_UPDATED ───────────────────────────────────────────────
  describe('NODE_METADATA_UPDATED', () => {
    it('sets metadata field', () => {
      const state = freshState();
      state.entities.set('e1', {
        id: 'e1',
        label: 'X',
        canonicalLabel: null,
        entityType: 'package',
        aliases: [],
        extractionConfidence: 0.9,
        firstSeenRunId: 'run-1',
        lastUpdatedRunId: 'run-1',
        metadata: {},
      });
      graphEventHandlers.NODE_METADATA_UPDATED(
        makeEvent('NODE_METADATA_UPDATED', {
          targetId: 'e1',
          field: 'description',
          oldValue: undefined,
          newValue: 'A package',
        }) as EventEnvelope,
        state,
      );
      expect(state.entities.get('e1')!.metadata['description']).toBe('A package');
    });
  });

  // ── ENTITY_MERGED ──────────────────────────────────────────────────────
  describe('ENTITY_MERGED', () => {
    it('removes absorbed entities, merges aliases', () => {
      const state = freshState();
      state.entities.set('e1', {
        id: 'e1',
        label: 'React',
        canonicalLabel: null,
        entityType: 'package',
        aliases: ['reactjs'],
        extractionConfidence: 0.9,
        firstSeenRunId: 'run-1',
        lastUpdatedRunId: 'run-1',
        metadata: {},
      });
      state.entities.set('e2', {
        id: 'e2',
        label: 'React.js',
        canonicalLabel: null,
        entityType: 'package',
        aliases: ['react-js'],
        extractionConfidence: 0.85,
        firstSeenRunId: 'run-2',
        lastUpdatedRunId: 'run-2',
        metadata: { extra: true },
      });
      graphEventHandlers.ENTITY_MERGED(
        makeEvent('ENTITY_MERGED', {
          survivorId: 'e1',
          mergedIds: ['e2'],
          mergedSnapshots: [
            {
              id: 'e2',
              label: 'React.js',
              aliases: ['react-js'],
              metadata: { extra: true },
              claimIds: [],
              evidenceIds: [],
            },
          ],
        }) as EventEnvelope,
        state,
      );
      expect(state.entities.has('e2')).toBe(false);
      expect(state.entities.get('e1')!.aliases).toContain('react-js');
      expect(state.entities.get('e1')!.metadata['extra']).toBe(true);
      expect(state.entityMergeHistory.has('e2')).toBe(true);
    });
  });

  // ── ENTITY_SPLIT ───────────────────────────────────────────────────────
  describe('ENTITY_SPLIT', () => {
    it('removes original entity and records split', () => {
      const state = freshState();
      state.entities.set('e1', {
        id: 'e1',
        label: 'Merged',
        canonicalLabel: null,
        entityType: 'package',
        aliases: [],
        extractionConfidence: 0.9,
        firstSeenRunId: 'run-1',
        lastUpdatedRunId: 'run-1',
        metadata: {},
      });
      graphEventHandlers.ENTITY_SPLIT(
        makeEvent('ENTITY_SPLIT', {
          originalId: 'e1',
          originalSnapshot: { label: 'Merged', aliases: [], metadata: {} },
          resultingIds: ['e2', 'e3'],
        }) as EventEnvelope,
        state,
      );
      expect(state.entities.has('e1')).toBe(false);
      expect(state.entityMergeHistory.has('e1')).toBe(true);
    });
  });

  // ── CLAIM_ACCEPTED ─────────────────────────────────────────────────────
  describe('CLAIM_ACCEPTED', () => {
    it('adds claim and updates family index', () => {
      const state = freshState();
      graphEventHandlers.CLAIM_ACCEPTED(
        makeEvent('CLAIM_ACCEPTED', {
          id: 'c1',
          familyId: 'fam-1',
          subjectText: 'React 19',
          predicate: 'improves',
          polarity: 'asserted',
          hedge: 'certain',
          evidenceType: 'study',
          confidence: 0.9,
          canonicalKey: { subject: 'react 19', predicate: 'improves' },
          contradictionState: 'none',
          firstSeenRunId: 'run-1',
          lastSeenRunId: 'run-1',
        }) as EventEnvelope,
        state,
      );
      expect(state.claims.size).toBe(1);
      expect(state.claimsByFamilyId.get('fam-1')!.has('c1')).toBe(true);
    });
  });

  // ── EVIDENCE_LINKED ────────────────────────────────────────────────────
  describe('EVIDENCE_LINKED', () => {
    it('adds evidence and updates claim index', () => {
      const state = freshState();
      graphEventHandlers.EVIDENCE_LINKED(
        makeEvent('EVIDENCE_LINKED', {
          id: 'ev1',
          claimId: 'c1',
          sourceId: 'src-1',
          runId: 'run-1',
        }) as EventEnvelope,
        state,
      );
      expect(state.evidence.size).toBe(1);
      expect(state.evidenceByClaimId.get('c1')!.has('ev1')).toBe(true);
    });
  });

  // ── CONTRADICTION_IDENTIFIED ───────────────────────────────────────────
  describe('CONTRADICTION_IDENTIFIED', () => {
    it('adds contradiction', () => {
      const state = freshState();
      graphEventHandlers.CONTRADICTION_IDENTIFIED(
        makeEvent('CONTRADICTION_IDENTIFIED', {
          id: 'cn1',
          familyId: 'fam-1',
          claimIdA: 'c1',
          claimIdB: 'c2',
          contradictionType: 'factual_disagreement',
          resolutionStatus: 'unresolved',
          firstSeenRunId: 'run-1',
        }) as EventEnvelope,
        state,
      );
      expect(state.contradictions.size).toBe(1);
      expect(state.contradictions.get('cn1')!.resolutionStatus).toBe('unresolved');
    });
  });

  // ── CONTRADICTION_RESOLVED ─────────────────────────────────────────────
  describe('CONTRADICTION_RESOLVED', () => {
    it('updates resolution status', () => {
      const state = freshState();
      state.contradictions.set('cn1', {
        id: 'cn1',
        familyId: 'fam-1',
        claimIdA: 'c1',
        claimIdB: 'c2',
        contradictionType: 'factual_disagreement',
        resolutionStatus: 'unresolved',
        firstSeenRunId: 'run-1',
      });
      graphEventHandlers.CONTRADICTION_RESOLVED(
        makeEvent('CONTRADICTION_RESOLVED', {
          contradictionId: 'cn1',
          previousStatus: 'unresolved',
          newStatus: 'resolved',
        }) as EventEnvelope,
        state,
      );
      expect(state.contradictions.get('cn1')!.resolutionStatus).toBe('resolved');
    });
  });

  // ── GAP_OPENED ─────────────────────────────────────────────────────────
  describe('GAP_OPENED', () => {
    it('adds gap', () => {
      const state = freshState();
      graphEventHandlers.GAP_OPENED(
        makeEvent('GAP_OPENED', {
          id: 'g1',
          familyId: 'fam-1',
          question: 'What about edge cases?',
          category: 'unanswered_sub_question',
          status: 'open',
          priority: 1,
          firstSeenRunId: 'run-1',
        }) as EventEnvelope,
        state,
      );
      expect(state.gaps.size).toBe(1);
      expect(state.gaps.get('g1')!.status).toBe('open');
    });
  });

  // ── GAP_RESOLVED ───────────────────────────────────────────────────────
  describe('GAP_RESOLVED', () => {
    it('updates gap status', () => {
      const state = freshState();
      state.gaps.set('g1', {
        id: 'g1',
        familyId: 'fam-1',
        question: 'Q?',
        category: 'low_confidence',
        status: 'open',
        priority: 2,
        firstSeenRunId: 'run-1',
      });
      graphEventHandlers.GAP_RESOLVED(
        makeEvent('GAP_RESOLVED', {
          gapId: 'g1',
          previousStatus: 'open',
          newStatus: 'resolved',
          resolution: { answer: 'Answer', evidenceSummary: 'Evidence' },
        }) as EventEnvelope,
        state,
      );
      expect(state.gaps.get('g1')!.status).toBe('resolved');
      expect(state.gaps.get('g1')!.resolution!.answer).toBe('Answer');
    });
  });

  // ── SOURCE_ADDED ───────────────────────────────────────────────────────
  describe('SOURCE_ADDED', () => {
    it('adds source', () => {
      const state = freshState();
      graphEventHandlers.SOURCE_ADDED(
        makeEvent('SOURCE_ADDED', {
          id: 'src-1',
          url: 'https://example.com',
          domain: 'example.com',
          sourceType: 'web',
          isPrimary: true,
          extractionStatus: 'pending',
          contentHash: 'abc',
          retrievedAt: new Date().toISOString(),
          firstSeenRunId: 'run-1',
        }) as EventEnvelope,
        state,
      );
      expect(state.sources.size).toBe(1);
      expect(state.sources.get('src-1')!.url).toBe('https://example.com');
    });
  });

  // ── SOURCE_READ ────────────────────────────────────────────────────────
  describe('SOURCE_READ', () => {
    it('marks source as read', () => {
      const state = freshState();
      state.sources.set('src-1', {
        id: 'src-1',
        url: 'https://example.com',
        domain: 'example.com',
        sourceType: 'web',
        isPrimary: true,
        extractionStatus: 'pending',
        contentHash: 'abc',
        retrievedAt: new Date().toISOString(),
        firstSeenRunId: 'run-1',
      });
      graphEventHandlers.SOURCE_READ(
        makeEvent('SOURCE_READ', { sourceId: 'src-1' }),
        state,
      );
      expect(state.sources.get('src-1')!.usageStatus).toBe('read');
    });
  });

  // ── SOURCE_CHANGED ─────────────────────────────────────────────────────
  describe('SOURCE_CHANGED', () => {
    it('updates content hash', () => {
      const state = freshState();
      state.sources.set('src-1', {
        id: 'src-1',
        url: 'https://example.com',
        domain: 'example.com',
        sourceType: 'web',
        isPrimary: true,
        extractionStatus: 'pending',
        contentHash: 'old-hash',
        retrievedAt: new Date().toISOString(),
        firstSeenRunId: 'run-1',
      });
      graphEventHandlers.SOURCE_CHANGED(
        makeEvent('SOURCE_CHANGED', {
          sourceId: 'src-1',
          oldContentHash: 'old-hash',
          newContentHash: 'new-hash',
        }) as EventEnvelope,
        state,
      );
      expect(state.sources.get('src-1')!.contentHash).toBe('new-hash');
    });
  });

  // ── SOURCE_RETRACTED ───────────────────────────────────────────────────
  describe('SOURCE_RETRACTED', () => {
    it('marks source as discarded', () => {
      const state = freshState();
      state.sources.set('src-1', {
        id: 'src-1',
        url: 'https://example.com',
        domain: 'example.com',
        sourceType: 'web',
        isPrimary: true,
        extractionStatus: 'pending',
        contentHash: 'abc',
        retrievedAt: new Date().toISOString(),
        firstSeenRunId: 'run-1',
      });
      graphEventHandlers.SOURCE_RETRACTED(
        makeEvent('SOURCE_RETRACTED', {
          sourceId: 'src-1',
          reasonType: 'low_relevance',
        }) as EventEnvelope,
        state,
      );
      expect(state.sources.get('src-1')!.usageStatus).toBe('discarded');
      expect(state.sources.get('src-1')!.discardReason).toBe('low_relevance');
    });
  });

  // ── EDGE_ADDED ─────────────────────────────────────────────────────────
  describe('EDGE_ADDED', () => {
    it('adds claim relation and updates indices', () => {
      const state = freshState();
      graphEventHandlers.EDGE_ADDED(
        makeEvent('EDGE_ADDED', {
          id: 'cr1',
          fromClaimId: 'c1',
          toClaimId: 'c2',
          relation: 'supports',
          strength: 'strong',
          score: 0.9,
          runId: 'run-1',
        }) as EventEnvelope,
        state,
      );
      expect(state.claimRelations.size).toBe(1);
      expect(state.claimRelationsByFromClaimId.get('c1')!.has('cr1')).toBe(true);
      expect(state.claimRelationsByToClaimId.get('c2')!.has('cr1')).toBe(true);
    });
  });

  // ── EDGE_REMOVED ───────────────────────────────────────────────────────
  describe('EDGE_REMOVED', () => {
    it('removes claim relation and cleans indices', () => {
      const state = freshState();
      state.claimRelations.set('cr1', {
        id: 'cr1',
        fromClaimId: 'c1',
        toClaimId: 'c2',
        relation: 'supports',
        strength: 'strong',
        score: 0.9,
        runId: 'run-1',
      });
      let fromSet = state.claimRelationsByFromClaimId.get('c1');
      if (!fromSet) {
        fromSet = new Set();
        state.claimRelationsByFromClaimId.set('c1', fromSet);
      }
      fromSet.add('cr1');
      let toSet = state.claimRelationsByToClaimId.get('c2');
      if (!toSet) {
        toSet = new Set();
        state.claimRelationsByToClaimId.set('c2', toSet);
      }
      toSet.add('cr1');

      graphEventHandlers.EDGE_REMOVED(
        makeEvent('EDGE_REMOVED', { edgeId: 'cr1' }),
        state,
      );
      expect(state.claimRelations.has('cr1')).toBe(false);
      expect(state.claimRelationsByFromClaimId.get('c1')!.has('cr1')).toBe(false);
      expect(state.claimRelationsByToClaimId.get('c2')!.has('cr1')).toBe(false);
    });
  });
});
