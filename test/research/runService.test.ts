import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDb,
  closeDb,
  appendEvents as appendEventsStore,
  queryEvents,
  rebuildProjection,
  rollbackRun,
} from '../../src/store/index.js';
import type { EventEnvelope, TrellisEventType } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { planClaimObservation } from '../../src/graph/claimReconciler.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import {
  createRunService,
  mapFindingToClaimEvents,
  mapSourceToEvents,
  mapGapToEvents,
  buildCompletionEvents,
  buildStateOutputEvents,
} from '../../src/research/runService.js';
import type {
  Finding,
  GapRecord,
  SourceEntry,
  ResearchResult,
} from '../../src/research/internalTypes.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { BudgetTracker } from '../../src/research/budget.js';
import type { TrellisConfig } from '../../src/config/index.js';

// ── Mock provider ────────────────────────────────────────────────────

const mockProvider: ResearchProvider = {
  name: 'mock',
  capabilities: {
    search: true, read: true, academic: false, code: false,
    community: { reddit: false, hackernews: false, stackoverflow: false },
    media: false, reference: false, browser: false,
  },
  search: async () => [{ url: 'https://example.com', title: 'Test', snippet: 'test snippet' }],
  read: async (_ctx, url) => ({ url, title: 'Test', content: 'test content', contentHash: 'hash1' }),
  crawl: async () => [],
  academic: async () => [],
};

const mockConfig: TrellisConfig = {
  storage: { dbPath: ':memory:' },
  llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
  searchProvider: { command: 'echo', args: [] },
  logLevel: 'silent',
};

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

function makeFinding(id: string, claim: string, sourceIds: string[]): Finding {
  return {
    id,
    claim,
    normalizedClaim: claim.toLowerCase(),
    evidenceExcerpt: `evidence for ${claim}`,
    evidenceDirectness: 'direct',
    claimType: 'primary',
    sourceIds,
    subQuestionIds: ['sq1'],
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

function makeSourceEntry(id: string): SourceEntry {
  return {
    id,
    title: `Source ${id}`,
    url: `https://example.com/${id}`,
    sourceType: 'web',
    domain: 'example.com',
    accessDate: new Date().toISOString(),
    isPrimary: true,
    relevantSubQuestions: ['sq1'],
    extractionStatus: 'extracted',
    subQuestionId: 'sq1',
    qualityScore: 0.8,
    contentHash: `hash_${id}`,
  };
}

function makeGap(id: string): GapRecord {
  return {
    id,
    category: 'low_confidence',
    description: `Gap ${id}: missing info`,
    status: 'open',
    suggestedActions: ['search more'],
    priority: 1,
  };
}

function makeResearchResult(findings: Finding[], sources: SourceEntry[]): ResearchResult {
  return {
    report: {
      query: 'test query',
      classification: 'explainer',
      depth: 'standard',
      degradationMode: 'deep',
      executiveSummary: 'summary',
      narrativeMarkdown: '# Report\n\nTest report content.',
      themes: [],
      contradictions: [],
      uncertainties: [],
      sourceNotes: [],
      openQuestions: [],
      limitations: [],
      sourceCount: sources.length,
      sourceTypeCount: 1,
      sourceDiversity: [{ type: 'web', count: sources.length }],
      findingCount: findings.length,
      evidenceSources: sources.map((s, i) => ({
        index: i, title: s.title, url: s.url, sourceType: s.sourceType, domain: s.domain,
      })),
      findingClusters: [],
      findingClusterEdges: [],
    },
    timeline: [{ phase: 'complete', percent: 100 }],
    canonicalFindings: findings,
  };
}

const TEST_HANDLERS: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
function appendEvents(events: readonly NewEventInput[]) {
  const projection = createEmptyProjectionState();
  projection.lastAppliedSeq = queryEvents({}).at(-1)?.seq ?? 0;
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.familyId === 'string') projection.families.set(p.familyId, { id: p.familyId, label: p.familyId, manifest: { scopeQuery: p.familyId }, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), relatedFamilies: [] } as never);
  }
  return appendEventsStore(events, { projection, handlers: TEST_HANDLERS });
}

function makeEvent(
  overrides: Partial<NewEventInput> & { eventType: TrellisEventType; runId: string },
): NewEventInput {
  return {
    timestamp: new Date().toISOString(),
    eventVersion: 1,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-run-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = initDb(dbPath);
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Mapping unit tests ───────────────────────────────────────────────

describe('mapping: Finding → Claim + Evidence events', () => {
  it('produces CLAIM_OBSERVED and one EVIDENCE_LINKED per sourceId', () => {
    const finding = makeFinding('f1', 'TypeScript is better than JavaScript', ['src1', 'src2']);
    const events = mapFindingToClaimEvents(finding, 'fam1', 'run1');

    const claims = events.filter((e) => e.eventType === 'CLAIM_OBSERVED');
    expect(claims).toHaveLength(1);

    const evidence = events.filter((e) => e.eventType === 'EVIDENCE_LINKED');
    expect(evidence).toHaveLength(2);

    const claimPayload = claims[0]!.payload as { observation: Record<string, unknown>; reconciliation: { canonicalClaimId: string } };
    expect(claimPayload.reconciliation.canonicalClaimId).toBe('claim_obs_run1_f1');
    expect(claimPayload.observation.familyId).toBe('fam1');
    expect(claimPayload.observation.subjectText).toBe('TypeScript is better than JavaScript');
    // confidence 0.9 > 0.8 → certain
    expect(claimPayload.observation.hedge).toBe('certain');

    for (const ev of evidence) {
      const p = ev.payload as Record<string, unknown>;
      expect(p.claimId).toBe('claim_obs_run1_f1');
      expect(typeof p.sourceId).toBe('string');
    }
  });

  it('maps claimType anecdote → evidenceType anecdote', () => {
    const finding: Finding = {
      ...makeFinding('f2', 'Anecdotal claim', ['s1']),
      claimType: 'anecdotal',
      confidence: 0.3,
    };
    const events = mapFindingToClaimEvents(finding, 'fam1', 'run1');
    const claimPayload = events[0]!.payload as { observation: Record<string, unknown> };
    expect(claimPayload.observation.evidenceType).toBe('anecdote');
    expect(claimPayload.observation.hedge).toBe('possible'); // confidence 0.3 < 0.5
  });
});

describe('mapping: SourceEntry → SOURCE_OBSERVED + SOURCE_READ events', () => {
  it('emits SOURCE_OBSERVED + SOURCE_READ for extracted sources', () => {
    const src = makeSourceEntry('s1');
    const events = mapSourceToEvents(src, 'run1');
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe('SOURCE_OBSERVED');
    expect(events[1]!.eventType).toBe('SOURCE_READ');
  });

  it('emits only SOURCE_OBSERVED when extractionStatus is pending', () => {
    const src = { ...makeSourceEntry('s2'), extractionStatus: 'pending' as const };
    const events = mapSourceToEvents(src, 'run1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('SOURCE_OBSERVED');
  });

  it('collapses duplicate canonical URLs to one observation per run', () => {
    const state = new ResearchStateEngine(new BudgetTracker({ maxStateEntries: 20 }));
    state.initialize('query', state.getBudget());
    state.addSource({ ...makeSourceEntry('first'), url: 'https://example.com/page#one', contentHash: undefined });
    state.addSource({ ...makeSourceEntry('second'), url: 'https://example.com/page#two', extractionStatus: 'extracted', contentHash: 'hash-rich' });

    const events = buildStateOutputEvents(state, 'fam1', 'run1');
    expect(events.filter((event) => event.eventType === 'SOURCE_OBSERVED')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'SOURCE_READ')).toHaveLength(1);
    expect((events.find((event) => event.eventType === 'SOURCE_OBSERVED')!.payload as { contentHash?: string }).contentHash).toBe('hash-rich');
  });
});

describe('mapping: GapRecord → GAP_OPENED events', () => {
  it('maps gap fields correctly', () => {
    const gap = makeGap('g1');
    const events = mapGapToEvents(gap, 'fam1', 'run1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('GAP_OPENED');
    const p = events[0]!.payload as Record<string, unknown>;
    expect(p.id).toBe('gap_g1');
    expect(p.familyId).toBe('fam1');
    expect(p.category).toBe('low_confidence');
  });
});

describe('mapping: buildCompletionEvents', () => {
  it('maps findings to claims + evidence, and contradictions to CONTRADICTION_IDENTIFIED', () => {
    const findings = [
      makeFinding('f1', 'Claim A', ['s1']),
      makeFinding('f2', 'Claim B', ['s2']),
    ];
    const sources = [makeSourceEntry('s1'), makeSourceEntry('s2')];
    const result = makeResearchResult(findings, sources);

    // Add a contradiction
    result.report.contradictions.push({
      id: 'ic1',
      claimA: 'Claim A',
      claimB: 'Claim B',
      sourceIdsA: ['s1'],
      sourceIdsB: ['s2'],
      contradictionType: 'factual_disagreement',
      resolutionStatus: 'unresolved',
    });

    const events = buildCompletionEvents(result, 'fam1', 'run1');

    expect(events.filter((e) => e.eventType === 'CLAIM_OBSERVED')).toHaveLength(2);
    expect(events.filter((e) => e.eventType === 'EVIDENCE_LINKED')).toHaveLength(2);
    expect(events.filter((e) => e.eventType === 'CONTRADICTION_IDENTIFIED')).toHaveLength(1);
  });
});

describe('mapping: buildCompletionEvents — claim id referential integrity', () => {
  it('resolves contradiction claimIdA/claimIdB to actual persisted canonical claim ids', () => {
    const findings = [
      makeFinding('f1', 'Claim A', ['s1']),
      makeFinding('f2', 'Claim B', ['s2']),
    ];
    const result = makeResearchResult(findings, []);
    result.report.contradictions.push({
      id: 'c1',
      claimA: 'Claim A',
      claimB: 'Claim B',
      sourceIdsA: ['s1'],
      sourceIdsB: ['s2'],
      contradictionType: 'factual_disagreement',
      resolutionStatus: 'unresolved',
    });

    const events = buildCompletionEvents(result, 'fam1', 'run1');
    const claimEvents = events.filter((e) => e.eventType === 'CLAIM_OBSERVED');
    const contradictionEvents = events.filter((e) => e.eventType === 'CONTRADICTION_IDENTIFIED');

    expect(contradictionEvents).toHaveLength(1);
    const payload = contradictionEvents[0]!.payload as { claimIdA: string; claimIdB: string };
    const persistedClaimIds = new Set(claimEvents.map((e) => e.entityId));
    expect(persistedClaimIds.has(payload.claimIdA)).toBe(true);
    expect(persistedClaimIds.has(payload.claimIdB)).toBe(true);
  });

  it('skips a contradiction whose claim text does not match any persisted finding, rather than emitting a dangling reference', () => {
    const findings = [makeFinding('f1', 'Claim A', ['s1'])];
    const result = makeResearchResult(findings, []);
    result.report.contradictions.push({
      id: 'c1',
      claimA: 'Some unrelated claim text never extracted as a finding',
      claimB: 'Claim A',
      sourceIdsA: ['s9'],
      sourceIdsB: ['s1'],
      contradictionType: 'factual_disagreement',
      resolutionStatus: 'unresolved',
    });

    const events = buildCompletionEvents(result, 'fam1', 'run1');
    expect(events.filter((e) => e.eventType === 'CONTRADICTION_IDENTIFIED')).toHaveLength(0);
  });

  it('resolves cluster edge fromClaimId/toClaimId to representative canonical claim ids', () => {
    const findings = [
      makeFinding('f1', 'Claim A', ['s1']),
      makeFinding('f2', 'Claim B', ['s2']),
    ];
    const result = makeResearchResult(findings, []);
    result.report.findingClusters = [
      { id: 'clu1', findingIds: ['f1'], normalizedClaim: 'claim a', sourceCount: 1 },
      { id: 'clu2', findingIds: ['f2'], normalizedClaim: 'claim b', sourceCount: 1 },
    ];
    result.report.findingClusterEdges = [
      { id: 'e1', fromClusterId: 'clu1', toClusterId: 'clu2', relation: 'contradicts', strength: 'strong', score: 0.9 },
    ];

    const events = buildCompletionEvents(result, 'fam1', 'run1');
    const claimEvents = events.filter((e) => e.eventType === 'CLAIM_OBSERVED');
    const edgeEvents = events.filter((e) => e.eventType === 'EDGE_ADDED');

    expect(edgeEvents).toHaveLength(1);
    const payload = edgeEvents[0]!.payload as { fromClaimId: string; toClaimId: string };
    const persistedClaimIds = new Set(claimEvents.map((e) => e.entityId));
    expect(persistedClaimIds.has(payload.fromClaimId)).toBe(true);
    expect(persistedClaimIds.has(payload.toClaimId)).toBe(true);
  });

  it('skips a cluster edge referencing a cluster with no findings, rather than emitting a dangling reference', () => {
    const findings = [makeFinding('f1', 'Claim A', ['s1'])];
    const result = makeResearchResult(findings, []);
    result.report.findingClusters = [
      { id: 'clu1', findingIds: ['f1'], normalizedClaim: 'claim a', sourceCount: 1 },
      { id: 'clu2', findingIds: [], normalizedClaim: 'empty cluster', sourceCount: 0 },
    ];
    result.report.findingClusterEdges = [
      { id: 'e1', fromClusterId: 'clu1', toClusterId: 'clu2', relation: 'contradicts', strength: 'weak', score: 0.5 },
    ];

    const events = buildCompletionEvents(result, 'fam1', 'run1');
    expect(events.filter((e) => e.eventType === 'EDGE_ADDED')).toHaveLength(0);
  });
});

// ── Full lifecycle test ──────────────────────────────────────────────

describe('run lifecycle: start → persist → queryable', () => {
  it('startRun → background completes → getStatus shows completed', async () => {
    const svc = createRunService();

    const { runId, familyId } = await svc.startRun({
      query: 'What is the best TypeScript framework?',
      provider: mockProvider,
      config: mockConfig,
      strategy: 'pipeline',
    });

    expect(runId).toBeTruthy();
    expect(familyId).toBeTruthy();

    // Status should be queryable immediately via event store
    const status0 = svc.getStatus(runId);
    expect(status0).not.toBeNull();
    expect(status0!.status).toBe('running');

    // Wait for background execution to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check status after completion
    const status1 = svc.getStatus(runId);
    expect(status1).not.toBeNull();
    expect(status1!.status).toBe('completed');
    expect(status1!.completedAt).toBeTruthy();

    // Verify projection has the family
    const projection = svc.getProjection();
    expect(projection.families.has(familyId)).toBe(true);
  });
});

// ── Cancellation test ────────────────────────────────────────────────

describe('run lifecycle: cancellation', () => {
  it('cancelRun returns false for unknown runId', () => {
    const svc = createRunService();
    expect(svc.cancelRun('nonexistent')).toBe(false);
  });
});

// ── Rollback test ────────────────────────────────────────────────────

describe('run lifecycle: rollback after persistence', () => {
  it('roll back a run — its pure_run_local claims disappear from projection on rebuild', () => {
    appendEvents([
      makeEvent({ eventType: 'FAMILY_CREATED', runId: 'run-good', payload: { family_id: 'fam1', label: 'Family 1' } }),
      makeEvent({
        eventType: 'RUN_STARTED',
        runId: 'run-good',
        payload: { runId: 'run-good', familyId: 'fam1', query: 'good query', strategy: 'agent' },
      }),
      makeEvent({
        eventType: 'CLAIM_ACCEPTED',
        runId: 'run-good',
        entityId: 'clm_good1',
        entityType: 'claim',
        payload: {
          id: 'clm_good1', familyId: 'fam1', subjectText: 'Good claim', predicate: 'good',
          polarity: 'asserted', hedge: 'certain', evidenceType: 'study', confidence: 0.9,
          canonicalKey: { subject: 'good', predicate: 'good' }, contradictionState: 'none',
          firstSeenRunId: 'run-good', lastSeenRunId: 'run-good',
        },
      }),
      makeEvent({
        eventType: 'RUN_STARTED',
        runId: 'run-bad',
        payload: { runId: 'run-bad', familyId: 'fam1', query: 'bad query', strategy: 'agent' },
      }),
      makeEvent({
        eventType: 'CLAIM_ACCEPTED',
        runId: 'run-bad',
        entityId: 'clm_bad1',
        entityType: 'claim',
        payload: {
          id: 'clm_bad1', familyId: 'fam1', subjectText: 'Bad claim', predicate: 'bad',
          polarity: 'asserted', hedge: 'likely', evidenceType: 'claim', confidence: 0.6,
          canonicalKey: { subject: 'bad', predicate: 'bad' }, contradictionState: 'none',
          firstSeenRunId: 'run-bad', lastSeenRunId: 'run-bad',
        },
      }),
    ]);

    const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

    // Build projection — both claims present
    const state1 = rebuildProjection(ALL_HANDLERS);
    expect(state1.claims.size).toBe(2);
    expect(state1.claims.has('clm_good1')).toBe(true);
    expect(state1.claims.has('clm_bad1')).toBe(true);

    // Roll back run-bad
    rollbackRun('run-bad', state1, { projection: state1, handlers: TEST_HANDLERS });

    // Rebuild — run-bad claims gone
    const state2 = rebuildProjection(ALL_HANDLERS);
    expect(state2.rolledBackRuns.has('run-bad')).toBe(true);
    expect(state2.claims.has('clm_good1')).toBe(true);
    expect(state2.claims.has('clm_bad1')).toBe(false);
  });
});

// ── Concurrency non-contamination test ───────────────────────────────

describe('run lifecycle: concurrent runs do not cross-contaminate', () => {
  it('two runs with different familyId produce isolated claims in projection', () => {
    // Run A → family A, claim A, source A
    appendEvents([
      makeEvent({ eventType: 'FAMILY_CREATED', runId: 'runA', payload: { family_id: 'famA', label: 'Family A' } }),
      makeEvent({
        eventType: 'RUN_STARTED', runId: 'runA',
        payload: { runId: 'runA', familyId: 'famA', query: 'query A', strategy: 'pipeline' },
      }),
      makeEvent({
        eventType: 'CLAIM_ACCEPTED', runId: 'runA', entityId: 'clmA1', entityType: 'claim',
        payload: {
          id: 'clmA1', familyId: 'famA', subjectText: 'Claim from A', predicate: 'a',
          polarity: 'asserted', hedge: 'certain', evidenceType: 'study', confidence: 0.9,
          canonicalKey: { subject: 'claim a', predicate: 'a' }, contradictionState: 'none',
          firstSeenRunId: 'runA', lastSeenRunId: 'runA',
        },
      }),
      makeEvent({
        eventType: 'SOURCE_ADDED', runId: 'runA', entityId: 'srcA1', entityType: 'source',
        payload: {
          id: 'srcA1', url: 'https://a.com', title: 'Source A', domain: 'a.com',
          sourceType: 'web', isPrimary: true, extractionStatus: 'extracted',
          contentHash: 'hashA', retrievedAt: new Date().toISOString(), firstSeenRunId: 'runA',
        },
      }),
    ]);

    // Run B → family B, claim B, source B
    appendEvents([
      makeEvent({ eventType: 'FAMILY_CREATED', runId: 'runB', payload: { family_id: 'famB', label: 'Family B' } }),
      makeEvent({
        eventType: 'RUN_STARTED', runId: 'runB',
        payload: { runId: 'runB', familyId: 'famB', query: 'query B', strategy: 'pipeline' },
      }),
      makeEvent({
        eventType: 'CLAIM_ACCEPTED', runId: 'runB', entityId: 'clmB1', entityType: 'claim',
        payload: {
          id: 'clmB1', familyId: 'famB', subjectText: 'Claim from B', predicate: 'b',
          polarity: 'asserted', hedge: 'likely', evidenceType: 'claim', confidence: 0.7,
          canonicalKey: { subject: 'claim b', predicate: 'b' }, contradictionState: 'none',
          firstSeenRunId: 'runB', lastSeenRunId: 'runB',
        },
      }),
      makeEvent({
        eventType: 'SOURCE_ADDED', runId: 'runB', entityId: 'srcB1', entityType: 'source',
        payload: {
          id: 'srcB1', url: 'https://b.com', title: 'Source B', domain: 'b.com',
          sourceType: 'web', isPrimary: true, extractionStatus: 'extracted',
          contentHash: 'hashB', retrievedAt: new Date().toISOString(), firstSeenRunId: 'runB',
        },
      }),
    ]);

    const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };
    const projection = rebuildProjection(ALL_HANDLERS);

    // Total claims: 2 (one per run, no cross-contamination)
    expect(projection.claims.size).toBe(2);
    expect(projection.claims.get('clmA1')!.familyId).toBe('famA');
    expect(projection.claims.get('clmB1')!.familyId).toBe('famB');

    // Sources isolated by runId
    expect(projection.sources.size).toBe(2);
    expect(projection.sources.get('srcA1')!.firstSeenRunId).toBe('runA');
    expect(projection.sources.get('srcB1')!.firstSeenRunId).toBe('runB');

    // Rolling back runA removes only its claims
    rollbackRun('runA', projection, { projection, handlers: TEST_HANDLERS });
    const projection2 = rebuildProjection(ALL_HANDLERS);
    expect(projection2.claims.has('clmA1')).toBe(false);
    expect(projection2.claims.has('clmB1')).toBe(true);
  });
});

// ── FAMILY_RESOLVED event payload carries score + method ───────────

describe('run lifecycle: FAMILY_RESOLVED event payload', () => {
  it('includes score and method fields in FAMILY_RESOLVED event', async () => {
    const svc = createRunService();

    const { runId } = await svc.startRun({
      query: 'TypeScript framework comparison',
      provider: mockProvider,
      config: mockConfig,
      strategy: 'pipeline',
    });

    // Wait for background execution to persist events
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Query FAMILY_RESOLVED events for this run
    const events = queryEvents({ eventType: 'FAMILY_RESOLVED', runId });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const payload = events[0]!.payload as Record<string, unknown>;
    expect(typeof payload.score).toBe('number');
    expect(payload.method).toBe('lexical_manifest_overlap');
    expect(typeof payload.familyId).toBe('string');
    expect(typeof payload.query).toBe('string');
    expect(typeof payload.isNew).toBe('boolean');
  });
});

// ── Durable run status (events, not in-memory singleton) ─────────────

describe('run lifecycle: durable run status', () => {
  it('getStatus queries event store directly — no singleton required', () => {
    appendEvents([
      makeEvent({
        eventType: 'RUN_STARTED', runId: 'runX',
        payload: { runId: 'runX', familyId: 'famX', query: 'query X', strategy: 'pipeline' },
      }),
      makeEvent({
        eventType: 'RUN_COMPLETED', runId: 'runX',
        payload: { runId: 'runX', claimCount: 5, sourceCount: 3, evidenceCount: 10 },
      }),
    ]);

    const svc = createRunService();
    const status = svc.getStatus('runX');

    expect(status).not.toBeNull();
    expect(status!.status).toBe('completed');
    expect(status!.claimCount).toBe(5);
    expect(status!.sourceCount).toBe(3);
    expect(status!.evidenceCount).toBe(10);
  });
});

describe('durable reconciler: asserted + negated → contradiction classification', () => {
  it('classifies second observation with opposite polarity as contradiction', () => {
    const scratch = createEmptyProjectionState();
    const familyId = 'fam-int';
    const runId = 'run-int';

    // First observation: asserted
    const obsA = {
      id: 'obs_a', familyId, runId, observedAt: new Date().toISOString(),
      subjectText: 'React', predicate: 'is fast',
      polarity: 'asserted' as const, hedge: 'certain' as const,
      evidenceType: 'study' as const, confidence: 0.9,
      sourceIds: [], extractionVersion: 'v1',
      canonicalKey: { subject: 'react', predicate: 'is fast' },
    };
    const plannedA = planClaimObservation(obsA, scratch);
    expect(plannedA.reconciliation.classification).toBe('new_claim');
    graphEventHandlers.CLAIM_OBSERVED(
      { id: 'evt_a', seq: 0, timestamp: '', eventType: 'CLAIM_OBSERVED', eventVersion: 1, runId, batchId: null, actor: 'system', entityId: null, entityType: null, payload: plannedA, payloadHash: '', actorId: null },
      scratch,
    );

    // Second observation: negated — same subject+predicate, opposite polarity
    const obsB = {
      id: 'obs_b', familyId, runId, observedAt: new Date().toISOString(),
      subjectText: 'React', predicate: 'is fast',
      polarity: 'negated' as const, hedge: 'certain' as const,
      evidenceType: 'study' as const, confidence: 0.9,
      sourceIds: [], extractionVersion: 'v1',
      canonicalKey: { subject: 'react', predicate: 'is fast' },
    };
    const plannedB = planClaimObservation(obsB, scratch);
    // Must be classified as contradiction, not new_claim or same_claim
    expect(plannedB.reconciliation.classification).toBe('contradiction');
    // Must have matchedClaimId pointing to the first claim
    expect(plannedB.reconciliation.matchedClaimId).toBeDefined();
  });
});
