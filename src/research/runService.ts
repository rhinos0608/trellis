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
import type { ResearchStrategy as StrategyName, RunProgressUpdate } from './types.js'
import type { BudgetProfile } from './internalTypes.js';
import type { ProviderCallContext, ResearchProvider } from '../providers/types.js';
import type { TrellisConfig } from '../config/index.js';
import type { AuthorityClass, ClaimObservation } from '../graph/types.js';
import { canonicalizeSourceUrl } from '../graph/sourceIdentity.js';
import { planClaimObservation } from '../graph/claimReconciler.js';
import { resolveClaimEntities } from '../graph/claimEntityResolution.js';
import { createEmptyProjectionState, serializeProjectionState, deserializeProjectionState } from '../store/projectionState.js';
import type { EventHandlerRegistry } from '../store/projectionState.js';
import { resolveBudgetProfile } from './budget.js';
import { ResearchStateEngine } from './state.js';
import { BudgetTracker } from './budget.js';
import { LlmClient } from './llm/client.js';
import { resolveFamily } from '../workspace/familyResolver.js';
import { resolveThread } from '../workspace/threadResolver.js';
import { appendEvents, queryEvents, type NewEventInput, type AppendContext } from '../store/events.js';
import { StaleProjectionError } from '../store/eventErrors.js';
import { rebuildProjection } from '../store/projectionBuilder.js';
import { rollbackRun } from '../store/rollback.js';
import { graphEventHandlers } from '../graph/index.js';
import { workspaceEventHandlers } from '../workspace/index.js';
import type { EventEnvelope } from '../store/eventTypes.js';
import type { ProjectionState } from '../store/projectionState.js';
import { logger } from '../logger.js';
import { classifyError } from './retry.js';
import { hashPayload } from '../store/events.js';
import { JobScheduler } from './scheduler.js'
import { foldRunLedger } from './runLedger.js';
import { selectFollowUpTarget } from './followUpPlanner.js';
import type { RunFollowUp } from './types.js';

function deserializeScratch(state: ProjectionState): ProjectionState { return deserializeProjectionState(serializeProjectionState(state)); }
function applyScratchEvents(events: readonly NewEventInput[], state: ProjectionState, handlers: EventHandlerRegistry): void {
  for (const [index, event] of events.entries()) handlers[event.eventType]?.({ ...event, id: `scratch_${String(index)}`, seq: state.lastAppliedSeq, payloadHash: '', actorId: event.actorId ?? null }, state);
}

// ── Run state (in-process ephemeral — NOT authoritative) ─────────────

interface RunAbort {
  controller: AbortController;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Thrown by startRun() when strategy:'agent' is requested but LLM config
 * (baseUrl + model) is missing. Permanent precondition — not retryable.
 */
export class MissingLlmConfigError extends Error {
  readonly classification = 'permanent' as const;
  constructor() {
    super(
      'Agent strategy requires LLM configuration: set TRELLIS_LLM_BASE_URL (or OPENAI_BASE_URL) and TRELLIS_LLM_MODEL (or OPENAI_MODEL)',
    );
    this.name = 'MissingLlmConfigError';
  }
}

export interface StartRunInput {
  query: string;
  strategy?: StrategyName;
  depth?: string;
  topic?: string;
  sessionId?: string;
  threadId?: string;
  /** Provider object retained for compatibility; scheduler prefers providerName. */
  provider?: ResearchProvider;
  providerName?: string;
  config: TrellisConfig;
  idempotencyKey?: string;
  deadlineMs?: number;
  /** If provided, skip family resolution and use this familyId. */
  explicitFamilyId?: string;
}

export interface RetryRunInput {
  runId: string;
  idempotencyKey?: string;
  deadlineMs?: number;
}

export interface ContinueResearchInput {
  familyId: string;
  depth?: 'quick' | 'standard';
  idempotencyKey?: string;
  config?: TrellisConfig;
}

export type ContinueResearchResult =
  | { status: 'queued'; runId: string; familyId: string; target: { type: 'gap' | 'contradiction'; id: string }; query: string; followUpsUsed: number; followUpCap: 3 }
  | { status: 'no_work' | 'cap_reached'; familyId: string; followUpsUsed: number; followUpCap: 3 };

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
  retryRun(input: RetryRunInput): Promise<{ runId: string; familyId: string; deduplicated: boolean }>;
  continueResearch(input: ContinueResearchInput): Promise<ContinueResearchResult>;
  /** Rebuild projection and return it for querying. */
  getProjection(): ProjectionState;
  startScheduler(): void;
  shutdownScheduler(): Promise<void>;
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
): { familyId: string; familyCreated: boolean; familyLabel: string; familyDescription: string; score: number } {
  if (input.explicitFamilyId !== undefined) {
    const exists = projection.families.has(input.explicitFamilyId);
    if (exists) {
      return {
        familyId: input.explicitFamilyId,
        familyCreated: false,
        familyLabel: '',
        familyDescription: '',
        score: 0,
      };
    }
    // Family doesn't exist yet — create it so FAMILY_CREATED is emitted
    return {
      familyId: input.explicitFamilyId,
      familyCreated: true,
      familyLabel: input.explicitFamilyId,
      familyDescription: input.query,
      score: 0,
    };
  }

  const families = [...projection.families.values()];
  const resolution = resolveFamily(input.query, families);
  return {
    familyId: resolution.family.id,
    familyCreated: resolution.isNew,
    familyLabel: resolution.family.label,
    familyDescription: resolution.family.description ?? input.query,
    score: resolution.score,
  };
}

// ── Event emission helpers ────────────────────────────────────────────

/** True when the run already has a terminal interruption/cancellation event
 *  (e.g. RUN_INTERRUPTED appended by scheduler shutdown) — suppresses a
 *  duplicate/misleading RUN_CANCELLED from the abort path. */
function hasTerminalInterruptionEvent(runId: string): boolean {
  const events = queryEvents({ runId });
  return events.some((e) => e.eventType === 'RUN_CANCELLED' || e.eventType === 'RUN_INTERRUPTED');
}

function makeEnvelope(
  eventType: EventEnvelope['eventType'],
  runId: string,
  payload: unknown,
  overrides?: Partial<NewEventInput>,
): NewEventInput {
  return {
    timestamp: new Date().toISOString(),
    eventType,
    eventVersion: 1,
    runId,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload,
    ...overrides,
  };
}

// ── Mapping: Finding → Claim + Evidence ──────────────────────────────

function mapFindingToClaimEvents(
  finding: Finding,
  familyId: string,
  runId: string,
  threadId?: string,
): NewEventInput[] {
  // Use structured assertion fields when available (GroundedFinding), fall back to legacy fields
  const hasAssertion = 'assertion' in finding;
  const assertion = hasAssertion ? (finding as unknown as { assertion: import('../graph/types.js').ClaimAssertion }).assertion : undefined;
  const groundings = hasAssertion ? (finding as unknown as { groundings: Array<{ sourceId: string; passageId: string; verbatimSpan: string; alignment: import('../graph/types.js').EvidenceAlignment; contentHash: string }> }).groundings : undefined;

  const observation: ClaimObservation = {
    id: `obs_${runId}_${finding.id}`, familyId, ...(threadId !== undefined ? { threadId } : {}), runId, observedAt: finding.lastUpdated || finding.createdAt,
    subjectText: assertion?.subjectText ?? finding.claim,
    predicate: assertion?.predicate ?? (finding.normalizedClaim || finding.claim),
    polarity: assertion?.polarity ?? 'asserted',
    hedge: assertion?.hedge ?? ((finding.confidence ?? 0.5) > 0.8 ? 'certain' : (finding.confidence ?? 0.5) > 0.5 ? 'likely' : 'possible'),
    evidenceType: assertion?.evidenceType ?? (finding.claimType === 'primary' ? 'study' : finding.claimType === 'secondary' ? 'claim' : 'anecdote'),
    confidence: finding.confidence ?? 0.5, sourceIds: finding.sourceIds, extractionVersion: 'finding-v2',
    canonicalKey: assertion?.canonicalKey ?? { subject: finding.claim.slice(0, 200), predicate: (finding.normalizedClaim || finding.claim).slice(0, 200) },
  };
  const planned = planClaimObservation(observation, createEmptyProjectionState());
  const claimId = planned.reconciliation.canonicalClaimId;

  const events: NewEventInput[] = [
    makeEnvelope('CLAIM_OBSERVED', runId, planned, { entityId: claimId, entityType: 'claim' }),
  ];

  // Evidence per grounding (structured) or per sourceId (legacy)
  if (groundings && groundings.length > 0) {
    for (const grounding of groundings) {
      const evidence = {
        id: `evd_${finding.id}_${grounding.sourceId}_${grounding.passageId}`,
        claimId,
        sourceId: grounding.sourceId,
        excerpt: grounding.verbatimSpan,
        alignment: grounding.alignment,
        observationId: observation.id,
        stance: 'supports' as const,
        runId,
      };
      events.push(
        makeEnvelope('EVIDENCE_LINKED', runId, evidence, { entityId: evidence.id, entityType: 'evidence', eventVersion: 2 }),
      );
    }
  } else {
    // Legacy fallback
    for (const sourceId of finding.sourceIds) {
      const evidence = {
        id: `evd_${finding.id}_${sourceId}`,
        claimId,
        sourceId,
        excerpt: finding.evidenceExcerpt,
        observationId: observation.id,
        stance: 'supports' as const,
        runId,
      };
      events.push(
        makeEnvelope('EVIDENCE_LINKED', runId, evidence, { entityId: evidence.id, entityType: 'evidence', eventVersion: 2 }),
      );
    }
  }

  return events;
}

// ── Mapping: FindingClusterEdge → ClaimRelation ─────────────────────

function mapClusterEdgeToClaimRelationEvents(
  edge: { fromClusterId: string; toClusterId: string; relation: string; strength: string; score: number },
  clusterRepresentativeClaimId: Map<string, string>,
  persistedClaimIds: Set<string>,
  runId: string,
): NewEventInput[] {
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
): NewEventInput[] {
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
  threadId?: string,
): NewEventInput[] {
  const gapEvent = {
    id: `gap_${gap.id}`,
    familyId,
    ...(threadId !== undefined ? { threadId } : {}),
    question: gap.description,
    category: gap.category,
    status: gap.status,
    priority: gap.priority,
    ...(gap.missingSourceTypes !== undefined ? { missingSourceTypes: gap.missingSourceTypes } : {}),
    ...(gap.dominantSourceType !== undefined ? { dominantSourceType: gap.dominantSourceType } : {}),
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
): NewEventInput[] {
  const canonicalUrl = canonicalizeSourceUrl(src.url);
  const sourceId = canonicalUrl;
  const observed = {
    sourceId,
    observedSourceId: src.id,
    canonicalUrl,
    url: src.url,
    title: src.title,
    domain: src.domain,
    sourceType: src.sourceType,
    isPrimary: src.isPrimary,
    extractionStatus: src.extractionStatus,
    ...(src.contentHash !== undefined ? { contentHash: src.contentHash } : {}),
    runId,
    observedAt: src.accessDate,
    qualityScore: src.qualityScore,
    authorityClass: src.authorityClass as AuthorityClass | undefined,
  };
  const events: NewEventInput[] = [
    makeEnvelope('SOURCE_OBSERVED', runId, observed, { entityId: sourceId, entityType: 'source' }),
  ];
  if (src.extractionStatus === 'extracted') {
    events.push(
      makeEnvelope('SOURCE_READ', runId, { sourceId }, { entityId: sourceId, entityType: 'source' }),
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
  threadId?: string,
): NewEventInput[] {
  const events: NewEventInput[] = [];
  const report = result.report;

  // Canonical findings → CLAIM_ACCEPTED + EVIDENCE_LINKED
  const findings = result.canonicalFindings ?? [];
  const claimTextToId = new Map<string, string>();
  const persistedClaimIds = new Set<string>();
  const scratch = createEmptyProjectionState();
  const findingToClaim = new Map<string, string>();
  for (const f of findings) {
    const first = mapFindingToClaimEvents(f, familyId, runId, threadId)[0];
    if (!first) continue;
    const planned = first.payload as { observation: ClaimObservation; reconciliation: { canonicalClaimId: string } };
    const claimId = planned.reconciliation.canonicalClaimId;
    claimTextToId.set(f.claim, claimId);
    persistedClaimIds.add(claimId);
    findingToClaim.set(f.id, claimId);
    events.push(first);
    graphEventHandlers.CLAIM_OBSERVED({ ...first, id: `scratch_${f.id}`, seq: scratch.lastAppliedSeq, payloadHash: '', actorId: first.actorId ?? null }, scratch);
    events.push(...mapFindingToClaimEvents(f, familyId, runId, threadId).slice(1));
  }

  // FindingClusters → representative claim per cluster (first finding in the cluster).
  // Cluster edges connect clusters, not individual claims; a representative avoids
  // fabricating a claim id from a cluster id that no persisted Claim actually has.
  const clusterRepresentativeClaimId = new Map<string, string>();
  if (report.findingClusters) {
    for (const cluster of report.findingClusters) {
      const representativeFindingId = cluster.findingIds[0];
      if (representativeFindingId !== undefined) {
        const claimId = findingToClaim.get(representativeFindingId);
        if (claimId) clusterRepresentativeClaimId.set(cluster.id, claimId);
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
  threadId?: string,
): NewEventInput[] {
  const events: NewEventInput[] = [];
  const s = state.getState();

  // Gaps → GAP_OPENED
  for (const gap of s.gaps) {
    events.push(...mapGapToEvents(gap, familyId, runId, threadId));
  }

  // Provider results can overlap; one canonical URL must count once per run.
  const sourcesByCanonicalUrl = new Map<string, (typeof s.sources)[number]>();
  for (const src of s.sources) {
    const canonicalUrl = canonicalizeSourceUrl(src.url);
    const current = sourcesByCanonicalUrl.get(canonicalUrl);
    if (
      current === undefined ||
      (src.extractionStatus === 'extracted' && current.extractionStatus !== 'extracted') ||
      (src.contentHash !== undefined && current.contentHash === undefined)
    ) sourcesByCanonicalUrl.set(canonicalUrl, src);
  }
  for (const src of sourcesByCanonicalUrl.values()) events.push(...mapSourceToEvents(src, runId));

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
  const runContexts = new Map<string, AppendContext>();
  const runInputs = new Map<string, StartRunInput>();
  const providerByName = new Map<string, ResearchProvider | undefined>();
  const familyLocks = new Map<string, Promise<void>>();
  const MAX_FOLLOW_UP_RUNS_PER_FAMILY = 3;

  function getProjection(): ProjectionState {
    return rebuildProjection(handlers);
  }

  const MAX_STALE_RETRIES = 10;

  function appendWithRetry(events: readonly NewEventInput[], context: AppendContext): void {
    for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
      try {
        appendEvents(events, context);
        return;
      } catch (error) {
        if (!(error instanceof StaleProjectionError) || attempt >= MAX_STALE_RETRIES) throw error;
        context.projection = getProjection();
      }
    }
  }

  function buildAndPersistCompletion(result: ResearchResult, stateEngine: ResearchStateEngine, familyId: string, runId: string, context: AppendContext, threadId?: string): void {
    for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
      const projection = attempt === 0 ? context.projection : getProjection();
      const scratch = deserializeScratch(projection);
      const stateEvents = buildStateOutputEvents(stateEngine, familyId, runId, threadId);
      const sourceEvents = stateEvents.filter((event) => event.eventType === 'SOURCE_OBSERVED' || event.eventType === 'SOURCE_READ');
      const oldContentHashes = new Map(
        sourceEvents
          .filter((event) => event.eventType === 'SOURCE_OBSERVED')
          .map((event) => {
            const sourceId = (event.payload as { sourceId: string }).sourceId;
            return [sourceId, scratch.sources.get(sourceId)?.contentHash] as const;
          }),
      );
      applyScratchEvents(sourceEvents, scratch, handlers);
      // Map every raw observation, including sources dropped by canonical-URL dedup.
      const sourceIdByObservedId = new Map(
        stateEngine.getState().sources.map((src) => [src.id, canonicalizeSourceUrl(src.url)] as const),
      );
      const events: NewEventInput[] = [...stateEvents];
      for (const event of sourceEvents) {
        if (event.eventType !== 'SOURCE_OBSERVED') continue;
        const payload = event.payload as { sourceId: string; contentHash?: string };
        const oldContentHash = oldContentHashes.get(payload.sourceId);
        if (oldContentHash !== undefined && payload.contentHash !== undefined && oldContentHash !== payload.contentHash) {
          events.push(makeEnvelope('SOURCE_CHANGED', runId, {
            sourceId: payload.sourceId,
            oldContentHash,
            newContentHash: payload.contentHash,
          }, { entityId: payload.sourceId, entityType: 'source' }));
        }
      }
      const findingClaims = new Map<string, string>();
      const claimTextToId = new Map<string, string>();
      for (const finding of result.canonicalFindings ?? []) {
        // Fail-closed validation: structured assertion must exist
        if (!finding.assertion) { logger.warn({ findingId: finding.id }, 'runService: skipping finding without assertion'); continue; }
        if (!finding.groundings || finding.groundings.length === 0) { logger.warn({ findingId: finding.id }, 'runService: skipping finding without groundings'); continue; }
        // Validate source IDs match groundings
        const groundingSourceIds = new Set(finding.groundings.map((g) => g.sourceId));
        const findingSourceIds = new Set(finding.sourceIds);
        if (groundingSourceIds.size !== findingSourceIds.size || ![...groundingSourceIds].every((id) => findingSourceIds.has(id))) {
          logger.warn({ findingId: finding.id }, 'runService: skipping finding — sourceIds mismatch groundings'); continue;
        }
        // Validate groundings exist in scratch and contentHash/offsets are consistent
        let groundingValid = true;
        for (const g of finding.groundings) {
          const canonicalSourceId = sourceIdByObservedId.get(g.sourceId) ?? g.sourceId;
          const src = scratch.sources.get(canonicalSourceId);
          if (!src) { logger.warn({ findingId: finding.id, sourceId: g.sourceId }, 'runService: skipping finding — grounding source not in scratch'); groundingValid = false; break; }
          if (src.contentHash !== undefined && g.contentHash !== src.contentHash) { logger.warn({ findingId: finding.id, sourceId: g.sourceId }, 'runService: skipping finding — grounding contentHash mismatch'); groundingValid = false; break; }
          if (!(0 <= g.spanStart && g.spanStart < g.spanEnd)) { logger.warn({ findingId: finding.id, sourceId: g.sourceId }, 'runService: skipping finding — invalid span offsets'); groundingValid = false; break; }
        }
        if (!groundingValid) continue;

        const a = finding.assertion;
        const observation: ClaimObservation = { id: `obs_${runId}_${finding.id}`, familyId, ...(threadId !== undefined ? { threadId } : {}), runId, observedAt: finding.lastUpdated || finding.createdAt, subjectText: a.subjectText, predicate: a.predicate, polarity: a.polarity, hedge: a.hedge, evidenceType: a.evidenceType, confidence: finding.confidence ?? 0.5, sourceIds: finding.sourceIds.map((sid) => sourceIdByObservedId.get(sid) ?? sid), extractionVersion: 'finding-v2', canonicalKey: a.canonicalKey, ...(a.objectText !== undefined ? { objectText: a.objectText } : {}), ...(a.quantifier !== undefined ? { quantifier: a.quantifier } : {}), ...(a.temporalScope !== undefined ? { temporalScope: a.temporalScope } : {}) };
        // Entity resolution: resolve subject/object text to canonical entity IDs
        const entityResult = resolveClaimEntities(observation, scratch, { now: new Date().toISOString(), runId });
        if (entityResult.subjectEntityId !== undefined) observation.subjectEntityId = entityResult.subjectEntityId;
        if (entityResult.objectEntityId !== undefined) observation.objectEntityId = entityResult.objectEntityId;
        // NODE_ADDED must precede CLAIM_OBSERVED in the append batch
        for (const evt of entityResult.entityEvents) {
          const envelope = makeEnvelope(evt.eventType as EventEnvelope['eventType'], runId, evt.payload, { entityId: (evt.payload as { id: string }).id, entityType: 'entity' });
          events.push(envelope);
          applyScratchEvents([envelope], scratch, handlers);
        }
        const planned = planClaimObservation(observation, scratch);
        const claimId = planned.reconciliation.canonicalClaimId;
        findingClaims.set(finding.id, claimId); claimTextToId.set(finding.claim, claimId);
        const claimEvent = makeEnvelope('CLAIM_OBSERVED', runId, planned, { entityId: claimId, entityType: 'claim' });
        events.push(claimEvent); applyScratchEvents([claimEvent], scratch, handlers);
        // EVIDENCE_LINKED per grounding (not per legacy sourceIds)
        for (const [gIdx, grounding] of finding.groundings.entries()) {
          const sourceId = sourceIdByObservedId.get(grounding.sourceId) ?? grounding.sourceId;
          const isContradiction = planned.reconciliation.classification === 'contradiction' && planned.reconciliation.matchedClaimId;
          if (isContradiction && planned.reconciliation.matchedClaimId) {
            const opposeId = `evd_${finding.id}_${sourceId}_${String(gIdx)}_opposes`;
            const supportId = `evd_${finding.id}_${sourceId}_${String(gIdx)}_supports`;
            events.push(makeEnvelope('EVIDENCE_LINKED', runId, { id: opposeId, claimId: planned.reconciliation.matchedClaimId, sourceId, observationId: observation.id, stance: 'opposes', excerpt: grounding.verbatimSpan, alignment: grounding.alignment, runId }, { entityId: opposeId, entityType: 'evidence', eventVersion: 2 }));
            events.push(makeEnvelope('EVIDENCE_LINKED', runId, { id: supportId, claimId, sourceId, observationId: observation.id, stance: 'supports', excerpt: grounding.verbatimSpan, alignment: grounding.alignment, runId }, { entityId: supportId, entityType: 'evidence', eventVersion: 2 }));
          } else {
            const evId = `evd_${finding.id}_${sourceId}_${String(gIdx)}`;
            events.push(makeEnvelope('EVIDENCE_LINKED', runId, { id: evId, claimId, sourceId, observationId: observation.id, stance: 'supports', excerpt: grounding.verbatimSpan, alignment: grounding.alignment, runId }, { entityId: evId, entityType: 'evidence', eventVersion: 2 }));
          }
        }
      }
      const clusters = new Map<string, string>();
      for (const cluster of result.report.findingClusters ?? []) { const findingId = cluster.findingIds[0]; const claimId = findingId ? findingClaims.get(findingId) : undefined; if (claimId) clusters.set(cluster.id, claimId); }
      const persisted = new Set(findingClaims.values());
      for (const edge of result.report.findingClusterEdges ?? []) events.push(...mapClusterEdgeToClaimRelationEvents(edge, clusters, persisted, runId));
      for (const contradiction of result.report.contradictions) events.push(...mapContradictionToEvents(contradiction, familyId, runId, claimTextToId));
      const persistedClaims = persisted.size;
      const persistedEvidence = events.filter((e) => e.eventType === 'EVIDENCE_LINKED').length;
      events.push(makeEnvelope('RUN_COMPLETED', runId, { runId, claimCount: persistedClaims, sourceCount: stateEngine.getState().sources.length, evidenceCount: persistedEvidence }, { entityId: runId, entityType: 'run' }));
      try { appendEvents(events, { projection, handlers }); context.projection = projection; return; } catch (error) { if (!(error instanceof StaleProjectionError) || attempt >= MAX_STALE_RETRIES) throw error; }
    }
  }

  async function startRun(input: StartRunInput, followUp?: RunFollowUp): Promise<{ runId: string; familyId: string }> {
    const runId = `run_${randomUUID().slice(0, 12)}`;

    // Permanent precondition: explicit agent strategy requires LLM config.
    // Reject before any events are appended — never fail deep in execution.
    if ((input.strategy ?? 'pipeline') === 'agent') {
      const llmCfg = input.config.llm;
      if (!llmCfg.baseUrl || !llmCfg.model) throw new MissingLlmConfigError();
    }

    // 1. Resolve family from current projection BEFORE starting research
    let projection: ProjectionState;
    try {
      projection = getProjection();
    } catch {
      projection = createEmptyProjectionState();
    }

    const { familyId, familyCreated, familyLabel, familyDescription, score: familyScore } = resolveFamilyForRun(input, projection);
    const effectiveThread = input.threadId !== undefined
      ? (() => {
        const thread = projection.threads.get(input.threadId);
        if (!thread) throw new Error(`Thread not found: ${input.threadId}`);
        if (thread.familyId !== familyId) throw new Error(`Thread ${input.threadId} does not belong to family ${familyId}`);
        return { thread, isNew: false };
      })()
      : resolveThread(input.query, familyId, [...projection.threads.values()], { now: new Date().toISOString() });
    const threadId = effectiveThread.thread.id;

    // 2. Append family/thread events before RUN_QUEUED
    const familyEvents: NewEventInput[] = [];
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
        score: familyScore,
        method: 'lexical_manifest_overlap' as const,
      }, { entityId: familyId, entityType: 'family' }),
    );

    if (effectiveThread.isNew) {
      familyEvents.push(makeEnvelope('THREAD_CREATED', runId, {
        threadId,
        familyId,
        label: effectiveThread.thread.label,
        ...(effectiveThread.thread.description !== undefined ? { description: effectiveThread.thread.description } : {}),
      }, { entityId: threadId, entityType: 'thread' }));
    }

    const queuedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + (input.deadlineMs ?? 600_000)).toISOString();
    const providerName = input.providerName ?? input.provider?.name ?? 'search-mcp';
    const retryPolicy = { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1_000, maxBackoffMs: 30_000 };
    const requestHash = hashPayload(JSON.stringify({ query: input.query, strategy: input.strategy ?? 'pipeline', depth: input.depth ?? 'standard', topic: input.topic, familyId, threadId, sessionId: input.sessionId, providerName, deadlineAt, retryPolicy }));
    const runPayload = { runId, rootRunId: runId, attempt: 1, familyId, query: input.query, strategy: input.strategy ?? 'pipeline', depth: input.depth ?? 'standard', topic: input.topic, sessionId: input.sessionId, threadId, providerName, idempotencyKey: input.idempotencyKey, requestHash, retryPolicy, deadlineAt, queuedAt, ...(followUp ? { followUp } : {}) };

    const allStartEvents: NewEventInput[] = [
      ...familyEvents,
      makeEnvelope('RUN_QUEUED', runId, runPayload, { entityId: runId, entityType: 'run' }),
    ];
    const appendContext: AppendContext = { projection, handlers };
    runContexts.set(runId, appendContext);
    try {
      appendWithRetry(allStartEvents, appendContext);
    } catch (err) {
      runContexts.delete(runId);
      throw err;
    }

    providerByName.set(providerName, input.provider);
    runInputs.set(runId, { ...input, threadId });
    await scheduler.enqueue({ ...runPayload, appendContext, input });
    return { runId, familyId };
  }

  function executeResearch(
    runId: string,
    familyId: string,
    input: StartRunInput,
    abortSignal: AbortSignal,
    providerCtx: ProviderCallContext,
    reportProgress: (update: RunProgressUpdate) => Promise<void>,
  ): Promise<void> {
    // Resolve strategy
    const depth: ResearchDepth = (input.depth ?? 'standard') as ResearchDepth;
    const strategyName = input.strategy ?? 'pipeline';

    // Build in-memory research state engine
    const budgetProfile: BudgetProfile = resolveBudgetProfile(depth);
    const budget = new BudgetTracker(budgetProfile);
    const stateEngine = new ResearchStateEngine(budget);
    stateEngine.initialize(input.query, budget);

    // Build strategy context — construct LlmClient when baseUrl+model are
    // configured (apiToken optional: local OpenAI-compatible servers). Token
    // spend flows into the run's BudgetTracker via the client's TokenBudget.
    const llmCfg = input.config.llm;
    const strategyCtx: StrategyContext = {
      state: stateEngine,
      budget,
      provider: input.provider ?? (() => { throw new Error('Provider is required'); })(),
      ...((llmCfg.baseUrl && llmCfg.model)
        ? {
            llm: new LlmClient(
              {
                baseUrl: llmCfg.baseUrl,
                model: llmCfg.model,
                ...(llmCfg.apiKey ? { apiToken: llmCfg.apiKey } : {}),
              },
              budget,
            ),
          }
        : {}),
      config: input.config,
      runContext: { familyId, researchRunId: runId, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}), ...(input.threadId !== undefined ? { threadId: input.threadId } : {}) },
      abortSignal,
      providerCtx,
      reportProgress,
      depth,
    };

    return executeStrategyAndPersist(runId, familyId, strategyName, strategyCtx, stateEngine, abortSignal, input.query, reportProgress);
  }

  async function executeStrategyAndPersist(
    runId: string,
    familyId: string,
    strategyName: string,
    strategyCtx: StrategyContext,
    stateEngine: ResearchStateEngine,
    abortSignal: AbortSignal,
    query: string,
    reportProgress: (update: RunProgressUpdate) => Promise<void>,
  ): Promise<void> {
    const context = runContexts.get(runId);
    if (!context) throw new Error(`Missing append context for run ${runId}`);
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

      if (abortSignal.aborted && !hasTerminalInterruptionEvent(runId)) {
        // Cancellation (user intent — shutdown interruption already recorded)
        await reportProgress({ phase: 'cancelled', message: 'Research cancelled' });
        appendWithRetry([
          makeEnvelope('RUN_CANCELLED', runId, { runId }, { entityId: runId, entityType: 'run' }),
        ], context);
        activeRuns.delete(runId);
        return;
      } else if (abortSignal.aborted) {
        activeRuns.delete(runId);
        return;
      }

      await reportProgress({ phase: 'complete', percent: 100, message: 'Research complete' });
      buildAndPersistCompletion(result, stateEngine, familyId, runId, context, strategyCtx.runContext.threadId);
      activeRuns.delete(runId);
    } catch (err: unknown) {
      if (abortSignal.aborted) {
        if (!hasTerminalInterruptionEvent(runId)) {
          await reportProgress({ phase: 'cancelled', message: 'Research cancelled' });
          appendWithRetry([makeEnvelope('RUN_CANCELLED', runId, { runId }, { entityId: runId, entityType: 'run' })], context);
        }
        return;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      await reportProgress({ phase: 'failed', message: errorMsg });
      appendWithRetry([
        makeEnvelope('RUN_FAILED', runId, {
          runId,
          error: {
            code: classifyError(err) === 'TRANSIENT' ? 'transient' : 'permanent',
            classification: classifyError(err) === 'TRANSIENT' ? 'transient' : 'permanent',
            message: errorMsg.slice(0, 500),
            retryable: classifyError(err) === 'TRANSIENT', occurredAt: new Date().toISOString(),
          },
        }, { entityId: runId, entityType: 'run', eventVersion: 2 }),
      ], context);
      activeRuns.delete(runId);
    } finally {
      activeRuns.delete(runId);
      runContexts.delete(runId);
    }
  }

  const scheduler = new JobScheduler({}, {
    getProvider: async (name) => providerByName.get(name) ?? (() => { throw new Error(`Provider not registered: ${name}`); })(),
    appendWithRetry,
    rebuildAppendContext: () => ({ projection: getProjection(), handlers }),
    rebuildProjection: getProjection,
    executeResearch: (runId, familyId, input, signal, provider, providerCtx, reportProgress) => executeResearch(runId, familyId, { ...input, provider }, signal, providerCtx, reportProgress),
  });

  scheduler.start();

  function getStatus(runId: string): RunStatus | null {
    // Query events directly — RUN_STARTED/RUN_COMPLETED are audit_only
    // and skipped by projectionBuilder, so projection won't have run state.
    const events = queryEvents({ runId });
    if (events.length === 0) return null;

    const startEvt = events.find((e) => e.eventType === 'RUN_STARTED');
    const queuedEvt = events.find((e) => e.eventType === 'RUN_QUEUED');
    if (!startEvt && !queuedEvt) return null;
    const baseEvt = startEvt ?? queuedEvt;
    if (!baseEvt) return null;
    const sp = baseEvt.payload as Record<string, unknown>;

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
      startedAt: baseEvt.timestamp,
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
    return scheduler.cancel(runId);
  }

  async function retryRun(input: RetryRunInput): Promise<{ runId: string; familyId: string; deduplicated: boolean }> {
    const original = foldRunLedger(queryEvents({})).get(input.runId);
    if (!original) throw new Error(`Run not found: ${input.runId}`);
    if (original.status !== 'failed' && original.status !== 'interrupted') {
      throw new Error(`Cannot retry run in status: ${original.status}`);
    }
    if (original.error && !original.error.retryable) {
      throw new Error(`Run error is not retryable: ${original.error.classification}`);
    }
    const runId = `run_${randomUUID().slice(0, 12)}`;
    const retryInput = runInputs.get(input.runId);
    const effectiveRetryInput = retryInput
      ? original.threadId !== undefined ? { ...retryInput, threadId: original.threadId } : retryInput
      : undefined;
    const appendContext: AppendContext = { projection: getProjection(), handlers };
    const queuedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + (input.deadlineMs ?? 600_000)).toISOString();
    const runPayload = {
      runId, rootRunId: original.rootRunId, attempt: original.attempt + 1,
      familyId: original.familyId, threadId: original.threadId, sessionId: original.sessionId,
      query: original.query, topic: original.topic, strategy: original.strategy, depth: original.depth,
      providerName: original.providerName, idempotencyKey: input.idempotencyKey,
      requestHash: original.requestHash, retryPolicy: original.retryPolicy, deadlineAt, queuedAt,
      retryOf: input.runId,
      ...(original.followUp ? { followUp: original.followUp } : {}),
    };
    runContexts.set(runId, appendContext);
    appendWithRetry([makeEnvelope('RUN_QUEUED', runId, runPayload, { entityId: runId, entityType: 'run' })], appendContext);
    return scheduler.enqueue({ ...runPayload, appendContext, ...(effectiveRetryInput ? { input: effectiveRetryInput } : {}) });
  }

  async function continueResearch(input: ContinueResearchInput): Promise<ContinueResearchResult> {
    const previous = familyLocks.get(input.familyId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const lock = previous.then(() => current);
    familyLocks.set(input.familyId, lock);
    await previous;
    try {
      const familyRuns = [...foldRunLedger(queryEvents({})).values()].filter((run) => run.familyId === input.familyId);
      const runs = familyRuns.filter((run) => run.followUp !== undefined);
      const followUpsUsed = runs.length;
      if (followUpsUsed >= MAX_FOLLOW_UP_RUNS_PER_FAMILY) return { status: 'cap_reached', familyId: input.familyId, followUpsUsed, followUpCap: MAX_FOLLOW_UP_RUNS_PER_FAMILY };
      const triedTargetIds = new Set(runs.map((run) => run.followUp?.targetId).filter((id): id is string => id !== undefined));
      const target = selectFollowUpTarget(input.familyId, getProjection(), triedTargetIds);
      if (!target) return { status: 'no_work', familyId: input.familyId, followUpsUsed, followUpCap: MAX_FOLLOW_UP_RUNS_PER_FAMILY };
      const runId = `run_${randomUUID().slice(0, 12)}`;
      const followUp: RunFollowUp = { kind: 'information_gain_v1', targetType: target.type, targetId: target.id, sourceRunId: familyRuns.at(-1)?.runId ?? runId };
      const priorInput = familyRuns.map((run) => runInputs.get(run.runId)).find((candidate) => candidate !== undefined);
      const result = await startRun({
        query: target.query,
        explicitFamilyId: input.familyId,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        depth: input.depth ?? 'quick',
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(priorInput?.provider ? { provider: priorInput.provider } : {}),
        ...(priorInput?.providerName ? { providerName: priorInput.providerName } : {}),
        config: input.config ?? priorInput?.config ?? {} as TrellisConfig,
      }, followUp);
      return { status: 'queued', runId: result.runId, familyId: result.familyId, target: { type: target.type, id: target.id }, query: target.query, followUpsUsed: followUpsUsed + 1, followUpCap: MAX_FOLLOW_UP_RUNS_PER_FAMILY };
    } finally {
      release();
      if (familyLocks.get(input.familyId) === lock) familyLocks.delete(input.familyId);
    }
  }

  return { startRun, getStatus, cancelRun, retryRun, continueResearch, getProjection, startScheduler: () => { scheduler.start(); }, shutdownScheduler: () => { return scheduler.shutdown(); } };
}

/**
 * Roll back a run's pure_run_local events via the store's rollback executor.
 * Returns the rollback outcome.
 */
export function rollbackRunById(
  runId: string,
): { skipped: number; executed: number; blocked: { eventId: string; reason: string }[]; readModelRebuilt: boolean; readModelError?: string } {
  const projection = rebuildProjection({ ...ALL_HANDLERS });
  return rollbackRun(runId, projection, { projection, handlers: { ...ALL_HANDLERS } });
}

// Re-export for tests
export { mapFindingToClaimEvents, mapSourceToEvents, mapGapToEvents, buildCompletionEvents, buildStateOutputEvents };
