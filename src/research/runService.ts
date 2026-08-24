/**
 * Run lifecycle service — the bridge between ephemeral research execution
 * and durable event-sourced persistence.
 *
 * Replaces search-mcp's in-memory jobManager singleton + JSON rehydration
 * with: family resolution (workspace) → event-appended run state →
 * strategy execution → event-appended research output → queryable projection.
 *
 * No global singleton. Every function that needs run context takes it explicitly.
 */

import { randomUUID } from 'node:crypto';
import type { StrategyContext } from './strategies/types.js';
import type { ResearchResult, Finding, InternalContradiction, GapRecord, ResearchDepth } from './internalTypes.js';
import type { ResearchStrategy as StrategyName } from './types.js';
import type { BudgetProfile } from './internalTypes.js';
import type { ResearchProvider } from '../providers/types.js';
import type { TrellisConfig } from '../config/index.js';
import type { AuthorityClass } from '../graph/types.js';
import { resolveBudgetProfile } from './budget.js';
import { ResearchStateEngine } from './state.js';
import { BudgetTracker } from './budget.js';
import { resolveFamily } from '../workspace/familyResolver.js';
import { appendEvents, queryEvents } from '../store/events.js';
import { rebuildProjection } from '../store/projectionBuilder.js';
import { rollbackRun } from '../store/rollback.js';
import { graphEventHandlers } from '../graph/index.js';
import { workspaceEventHandlers } from '../workspace/index.js';
import type { EventEnvelope } from '../store/eventTypes.js';
import type { ProjectionState } from '../store/projectionState.js';
import { logger } from '../logger.js';

// ── Run state (in-process ephemeral — NOT authoritative) ─────────────

interface RunAbort {
  controller: AbortController;
}

// ── Public API ────────────────────────────────────────────────────────

export interface StartRunInput {
  query: string;
  strategy?: StrategyName;
  depth?: string;
  topic?: string;
  sessionId?: string;
  provider: ResearchProvider;
  config: TrellisConfig;
  /** If provided, skip family resolution and use this familyId. */
  explicitFamilyId?: string;
}

export interface RunStatus {
  runId: string;
  familyId: string;
  status: string;
  query: string;
  progress: { phase: string; percent?: number; message?: string };
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastError?: string;
  entityCount?: number;
  claimCount?: number;
  sourceCount?: number;
  evidenceCount?: number;
}

export interface RunService {
  startRun(input: StartRunInput): Promise<{ runId: string; familyId: string }>;
  getStatus(runId: string): RunStatus | null;
  cancelRun(runId: string): boolean;
  /** Rebuild projection and return it for querying. */
  getProjection(): ProjectionState;
}

// ── Handlers registry (merged domain handlers for projection rebuild) ─

const ALL_HANDLERS = {
  ...graphEventHandlers,
  ...workspaceEventHandlers,
};

// ── Family resolution helper ─────────────────────────────────────────

function resolveFamilyForRun(
  input: StartRunInput,
  projection: ProjectionState,
): { familyId: string; familyCreated: boolean; familyLabel: string; familyDescription: string } {
  if (input.explicitFamilyId !== undefined) {
    const exists = projection.families.has(input.explicitFamilyId);
    if (exists) {
      return {
        familyId: input.explicitFamilyId,
        familyCreated: false,
        familyLabel: '',
        familyDescription: '',
      };
    }
    // Family doesn't exist yet — create it so FAMILY_CREATED is emitted
    return {
      familyId: input.explicitFamilyId,
      familyCreated: true,
      familyLabel: input.explicitFamilyId,
      familyDescription: input.query,
    };
  }

  const families = [...projection.families.values()];
  const resolution = resolveFamily(input.query, families);
  return {
    familyId: resolution.family.id,
    familyCreated: resolution.isNew,
    familyLabel: resolution.family.label,
    familyDescription: resolution.family.description ?? input.query,
  };
}

// ── Event emission helpers ────────────────────────────────────────────

function makeEnvelope(
  eventType: EventEnvelope['eventType'],
  runId: string,
  payload: unknown,
  overrides?: Partial<EventEnvelope>,
): EventEnvelope {
  return {
    id: '',
    timestamp: new Date().toISOString(),
    eventType,
    eventVersion: 1,
    runId,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload,
    payloadHash: null,
    ...overrides,
  };
}

// ── Mapping: Finding → Claim + Evidence ──────────────────────────────

function mapFindingToClaimEvents(
  finding: Finding,
  familyId: string,
  runId: string,
): EventEnvelope[] {
  const claimId = `clm_${finding.id}`;
  const claim = {
    id: claimId,
    familyId,
    subjectText: finding.claim,
    predicate: finding.normalizedClaim || finding.claim,
    polarity: 'asserted' as const,
    hedge: finding.confidence !== undefined
      ? (finding.confidence > 0.8 ? 'certain' as const
        : finding.confidence > 0.5 ? 'likely' as const
        : 'possible' as const)
      : 'possible' as const,
    evidenceType: finding.claimType === 'primary' ? 'study' as const
      : finding.claimType === 'secondary' ? 'claim' as const
      : 'anecdote' as const,
    confidence: finding.confidence ?? 0.5,
    canonicalKey: {
      subject: finding.claim.slice(0, 200),
      predicate: finding.normalizedClaim.slice(0, 200),
    },
    contradictionState: 'none' as const,
    firstSeenRunId: runId,
    lastSeenRunId: runId,
  };

  const events: EventEnvelope[] = [
    makeEnvelope('CLAIM_ACCEPTED', runId, claim, { entityId: claimId, entityType: 'claim' }),
  ];

  // Evidence per sourceId
  for (const sourceId of finding.sourceIds) {
    const evidence = {
      id: `evd_${finding.id}_${sourceId}`,
      claimId,
      sourceId,
      excerpt: finding.evidenceExcerpt,
      runId,
    };
    events.push(
      makeEnvelope('EVIDENCE_LINKED', runId, evidence, { entityId: evidence.id, entityType: 'evidence' }),
    );
  }

  return events;
}

// ── Mapping: FindingClusterEdge → ClaimRelation ─────────────────────

function mapClusterEdgeToClaimRelationEvents(
  edge: { fromClusterId: string; toClusterId: string; relation: string; strength: string; score: number },
  clusterRepresentativeClaimId: Map<string, string>,
  persistedClaimIds: Set<string>,
  runId: string,
): EventEnvelope[] {
  const fromClaimId = clusterRepresentativeClaimId.get(edge.fromClusterId);
  const toClaimId = clusterRepresentativeClaimId.get(edge.toClusterId);
  if (
    fromClaimId === undefined ||
    toClaimId === undefined ||
    !persistedClaimIds.has(fromClaimId) ||
    !persistedClaimIds.has(toClaimId)
  ) {
    logger.warn(
      { edge },
      'runService: skipping cluster edge — cluster has no resolvable representative claim',
    );
    return [];
  }
  const relation = {
    id: `rel_${edge.fromClusterId}_${edge.toClusterId}_${edge.relation}`,
    fromClaimId,
    toClaimId,
    relation: edge.relation,
    strength: edge.strength,
    score: edge.score,
    runId,
  };
  return [
    makeEnvelope('EDGE_ADDED', runId, relation, { entityId: relation.id, entityType: 'claim_relation' }),
  ];
}

// ── Mapping: InternalContradiction → Contradiction ──────────────────

function mapContradictionToEvents(
  ic: InternalContradiction,
  familyId: string,
  runId: string,
  claimTextToId: Map<string, string>,
): EventEnvelope[] {
  const claimIdA = claimTextToId.get(ic.claimA);
  const claimIdB = claimTextToId.get(ic.claimB);
  if (claimIdA === undefined || claimIdB === undefined) {
    logger.warn(
      { contradictionId: ic.id },
      'runService: skipping contradiction — claim text did not resolve to a persisted claim',
    );
    return [];
  }
  const contradiction = {
    id: `con_${ic.id}`,
    familyId,
    claimIdA,
    claimIdB,
    contradictionType: ic.contradictionType,
    resolutionStatus: 'unresolved' as const,
    likelyExplanation: ic.likelyExplanation,
    firstSeenRunId: runId,
  };
  return [
    makeEnvelope('CONTRADICTION_IDENTIFIED', runId, contradiction, { entityId: contradiction.id, entityType: 'contradiction' }),
  ];
}

// ── Mapping: GapRecord → Gap ─────────────────────────────────────────

function mapGapToEvents(
  gap: GapRecord,
  familyId: string,
  runId: string,
): EventEnvelope[] {
  const gapEvent = {
    id: `gap_${gap.id}`,
    familyId,
    question: gap.description,
    category: gap.category,
    status: gap.status,
    priority: gap.priority,
    firstSeenRunId: runId,
  };
  return [
    makeEnvelope('GAP_OPENED', runId, gapEvent, { entityId: gapEvent.id, entityType: 'gap' }),
  ];
}

// ── Mapping: SourceEntry → Source ─────────────────────────────────────

function mapSourceToEvents(
  src: { id: string; title: string; url: string; sourceType: string; domain: string; isPrimary: boolean; extractionStatus: string; contentHash?: string; accessDate: string; publishedDate?: string; qualityScore?: number; authorityClass?: string; discardReason?: string; usageStatus?: string },
  runId: string,
): EventEnvelope[] {
  const source = {
    id: src.id,
    url: src.url,
    title: src.title,
    domain: src.domain,
    sourceType: src.sourceType,
    isPrimary: src.isPrimary,
    extractionStatus: src.extractionStatus,
    contentHash: src.contentHash ?? `hash_${src.id}`,
    retrievedAt: src.accessDate,
    publishedAt: src.publishedDate,
    qualityScore: src.qualityScore,
    authorityClass: src.authorityClass as AuthorityClass | undefined,
    firstSeenRunId: runId,
  };
  const events: EventEnvelope[] = [
    makeEnvelope('SOURCE_ADDED', runId, source, { entityId: src.id, entityType: 'source' }),
  ];
  if (src.extractionStatus === 'extracted') {
    events.push(
      makeEnvelope('SOURCE_READ', runId, { sourceId: src.id }, { entityId: src.id, entityType: 'source' }),
    );
  }
  return events;
}

// ── Core implementation ──────────────────────────────────────────────

/**
 * Build the full event batch for a completed research run.
 * Maps structured objects directly to events — never round-trips through narrativeMarkdown.
 */
function buildCompletionEvents(
  result: ResearchResult,
  familyId: string,
  runId: string,
): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  const report = result.report;

  // Canonical findings → CLAIM_ACCEPTED + EVIDENCE_LINKED
  const findings = result.canonicalFindings ?? [];
  const claimTextToId = new Map<string, string>();
  const persistedClaimIds = new Set<string>();
  for (const f of findings) {
    const claimId = `clm_${f.id}`;
    claimTextToId.set(f.claim, claimId);
    persistedClaimIds.add(claimId);
    events.push(...mapFindingToClaimEvents(f, familyId, runId));
  }

  // FindingClusters → representative claim per cluster (first finding in the cluster).
  // Cluster edges connect clusters, not individual claims; a representative avoids
  // fabricating a claim id from a cluster id that no persisted Claim actually has.
  const clusterRepresentativeClaimId = new Map<string, string>();
  if (report.findingClusters) {
    for (const cluster of report.findingClusters) {
      const representativeFindingId = cluster.findingIds[0];
      if (representativeFindingId !== undefined) {
        clusterRepresentativeClaimId.set(cluster.id, `clm_${representativeFindingId}`);
      }
    }
  }

  // FindingClusterEdges → EDGE_ADDED
  if (report.findingClusterEdges) {
    for (const edge of report.findingClusterEdges) {
      events.push(
        ...mapClusterEdgeToClaimRelationEvents(
          edge,
          clusterRepresentativeClaimId,
          persistedClaimIds,
          runId,
        ),
      );
    }
  }

  // Contradictions → CONTRADICTION_IDENTIFIED (skipped if claim text doesn't resolve)
  for (const ic of report.contradictions) {
    events.push(...mapContradictionToEvents(ic, familyId, runId, claimTextToId));
  }

  return events;
}

/**
 * Build events for research state output (gaps, sources).
 * These come from state.getState() not from the report.
 */
function buildStateOutputEvents(
  state: ResearchStateEngine,
  familyId: string,
  runId: string,
): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  const s = state.getState();

  // Gaps → GAP_OPENED
  for (const gap of s.gaps) {
    events.push(...mapGapToEvents(gap, familyId, runId));
  }

  // Sources → SOURCE_ADDED (+ SOURCE_READ if extracted)
  for (const src of s.sources) {
    events.push(...mapSourceToEvents(src, runId));
  }

  return events;
}

/**
 * Create a RunService bound to an explicit store context.
 * The caller is responsible for initDb() before calling startRun.
 */
export function createRunService(): RunService {
  // Build merged handler registry for projection rebuilds
  const handlers = { ...ALL_HANDLERS };
  // Closure-local, not module-level — each RunService instance owns its
  // own in-flight-run bookkeeping so separate instances never contaminate.
  const activeRuns = new Map<string, RunAbort>();

  function getProjection(): ProjectionState {
    return rebuildProjection(handlers);
  }

  function startRun(input: StartRunInput): Promise<{ runId: string; familyId: string }> {
    const runId = `run_${randomUUID().slice(0, 12)}`;

    // 1. Resolve family from current projection BEFORE starting research
    let projection: ProjectionState;
    try {
      projection = getProjection();
    } catch {
      projection = { families: new Map() } as ProjectionState;
    }

    const { familyId, familyCreated, familyLabel, familyDescription } = resolveFamilyForRun(input, projection);

    // 2. Append RUN_STARTED event immediately (durable from the start)
    const familyEvents: EventEnvelope[] = [];
    if (familyCreated) {
      familyEvents.push(
        makeEnvelope('FAMILY_CREATED', runId, {
          family_id: familyId,
          label: familyLabel,
          description: familyDescription,
        }, { entityId: familyId, entityType: 'family' }),
      );
    }
    familyEvents.push(
      makeEnvelope('FAMILY_RESOLVED', runId, {
        familyId,
        query: input.query,
        isNew: familyCreated,
      }, { entityId: familyId, entityType: 'family' }),
    );

    const runPayload = {
      runId,
      familyId,
      query: input.query,
      strategy: input.strategy ?? 'pipeline',
      topic: input.topic,
      sessionId: input.sessionId,
    };

    const allStartEvents: EventEnvelope[] = [
      ...familyEvents,
      makeEnvelope('RUN_STARTED', runId, runPayload, { entityId: runId, entityType: 'run' }),
    ];
    appendEvents(allStartEvents);

    // 3. Setup abort controller
    const controller = new AbortController();
    activeRuns.set(runId, { controller });

    // 4. Execute research in background, then persist results
    executeResearch(runId, familyId, input, controller.signal).catch((err: unknown) => {
      logger.error({ runId, err }, 'runService: background execution failed');
    });

    return Promise.resolve({ runId, familyId });
  }

  function executeResearch(
    runId: string,
    familyId: string,
    input: StartRunInput,
    abortSignal: AbortSignal,
  ): Promise<void> {
    // Resolve strategy
    const depth: ResearchDepth = (input.depth ?? 'standard') as ResearchDepth;
    const strategyName = input.strategy ?? 'pipeline';

    // Build in-memory research state engine
    const budgetProfile: BudgetProfile = resolveBudgetProfile(depth);
    const budget = new BudgetTracker(budgetProfile);
    const stateEngine = new ResearchStateEngine(budget);
    stateEngine.initialize(input.query, budget);

    // Build strategy context
    const strategyCtx: StrategyContext = {
      state: stateEngine,
      budget,
      provider: input.provider,
      config: input.config,
      runContext: { familyId, researchRunId: runId, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}) },
      abortSignal,
      depth,
    };

    return executeStrategyAndPersist(runId, familyId, strategyName, strategyCtx, stateEngine, abortSignal, input.query);
  }

  async function executeStrategyAndPersist(
    runId: string,
    familyId: string,
    strategyName: string,
    strategyCtx: StrategyContext,
    stateEngine: ResearchStateEngine,
    abortSignal: AbortSignal,
    query: string,
  ): Promise<void> {
    try {
      // Import strategy dynamically to avoid circular deps
      const { StrategyRegistry } = await import('./strategies/registry.js');
      const registry = new StrategyRegistry();

      // Register pipeline strategy
      const { PipelineStrategy } = await import('./strategies/pipelineStrategy.js');
      registry.register('pipeline', (_ctx) => new PipelineStrategy());

      // Register agent strategy if LLM available
      if (strategyCtx.llm) {
        try {
          const { AgentStrategy } = await import('./strategies/agentStrategy.js');
          registry.register('agent', (ctx) => new AgentStrategy(ctx));
        } catch {
          // agent strategy not available, fall through to pipeline
        }
      }

      const strategy = registry.create(strategyName, strategyCtx);

      // Execute
      const result = await strategy.analyze(query, strategyCtx);

      if (abortSignal.aborted) {
        // Cancellation
        appendEvents([
          makeEnvelope('RUN_CANCELLED', runId, { runId }, { entityId: runId, entityType: 'run' }),
        ]);
        activeRuns.delete(runId);
        return;
      }

      // Build completion events: report-based + state-based
      const completionEvents = [
        ...buildCompletionEvents(result, familyId, runId),
        ...buildStateOutputEvents(stateEngine, familyId, runId),
      ];

      // Run-completed envelope
      completionEvents.push(
        makeEnvelope('RUN_COMPLETED', runId, {
          runId,
          claimCount: result.canonicalFindings?.length ?? 0,
          sourceCount: stateEngine.getState().sources.length,
          evidenceCount: (result.canonicalFindings ?? []).reduce(
            (sum, f) => sum + f.sourceIds.length, 0,
          ),
        }, { entityId: runId, entityType: 'run' }),
      );

      appendEvents(completionEvents);
      activeRuns.delete(runId);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      appendEvents([
        makeEnvelope('RUN_FAILED', runId, {
          runId,
          error: errorMsg,
        }, { entityId: runId, entityType: 'run' }),
      ]);
      activeRuns.delete(runId);
    }
  }

  function getStatus(runId: string): RunStatus | null {
    // Query events directly — RUN_STARTED/RUN_COMPLETED are audit_only
    // and skipped by projectionBuilder, so projection won't have run state.
    const events = queryEvents({ runId });
    if (events.length === 0) return null;

    const startEvt = events.find((e) => e.eventType === 'RUN_STARTED');
    if (!startEvt) return null;
    const sp = startEvt.payload as Record<string, unknown>;

    let status = 'running';
    const completedEvt = events.find((e) => e.eventType === 'RUN_COMPLETED');
    const failedEvt = events.find((e) => e.eventType === 'RUN_FAILED');
    const cancelledEvt = events.find((e) => e.eventType === 'RUN_CANCELLED');
    if (completedEvt) status = 'completed';
    else if (failedEvt) status = 'failed';
    else if (cancelledEvt) status = 'cancelled';

    const out: RunStatus = {
      runId,
      familyId: sp.familyId as string,
      status,
      query: sp.query as string,
      progress: { phase: status },
      startedAt: startEvt.timestamp,
    };
    if (completedEvt) {
      const cp = completedEvt.payload as Record<string, unknown>;
      out.completedAt = completedEvt.timestamp;
      if (typeof cp.claimCount === 'number') out.claimCount = cp.claimCount;
      if (typeof cp.sourceCount === 'number') out.sourceCount = cp.sourceCount;
      if (typeof cp.evidenceCount === 'number') out.evidenceCount = cp.evidenceCount;
    }
    if (failedEvt) {
      const fp = failedEvt.payload as Record<string, unknown>;
      out.failedAt = failedEvt.timestamp;
      if (typeof fp.error === 'string') out.lastError = fp.error;
    }
    if (cancelledEvt) {
      out.cancelledAt = cancelledEvt.timestamp;
    }
    return out;
  }

  function cancelRun(runId: string): boolean {
    const abort = activeRuns.get(runId);
    if (!abort) return false;
    abort.controller.abort();
    return true;
  }

  return { startRun, getStatus, cancelRun, getProjection };
}

/**
 * Roll back a run's pure_run_local events via the store's rollback executor.
 * Returns the rollback outcome.
 */
export function rollbackRunById(
  runId: string,
): { skipped: number; executed: number; blocked: { eventId: string; reason: string }[] } {
  const projection = rebuildProjection({ ...ALL_HANDLERS });
  return rollbackRun(runId, projection);
}

// Re-export for tests
export { mapFindingToClaimEvents, mapSourceToEvents, mapGapToEvents, buildCompletionEvents };
