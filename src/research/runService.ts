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
import type { ResearchResult, Finding, InternalContradiction, GapRecord, ResearchDepth, FindingCluster, FindingClusterEdge } from './internalTypes.js';
import type { ResearchRun, RunProgressUpdate } from './types.js'
import type { BudgetProfile } from './internalTypes.js';
import type { ProviderCallContext, ResearchProvider } from '../providers/types.js';
import type { TrellisConfig } from '../config/index.js';
import type { AuthorityClass, ClaimObservation } from '../graph/types.js';
import { getClaimsByFamily, getGapsByFamily } from '../graph/queries.js';
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
import { upsertCheckpoint, CURRENT_CHECKPOINT_FORMAT_VERSION, type StepCheckpoint, type ExecutionSpec } from './stepCheckpoints.js';
import type { ResumeState } from './strategies/types.js';

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
  strategy?: 'agent';
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

function hedgeForConfidence(confidence?: number): 'certain' | 'likely' | 'possible' {
  const value = confidence ?? 0.5;
  if (value > 0.8) return 'certain';
  if (value > 0.5) return 'likely';
  return 'possible';
}

function evidenceTypeForClaimType(claimType?: string): import('../graph/types.js').ClaimAssertion['evidenceType'] {
  if (claimType === 'primary') return 'study';
  if (claimType === 'secondary') return 'claim';
  return 'anecdote';
}

interface ResolvedFindingAssertion {
  subjectText: string;
  predicate: string;
  polarity: import('../graph/types.js').ClaimAssertion['polarity'];
  hedge: import('../graph/types.js').ClaimAssertion['hedge'];
  evidenceType: import('../graph/types.js').ClaimAssertion['evidenceType'];
  canonicalKey: import('../graph/types.js').ClaimAssertion['canonicalKey'];
  groundings: { sourceId: string; passageId: string; verbatimSpan: string; alignment: import('../graph/types.js').EvidenceAlignment; contentHash: string }[] | undefined;
}

function resolveFindingAssertion(finding: Finding): ResolvedFindingAssertion {
  const structured = finding as unknown as {
    assertion?: import('../graph/types.js').ClaimAssertion;
    groundings?: ResolvedFindingAssertion['groundings'];
  };
  const assertion = structured.assertion;
  const fallbackPredicate = finding.normalizedClaim || finding.claim;
  return {
    subjectText: assertion?.subjectText ?? finding.claim,
    predicate: assertion?.predicate ?? fallbackPredicate,
    polarity: assertion?.polarity ?? 'asserted',
    hedge: assertion?.hedge ?? hedgeForConfidence(finding.confidence),
    evidenceType: assertion?.evidenceType ?? evidenceTypeForClaimType(finding.claimType),
    canonicalKey: assertion?.canonicalKey ?? {
      subject: finding.claim.slice(0, 200),
      predicate: fallbackPredicate.slice(0, 200),
    },
    groundings: structured.groundings,
  };
}

function buildFindingObservation(args: {
  finding: Finding;
  resolved: ResolvedFindingAssertion;
  familyId: string;
  runId: string;
  threadId?: string | undefined;
}): ClaimObservation {
  const { finding, resolved, familyId, runId, threadId } = args;
  return {
    id: `obs_${runId}_${finding.id}`, familyId, ...(threadId !== undefined ? { threadId } : {}), runId,
    observedAt: finding.lastUpdated || finding.createdAt,
    subjectText: resolved.subjectText,
    predicate: resolved.predicate,
    polarity: resolved.polarity,
    hedge: resolved.hedge,
    evidenceType: resolved.evidenceType,
    confidence: finding.confidence ?? 0.5, sourceIds: finding.sourceIds, extractionVersion: 'finding-v2',
    canonicalKey: resolved.canonicalKey,
  };
}

function buildStructuredEvidenceEvents(args: {
  finding: Finding;
  groundings: NonNullable<ResolvedFindingAssertion['groundings']>;
  claimId: string;
  observationId: string;
  runId: string;
}): NewEventInput[] {
  const { finding, groundings, claimId, observationId, runId } = args;
  return groundings.map((grounding) => {
    const evidence = {
      id: `evd_${finding.id}_${grounding.sourceId}_${grounding.passageId}`,
      claimId,
      sourceId: grounding.sourceId,
      excerpt: grounding.verbatimSpan,
      alignment: grounding.alignment,
      observationId,
      stance: 'supports' as const,
      runId,
    };
    return makeEnvelope('EVIDENCE_LINKED', runId, evidence, { entityId: evidence.id, entityType: 'evidence', eventVersion: 2 });
  });
}

function buildLegacyEvidenceEvents(args: {
  finding: Finding;
  claimId: string;
  observationId: string;
  runId: string;
}): NewEventInput[] {
  const { finding, claimId, observationId, runId } = args;
  return finding.sourceIds.map((sourceId) => {
    const evidence = {
      id: `evd_${finding.id}_${sourceId}`,
      claimId,
      sourceId,
      excerpt: finding.evidenceExcerpt,
      observationId,
      stance: 'supports' as const,
      runId,
    };
    return makeEnvelope('EVIDENCE_LINKED', runId, evidence, { entityId: evidence.id, entityType: 'evidence', eventVersion: 2 });
  });
}

function mapFindingToClaimEvents(
  finding: Finding,
  familyId: string,
  runId: string,
  threadId?: string,
): NewEventInput[] {
  const resolved = resolveFindingAssertion(finding);
  const observation = buildFindingObservation({ finding, resolved, familyId, runId, threadId });
  const planned = planClaimObservation(observation, createEmptyProjectionState());
  const claimId = planned.reconciliation.canonicalClaimId;
  const claimEvent = makeEnvelope('CLAIM_OBSERVED', runId, planned, { entityId: claimId, entityType: 'claim' });
  const hasStructuredGroundings = resolved.groundings !== undefined && resolved.groundings.length > 0;
  const evidenceEvents = hasStructuredGroundings
    ? buildStructuredEvidenceEvents({ finding, groundings: resolved.groundings ?? [], claimId, observationId: observation.id, runId })
    : buildLegacyEvidenceEvents({ finding, claimId, observationId: observation.id, runId });
  return [claimEvent, ...evidenceEvents];
}

// ── Mapping: FindingClusterEdge → ClaimRelation ─────────────────────

function hasUnresolvableEdgeEndpoints(fromClaimId: string | undefined, toClaimId: string | undefined, persistedClaimIds: Set<string>): boolean {
  return fromClaimId === undefined || toClaimId === undefined || !persistedClaimIds.has(fromClaimId) || !persistedClaimIds.has(toClaimId);
}

function mapClusterEdgeToClaimRelationEvents(
  edge: { fromClusterId: string; toClusterId: string; relation: string; strength: string; score: number },
  clusterRepresentativeClaimId: Map<string, string>,
  persistedClaimIds: Set<string>,
  runId: string,
): NewEventInput[] {
  const fromClaimId = clusterRepresentativeClaimId.get(edge.fromClusterId);
  const toClaimId = clusterRepresentativeClaimId.get(edge.toClusterId);
  if (hasUnresolvableEdgeEndpoints(fromClaimId, toClaimId, persistedClaimIds)) {
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
function appendFindingClaimBatch(args: {
  findings: Finding[];
  familyId: string;
  runId: string;
  threadId: string | undefined;
  target: { claimTextToId: Map<string, string>; persistedClaimIds: Set<string>; findingToClaim: Map<string, string>; scratch: ProjectionState };
  events: NewEventInput[];
}): void {
  const { findings, familyId, runId, threadId, target, events } = args;
  for (const f of findings) {
    const mapped = mapFindingToClaimEvents(f, familyId, runId, threadId);
    const first = mapped[0];
    if (!first) continue;
    const planned = first.payload as { observation: ClaimObservation; reconciliation: { canonicalClaimId: string } };
    const claimId = planned.reconciliation.canonicalClaimId;
    target.claimTextToId.set(f.claim, claimId);
    target.persistedClaimIds.add(claimId);
    target.findingToClaim.set(f.id, claimId);
    events.push(first);
    graphEventHandlers.CLAIM_OBSERVED({ ...first, id: `scratch_${f.id}`, seq: target.scratch.lastAppliedSeq, payloadHash: '', actorId: first.actorId ?? null }, target.scratch);
    events.push(...mapped.slice(1));
  }
}

function buildClusterRepresentatives(
  clusters: FindingCluster[] | undefined,
  findingToClaim: Map<string, string>,
): Map<string, string> {
  const representatives = new Map<string, string>();
  if (!clusters) return representatives;
  for (const cluster of clusters) {
    const representativeFindingId = cluster.findingIds[0];
    if (representativeFindingId === undefined) continue;
    const claimId = findingToClaim.get(representativeFindingId);
    if (claimId) representatives.set(cluster.id, claimId);
  }
  return representatives;
}

function appendClusterEdgeEvents(args: {
  edges: FindingClusterEdge[] | undefined;
  clusterRepresentativeClaimId: Map<string, string>;
  persistedClaimIds: Set<string>;
  runId: string;
  events: NewEventInput[];
}): void {
  const { edges, clusterRepresentativeClaimId, persistedClaimIds, runId, events } = args;
  if (!edges) return;
  for (const edge of edges) {
    events.push(...mapClusterEdgeToClaimRelationEvents(edge, clusterRepresentativeClaimId, persistedClaimIds, runId));
  }
}

function appendContradictionEvents(args: {
  contradictions: InternalContradiction[];
  familyId: string;
  runId: string;
  claimTextToId: Map<string, string>;
  events: NewEventInput[];
}): void {
  const { contradictions, familyId, runId, claimTextToId, events } = args;
  for (const ic of contradictions) {
    events.push(...mapContradictionToEvents(ic, familyId, runId, claimTextToId));
  }
}

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
  const findingToClaim = new Map<string, string>();
  const claimBatch = { claimTextToId, persistedClaimIds, findingToClaim, scratch: createEmptyProjectionState() };
  appendFindingClaimBatch({ findings, familyId, runId, threadId, target: claimBatch, events });

  // FindingClusters → representative claim per cluster (first finding in the cluster).
  // Cluster edges connect clusters, not individual claims; a representative avoids
  // fabricating a claim id from a cluster id that no persisted Claim actually has.
  const clusterRepresentativeClaimId = buildClusterRepresentatives(report.findingClusters, findingToClaim);
  if (report.findingClusterEdges) {
  appendClusterEdgeEvents({ edges: report.findingClusterEdges, clusterRepresentativeClaimId, persistedClaimIds, runId, events });
  }

  // Contradictions → CONTRADICTION_IDENTIFIED (skipped if claim text doesn't resolve)
  appendContradictionEvents({ contradictions: report.contradictions, familyId, runId, claimTextToId, events });

  return events;
}

/**
 * Build events for research state output (gaps, sources).
 * These come from state.getState() not from the report.
 */
function prefersSourceCandidate(current: import('./internalTypes.js').SourceEntry | undefined, candidate: import('./internalTypes.js').SourceEntry): boolean {
  if (current === undefined) return true;
  return (candidate.extractionStatus === 'extracted' && current.extractionStatus !== 'extracted') ||
    (candidate.contentHash !== undefined && current.contentHash === undefined);
}

function appendGapEvents(args: {
  state: ResearchStateEngine;
  familyId: string;
  runId: string;
  threadId: string | undefined;
  events: NewEventInput[];
}): void {
  const { state, familyId, runId, threadId, events } = args;
  for (const gap of state.getState().gaps) events.push(...mapGapToEvents(gap, familyId, runId, threadId));
}

function appendDedupedSourceEvents(state: ResearchStateEngine, runId: string, events: NewEventInput[]): void {
  const seenSourceUrls = new Map<string, import('./internalTypes.js').SourceEntry>();
  for (const src of state.getState().sources) {
    const key = canonicalizeSourceUrl(src.url);
    const current = seenSourceUrls.get(key);
    if (current === undefined || prefersSourceCandidate(current, src)) seenSourceUrls.set(key, src);
  }
  for (const src of seenSourceUrls.values()) events.push(...mapSourceToEvents(src, runId));
}

function buildStateOutputEvents(
  state: ResearchStateEngine,
  familyId: string,
  runId: string,
  threadId?: string,
): NewEventInput[] {
  const events: NewEventInput[] = [];

  appendGapEvents({ state, familyId, runId, threadId, events });
  appendDedupedSourceEvents(state, runId, events);

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
  const MAX_RUN_INPUTS = 100;
  function setRunInput(id: string, input: StartRunInput): void {
    if (runInputs.size >= MAX_RUN_INPUTS) {
      // Evict oldest entry (Map preserves insertion order)
      const oldest = runInputs.keys().next().value;
      if (oldest !== undefined) runInputs.delete(oldest);
    }
    runInputs.set(id, input);
  }
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

  interface CompletionPersistParams {
    result: ResearchResult;
    stateEngine: ResearchStateEngine;
    familyId: string;
    runId: string;
    context: AppendContext;
    threadId?: string | undefined;
  }

  interface CompletionAttemptState {
    scratch: ProjectionState;
    sourceIdByObservedId: Map<string, string>;
    events: NewEventInput[];
    findingClaims: Map<string, string>;
    claimTextToId: Map<string, string>;
  }

  function collectCompletionScratch(params: CompletionPersistParams, projection: ProjectionState): CompletionAttemptState {
    const scratch = deserializeScratch(projection);
    const stateEvents = buildStateOutputEvents(params.stateEngine, params.familyId, params.runId, params.threadId);
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
    const sourceIdByObservedId = new Map(
      params.stateEngine.getState().sources.map((src) => [src.id, canonicalizeSourceUrl(src.url)] as const),
    );
    const events: NewEventInput[] = [...stateEvents];
    appendSourceChangedEvents(sourceEvents, oldContentHashes, params.runId, events);
    return { scratch, sourceIdByObservedId, events, findingClaims: new Map(), claimTextToId: new Map() };
  }

function contentHashChanged(oldContentHash: string | undefined, newContentHash: string | undefined): boolean {
  return oldContentHash !== undefined && newContentHash !== undefined && oldContentHash !== newContentHash;
}

  function appendSourceChangedEvents(sourceEvents: NewEventInput[], oldContentHashes: Map<string, string | undefined>, runId: string, events: NewEventInput[]): void {
    for (const event of sourceEvents) {
      if (event.eventType !== 'SOURCE_OBSERVED') continue;
      const payload = event.payload as { sourceId: string; contentHash?: string };
      const oldContentHash = oldContentHashes.get(payload.sourceId);
      if (!contentHashChanged(oldContentHash, payload.contentHash)) continue;
      events.push(makeEnvelope('SOURCE_CHANGED', runId, {
        sourceId: payload.sourceId,
        oldContentHash,
        newContentHash: payload.contentHash,
      }, { entityId: payload.sourceId, entityType: 'source' }));
    }
  }

  function findingSourceIdsMatchGroundings(finding: { sourceIds: string[]; groundings: { sourceId: string }[] }): boolean {
    const groundingSourceIds = new Set(finding.groundings.map((g) => g.sourceId));
    const findingSourceIds = new Set(finding.sourceIds);
    return groundingSourceIds.size === findingSourceIds.size && [...groundingSourceIds].every((id) => findingSourceIds.has(id));
  }

  function validateFindingGroundings(finding: { id: string; groundings: { sourceId: string; contentHash: string; spanStart: number; spanEnd: number }[] }, scratch: ProjectionState, sourceIdByObservedId: Map<string, string>): boolean {
    for (const g of finding.groundings) {
      const canonicalSourceId = sourceIdByObservedId.get(g.sourceId) ?? g.sourceId;
      const src = scratch.sources.get(canonicalSourceId);
      if (!src) { logger.warn({ findingId: finding.id, sourceId: g.sourceId }, 'runService: skipping finding — grounding source not in scratch'); return false; }
      if (src.contentHash !== undefined && g.contentHash !== src.contentHash) { logger.warn({ findingId: finding.id, sourceId: g.sourceId }, 'runService: skipping finding — grounding contentHash mismatch'); return false; }
      if (!(0 <= g.spanStart && g.spanStart < g.spanEnd)) { logger.warn({ findingId: finding.id, sourceId: g.sourceId }, 'runService: skipping finding — invalid span offsets'); return false; }
    }
    return true;
  }

  function buildCanonicalFindingObservation(args: {
    finding: { assertion: import('../graph/types.js').ClaimAssertion; id: string; lastUpdated: string; createdAt: string; confidence?: number; sourceIds: string[] };
    familyId: string;
    runId: string;
    threadId: string | undefined;
    sourceIdByObservedId: Map<string, string>;
  }): ClaimObservation {
    const { finding, familyId, runId, threadId, sourceIdByObservedId } = args;
    const a = finding.assertion;
    return {
      id: `obs_${runId}_${(finding as { id: string }).id}`, familyId, ...(threadId !== undefined ? { threadId } : {}), runId,
      observedAt: (finding as { lastUpdated: string; createdAt: string }).lastUpdated || (finding as { createdAt: string }).createdAt,
      subjectText: a.subjectText, predicate: a.predicate, polarity: a.polarity, hedge: a.hedge, evidenceType: a.evidenceType,
      confidence: (finding as { confidence?: number }).confidence ?? 0.5,
      sourceIds: (finding as { sourceIds: string[] }).sourceIds.map((sid) => sourceIdByObservedId.get(sid) ?? sid),
      extractionVersion: 'finding-v2', canonicalKey: a.canonicalKey,
      ...(a.objectText !== undefined ? { objectText: a.objectText } : {}),
      ...(a.quantifier !== undefined ? { quantifier: a.quantifier } : {}),
      ...(a.temporalScope !== undefined ? { temporalScope: a.temporalScope } : {}),
    };
  }

  function appendEntityResolutionEvents(observation: ClaimObservation, scratch: ProjectionState, runId: string, events: NewEventInput[]): void {
    const entityResult = resolveClaimEntities(observation, scratch, { now: new Date().toISOString(), runId });
    if (entityResult.subjectEntityId !== undefined) observation.subjectEntityId = entityResult.subjectEntityId;
    if (entityResult.objectEntityId !== undefined) observation.objectEntityId = entityResult.objectEntityId;
    // NODE_ADDED must precede CLAIM_OBSERVED in the append batch
    for (const evt of entityResult.entityEvents) {
      const envelope = makeEnvelope(evt.eventType as EventEnvelope['eventType'], runId, evt.payload, { entityId: (evt.payload as { id: string }).id, entityType: 'entity' });
      events.push(envelope);
      applyScratchEvents([envelope], scratch, handlers);
    }
  }

  function appendSupersessionEvent(planned: { reconciliation: { classification: string; matchedClaimId?: string; canonicalClaimId: string } }, observation: ClaimObservation, runId: string, events: NewEventInput[]): void {
    if (planned.reconciliation.classification !== 'supersedes' || !planned.reconciliation.matchedClaimId) return;
    events.push(makeEnvelope('CLAIM_EXPIRED', runId, {
      claimId: planned.reconciliation.matchedClaimId,
      expiredAt: new Date().toISOString(),
      reason: 'superseded' as const,
      replacementClaimId: planned.reconciliation.canonicalClaimId,
      replacementObservationId: observation.id,
    }, { entityId: planned.reconciliation.matchedClaimId, entityType: 'claim' }));
  }

  function appendGroundingEvidenceEvents(finding: { id: string; groundings: { sourceId: string; verbatimSpan: string; alignment: import('../graph/types.js').EvidenceAlignment }[] }, planned: { reconciliation: { classification: string; matchedClaimId?: string; canonicalClaimId: string } }, observation: ClaimObservation, sourceIdByObservedId: Map<string, string>, runId: string, events: NewEventInput[]): void {
    const claimId = planned.reconciliation.canonicalClaimId;
    const isContradiction = planned.reconciliation.classification === 'contradiction' && planned.reconciliation.matchedClaimId;
    for (const [gIdx, grounding] of finding.groundings.entries()) {
      const sourceId = sourceIdByObservedId.get(grounding.sourceId) ?? grounding.sourceId;
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

  function appendCompletionFinding(finding: NonNullable<ResearchResult['canonicalFindings']>[number], params: CompletionPersistParams, attempt: CompletionAttemptState): void {
    if (!findingSourceIdsMatchGroundings(finding)) {
      logger.warn({ findingId: finding.id }, 'runService: skipping finding — sourceIds mismatch groundings'); return;
    }
    if (!validateFindingGroundings(finding, attempt.scratch, attempt.sourceIdByObservedId)) return;
    const observation = buildCanonicalFindingObservation({ finding, familyId: params.familyId, runId: params.runId, threadId: params.threadId, sourceIdByObservedId: attempt.sourceIdByObservedId });
    appendEntityResolutionEvents(observation, attempt.scratch, params.runId, attempt.events);
    const planned = planClaimObservation(observation, attempt.scratch);
    const claimId = planned.reconciliation.canonicalClaimId;
    attempt.findingClaims.set(finding.id, claimId);
    attempt.claimTextToId.set(finding.claim, claimId);
    appendSupersessionEvent(planned, observation, params.runId, attempt.events);
    const claimEvent = makeEnvelope('CLAIM_OBSERVED', params.runId, planned, { entityId: claimId, entityType: 'claim' });
    attempt.events.push(claimEvent);
    applyScratchEvents([claimEvent], attempt.scratch, handlers);
    appendGroundingEvidenceEvents(finding, planned, observation, attempt.sourceIdByObservedId, params.runId, attempt.events);
  }

  function finalizeCompletionBatch(params: CompletionPersistParams, attempt: CompletionAttemptState): void {
    const clusters = new Map<string, string>();
    for (const cluster of params.result.report.findingClusters ?? []) {
      const findingId = cluster.findingIds[0];
      const claimId = findingId ? attempt.findingClaims.get(findingId) : undefined;
      if (claimId) clusters.set(cluster.id, claimId);
    }
    const persisted = new Set(attempt.findingClaims.values());
    for (const edge of params.result.report.findingClusterEdges ?? []) attempt.events.push(...mapClusterEdgeToClaimRelationEvents(edge, clusters, persisted, params.runId));
    for (const contradiction of params.result.report.contradictions) attempt.events.push(...mapContradictionToEvents(contradiction, params.familyId, params.runId, attempt.claimTextToId));
    const persistedEvidence = attempt.events.filter((e) => e.eventType === 'EVIDENCE_LINKED').length;
    attempt.events.push(makeEnvelope('RUN_COMPLETED', params.runId, { runId: params.runId, claimCount: persisted.size, sourceCount: params.stateEngine.getState().sources.length, evidenceCount: persistedEvidence }, { entityId: params.runId, entityType: 'run' }));
  }

  function persistCompletionAttempt(params: CompletionPersistParams, projection: ProjectionState): void {
    const attempt = collectCompletionScratch(params, projection);
    for (const finding of params.result.canonicalFindings ?? []) appendCompletionFinding(finding, params, attempt);
    finalizeCompletionBatch(params, attempt);
    appendEvents(attempt.events, { projection, handlers });
    params.context.projection = projection;
  }

  function buildAndPersistCompletion(params: CompletionPersistParams): void {
    for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
      const projection = attempt === 0 ? params.context.projection : getProjection();
      try {
        persistCompletionAttempt(params, projection);
        return;
      } catch (error) {
        if (!(error instanceof StaleProjectionError) || attempt >= MAX_STALE_RETRIES) throw error;
      }
    }
  }
  function assertLlmConfigured(input: StartRunInput): void {
    const llmCfgForCheck = input.config.llm;
    if (!llmCfgForCheck.baseUrl || !llmCfgForCheck.model) throw new MissingLlmConfigError();
  }

  function resolveEffectiveThreadForStart(
    threadIdInput: string | undefined,
    query: string,
    familyId: string,
    projection: ProjectionState,
    now: string,
  ): { thread: { id: string; label: string; description?: string }; isNew: boolean } {
    if (threadIdInput !== undefined) {
      const thread = projection.threads.get(threadIdInput);
      if (!thread) throw new Error(`Thread not found: ${threadIdInput}`);
      if (thread.familyId !== familyId) throw new Error(`Thread ${threadIdInput} does not belong to family ${familyId}`);
      return { thread, isNew: false };
    }
    return resolveThread(query, familyId, [...projection.threads.values()], { now });
  }

  function checkStartIdempotency(scheduler: JobScheduler, idempotencyKey: string | undefined, requestHash: string): { runId: string; familyId: string } | undefined {
    const idemCheck = scheduler.checkIdempotency({ idempotencyKey: idempotencyKey ?? undefined, requestHash });
    if (idemCheck.deduplicated) return { runId: idemCheck.runId, familyId: idemCheck.familyId };
    return undefined;
  }

  function buildFamilyStartEvents(args: {
    runId: string;
    familyId: string;
    familyCreated: boolean;
    familyLabel: string;
    familyDescription: string;
    familyScore: number;
    input: StartRunInput;
    threadId: string;
    effectiveThread: { thread: { label: string; description?: string }; isNew: boolean };
  }): NewEventInput[] {
    const { runId, familyId, familyCreated, familyLabel, familyDescription, familyScore, input, threadId, effectiveThread } = args;
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
    return familyEvents;
  }

  interface RunPayloadForStart {
    runId: string; rootRunId: string; attempt: number; familyId: string; query: string;
    strategy: 'agent'; depth: string; topic?: string | undefined; sessionId?: string | undefined;
    threadId: string; providerName: string; idempotencyKey?: string | undefined;
    requestHash: string; retryPolicy: { maxAttempts: number; autoRetry: boolean; initialBackoffMs: number; maxBackoffMs: number };
    deadlineAt: string; queuedAt: string; followUp?: RunFollowUp | undefined;
  }

  function buildRunPayloadForStart(args: {
    runId: string; familyId: string; input: StartRunInput; threadId: string; providerName: string;
    requestHash: string; retryPolicy: { maxAttempts: number; autoRetry: boolean; initialBackoffMs: number; maxBackoffMs: number };
    deadlineAt: string; queuedAt: string; followUp?: RunFollowUp | undefined;
  }): RunPayloadForStart {
    const { runId, familyId, input, threadId, providerName, requestHash, retryPolicy, deadlineAt, queuedAt, followUp } = args;
    return {
      runId, rootRunId: runId, attempt: 1, familyId, query: input.query,
      strategy: input.strategy ?? 'agent', depth: input.depth ?? 'standard',
      topic: input.topic, sessionId: input.sessionId, threadId, providerName,
      idempotencyKey: input.idempotencyKey, requestHash, retryPolicy, deadlineAt, queuedAt,
      ...(followUp ? { followUp } : {}),
    };
  }

  function computeStartRequestHash(args: {
    input: StartRunInput; familyId: string; threadId: string; providerName: string;
    effectiveDeadlineMs: number; retryPolicy: { maxAttempts: number; autoRetry: boolean; initialBackoffMs: number; maxBackoffMs: number };
  }): string {
    const { input, familyId, threadId, providerName, effectiveDeadlineMs, retryPolicy } = args;
    return hashPayload(JSON.stringify({
      query: input.query, strategy: input.strategy ?? 'agent', depth: input.depth ?? 'standard',
      topic: input.topic, familyId, threadId, sessionId: input.sessionId, providerName,
      deadlineMs: effectiveDeadlineMs, retryPolicy,
    }));
  }

  async function startRun(input: StartRunInput, followUp?: RunFollowUp): Promise<{ runId: string; familyId: string }> {
    const runId = `run_${randomUUID().slice(0, 12)}`;

    // Permanent precondition: every new run requires LLM config (agent is the only strategy).
    // Reject before any events are appended — never fail deep in execution.
    assertLlmConfigured(input);

    // 1. Resolve family from current projection BEFORE starting research
    let projection: ProjectionState;
    try {
      projection = getProjection();
    } catch {
      projection = createEmptyProjectionState();
    }

    const { familyId, familyCreated, familyLabel, familyDescription, score: familyScore } = resolveFamilyForRun(input, projection);
    const effectiveThread = resolveEffectiveThreadForStart(input.threadId, input.query, familyId, projection, new Date().toISOString());
    const threadId = effectiveThread.thread.id;

    // 2. Append family/thread events before RUN_QUEUED
    const familyEvents: NewEventInput[] = buildFamilyStartEvents({
      runId, familyId, familyCreated, familyLabel, familyDescription, familyScore,
      input, threadId, effectiveThread,
    });

    const queuedAt = new Date().toISOString();
    const effectiveDeadlineMs = input.deadlineMs ?? 600_000;
    const deadlineAt = new Date(Date.now() + effectiveDeadlineMs).toISOString();
    const providerName = input.providerName ?? input.provider?.name ?? 'search-mcp';
    const retryPolicy = { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1_000, maxBackoffMs: 30_000 };
    const requestHash = computeStartRequestHash({ input, familyId, threadId, providerName, effectiveDeadlineMs, retryPolicy });
    const runPayload = buildRunPayloadForStart({
      runId, familyId, input, threadId, providerName, requestHash, retryPolicy, deadlineAt, queuedAt,
      ...(followUp ? { followUp } : {}),
    });

    const appendContext: AppendContext = { projection, handlers };

    // Consult scheduler for idempotency BEFORE appending any events.
    const deduplicated = checkStartIdempotency(scheduler, input.idempotencyKey, requestHash);
    if (deduplicated) return deduplicated;

    // Append RUN_QUEUED durably BEFORE activating the scheduler.
    const allStartEvents: NewEventInput[] = [
      ...familyEvents,
      makeEnvelope('RUN_QUEUED', runId, runPayload, { entityId: runId, entityType: 'run' }),
    ];
    runContexts.set(runId, appendContext);
    try {
      appendWithRetry(allStartEvents, appendContext);
    } catch (err) {
      runContexts.delete(runId);
      throw err;
    }

    providerByName.set(providerName, input.provider);
    setRunInput(runId, { ...input, threadId });
    scheduler.activate({ ...runPayload, appendContext, input });
    return { runId, familyId };
  }

  interface ExecuteResearchParams {
    runId: string;
    familyId: string;
    input: StartRunInput;
    abortSignal: AbortSignal;
    providerCtx: ProviderCallContext;
    reportProgress: (update: RunProgressUpdate) => Promise<void>;
    checkpoint?: StepCheckpoint | undefined;
  }

  function buildResumeState(checkpoint: StepCheckpoint | undefined, stateEngine: ResearchStateEngine, budget: BudgetTracker): ResumeState | undefined {
    if (checkpoint === undefined) return undefined;
    stateEngine.fromJSON(checkpoint.strategyState);
    budget.restore(checkpoint.strategyState.budget);
    const pending = checkpoint.pendingWrite;
    return {
      stepIndex: checkpoint.stepIndex,
      status: checkpoint.status,
      history: checkpoint.history,
      strategyState: checkpoint.strategyState,
      budgetState: checkpoint.strategyState.budget,
      ...(pending !== null && checkpoint.status === 'started'
        ? { pendingTool: { name: (pending as { tool: string }).tool, args: (pending as { args: Record<string, unknown> }).args, ...(pending as { thought?: string }).thought !== undefined ? { thought: (pending as { thought?: string }).thought } : {} } }
        : {}),
    };
  }

  function buildResearchLlm(input: StartRunInput, budget: BudgetTracker): LlmClient | undefined {
    const llmCfg = input.config.llm;
    if (!llmCfg.baseUrl || !llmCfg.model) return undefined;
    return new LlmClient(
      {
        baseUrl: llmCfg.baseUrl,
        model: llmCfg.model,
        ...(llmCfg.apiKey ? { apiToken: llmCfg.apiKey } : {}),
      },
      budget,
    );
  }

  function makeCheckpointStep(args: {
    runId: string; input: StartRunInput; familyId: string;
    providerCtx: ProviderCallContext; stateEngine: ResearchStateEngine;
  }): NonNullable<StrategyContext['checkpointStep']> {
    const { runId, input, familyId, providerCtx, stateEngine } = args;
    return (stepIndex, status, pendingWrite, history) => {
      const execSpec: ExecutionSpec = {
        query: input.query,
        depth: input.depth ?? 'standard',
        topic: input.topic,
        familyId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        providerName: input.providerName ?? input.provider?.name ?? 'unknown',
        deadlineAt: new Date(providerCtx.deadlineAt).toISOString(),
        config: input.config,
      };
      upsertCheckpoint({
        runId,
        stepIndex,
        status,
        executionSpec: execSpec,
        strategyState: stateEngine.toJSON(),
        history,
        pendingWrite: pendingWrite as StepCheckpoint['pendingWrite'],
        formatVersion: CURRENT_CHECKPOINT_FORMAT_VERSION,
        updatedAt: new Date().toISOString(),
      });
    };
  }

  function makePriorKnowledge(familyId: string): NonNullable<StrategyContext['getPriorKnowledge']> {
    return async () => {
      const proj = getProjection();
      const claims = getClaimsByFamily(proj, familyId).slice(0, 20);
      const gaps = getGapsByFamily(proj, familyId).slice(0, 10);
      return {
        knownClaims: claims.map((c) => `${c.subjectText} ${c.predicate}`),
        knownGaps: gaps.map((g) => g.question),
      };
    };
  }

  function makePersistPlan(args: { runId: string; input: StartRunInput; counter: { count: number } }): NonNullable<StrategyContext['persistPlan']> {
    const { runId, input, counter } = args;
    return async (plan, kind, reason) => {
      const ctx = runContexts.get(runId);
      if (!ctx) return;
      const now = new Date().toISOString();
      if (kind === 'created') {
        appendWithRetry([makeEnvelope('RESEARCH_PLAN_CREATED', runId, { runId, query: input.query, plan, createdAt: now }, { entityId: runId, entityType: 'run' })], ctx);
        return;
      }
      counter.count++;
      appendWithRetry([makeEnvelope('RESEARCH_PLAN_REVISED', runId, { runId, query: input.query, revisionReason: reason ?? '', plan, revisedAt: now, revisionNumber: counter.count }, { entityId: runId, entityType: 'run' })], ctx);
    };
  }

  function executeResearch(params: ExecuteResearchParams): Promise<void> {
    const { runId, familyId, input, abortSignal, providerCtx, reportProgress, checkpoint } = params;
    // Resolve strategy
    const depth: ResearchDepth = (input.depth ?? 'standard') as ResearchDepth;

    // Build in-memory research state engine
    const budgetProfile: BudgetProfile = resolveBudgetProfile(depth);
    const budget = new BudgetTracker(budgetProfile);
    const stateEngine = new ResearchStateEngine(budget);
    stateEngine.initialize(input.query, budget);

    const resumeState = buildResumeState(checkpoint, stateEngine, budget);
    const llm = buildResearchLlm(input, budget);
    const revisionCounter = { count: 0 };
    const strategyCtx: StrategyContext = {
      state: stateEngine,
      budget,
      provider: input.provider ?? (() => { throw new Error('Provider is required'); })(),
      ...(llm !== undefined ? { llm } : {}),
      config: input.config,
      runContext: { familyId, researchRunId: runId, ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}), ...(input.threadId !== undefined ? { threadId: input.threadId } : {}) },
      abortSignal,
      providerCtx,
      reportProgress,
      depth,
      ...(resumeState !== undefined ? { resumeState } : {}),
      checkpointStep: makeCheckpointStep({ runId, input, familyId, providerCtx, stateEngine }),
      getPriorKnowledge: makePriorKnowledge(familyId),
      persistPlan: makePersistPlan({ runId, input, counter: revisionCounter }),
    };

    return executeStrategyAndPersist({ runId, familyId, strategyCtx, stateEngine, abortSignal, query: input.query, reportProgress });
  }

  interface StrategyPersistParams {
    runId: string;
    familyId: string;
    strategyCtx: StrategyContext;
    stateEngine: ResearchStateEngine;
    abortSignal: AbortSignal;
    query: string;
    reportProgress: (update: RunProgressUpdate) => Promise<void>;
  }

  async function appendRunCancelledEvent(runId: string, reportProgress: (update: RunProgressUpdate) => Promise<void>, context: AppendContext): Promise<void> {
    await reportProgress({ phase: 'cancelled', message: 'Research cancelled' });
    appendWithRetry([
      makeEnvelope('RUN_CANCELLED', runId, { runId }, { entityId: runId, entityType: 'run' }),
    ], context);
  }

  function appendRunFailedEvent(runId: string, err: unknown, context: AppendContext): { message: string } {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const classification = classifyError(err) === 'TRANSIENT' ? 'transient' : 'permanent';
    appendWithRetry([
      makeEnvelope('RUN_FAILED', runId, {
        runId,
        error: {
          code: classification,
          classification,
          message: errorMsg.slice(0, 500),
          retryable: classifyError(err) === 'TRANSIENT', occurredAt: new Date().toISOString(),
        },
      }, { entityId: runId, entityType: 'run', eventVersion: 2 }),
    ], context);
    return { message: errorMsg };
  }

  async function handleStrategyAbort(params: StrategyPersistParams, context: AppendContext): Promise<boolean> {
    const { runId, abortSignal, reportProgress } = params;
    if (!abortSignal.aborted) return false;
    if (!hasTerminalInterruptionEvent(runId)) {
      await appendRunCancelledEvent(runId, reportProgress, context);
    }
    activeRuns.delete(runId);
    return true;
  }

  async function handleStrategyError(params: StrategyPersistParams, context: AppendContext, err: unknown): Promise<void> {
    const { runId, abortSignal, reportProgress } = params;
    if (abortSignal.aborted) {
      if (!hasTerminalInterruptionEvent(runId)) {
        await appendRunCancelledEvent(runId, reportProgress, context);
      }
      return;
    }
    const { message } = appendRunFailedEvent(runId, err, context);
    await reportProgress({ phase: 'failed', message });
    activeRuns.delete(runId);
  }

  async function executeStrategyAndPersist(params: StrategyPersistParams): Promise<void> {
    const { runId, familyId, strategyCtx, stateEngine, query, reportProgress } = params;
    const context = runContexts.get(runId);
    if (!context) throw new Error(`Missing append context for run ${runId}`);
    try {
      // Import strategy dynamically to avoid circular deps
      const { AgentStrategy } = await import('./strategies/agentStrategy.js');
      const strategy = new AgentStrategy(strategyCtx);

      // Execute
      const result = await strategy.analyze(query, strategyCtx);

      if (await handleStrategyAbort(params, context)) return;

      await reportProgress({ phase: 'complete', percent: 100, message: 'Research complete' });
      buildAndPersistCompletion({ result, stateEngine, familyId, runId, context, threadId: strategyCtx.runContext.threadId });
      activeRuns.delete(runId);
    } catch (err: unknown) {
      await handleStrategyError(params, context, err);
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
    executeResearch: (runId, familyId, input, signal, provider, providerCtx, reportProgress, checkpoint) => executeResearch({ runId, familyId, input: { ...input, provider }, abortSignal: signal, providerCtx, reportProgress, checkpoint }),
  });

  scheduler.start();

  function resolveRunBaseEvent(events: { eventType: string; timestamp: string; payload: unknown }[]): { baseEvt: { timestamp: string; payload: unknown }; status: string; completedEvt?: { timestamp: string; payload: unknown }; failedEvt?: { timestamp: string; payload: unknown }; cancelledEvt?: { timestamp: string; payload: unknown } } | null {
    const startEvt = events.find((e) => e.eventType === 'RUN_STARTED');
    const queuedEvt = events.find((e) => e.eventType === 'RUN_QUEUED');
    const baseEvt = startEvt ?? queuedEvt;
    if (!baseEvt) return null;
    const completedEvt = events.find((e) => e.eventType === 'RUN_COMPLETED');
    const failedEvt = events.find((e) => e.eventType === 'RUN_FAILED');
    const cancelledEvt = events.find((e) => e.eventType === 'RUN_CANCELLED');
    let status = 'running';
    if (completedEvt) status = 'completed';
    else if (failedEvt) status = 'failed';
    else if (cancelledEvt) status = 'cancelled';
    return { baseEvt, status, ...(completedEvt ? { completedEvt } : {}), ...(failedEvt ? { failedEvt } : {}), ...(cancelledEvt ? { cancelledEvt } : {}) };
  }

  function applyCompletionCounts(out: RunStatus, completedEvt: { timestamp: string; payload: unknown }): void {
    const cp = completedEvt.payload as Record<string, unknown>;
    out.completedAt = completedEvt.timestamp;
    if (typeof cp.claimCount === 'number') out.claimCount = cp.claimCount;
    if (typeof cp.sourceCount === 'number') out.sourceCount = cp.sourceCount;
    if (typeof cp.evidenceCount === 'number') out.evidenceCount = cp.evidenceCount;
  }

  function applyFailureInfo(out: RunStatus, failedEvt: { timestamp: string; payload: unknown }): void {
    const fp = failedEvt.payload as Record<string, unknown>;
    out.failedAt = failedEvt.timestamp;
    if (typeof fp.error === 'string') out.lastError = fp.error;
  }

  function getStatus(runId: string): RunStatus | null {
    // Query events directly — RUN_STARTED/RUN_COMPLETED are audit_only
    // and skipped by projectionBuilder, so projection won't have run state.
    const events = queryEvents({ runId });
    if (events.length === 0) return null;
    const resolved = resolveRunBaseEvent(events);
    if (!resolved) return null;
    const sp = resolved.baseEvt.payload as Record<string, unknown>;
    const out: RunStatus = {
      runId,
      familyId: sp.familyId as string,
      status: resolved.status,
      query: sp.query as string,
      progress: { phase: resolved.status },
      startedAt: resolved.baseEvt.timestamp,
    };
    if (resolved.completedEvt) applyCompletionCounts(out, resolved.completedEvt);
    if (resolved.failedEvt) applyFailureInfo(out, resolved.failedEvt);
    if (resolved.cancelledEvt) out.cancelledAt = resolved.cancelledEvt.timestamp;
    return out;
  }

  function cancelRun(runId: string): boolean {
    return scheduler.cancel(runId);
  }

  function loadRetryableOriginal(runId: string): ResearchRun {
    const original = foldRunLedger(queryEvents({})).get(runId);
    if (!original) throw new Error(`Run not found: ${runId}`);
    if (original.status !== 'failed' && original.status !== 'interrupted') {
      throw new Error(`Cannot retry run in status: ${original.status}`);
    }
    if (original.error && !original.error.retryable) {
      throw new Error(`Run error is not retryable: ${original.error.classification}`);
    }
    return original;
  }

  function loadEffectiveRetryInput(runId: string, original: ResearchRun): StartRunInput {
    const retryInput = runInputs.get(runId);
    if (!retryInput) {
      throw new Error(`Cannot retry run: original run input not available (started by a different process?).`);
    }
    return original.threadId !== undefined ? { ...retryInput, threadId: original.threadId } : retryInput;
  }

  function buildRetryPayload(args: {
    runId: string; original: ResearchRun; input: RetryRunInput;
    deadlineAt: string; queuedAt: string;
  }): ResearchRun & { retryOf: string } {
    const { runId, original, input, deadlineAt, queuedAt } = args;
    return {
      runId, rootRunId: original.rootRunId, attempt: original.attempt + 1,
      familyId: original.familyId, threadId: original.threadId, sessionId: original.sessionId,
      query: original.query, topic: original.topic, strategy: original.strategy, depth: original.depth,
      providerName: original.providerName, idempotencyKey: input.idempotencyKey,
      requestHash: original.requestHash, retryPolicy: original.retryPolicy, deadlineAt, queuedAt,
      retryOf: input.runId,
      ...(original.followUp ? { followUp: original.followUp } : {}),
    } as ResearchRun & { retryOf: string };
  }

  async function withFamilyLock<T>(familyId: string, fn: () => Promise<T>): Promise<T> {
    const previous = familyLocks.get(familyId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const lock = previous.then(() => current);
    familyLocks.set(familyId, lock);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (familyLocks.get(familyId) === lock) familyLocks.delete(familyId);
    }
  }

  function buildContinueStartInput(args: {
    input: ContinueResearchInput;
    target: { query: string; threadId?: string };
    priorInput?: StartRunInput | undefined;
  }): StartRunInput {
    const { input, target, priorInput } = args;
    return {
      query: target.query,
      explicitFamilyId: input.familyId,
      ...(target.threadId ? { threadId: target.threadId } : {}),
      depth: input.depth ?? 'quick',
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(priorInput?.provider ? { provider: priorInput.provider } : {}),
      ...(priorInput?.providerName ? { providerName: priorInput.providerName } : {}),
      config: input.config ?? priorInput?.config ?? {} as TrellisConfig,
    };
  }

  async function retryRun(input: RetryRunInput): Promise<{ runId: string; familyId: string; deduplicated: boolean }> {
    const original = loadRetryableOriginal(input.runId);
    const runId = `run_${randomUUID().slice(0, 12)}`;
    const effectiveRetryInput = loadEffectiveRetryInput(input.runId, original);
    const appendContext: AppendContext = { projection: getProjection(), handlers };
    const queuedAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + (input.deadlineMs ?? 600_000)).toISOString();
    const runPayload = buildRetryPayload({ runId, original, input, deadlineAt, queuedAt });
    runContexts.set(runId, appendContext);
    appendWithRetry([makeEnvelope('RUN_QUEUED', runId, runPayload, { entityId: runId, entityType: 'run' })], appendContext);
    scheduler.activate({ ...runPayload, appendContext, input: effectiveRetryInput });
    return { runId, familyId: original.familyId, deduplicated: false };
  }

  async function continueResearch(input: ContinueResearchInput): Promise<ContinueResearchResult> {
    return withFamilyLock(input.familyId, async () => {
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
      const result = await startRun(buildContinueStartInput({ input, target, priorInput }), followUp);
      return { status: 'queued', runId: result.runId, familyId: result.familyId, target: { type: target.type, id: target.id }, query: target.query, followUpsUsed: followUpsUsed + 1, followUpCap: MAX_FOLLOW_UP_RUNS_PER_FAMILY };
    });
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
