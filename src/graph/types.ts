/**
 * Canonical entity, claim, evidence, and contradiction model — Trellis's
 * durable knowledge graph. Unifies search-mcp's ephemeral research-side
 * shapes (StructuredClaim/Finding/ResearchClaim/Contradiction/GapRecord+
 * GapTarget) with its KG-side persisted shapes (KgNode/KgEdge). See
 * docs/ARCHITECTURE.md §1 and §3 for the reconciliation rationale.
 *
 * Foreign keys are plain string IDs (ULIDs), not nested objects — matches
 * the event-sourced/relational convention used throughout search-mcp's
 * existing knowledge graph code.
 *
 * Owned by Worker 3 (entities + claims/evidence). Consumed by research/
 * (Worker 6), store/ (Worker 2), workspace/ (Worker 4), mcp/ (Worker 8).
 */

// ── Canonical entity ────────────────────────────────────────────────────────

export type ReleaseEntityType =
  | 'protocol'
  | 'specification'
  | 'sdk'
  | 'package'
  | 'client_app'
  | 'server'
  | 'blog_post'
  | 'proposal'
  | 'roadmap'
  | 'unknown';

export interface ReleaseMeta {
  owner?: string;
  ecosystem?: string;
  packageName?: string;
  repo?: string;
  version?: string;
  releaseDate?: string;
  entityType?: ReleaseEntityType;
}

export interface CanonicalEntity {
  id: string;
  label: string;
  canonicalLabel: string | null;
  entityType: string;
  aliases: string[];
  extractionConfidence: number | null;
  firstSeenRunId: string;
  lastUpdatedRunId: string;
  metadata: Record<string, unknown>;
  releaseMeta?: ReleaseMeta;
}

// ── Claim ─────────────────────────────────────────────────────────────────

export type ClaimPolarity = 'asserted' | 'negated' | 'conditional';
export type ClaimHedge = 'certain' | 'likely' | 'possible' | 'speculative';
export type ClaimEvidenceType = 'study' | 'benchmark' | 'claim' | 'opinion' | 'anecdote';
export type EpistemicStatus = 'consensus' | 'contested' | 'emerging' | 'speculative' | 'unknown';

export type AuthorityClass =
  | 'official_spec'
  | 'official_changelog'
  | 'official_repo'
  | 'official_vendor'
  | 'package_registry'
  | 'vendor_sdk_docs'
  | 'third_party_analysis'
  | 'news'
  | 'encyclopedia'
  | 'forum_social'
  | 'unknown';

export type ClaimAuthorityRequirement =
  | 'primary_required'
  | 'primary_preferred'
  | 'secondary_ok'
  | 'any_ok';

export type TemporalEventType =
  | 'released'
  | 'announced'
  | 'proposed'
  | 'documented'
  | 'discussed'
  | 'updated'
  | 'deprecated'
  | 'unknown';

export type DateConfidence = 'exact' | 'inferred' | 'publication_only' | 'unknown';

export interface TemporalScope {
  eventType: TemporalEventType;
  eventDate?: string;
  publicationDate?: string;
  version?: string;
  dateConfidence: DateConfidence;
}

/**
 * Normalizes "10% improvement", "reduced by a tenth", and "one-tenth
 * efficiency gain" into the same structured form for cross-source
 * clustering. Ported as-is from research/types.ts CanonicalQuantifier.
 */
export interface CanonicalQuantifier {
  value: number;
  unit: string;
  comparisonType: 'increase' | 'decrease' | 'absolute' | 'ratio';
  baseline?: string;
  originalText?: string;
}

export interface NormalizedClaimKey {
  subject: string;
  predicate: string;
  quantifierCanonical?: string;
}

export type SupportLevel = 'primary' | 'secondary' | 'weak' | 'conflicting';
export type ClaimContradictionState = 'none' | 'contested' | 'resolved';

/**
 * A persisted, first-class claim. Unifies research's per-passage
 * StructuredClaim, its clustered/synthesis-ready Finding, and its
 * ResearchClaim ledger entry into one durable shape — modeled most closely
 * on Finding (the richest of the three, and what actually flows into
 * synthesis today), with authorityRequirement/supportLevel pulled in from
 * ResearchClaim.
 *
 * id is an independent ULID — never derived from subject/predicate/object —
 * so identity survives edits to any of those fields.
 */
export interface Claim {
  id: string;
  familyId: string;
  threadId?: string;
  subjectEntityId?: string;
  subjectText: string;
  predicate: string;
  objectEntityId?: string;
  objectText?: string;
  quantifier?: CanonicalQuantifier;
  polarity: ClaimPolarity;
  hedge: ClaimHedge;
  epistemicStatus?: EpistemicStatus;
  evidenceType: ClaimEvidenceType;
  temporalScope?: TemporalScope;
  confidence: number;
  authorityClass?: AuthorityClass;
  authorityRequirement?: ClaimAuthorityRequirement;
  supportLevel?: SupportLevel;
  canonicalKey: NormalizedClaimKey;
  contradictionState: ClaimContradictionState;
  firstSeenRunId: string;
  lastSeenRunId: string;
}

// ── Evidence ──────────────────────────────────────────────────────────────

export interface EvidenceAlignment {
  score: number;
  method: 'lexical_anchor_overlap' | 'semantic_vector_overlap' | 'hybrid_lexical_semantic';
  matchedTerms: string[];
  missingAnchorTerms: string[];
  semanticScore?: number;
  evidenceSnippet?: string;
  explanation: string;
}

/**
 * Source -> claim link. sourceId is mandatory: this is what keeps
 * provenance from being lost during projection. search-mcp's KgEdge has
 * evidence/sourceId/evidenceVerbatim columns but the extractor doesn't
 * reliably populate them because they sit downstream of the narrative
 * collapse (docs/ARCHITECTURE.md invariant #4) — here Evidence rows are
 * minted directly from research's EvidenceItem/EvidenceAlignment, not
 * re-derived from prose.
 */
export interface Evidence {
  id: string;
  claimId: string;
  sourceId: string;
  excerpt?: string;
  alignment?: EvidenceAlignment;
  runId: string;
}

// ── Claim relations (independent edge identity) ────────────────────────────

/** Reused verbatim from research's FindingClusterRelation. */
export type ClaimRelationType =
  | 'same_claim'
  | 'near_duplicate'
  | 'supports'
  | 'elaborates'
  | 'contradicts'
  | 'background';

export type ClaimRelationStrength = 'strong' | 'weak';

/**
 * Claim -> claim link with its own ULID — never a from->to composite key.
 * search-mcp's KG extractor keys edges by `${fromCanonical}->${toCanonical}`
 * (extractor/index.ts:452) and silently drops a second relation type
 * between the same pair (projection-handlers.ts:141). Rows here are
 * independent, so "A supports B" and "A contradicts B" can coexist.
 */
export interface ClaimRelation {
  id: string;
  fromClaimId: string;
  toClaimId: string;
  relation: ClaimRelationType;
  strength: ClaimRelationStrength;
  score: number;
  rationale?: string;
  runId: string;
}

// ── Contradictions ──────────────────────────────────────────────────────────

/** Reused verbatim from research's 9-variant ContradictionType — richer
 * and more specific than the KG side's 6-variant version of the same name. */
export type ContradictionType =
  | 'factual_disagreement'
  | 'benchmark_disagreement'
  | 'terminology_mismatch'
  | 'time_version_mismatch'
  | 'scope_mismatch'
  | 'implementation_specific'
  | 'opinion_tradeoff'
  | 'vendor_vs_independent'
  | 'academic_vs_practitioner';

/**
 * Resolution outcomes, reused from the KG side rather than research's
 * narrower 4-variant ContradictionStatus — the extra outcomes (superseded,
 * source_error, scope_distinction) only make sense once contradictions are
 * tracked across runs over time, which is Trellis's whole point.
 */
export type ContradictionResolutionStatus =
  | 'unresolved'
  | 'resolved'
  | 'superseded'
  | 'source_error'
  | 'scope_distinction';

export interface Contradiction {
  id: string;
  familyId: string;
  claimIdA: string;
  claimIdB: string;
  contradictionType: ContradictionType;
  resolutionStatus: ContradictionResolutionStatus;
  likelyExplanation?: string;
  followUpSearchRecommended?: string;
  firstSeenRunId: string;
  resolvedRunId?: string;
}

// ── Sources ───────────────────────────────────────────────────────────────

/** Reused verbatim from research/types.ts SOURCE_TYPE_ARRAY. */
export type SourceType =
  | 'academic'
  | 'web'
  | 'github'
  | 'reddit'
  | 'hackernews'
  | 'stackoverflow'
  | 'documentation'
  | 'official_docs'
  | 'official_blog'
  | 'package_registry'
  | 'vendor_docs'
  | 'forum'
  | 'social'
  | 'news'
  | 'patent'
  | 'pubmed'
  | 'wikipedia'
  | 'podcast'
  | 'producthunt'
  | 'youtube'
  | 'browser-interactive'
  | 'openalex'
  | 'crossref'
  | 'datacite'
  | 'ror'
  | 'semantic_scholar'
  | 'gdelt'
  | 'wikidata'
  | 'unknown';

export type ExtractionStatus = 'pending' | 'extracted' | 'failed';
export type SourceUsageStatus = 'searched' | 'selected' | 'read' | 'used' | 'discarded' | 'failed';

export type DiscardReason =
  | 'duplicate'
  | 'stale'
  | 'low_relevance'
  | 'thin_content'
  | 'extraction_failed'
  | 'bot_challenge'
  | 'paywall'
  | 'no_findings'
  | 'unsupported'
  | 'budget_exceeded';

/** Merges research's SourceEntry (rich lifecycle fields) with the KG side's
 * KgSource (content hashing for change detection across runs). */
export interface Source {
  id: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  domain: string;
  sourceType: SourceType;
  authorityClass?: AuthorityClass;
  qualityScore?: number;
  isPrimary: boolean;
  extractionStatus: ExtractionStatus;
  usageStatus?: SourceUsageStatus;
  discardReason?: DiscardReason;
  contentHash: string;
  retrievedAt: string;
  publishedAt?: string;
  firstSeenRunId: string;
}

// ── Gaps ──────────────────────────────────────────────────────────────────

/** Reused verbatim from research/types.ts GapCategory. */
export type GapCategory =
  | 'unanswered_sub_question'
  | 'low_confidence'
  | 'unresolvable_contradiction'
  | 'missing_source_type'
  | 'missing_recency'
  | 'overrepresented_viewpoint'
  | 'thin_coverage'
  | 'low_content_depth'
  | 'single_source_dependency'
  | 'promotional_bias';

export type GapStatus =
  | 'open'
  | 'in_progress'
  | 'partially_resolved'
  | 'resolved'
  | 'deferred'
  | 'unresolvable';

/**
 * Merges research's two overlapping legacy shapes: the older GapRecord
 * (category/suggestedActions, no lifecycle) and the newer GapTarget
 * (attempts/createdAtStep/resolution, no category) into one durable record
 * scoped to a family/thread instead of a single in-memory run.
 */
export interface Gap {
  id: string;
  familyId: string;
  threadId?: string;
  question: string;
  category: GapCategory;
  status: GapStatus;
  priority: number;
  relatedClaimId?: string;
  relatedContradictionId?: string;
  resolution?: { answer: string; evidenceSummary: string };
  firstSeenRunId: string;
  resolvedRunId?: string;
}
