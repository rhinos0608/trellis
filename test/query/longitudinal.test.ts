import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NewEventInput } from '../../src/store/events.js';
import { appendEvents, closeDb, createEmptyProjectionState, getDb, initDb, queryEvents } from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import type { Claim, Evidence, Source, Contradiction, Gap } from '../../src/graph/types.js';
import {
  getBelief,
  getProvenance,
  getTimeline,
  getChanges,
  rankResearchNext,
  synthesizeFamilyView,
} from '../../src/query/longitudinal.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
let liveState: ProjectionState;
let dir: string;

const event = (eventType: NewEventInput['eventType'], payload: unknown, eventVersion = 1): NewEventInput => ({
  eventType, eventVersion, runId: 'longitudinal-test', batchId: null, actor: 'system',
  entityId: null, entityType: null, timestamp: new Date().toISOString(), payload,
});
const family = (id: string) => event('FAMILY_CREATED', { family_id: id, label: id });
const claim = (id: string, familyId: string, text: string, at: string) => ({ ...event('CLAIM_OBSERVED', {
  observation: { id: `obs-${id}`, familyId, runId: 'longitudinal-test', observedAt: at, subjectText: text, predicate: 'improves', objectText: 'research', polarity: 'asserted', hedge: 'certain', evidenceType: 'study', canonicalKey: { subject: text.toLowerCase(), predicate: 'improves' }, confidence: 0.9, sourceIds: [], extractionVersion: 'v1' },
  reconciliation: { observationId: `obs-${id}`, classification: 'new_claim', canonicalClaimId: id, score: 1, method: 'canonical_key_exact', rationale: 'test', reconcilerVersion: 1, candidates: [] },
}), entityId: id });
const source = (id: string) => ({ ...event('SOURCE_OBSERVED', { sourceId: id, observedSourceId: id, canonicalUrl: `https://${id}.example.com`, url: `https://${id}.example.com`, title: id, domain: `${id}.example.com`, sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'longitudinal-test', observedAt: '2024-01-01T00:00:00.000Z' }), entityId: id });
const evidence = (id: string, claimId: string, sourceId: string, obsId: string, stance: 'supports' | 'opposes') => ({ ...event('EVIDENCE_LINKED', { id, claimId, sourceId, observationId: obsId, stance, runId: 'longitudinal-test' }, 2), entityId: id });
const contradiction = (id: string, familyId: string, claimIdA: string, claimIdB: string) => ({ ...event('CONTRADICTION_IDENTIFIED', { id, familyId, claimIdA, claimIdB, contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved', firstSeenRunId: 'longitudinal-test' }), entityId: id });
const gap = (id: string, familyId: string, question: string, category: string, priority: number) => ({ ...event('GAP_OPENED', { id, familyId, question, category, status: 'open', priority, firstSeenRunId: 'longitudinal-test' }), entityId: id });

function append(...events: NewEventInput[]): void {
  appendEvents(events, { projection: liveState, handlers });
}

// ── Build a minimal ProjectionState with test data ──────────────────

function buildTestState(): ProjectionState {
  const state = createEmptyProjectionState();

  // Family
  state.families.set('fam1', { id: 'fam1', label: 'Test Family', description: '', manifest: '', manifestTokens: [], createdAt: '2024-01-01T00:00:00.000Z', lastUpdatedRunId: 'r1' } as never);

  // Claims
  const claimA: Claim = {
    id: 'claim-a', familyId: 'fam1', subjectText: 'React', predicate: 'outperforms', objectText: 'Vue',
    polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
    canonicalKey: { subject: 'react', predicate: 'outperforms' },
    confidence: 0.85, epistemicStatus: 'emerging', contradictionState: 'contested',
    firstSeenRunId: 'r1', lastSeenRunId: 'r1', observationIds: ['obs-a1', 'obs-a2'],
    supportingEvidenceCount: 2, opposingEvidenceCount: 1,
  };
  state.claims.set('claim-a', claimA);
  state.claimsByFamilyId.set('fam1', new Set(['claim-a']));
  state.observationsByClaimId.set('claim-a', new Set(['obs-a1', 'obs-a2']));

  const claimB: Claim = {
    id: 'claim-b', familyId: 'fam1', subjectText: 'Vue', predicate: 'is lighter than', objectText: 'React',
    polarity: 'asserted', hedge: 'likely', evidenceType: 'benchmark',
    canonicalKey: { subject: 'vue', predicate: 'is lighter than' },
    confidence: 0.7, contradictionState: 'none',
    firstSeenRunId: 'r1', lastSeenRunId: 'r1', observationIds: ['obs-b1'],
    supportingEvidenceCount: 1, opposingEvidenceCount: 0,
  };
  state.claims.set('claim-b', claimB);
  state.claimsByFamilyId.get('fam1')!.add('claim-b');
  state.observationsByClaimId.set('claim-b', new Set(['obs-b1']));

  // Observations
  state.claimObservations.set('obs-a1', {
    id: 'obs-a1', familyId: 'fam1', runId: 'r1', observedAt: '2024-01-01T00:00:00.000Z',
    subjectText: 'React', predicate: 'outperforms', objectText: 'Vue', polarity: 'asserted',
    hedge: 'certain', evidenceType: 'study', canonicalKey: { subject: 'react', predicate: 'outperforms' },
    confidence: 0.85, sourceIds: ['src-a'], extractionVersion: 'v1',
  } as never);
  state.claimObservations.set('obs-a2', {
    id: 'obs-a2', familyId: 'fam1', runId: 'r1', observedAt: '2024-01-02T00:00:00.000Z',
    subjectText: 'React', predicate: 'outperforms', objectText: 'Vue', polarity: 'asserted',
    hedge: 'certain', evidenceType: 'study', canonicalKey: { subject: 'react', predicate: 'outperforms' },
    confidence: 0.9, sourceIds: ['src-b'], extractionVersion: 'v1',
  } as never);
  state.claimObservations.set('obs-b1', {
    id: 'obs-b1', familyId: 'fam1', runId: 'r1', observedAt: '2024-01-01T00:00:00.000Z',
    subjectText: 'Vue', predicate: 'is lighter than', objectText: 'React', polarity: 'asserted',
    hedge: 'likely', evidenceType: 'benchmark', canonicalKey: { subject: 'vue', predicate: 'is lighter than' },
    confidence: 0.7, sourceIds: ['src-c'], extractionVersion: 'v1',
  } as never);

  // Sources
  const srcA: Source = {
    id: 'src-a', url: 'https://a.example.com', canonicalUrl: 'https://a.example.com',
    title: 'Official Spec', domain: 'a.example.com', sourceType: 'official_docs',
    authorityClass: 'official_spec', isPrimary: true, extractionStatus: 'extracted',
    retrievedAt: '2024-01-01T00:00:00.000Z', firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    lastSeenAt: '2024-01-01T00:00:00.000Z', runCount: 1,
  };
  const srcB: Source = {
    id: 'src-b', url: 'https://b.example.com', canonicalUrl: 'https://b.example.com',
    title: 'Blog Post', domain: 'b.example.com', sourceType: 'blog_post',
    authorityClass: 'forum_social', isPrimary: false, extractionStatus: 'extracted',
    retrievedAt: '2024-01-01T00:00:00.000Z', firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    lastSeenAt: '2024-01-01T00:00:00.000Z', runCount: 1,
  };
  const srcC: Source = {
    id: 'src-c', url: 'https://c.example.com', canonicalUrl: 'https://c.example.com',
    title: 'News Article', domain: 'c.example.com', sourceType: 'news',
    authorityClass: 'news', isPrimary: false, extractionStatus: 'extracted',
    retrievedAt: '2024-01-01T00:00:00.000Z', firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    lastSeenAt: '2024-01-01T00:00:00.000Z', runCount: 1,
  };
  state.sources.set('src-a', srcA);
  state.sources.set('src-b', srcB);
  state.sources.set('src-c', srcC);

  // Evidence
  const ev1: Evidence = { id: 'ev1', claimId: 'claim-a', sourceId: 'src-a', observationId: 'obs-a1', stance: 'supports', runId: 'r1' };
  const ev2: Evidence = { id: 'ev2', claimId: 'claim-a', sourceId: 'src-b', observationId: 'obs-a2', stance: 'supports', runId: 'r1' };
  const ev3: Evidence = { id: 'ev3', claimId: 'claim-a', sourceId: 'src-c', observationId: 'obs-a1', stance: 'opposes', runId: 'r1' };
  const ev4: Evidence = { id: 'ev4', claimId: 'claim-b', sourceId: 'src-c', observationId: 'obs-b1', stance: 'supports', runId: 'r1' };
  state.evidence.set('ev1', ev1);
  state.evidence.set('ev2', ev2);
  state.evidence.set('ev3', ev3);
  state.evidence.set('ev4', ev4);
  state.evidenceByClaimId.set('claim-a', new Set(['ev1', 'ev2', 'ev3']));
  state.evidenceByClaimId.set('claim-b', new Set(['ev4']));

  // Contradictions
  const contr: Contradiction = {
    id: 'contr-1', familyId: 'fam1', claimIdA: 'claim-a', claimIdB: 'claim-b',
    contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved',
    firstSeenRunId: 'r1',
  };
  state.contradictions.set('contr-1', contr);

  // Gaps
  const g1: Gap = {
    id: 'gap-1', familyId: 'fam1', question: 'What benchmarks support React superiority?',
    category: 'single_source_dependency', status: 'open', priority: 3, firstSeenRunId: 'r1',
  };
  const g2: Gap = {
    id: 'gap-2', familyId: 'fam1', question: 'Are there independent confirmations?',
    category: 'missing_source_type', status: 'open', priority: 1, firstSeenRunId: 'r1',
  };
  state.gaps.set('gap-1', g1);
  state.gaps.set('gap-2', g2);

  return state;
}

// ── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  liveState = createEmptyProjectionState();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-longitudinal-'));
  expect(initDb(path.join(dir, 'test.db'))).not.toBeNull();
  getDb()!.prepare("UPDATE rm_state SET status='ready' WHERE model_name='knowledge'").run();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getBelief', () => {
  it('returns null for unknown claim', () => {
    const state = buildTestState();
    expect(getBelief(state, 'nonexistent')).toBeNull();
  });

  it('returns populated view with counts and strongest evidence', () => {
    const state = buildTestState();
    const belief = getBelief(state, 'claim-a');
    expect(belief).not.toBeNull();
    expect(belief!.claimId).toBe('claim-a');
    expect(belief!.assertion).toBe('React outperforms Vue');
    expect(belief!.confidence).toBe(0.85);
    expect(belief!.epistemicStatus).toBe('emerging');
    expect(belief!.contradictionState).toBe('contested');
    expect(belief!.supportingEvidenceCount).toBe(2);
    expect(belief!.opposingEvidenceCount).toBe(1);
    // Strongest supporting should be src-a (official_spec, rank 0) over src-b (forum_social, rank 9)
    expect(belief!.strongestSupporting).toBeDefined();
    expect(belief!.strongestSupporting!.sourceId).toBe('src-a');
    expect(belief!.strongestSupporting!.authorityClass).toBe('official_spec');
    // Strongest opposing should be src-c (news)
    expect(belief!.strongestOpposing).toBeDefined();
    expect(belief!.strongestOpposing!.sourceId).toBe('src-c');
  });

  it('returns supports-only view for claim-b', () => {
    const state = buildTestState();
    const belief = getBelief(state, 'claim-b');
    expect(belief).not.toBeNull();
    expect(belief!.supportingEvidenceCount).toBe(1);
    expect(belief!.opposingEvidenceCount).toBe(0);
    expect(belief!.strongestSupporting).toBeDefined();
    expect(belief!.strongestOpposing).toBeUndefined();
  });

  it('returns zero evidence counts for claim with no evidence', () => {
    const state = createEmptyProjectionState();
    state.claims.set('claim-empty', {
      id: 'claim-empty', familyId: 'fam-x', subjectText: 'Nothing', predicate: 'exists',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'claim',
      canonicalKey: { subject: 'nothing', predicate: 'exists' },
      confidence: 0.5, contradictionState: 'none',
      firstSeenRunId: 'r1', lastSeenRunId: 'r1', observationIds: [],
      supportingEvidenceCount: 0, opposingEvidenceCount: 0,
    } as never);
    const belief = getBelief(state, 'claim-empty');
    expect(belief).not.toBeNull();
    expect(belief!.supportingEvidenceCount).toBe(0);
    expect(belief!.opposingEvidenceCount).toBe(0);
    expect(belief!.strongestSupporting).toBeUndefined();
    expect(belief!.strongestOpposing).toBeUndefined();
  });
});

describe('getProvenance', () => {
  it('returns null for unknown claim', () => {
    const state = buildTestState();
    expect(getProvenance(state, 'nonexistent')).toBeNull();
  });

  it('walks full chain correctly', () => {
    const state = buildTestState();
    const prov = getProvenance(state, 'claim-a');
    expect(prov).not.toBeNull();
    expect(prov!.claimId).toBe('claim-a');
    expect(prov!.observationCount).toBe(2);

    // obs-a1 has 2 evidence (ev1 supports, ev3 opposes)
    const chain1 = prov!.chains.find((c) => c.observationId === 'obs-a1');
    expect(chain1).toBeDefined();
    expect(chain1!.evidence.length).toBe(2);

    // obs-a2 has 1 evidence (ev2 supports)
    const chain2 = prov!.chains.find((c) => c.observationId === 'obs-a2');
    expect(chain2).toBeDefined();
    expect(chain2!.evidence.length).toBe(1);
    expect(chain2!.evidence[0].sourceId).toBe('src-b');
  });
});

describe('getTimeline', () => {
  it('returns empty for unknown target', () => {
    const entries = getTimeline({ queryEvents }, {});
    expect(entries).toEqual([]);
  });

  it('returns timeline for claimId from real event log', () => {
    append(
      family('fam1'),
      claim('c1', 'fam1', 'Test claim', '2024-01-01T00:00:00.000Z'),
      source('s1'),
      evidence('e1', 'c1', 's1', 'obs-c1', 'supports'),
      claim('c2', 'fam1', 'Competing claim', '2024-01-02T00:00:00.000Z'),
      evidence('e2', 'c2', 's1', 'obs-c2', 'supports'),
    );
    const entries = getTimeline({ queryEvents }, { claimId: 'c1' });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const types = entries.map((e) => e.eventType);
    expect(types).toContain('CLAIM_OBSERVED');
    expect(types).toContain('EVIDENCE_LINKED');
    // Must not include c2's evidence (ev2) — inspect description field
    const c2Evidence = entries.filter((e) => e.eventType === 'EVIDENCE_LINKED' && e.description.includes('ev2'));
    expect(c2Evidence.length).toBe(0);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].seq).toBeGreaterThanOrEqual(entries[i - 1].seq);
    }
  });

  it('returns timeline for sourceId', () => {
    append(source('s1'));
    const entries = getTimeline({ queryEvents }, { sourceId: 's1' });
    expect(entries.length).toBe(1);
    expect(entries[0].eventType).toBe('SOURCE_OBSERVED');
  });

  it('returns timeline for contradictionId', () => {
    append(
      family('fam1'),
      claim('c1', 'fam1', 'A', '2024-01-01T00:00:00.000Z'),
      claim('c2', 'fam1', 'B', '2024-01-01T00:00:00.000Z'),
      contradiction('contr-1', 'fam1', 'c1', 'c2'),
    );
    const entries = getTimeline({ queryEvents }, { contradictionId: 'contr-1' });
    expect(entries.length).toBe(1);
    expect(entries[0].eventType).toBe('CONTRADICTION_IDENTIFIED');
  });

  it('returns timeline for gapId', () => {
    append(
      family('fam1'),
      gap('gap-1', 'fam1', 'What?', 'low_confidence', 1),
    );
    const entries = getTimeline({ queryEvents }, { gapId: 'gap-1' });
    expect(entries.length).toBe(1);
    expect(entries[0].eventType).toBe('GAP_OPENED');
  });

  it('respects limit', () => {
    append(
      family('fam1'),
      claim('c1', 'fam1', 'Test', '2024-01-01T00:00:00.000Z'),
      source('s1'),
      evidence('e1', 'c1', 's1', 'obs-c1', 'supports'),
    );
    const entries = getTimeline({ queryEvents }, { claimId: 'c1' }, { limit: 1 });
    expect(entries.length).toBe(1);
  });
});

describe('getChanges', () => {
  it('returns empty changeset when no events after seq', () => {
    append(family('fam1'), claim('c1', 'fam1', 'A', '2024-01-01T00:00:00.000Z'));
    const cs = getChanges({ queryEvents }, 999);
    expect(cs.newClaims.length).toBe(0);
    expect(cs.sinceSeq).toBe(999);
  });

  it('buckets events correctly', () => {
    append(
      family('fam1'),
      claim('c1', 'fam1', 'New claim', '2024-01-01T00:00:00.000Z'),
      source('s1'),
      evidence('e1', 'c1', 's1', 'obs-c1', 'supports'),
    );
    const cs = getChanges({ queryEvents }, 0);
    expect(cs.newClaims.length).toBeGreaterThanOrEqual(1);
    expect(cs.newEvidence.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by familyId when provided', () => {
    append(
      family('fam1'),
      family('fam2'),
      claim('c1', 'fam1', 'A', '2024-01-01T00:00:00.000Z'),
      claim('c2', 'fam2', 'B', '2024-01-01T00:00:00.000Z'),
    );
    const cs = getChanges({ queryEvents }, 0, { familyId: 'fam1' });
    // Should only include events for fam1
    expect(cs.newClaims.length).toBe(1);
    expect(cs.newClaims[0].description).toContain('A');
  });
});

describe('rankResearchNext', () => {
  it('returns empty for family with no open gaps or contradictions', () => {
    const state = buildTestState();
    expect(rankResearchNext(state, 'empty-family')).toEqual([]);
  });

  it('ranks gaps by priority with single_source_dependency boost', () => {
    const state = buildTestState();
    const ranked = rankResearchNext(state, 'fam1');
    expect(ranked.length).toBe(3); // 2 gaps + 1 contradiction

    // gap-2 (priority 1) should rank first
    expect(ranked[0].id).toBe('gap-2');
    expect(ranked[0].score).toBe(1);

    // contradiction (score 2) should rank second
    expect(ranked[1].id).toBe('contr-1');
    expect(ranked[1].score).toBe(2);

    // gap-1 (priority 3, but single_source_dependency gets -0.5 → 2.5) should rank last
    expect(ranked[2].id).toBe('gap-1');
    expect(ranked[2].score).toBe(2.5);
  });

  it('does not include resolved gaps or contradictions', () => {
    const state = buildTestState();
    // Add a resolved gap
    state.gaps.set('gap-resolved', {
      id: 'gap-resolved', familyId: 'fam1', question: 'Resolved',
      category: 'low_confidence', status: 'resolved', priority: 1, firstSeenRunId: 'r1',
    });
    const ranked = rankResearchNext(state, 'fam1');
    expect(ranked.find((r) => r.id === 'gap-resolved')).toBeUndefined();
  });
});

describe('synthesizeFamilyView', () => {
  it('returns null for unknown family', () => {
    const state = buildTestState();
    expect(synthesizeFamilyView(state, 'nonexistent')).toBeNull();
  });

  it('composes correctly for multi-claim family', () => {
    const state = buildTestState();
    const view = synthesizeFamilyView(state, 'fam1');
    expect(view).not.toBeNull();
    expect(view!.familyId).toBe('fam1');
    expect(view!.familyLabel).toBe('Test Family');
    expect(view!.claimCount).toBe(2);
    expect(view!.beliefs.length).toBe(2);
    expect(view!.contradictions.length).toBe(1);
    expect(view!.contradictions[0].type).toBe('factual_disagreement');
    expect(view!.gaps.length).toBe(2);
    expect(view!.sourceCount).toBe(3);
    expect(view!.sourceIds).toContain('src-a');
    expect(view!.sourceIds).toContain('src-b');
    expect(view!.sourceIds).toContain('src-c');
    expect(view!.researchNext.length).toBe(3);
    expect(view!.narrativeMarkdown).toContain('Test Family');
    expect(view!.narrativeMarkdown).toContain('React outperforms Vue');
  });
});
