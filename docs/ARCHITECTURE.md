# Trellis — Architecture Decisions (Phase 0 Synthesis)


Source repo inspected: `/Users/rhinesharar/search-mcp` (main, clean except two scratch recon files, since removed).
Recon date: 2026-08-24.

Trellis is a temporary project name (see naming note at end of handoff). Nothing here depends on the name.

## 0. Evidence sources

- `search-mcp` deep-research recon (53 files, `src/research/**` classified): produced by scout, content folded into §7 below. Raw report was at `search-mcp/trellis-recon-report.md` (untracked scratch file, removed after folding into this doc).
- `search-mcp` KG recon (28 files, `src/knowledge/**` classified, edge-identity + rollback deep dive): raw report was at `search-mcp/.trellis-kg-recon.md` (untracked scratch, removed after folding in).
- Model comparison: research-side shapes read in full from `src/research/types.ts` etc. (via scout transcript); KG-side shapes read directly by the parent orchestrator from `src/knowledge/types.ts` and `src/knowledge/store/schema.ts`.
- Acquisition boundary + provider design: scout recon, adopted with minor tightening in §5.
- `CLAIM_EXTRACTED` audit-only claim verified directly against `src/knowledge/store/projection-state.ts:20-57`.

All file:line citations below point at `search-mcp` as of the recon commit (`9b7364c`, "feat(knowledge-graph): store, extractor, families, tools").

## 1. Invariant-by-invariant findings

| # | Invariant | KNOWN (current search-mcp behavior) | DECISION for Trellis |
|---|---|---|---|
| 1 | No narrative re-extraction bridge | **Present today, exactly as feared.** `narrativeMarkdown` (`research/types.ts:1094`, produced by `llm/synthesis.ts:289,322` / `synthesizer.ts:116`) is the *only* input `knowledge/hook.ts:231` reads (`result.report.narrativeMarkdown`) before handing it to `KnowledgeGraphExtractor` for a second LLM pass. Research code itself never imports `knowledge/**` (zero cross-imports, confirmed). | Delete the hook→narrative→extractor path entirely. Trellis persists `Finding`/`StructuredClaim`/`EvidenceItem`/`Contradiction`/`GapRecord` objects directly as events (§4). `narrativeMarkdown` becomes a rendered view, generated on read, not an ingestion input. |
| 2 | Persist native evidence graph | `EvidenceGraph` (`types.ts:1073-1082`: sources/evidence/findings/clusters/findingClusterEdges/auditIssues/synthesisClaims/edges) is rich but **fully ephemeral** — exists only in-process during a run, never persisted. | Project `EvidenceGraph` members directly into durable store instead of collapsing through narrative (§3). |
| 3 | Claims first-class | KG has only generic `KgNode{type:'claim'}` / `KgEdge{type:'supports'\|'contradicts'\|...}`. Research side already has the rich shape (`StructuredClaim`, `Finding`, `ResearchClaim`) but it's never persisted. **`CLAIM_EXTRACTED` is registered `audit_only`** (`projection-state.ts:49-57`) — verified directly — so even today's shallow claim event never reaches a queryable projection table. | New `Claim` projection (§3), fed by a new `CLAIM_ACCEPTED` event registered `pure_run_local` (not `audit_only`), carrying the full field set research already computes. |
| 4 | Evidence provenance survives projection | `KgEdge` has `evidence`/`sourceId`/`evidenceVerbatim` columns but scout confirms the extractor doesn't consistently populate them; the richer `EvidenceItem.excerpt` / `EvidenceAlignment` scoring never reaches KG because it's upstream of the narrative collapse (same root cause as #1). | Fixed by #1 + #3: `Evidence` records always carry `sourceId` + `claimId` + optional excerpt, minted directly from research's `EvidenceItem`/`EvidenceAlignment`, not re-derived. |
| 5 | No from-\>to edge collapse | **Confirmed violated.** `extractor/index.ts:452`: `edgeId = \`${fromCanonical}->${toCanonical}\``. `projection-handlers.ts:141`: `if (state.edges.has(edgeId)) return;` — second relation type between the same pair is silently dropped. Schema's `kg_edges.id` is a free-form PK (not schema-forced to be composite), so this is an extractor bug, not a schema limitation. Research side's `FindingClusterEdge`/`ClaimEdge` already avoid this — they're array elements, not pair-keyed. | New assertion/edge tables use ULID primary keys, never `from->to` composites. Carries forward research's existing (already-correct) pattern rather than KG's. |
| 6 | Families as workspaces | `KgFamily` = `{id,label,description,createdAt,lastActivity,runCount,relatedFamilies}` — pure semantic bucket, no manifest/threads/runs/claims/timeline. `kg_node_families` (many-to-many entity↔family) already supports entities in multiple families — that part is fine and reusable. | New `Family` = workspace envelope (§3). Entity↔family membership table is kept as-is (already correct shape). |
| 7 | Resolve family before deep research | Family classification (`families/classifier.ts`) runs **after** a run via `runFamilyPipelineAfterRun` — post-hoc, not pre-run. `deepResearch.ts` has zero KG awareness at start. Net-new capability. | `FamilyResolver` runs before orchestration starts for explicit deep-research requests; creates a family immediately on no strong match (per invariant #7, skip the passive multi-run solidification gate here). |
| 8 | Threads | **Does not exist anywhere** in research or KG code today. Net-new concept. | New `Thread` entity, scoped to one family (§3). |
| 9 | No global active run | **Confirmed violated in two places**: `jobManager.ts:683` (`export const researchJobManager = new ResearchJobManager()`, module singleton) and KG's `run-active.ts` (`setRunActiveFlag`/`getActiveRunId`, plus `kg_runs.active` boolean column — a literal "the one active run" concept). | Both removed. Explicit `{familyId, threadId?, researchRunId, sessionId?}` threaded through every call (Worker 7 contract). |
| 10 | Event sourcing preserved | **KG side is genuinely strong** — real append-only `kg_events`, versioned event types (`eventVersion` + `EventVersionAdapter` registry), checksummed checkpoints (`kg_projection_checkpoints.checksum`), deterministic rebuild (`projection-builder.ts`). **Research side is not** — `state.ts` is CRUD; `TraceEvent[]` exists in types but isn't the mutation mechanism. | Extend the *existing* KG event store/type system rather than build a second one. Research state changes become events emitted at the boundaries in §4, landing in the same `kg_events`-equivalent table. |
| 11 | Rollback preserved | Well-understood mechanism: `pure_run_local` events vanish from projection on rollback of their run; `cross_run_mutation` events (merges, splits, renames) **never** auto-roll-back — a compensation plan is emitted (`knowledgeGraph.ts:1385-1406`) but nothing executes it today (advisory-only). No data is ever deleted from the event store, rollback is a replay-time filter. | Keep advisory-only compensation for cross-run mutations (matches current behavior, safer default — auto-executing un-merges/un-splits can cascade unpredictably). Extend the *same* `pure_run_local`/`cross_run_mutation`/`audit_only`/`dynamic_edge` taxonomy to the new claim/evidence/thread/family event types (mapping in §4). **Flagged as an open decision in §8**, not silently decided. |
| 12 | Durable job state | **Confirmed exactly as suspected**: in-memory `Map` (`jobManager.ts:169`) + JSON directory rehydration (`deepResearch.ts:659-716`, `~/.cache/search-mcp/research-results/YYYY/MM/DD/*.json`) is the primary persistence mechanism; `autoSaveResult()` offloads snapshots to disk to free memory. | Replace with `ResearchRun` rows/events in Trellis's own store (§3). Full report/narrative artifacts may still be written to disk for humans, but are not authoritative — the event store is. Behavioral features to preserve (async start/poll, cancellation, progress, bounded partial state, concurrency limits) are confirmed present; **adaptive timeout/runtime extension was not independently confirmed by recon and should be checked when Worker 6 ports `jobManager.ts`.** |

## 2. What "model reconciliation" actually means here

The research side already has almost everything invariant #3 asks for — `StructuredClaim`, `Finding`, `ResearchClaim` (claim ledger), `Contradiction`, `GapRecord`/`GapTarget`, `EvidenceItem`/`EvidenceAlignment`, `SourceEntry`, `FindingClusterEdge`/`ClaimEdge` are all richer than anything in the KG schema. The KG side has almost everything invariant #10 asks for — append-only events, versioning, checkpoints, deterministic rebuild. Neither side needs to be reinvented. The work is: **stop routing research's rich shapes through `narrativeMarkdown` and a second LLM extraction, and instead emit them as typed events into the KG's existing event-sourcing machinery.** This is a plumbing/persistence problem, not a modeling-from-scratch problem.

## 3. Canonical Trellis data model

```typescript
// ── Canonical entity (was KgNode, enriched) ────────────────────────────────
interface CanonicalEntity {
  id: string; // ULID
  label: string;
  canonicalLabel: string | null;
  entityType: string; // seeded from KgNode.type union + ReleaseEntityType
  aliases: string[];
  extractionConfidence: number | null;
  firstSeenRunId: string;
  lastUpdatedRunId: string;
  metadata: Record<string, unknown>;
  releaseMeta?: { owner?: string; ecosystem?: string; packageName?: string; repo?: string; version?: string; releaseDate?: string; entityType?: ReleaseEntityType };
}

// ── Claim (was StructuredClaim + Finding + ResearchClaim, unified) ─────────
//
// Three-layer model:
//   ClaimAssertion  — the semantic content of one observation (subject/predicate/object/polarity/etc.)
//   ClaimObservation extends ClaimAssertion — one observed instance of a claim in a specific run
//   Claim extends ClaimAssertion — the durable claim entity, accumulating observations over runs
//
interface ClaimAssertion {
  subjectEntityId?: string;   // FK -> CanonicalEntity when resolved
  subjectText: string;
  predicate: string;
  objectEntityId?: string;
  objectText?: string;
  quantifier?: CanonicalQuantifier;       // reuse research shape as-is
  polarity: ClaimPolarity;                // 'asserted'|'negated'|'conditional'
  hedge: ClaimHedge;                      // 'certain'|'likely'|'possible'|'speculative'
  evidenceType: ClaimEvidenceType;        // 'study'|'benchmark'|'claim'|'opinion'|'anecdote'
  temporalScope?: TemporalScope;          // reuse as-is
  authorityClass?: AuthorityClass;
  authorityRequirement?: ClaimAuthorityRequirement;
  supportLevel?: SupportLevel;
  canonicalKey: NormalizedClaimKey;       // dedup/clustering key
}

interface ClaimObservation extends ClaimAssertion {
  id: string; familyId: string; threadId?: string; runId: string; observedAt: string;
  confidence: number; sourceIds: string[]; extractionVersion: string;
  curationStatus?: 'active' | 'retracted';
  lastCuration?: CurationMark;
}

interface Claim extends ClaimAssertion {
  id: string; // ULID — independent identity, never derived from subject/predicate/object
  familyId: string;
  threadId?: string;
  currentObservationId?: string;
  confidence: number;
  epistemicStatus?: EpistemicStatus;      // 'consensus'|'contested'|'emerging'|'speculative'|'unknown'
  contradictionState: 'none' | 'contested' | 'resolved';
  firstSeenRunId: string; firstSeenAt?: string;
  lastSeenRunId: string; lastSeenAt?: string;
  observationIds?: string[]; evidenceIds?: string[]; observationCount?: number;
  supportingEvidenceCount?: number; opposingEvidenceCount?: number;
  confidenceHistory?: ClaimConfidencePoint[]; revisionHistory?: ClaimRevision[];
  curationStatus?: 'active' | 'retracted' | 'merged' | 'split';
  mergedIntoClaimId?: string;
  splitIntoClaimIds?: string[];
  lastCuration?: CurationMark;
}

// ── Evidence: Source -> Claim link (was EvidenceItem) ──────────────────────
interface Evidence {
  id: string; // ULID
  claimId: string;
  sourceId: string;           // mandatory — this is the provenance fix for #4
  observationId?: string;     // links to the specific ClaimObservation this evidence supports/opposes
  stance?: 'supports' | 'opposes' | 'context';
  excerpt?: string;
  alignment?: EvidenceAlignment; // reuse as-is: score/method/matchedTerms/semanticScore/snippet
  runId: string;
}

// ── ClaimRelation: Claim -> Claim link (was FindingClusterEdge/ClaimEdge) ──
// Independent ID per row — this is what fixes invariant #5. Multiple relation
// types between the same claim pair coexist as separate rows.
interface ClaimRelation {
  id: string; // ULID
  fromClaimId: string;
  toClaimId: string;
  relation: 'supports' | 'contradicts' | 'qualifies' | 'elaborates' | 'is_example_of' | 'depends_on' | 'near_duplicate' | 'background';
  strength: 'strong' | 'weak';
  score: number;
  rationale?: string;
  runId: string;
}

// ── Contradiction: first-class, richer than a ClaimRelation tag ────────────
interface Contradiction {
  id: string;
  claimIdA: string;
  claimIdB: string;
  contradictionType: ContradictionType;        // reuse research's 9-variant enum
  resolutionStatus: ContradictionResolutionStatus; // reuse KG's enum
  likelyExplanation?: string;
  followUpSearchRecommended?: string;
  firstSeenRunId: string;
  resolvedRunId?: string;
}

// ── Source (was SourceEntry + KgSource, merged) ─────────────────────────────
interface Source {
  id: string;
  url: string;
  canonicalUrl: string;       // mandatory — canonicalized on ingestion
  title?: string;
  domain: string;
  sourceType: SourceType;      // reuse research's richer enum
  authorityClass?: AuthorityClass;
  qualityScore?: number;
  isPrimary: boolean;
  extractionStatus: ExtractionStatus;
  usageStatus?: SourceUsageStatus;
  discardReason?: DiscardReason;
  contentHash?: string;
  retrievedAt: string;
  publishedAt?: string;
  firstSeenRunId: string;
  lastSeenRunId: string;      // tracks cross-run source reuse
  lastSeenAt: string;
  runCount: number;
}

// ── Family: research workspace (was thin KgFamily) ──────────────────────────
interface Family {
  id: string;
  label: string;
  description?: string;
  manifest: { scopeQuery: string; scopeSummary?: string; tags?: string[] };
  createdAt: string;
  lastActivity: string;
  relatedFamilies: FamilyRelation[]; // reuse FamilyRelationType: adjacent|contradicts|parent|child|supersedes
}
// runs/threads/claims/evidence/sources/gaps/contradictions/timeline are QUERIES
// scoped by familyId against the tables above, not columns on Family itself.

// ── Supporting types for Claim lifecycle ──────────────────────────────────
interface CurationMark {
  commandId: string; actorId: string; reason: string; at: string;
}
interface ClaimConfidencePoint { observationId: string; runId: string; observedAt: string; confidence: number; }
interface ClaimRevision {
  revision: number; classification: 'supersedes'; fromObservationId: string; toObservationId: string;
  runId: string; revisedAt: string; before: ClaimAssertion; after: ClaimAssertion; rationale: string;
}

interface Thread {
  id: string;
  familyId: string;
  label: string;
  description?: string;
  createdAt: string;
  status: 'open' | 'resolved' | 'stale';
}

// ── Gap (was GapRecord/GapTarget, unified) ──────────────────────────────────
interface Gap {
  id: string;
  familyId: string;
  threadId?: string;
  question: string;
  category: GapCategory;        // reuse research's 11-variant enum
  status: GapStatus;            // 'open'|'in_progress'|'partially_resolved'|'resolved'|'deferred'|'unresolvable'
  priority: number;
  relatedClaimId?: string;
  relatedContradictionId?: string;
  resolution?: { answer: string; evidenceSummary: string };
  firstSeenRunId: string;
  resolvedRunId?: string;
}

// ── ResearchRun — exposed as RunSummaryDto, not a standalone projection ──
// Runs are tracked via lifecycle events (RUN_QUEUED, RUN_STARTING, RUN_RUNNING,
// RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED, RUN_INTERRUPTED, RUN_ROLLED_BACK)
// and projected into an in-memory RunSummaryDto for query. There is no
// persistent rm_runs table — the event log IS the durable run state.
//
// RunSummaryDto (src/app/types.ts) carries:
//   runId, familyId, status, query, progress?, startedAt?, completedAt?,
//   failedAt?, cancelledAt?, lastError?, entityCount?, claimCount?,
//   sourceCount?, evidenceCount?, strategy?
```

Entity↔family membership stays a many-to-many table shaped like today's `kg_node_families` (already correct — no change needed).

## 4. Event vocabulary

Extend `KgEventType` rather than replace it — keep all 26 legacy types (they're well-designed), add:

| New event | Rollback class | Commit point |
|---|---|---|
| `FAMILY_RESOLVED` | `pure_run_local` | FamilyResolver picks/creates a family for an explicit run, before orchestration starts |
| `THREAD_CREATED` / `THREAD_RESOLVED` | `pure_run_local` / `pure_run_local` | Thread assignment for a run |
| `SOURCE_READ` | `pure_run_local` | Distinguish "discovered" (existing `SOURCE_ADDED`) from "actually fetched/read" |
| `SOURCE_OBSERVED` | `pure_run_local` | Full source observation snapshot (content-hash based change detection across runs) |
| `CLAIM_ACCEPTED` | **`pure_run_local`** (fixes the current `CLAIM_EXTRACTED` audit-only gap — verified at `projection-state.ts:35,54`) | A claim survives pruning/dedup and is committed |
| `CLAIM_OBSERVED` | `pure_run_local` | Per-observation claim sighting with confidence and extraction version |
| `EVIDENCE_LINKED` | `pure_run_local` | Source↔claim link recorded |
| `CONTRADICTION_IDENTIFIED` | `pure_run_local` | Replaces generic `CONTRADICTION_FLAGGED` for the new `Contradiction` shape |
| `CONTRADICTION_RESOLVED` | `cross_run_mutation` | Resolution can reference claims from other runs |
| `GAP_OPENED` / `GAP_RESOLVED` | `pure_run_local` / `cross_run_mutation` | Gap lifecycle |
| `SYNTHESIS_COMPLETED` | `audit_only` | Marks narrative-view generation, not a state mutation |
| `RUN_CANCELLED` / `RUN_INTERRUPTED` | `audit_only` / `audit_only` | Explicit cancel vs process-shutdown interruption |
| `RUN_QUEUED` / `RUN_STARTING` / `RUN_RUNNING` / `RUN_PROGRESS` / `RUN_HEARTBEAT` | `audit_only` | Run lifecycle progression (all audit-only — state is derived, not authoritative) |
| `RUN_CANCELLATION_REQUESTED` | `audit_only` | Operator or scheduler signals cancellation intent |
| `RESEARCH_PLAN_CREATED` / `RESEARCH_PLAN_REVISED` | `pure_run_local` | Agent strategy plan lifecycle |
| `CLAIM_MERGED` / `CLAIM_SPLIT` / `CLAIM_RETRACTION_SET` | `cross_run_mutation` | Operator curation — embeds before/after snapshots for compensation |
| `CLAIM_RELATION_CURATED` / `EVIDENCE_STANCE_OVERRIDDEN` | `cross_run_mutation` | Operator curation of relations and evidence stance |

Do not emit an event per intermediate research-state mutation (worker thoughts, retries, scoring passes) — only at the commit points above, per the user's explicit "avoid excessive event chatter" instruction.

**Curation events** (Phase 9 Stage 1) carry a `CurationContext` block (`commandId`, `reason`, `expectedSeq`) for idempotency and optimistic concurrency. They are all `cross_run_mutation` — their payloads embed full before/after snapshots so the rollback executor can synthesize compensation. See `src/store/eventTypes.ts` for payload definitions.

## 5. Acquisition provider interface

Adopted from recon with the boundary question resolved first: **confirmed research code uses direct TypeScript module imports exclusively — zero MCP tool-call/registry usage** (`discovery.ts`, `researchTools.ts`, `agentTools.ts`, `extraction.ts` all statically or dynamically `import` backend functions directly; `workerAgent.ts` and `deepResearch.ts` are already clean via DI). This means an out-of-process MCP-client adapter is a pure swap-in later with zero research-core changes required now.

8 normalized capabilities (down from 30+ search-mcp tools — see recon for the full per-symbol import inventory):

```typescript
interface ProviderCallContext {
  signal: AbortSignal;
  runId: string;
  deadlineAt: number;  // Absolute Unix epoch deadline in milliseconds
  trace: ProviderTraceMetadata;
}

interface ResearchCapabilities {
  search: boolean; read: boolean; academic: boolean; code: boolean;
  community: { reddit: boolean; hackernews: boolean; stackoverflow: boolean };
  media: boolean; reference: boolean; browser: boolean;
  academicBackends?: string[];
}

interface ResearchProvider {
  readonly name: string;
  readonly capabilities: ResearchCapabilities;
  search(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]>;
  read(ctx: ProviderCallContext, url: string): Promise<ReadResult>;
  crawl(ctx: ProviderCallContext, url: string, opts?: { maxPages?: number }): Promise<CrawlResult[]>;
  academic(ctx: ProviderCallContext, query: string, opts?: AcademicOpts): Promise<ResearchHit[]>;
  github?(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<GitHubHit[]>;
  reddit?(ctx: ProviderCallContext, query: string, opts?: CommunityOpts): Promise<RedditHit[]>;
  redditThread?(ctx: ProviderCallContext, url: string, opts?: { limit?: number }): Promise<RedditThread>;
  hackernews?(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]>;
  stackoverflow?(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]>;
  youtube?(ctx: ProviderCallContext, query: string, opts?: MediaOpts): Promise<YouTubeHit[]>;
  youtubeTranscript?(ctx: ProviderCallContext, videoId: string, language?: string): Promise<TranscriptSegment[]>;
  wikipedia?(ctx: ProviderCallContext, query: string, opts?: { language?: string }): Promise<ResearchHit[]>;
  semanticSearch?(ctx: ProviderCallContext, query: string, opts: SemanticOpts): Promise<SemanticResult>;
  semanticCrawl?(ctx: ProviderCallContext, url: string, query: string, opts?: SemanticOpts): Promise<SemanticResult>;
  semanticCode?(ctx: ProviderCallContext, query: string, opts: SemanticCodeOpts): Promise<SemanticCodeResult>;
  browser?: { open(ctx: ProviderCallContext, opts?): Promise<string>; extract(ctx, sessionId, url, plan): Promise<...>; close(ctx, sessionId): Promise<void> };
  close?(): Promise<void>;
}
```

All return types are plain JSON-serializable objects — no class instances or streams — so `provider.search(q)` → `mcp.callTool("search", {q})` is a transparent later swap.

**Residual risk carried forward**: `discovery.ts` (13 backends) and `extraction.ts` (5 backends) currently bypass the existing `ResearchTools` DI interface and import backends directly — porting them means routing through `ResearchProvider` for the first time, not just renaming an existing seam. Budget real effort here, not a mechanical rename (Worker 6).

## 6. Package layout (adapting the user's suggested tree to recon findings)

```
trellis/
├── src/
│   ├── app/               # application services (researchService, curationService, DTOs)
│   ├── cli/               # operator CLI (run, search, claim, curation, backup/restore/export)
│   ├── config/            # env-based configuration loader
│   ├── evaluation/        # reconciliation corpus, fixtures, eval harness
│   ├── graph/             # entities, claims, evidence, contradictions, epistemics, queries
│   ├── http/              # loopback HTTP server (healthz/readyz, research + knowledge REST)
│   ├── logger.ts          # pino structured logger with redaction
│   ├── mcp/               # research/knowledge MCP tool surface
│   ├── providers/         # types.ts (ResearchProvider), search-mcp/ (adapter)
│   ├── query/             # knowledge query service, longitudinal views, cursor pagination
│   ├── research/          # orchestrator, strategies, phases, workers, state, gaps, audit
│   ├── store/             # events, projections, checkpoints, rollback, migrations, read model
│   ├── version.ts         # single version source from package.json
│   └── workspace/         # families, threads, resolver, timeline
├── scripts/               # benchmark harnesses, eval runners
├── test/
└── docs/
    ├── ARCHITECTURE.md   # this file
    ├── CONFIGURATION.md  # env vars, Docker, HTTP endpoints
    ├── EQUIVALENCE_NOTES.md # Trellis vs search-mcp capability mapping
    └── research-roadmap.md  # post-audit evolution priorities
```

## 7. Module migration map (source: search-mcp recon)

Full per-file classification (portable-core / search-coupling / utility-coupling / search-mcp-only / obsolete) lives in this document's history — condensed:

**Research side** (53 files): 41 portable-core (state.ts, orchestrator.ts, jobManager.ts, types.ts, all strategies/phases, llm/*, provenance.ts, gapAnalysis.ts, pruning.ts, retry.ts, synthesizer.ts, findingLinkage.ts, claimClustering.ts, contradictionDetector.ts, entityExtractor.ts, and 27 more — trivial logger/config/embedding shims only). 3 files are the real search-coupling seam: `discovery.ts` (13 backends), `researchTools.ts` (24 backends), `extraction.ts` (5 backends). 14 files need generic utility shims (embedding, BM25/fusion, HTTP guards, citation parsing — all trivially portable). `deepResearch.ts` stays in search-mcp (MCP registration). `interactiveAgent.ts` (browser agent) and the `kgHook.onDeepResearchComplete` bridge are obsolete after Trellis.

**KG side** (28 files): 24 portable-core (all of `store/**` except db/schema which are portable-as-is too, `extractor/schemas.ts`, `extractor/versions/v1.ts`, `families/index.ts`). 4 files have search-mcp coupling: `hook.ts` (SearchConfig + ResearchResult + contentScrubber), `extractor/canonicalise.ts` + `families/classifier.ts` + `families/consolidation.ts` (all need `embedTexts` from `rag/embedding.js` — shim as a provider). `extractor/normalise.ts` (hardcoded search-mcp tool-name mappings) is obsolete — Trellis needs its own ingestion adapters. `tools/families/knowledgeGraph.ts` (MCP tool surface) stays in search-mcp's tree until deleted per the cleanup phase.

## 8. Decisions — resolved

1. **Repo location**: `/Users/rhinesharar/trellis` — confirmed.
2. **Rollback compensation**: advisory-only for `cross_run_mutation` events, with executable compensation where snapshots are available. Curation events (Phase 9) carry full before/after snapshots enabling the rollback executor to synthesize compensation. Later-run interference detection blocks unsafe rollback (see `src/store/rollback.ts`).
3. **search-mcp adapter for v1**: in-process `SearchMcpProvider` wrapping `createResearchTools()` via stdio child process (`src/providers/searchMcp/`). Swappable for out-of-process MCP-client adapter later with zero research-core changes.
4. **Implementation complete** — all 9 worker scopes delivered. Remaining gaps are tracked in `docs/research-roadmap.md`.
