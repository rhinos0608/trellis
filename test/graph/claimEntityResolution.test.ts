import { describe, expect, it } from 'vitest';
import { resolveClaimEntities } from '../../src/graph/claimEntityResolution.js';
import type { CanonicalEntity, ClaimObservation } from '../../src/graph/types.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';

function obs(overrides: Partial<ClaimObservation> = {}): ClaimObservation {
  return {
    id: 'obs-1', familyId: 'f1', runId: 'run-1', observedAt: '2025-01-01',
    confidence: 0.9, sourceIds: [], extractionVersion: 'test',
    subjectText: 'NVIDIA H100', predicate: 'has', objectText: '80GB VRAM',
    polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
    canonicalKey: { subject: 'nvidia h100', predicate: 'has' },
    ...overrides,
  };
}

function entity(id: string, label: string, overrides: Partial<CanonicalEntity> = {}): CanonicalEntity {
  return {
    id, label, canonicalLabel: null, entityType: 'concept', aliases: [],
    extractionConfidence: 0.9, firstSeenRunId: 'run-0', lastSeenRunId: 'run-0',
    metadata: {}, ...overrides,
  };
}

function stateWith(...entities: CanonicalEntity[]) {
  const state = createEmptyProjectionState();
  for (const e of entities) state.entities.set(e.id, e);
  return state;
}

describe('resolveClaimEntities', () => {
  const defaultOpts = { runId: 'run-1' };

  it('reuses existing entity id when confident single candidate found (case variant)', () => {
    // "NVIDIA H100" vs existing "nvidia h100" — same normalized label → exact match
    const existing = entity('e1', 'nvidia h100');
    const state = stateWith(existing);
    const result = resolveClaimEntities(obs({ objectText: undefined }), state, defaultOpts);
    expect(result.subjectEntityId).toBe('e1');
    expect(result.entityEvents).toHaveLength(0); // no NODE_ADDED
  });

  it('mints new entity when no candidates exist', () => {
    const state = stateWith(); // empty
    const result = resolveClaimEntities(
      obs({ subjectText: 'PostgreSQL', objectText: 'relational DB' }),
      state,
      defaultOpts,
    );
    expect(result.subjectEntityId).toBeDefined();
    expect(result.objectEntityId).toBeDefined();
    expect(result.subjectEntityId).not.toBe(result.objectEntityId);
    expect(result.entityEvents).toHaveLength(2);
    expect(result.entityEvents[0]!.eventType).toBe('NODE_ADDED');
    expect(result.entityEvents[0]!.payload.entityType).toBe('concept');
    expect(result.entityEvents[1]!.eventType).toBe('NODE_ADDED');
  });

  it('ambiguity guard: near-tied candidates mint new entity', () => {
    // Two entities with very similar labels that produce near-tied scores
    const e1 = entity('e1', 'H100 GPU');
    const e2 = entity('e2', 'H100 TPU');
    const state = stateWith(e1, e2);
    const result = resolveClaimEntities(
      obs({ subjectText: 'H100 chip' }),
      state,
      defaultOpts,
    );
    // "H100 chip" vs "H100 GPU" and "H100 TPU" — Jaccard = 1/3 ≈ 0.33 for both
    // Both below AMBIGUITY_CONFIDENT_SCORE (0.50), gap is ~0 → ambiguity guard triggers
    // Should mint new entity
    expect(result.subjectEntityId).toBeDefined();
    expect(result.subjectEntityId).not.toBe('e1');
    expect(result.subjectEntityId).not.toBe('e2');
    expect(result.entityEvents).toHaveLength(2); // subject (ambiguity guard) + object (80GB VRAM)
  });

  it('llmJudgesSameEntity returns true → reuses entity (no NODE_ADDED)', () => {
    const e1 = entity('e1', 'H100 GPU');
    const e2 = entity('e2', 'H100 TPU');
    const state = stateWith(e1, e2);
    const result = resolveClaimEntities(
      obs({ subjectText: 'H100 chip', objectText: undefined }),
      state,
      { ...defaultOpts, llmJudgesSameEntity: () => true },
    );
    // LLM says it's the same → reuse best candidate
    expect(result.subjectEntityId).toBe('e1');
    expect(result.entityEvents).toHaveLength(0);
  });

  it('llmJudgesSameEntity returns false → mints new entity', () => {
    const e1 = entity('e1', 'H100 GPU');
    const e2 = entity('e2', 'H100 TPU');
    const state = stateWith(e1, e2);
    const result = resolveClaimEntities(
      obs({ subjectText: 'H100 chip', objectText: undefined }),
      state,
      { ...defaultOpts, llmJudgesSameEntity: () => false },
    );
    // LLM says no match → mint new
    expect(result.subjectEntityId).toBeDefined();
    expect(result.subjectEntityId).not.toBe('e1');
    expect(result.subjectEntityId).not.toBe('e2');
    expect(result.entityEvents).toHaveLength(1);
    expect(result.entityEvents[0]!.eventType).toBe('NODE_ADDED');
  });

  it('llmJudgesSameEntity throws → fail-safe: mints new entity', () => {
    const e1 = entity('e1', 'H100 GPU');
    const e2 = entity('e2', 'H100 TPU');
    const state = stateWith(e1, e2);
    const result = resolveClaimEntities(
      obs({ subjectText: 'H100 chip', objectText: undefined }),
      state,
      { ...defaultOpts, llmJudgesSameEntity: () => { throw new Error('LLM timeout'); } },
    );
    // LLM threw → fail-safe mint new
    expect(result.subjectEntityId).toBeDefined();
    expect(result.subjectEntityId).not.toBe('e1');
    expect(result.entityEvents).toHaveLength(1);
    expect(result.entityEvents[0]!.eventType).toBe('NODE_ADDED');
  });

  it('llmJudgesSameEntity not provided → current behavior unchanged (ambiguity guard mints)', () => {
    const e1 = entity('e1', 'H100 GPU');
    const e2 = entity('e2', 'H100 TPU');
    const state = stateWith(e1, e2);
    const result = resolveClaimEntities(
      obs({ subjectText: 'H100 chip', objectText: undefined }),
      state,
      defaultOpts, // no llmJudgesSameEntity
    );
    // No LLM → ambiguity guard mints as before
    expect(result.subjectEntityId).toBeDefined();
    expect(result.subjectEntityId).not.toBe('e1');
    expect(result.subjectEntityId).not.toBe('e2');
    expect(result.entityEvents).toHaveLength(1);
    expect(result.entityEvents[0]!.eventType).toBe('NODE_ADDED');
  });

  it('llmJudgesSameEntity returns Promise → fail-safe: mints new entity', () => {
    const e1 = entity('e1', 'H100 GPU');
    const e2 = entity('e2', 'H100 TPU');
    const state = stateWith(e1, e2);
    const result = resolveClaimEntities(
      obs({ subjectText: 'H100 chip', objectText: undefined }),
      state,
      { ...defaultOpts, llmJudgesSameEntity: async () => true },
    );
    // Promise not trusted in sync context → mint new
    expect(result.subjectEntityId).not.toBe('e1');
    expect(result.entityEvents).toHaveLength(1);
  });

  it('two genuinely distinct entities do not collide', () => {
    const e1 = entity('e1', 'PostgreSQL');
    const state = stateWith(e1);
    const result = resolveClaimEntities(
      obs({ subjectText: 'Oracle Database', objectText: undefined }),
      state,
      defaultOpts,
    );
    // "Oracle Database" vs "PostgreSQL" — Jaccard = 0 → no match
    expect(result.subjectEntityId).toBeDefined();
    expect(result.subjectEntityId).not.toBe('e1');
    expect(result.entityEvents).toHaveLength(1); // only subject (no match → mint)
  });

  it('skips empty/undefined objectText', () => {
    const state = stateWith();
    const result = resolveClaimEntities(
      obs({ objectText: undefined }),
      state,
      defaultOpts,
    );
    expect(result.objectEntityId).toBeUndefined();
    expect(result.entityEvents).toHaveLength(1); // only subject entity
  });

  it('uses custom idGen', () => {
    let counter = 0;
    const state = stateWith();
    const result = resolveClaimEntities(obs(), state, {
      ...defaultOpts,
      idGen: () => `custom-${++counter}`,
    });
    expect(result.entityEvents[0]!.payload.id).toBe('entity_custom-1');
  });
});
