/**
 * Internal types for the research engine — ephemeral working state during
 * a single research run. Distinct from the durable output types in graph/types.ts.
 *
 * Ported from search-mcp's research/types.ts, simplified to match Trellis's
 * provider interface and structured output contract.
 */

import type { SourceType, ClaimAssertion } from '../graph/types.js';
export type { SourceType, AuthorityClass, ClaimAssertion } from '../graph/types.js';

// ── Research phases ────────────────────────────────────────────────────────

export type ResearchPhase =
  | 'idle'
  | 'decomposition'
  | 'discovery'
  | 'extraction'
  | 'gap_analysis'
  | 'post_processing'
  | 'audit'
  | 'synthesis'
  | 'complete'
  | 'tree_research';

// ── Sub-questions ──────────────────────────────────────────────────────────

export type SubQuestionStatus =
  | 'pending'
  | 'in_progress'
  | 'sufficient'
  | 'contradictory'
  | 'unresolvable';

export type QueryClassification =
  | 'explainer'
  | 'comparative'
  | 'technical'
  | 'applied-practitioner'
  | 'current-events'
  | 'historical-timeline'
  | 'market-ecosystem'
  | 'literature-review'
  | 'decision-support';

export interface SubQuestion {
  id: string;
  text: string;
  classification: QueryClassification;
  evidenceType: string;
  preferredSources: SourceType[];
  freshnessRequirement: string;
  failureModes: string[];
  budgetPriority: number;
  status: SubQuestionStatus;
}

// ── Source entries ─────────────────────────────────────────────────────────

export type ExtractionStatus = 'pending' | 'extracted' | 'failed' | 'unavailable';
export type SourceUsageStatus =
  | 'searched'
  | 'selected'
  | 'read'
  | 'used'
  | 'discarded'
  | 'failed';

export interface SourceEntry {
  id: string;
  title: string;
  url: string;
  sourceType: SourceType;
  domain: string;
  accessDate: string;
  publishedDate?: string;
  isPrimary: boolean;
  relevantSubQuestions: string[];
  extractionStatus: ExtractionStatus;
  subQuestionId: string;
  qualityScore?: number;
  relevanceScore?: number;
  freshnessScore?: number;
  authorityClass?: string;
  contentHash?: string;
  discardReason?: string;
  usageStatus?: SourceUsageStatus;
}

// ── Findings ──────────────────────────────────────────────────────────────

export type EvidenceDirectness =
  | 'direct'
  | 'near-direct'
  | 'secondary'
  | 'anecdotal'
  | 'speculative';

export type ClaimType = 'primary' | 'secondary' | 'anecdotal';

export interface Finding {
  id: string;
  claim: string;
  normalizedClaim: string;
  evidenceExcerpt?: string;
  evidenceSummary?: string;
  evidenceDirectness: EvidenceDirectness;
  claimType: ClaimType;
  sourceIds: string[];
  subQuestionIds: string[];
  relevanceScore?: number;
  confidence?: number;
  caveats?: string[];
  freshnessSensitive?: boolean;
  createdAt: string;
  lastUpdated: string;
  clusterId?: string;
}

// ── Claim extraction types (Stage 1) ───────────────────────────────────

export interface SourcePassage {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface ClaimExtractionInput {
  source: Pick<SourceEntry, 'id' | 'title' | 'url' | 'sourceType' | 'isPrimary' | 'publishedDate' | 'relevantSubQuestions'>;
  query: string;
  subQuestions: readonly Pick<SubQuestion, 'id' | 'text'>[];
  content: string;
  contentHash: string;
}

export interface ExtractedClaimDraft {
  subjectText: string;
  predicate: string;
  objectText?: string;
  polarity: ClaimAssertion['polarity'];
  hedge: ClaimAssertion['hedge'];
  evidenceType: ClaimAssertion['evidenceType'];
  evidenceDirectness: EvidenceDirectness;
  quantifier?: ClaimAssertion['quantifier'];
  temporalScope?: ClaimAssertion['temporalScope'];
  passageId: string;
  verbatimSpan: string;
  confidence: number;
  subQuestionIds: string[];
  caveats: string[];
  freshnessSensitive: boolean;
}

export interface EvidenceGrounding {
  sourceId: string;
  passageId: string;
  verbatimSpan: string;
  spanStart: number;
  spanEnd: number;
  contentHash: string;
  alignment: import('../graph/types.js').EvidenceAlignment;
}

export interface ExtractedClaimCandidate {
  assertion: ClaimAssertion;
  grounding: EvidenceGrounding;
  confidence: number;
  subQuestionIds: string[];
  evidenceDirectness: EvidenceDirectness;
  caveats: string[];
  freshnessSensitive: boolean;
}

export interface GroundedFinding extends Finding {
  assertion: ClaimAssertion;
  groundings: [EvidenceGrounding, ...EvidenceGrounding[]];
  extractionVersion: 'llm-grounded-v1';
}

// ── Contradictions (internal shape — maps to graph/types.ts Contradiction) ─

export type InternalContradictionType =
  | 'factual_disagreement'
  | 'benchmark_disagreement'
  | 'terminology_mismatch'
  | 'time_version_mismatch'
  | 'scope_mismatch'
  | 'implementation_specific'
  | 'opinion_tradeoff'
  | 'vendor_vs_independent'
  | 'academic_vs_practitioner';

export type InternalContradictionStatus =
  | 'unresolved'
  | 'partially_resolved'
  | 'resolved'
  | 'apparent_only';

export interface InternalContradiction {
  id: string;
  claimA: string;
  claimB: string;
  sourceIdsA: string[];
  sourceIdsB: string[];
  contradictionType: InternalContradictionType;
  resolutionStatus: InternalContradictionStatus;
  likelyExplanation?: string;
}

// ── Gaps ──────────────────────────────────────────────────────────────────

export type GapCategory =
  | 'unanswered_sub_question'
  | 'low_confidence'
  | 'missing_source_type'
  | 'missing_recency'
  | 'overrepresented_viewpoint'
  | 'unresolvable_contradiction'
  | 'thin_coverage'
  | 'low_content_depth'
  | 'single_source_dependency'
  | 'promotional_bias';

export type GapStatus = 'open' | 'in_progress' | 'resolved';

export interface GapRecord {
  id: string;
  category: GapCategory;
  description: string;
  subQuestionId?: string;
  relatedFindingId?: string;
  status: GapStatus;
  suggestedActions: string[];
  priority: number;
  missingSourceTypes?: string[];
  dominantSourceType?: string;
}

// ── Claim edges (internal) ────────────────────────────────────────────────

export type ClaimEdgeRelation =
  | 'supports'
  | 'contradicts'
  | 'elaborates'
  | 'near_duplicate'
  | 'background';

export interface ClaimEdge {
  sourceFindingId: string;
  targetFindingId: string;
  relation: ClaimEdgeRelation;
  strength: 'strong' | 'weak';
  score: number;
}

// ── Finding clusters ──────────────────────────────────────────────────────

export type FindingClusterRelation =
  | 'same_claim'
  | 'near_duplicate'
  | 'supports'
  | 'elaborates'
  | 'contradicts'
  | 'background';

export type FindingClusterEdgeStrength = 'strong' | 'weak';

export interface FindingCluster {
  id: string;
  findingIds: string[];
  normalizedClaim: string;
  sourceCount: number;
}

export interface FindingClusterEdge {
  id: string;
  fromClusterId: string;
  toClusterId: string;
  relation: FindingClusterRelation;
  strength: FindingClusterEdgeStrength;
  score: number;
}

// ── Search clusters ───────────────────────────────────────────────────────

export interface SearchCluster {
  query: string;
  sourceIds: string[];
  sourceTypes: string[];
}

// ── Content quality ───────────────────────────────────────────────────────

export interface ContentQualityAssessment {
  contentDepth: number;
  isPromotional: boolean;
  informationDensity: number;
}

// ── Sub-question coverage ─────────────────────────────────────────────────

export interface SubQuestionCoverage {
  subQuestionId: string;
  subQuestionText: string;
  sourceCount: number;
  uniqueDomainCount: number;
  findingCount: number;
  averageContentDepth: number;
  hasPromotionalSources: boolean;
  sourceTypes: string[];
  status: 'uncovered' | 'thin' | 'risky' | 'adequate';
}

// ── Taxonomy ──────────────────────────────────────────────────────────────

export interface ResearchTaxonomy {
  originalQuery: string;
  subQuestions: SubQuestion[];
  revised: boolean;
  revisionHistory: string[];
}

// ── Budget ────────────────────────────────────────────────────────────────

export type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive' | 'tree';

export interface BudgetProfile {
  depth: ResearchDepth;
  maxSources: number;
  maxExtractions: number;
  maxGapLoops: number;
  minGapLoops: number;
  maxToolCalls: number;
  maxTokens: number;
  maxTimeMs: number;
  maxStateEntries: number;
}

export interface BudgetState {
  toolCallsUsed: number;
  tokensUsed: number;
  extractionsUsed: number;
  gapLoopsUsed: number;
  startTime: number;
  maxToolCalls: number;
  maxTokens: number;
  maxExtractions: number;
  maxGapLoops: number;
  stateEntriesUsed: number;
  maxStateEntries: number;
  maxTimeMs: number;
  stepCosts: Record<string, number>;
  findingsAddedPerLoop: number[];
}

// ── Research state ────────────────────────────────────────────────────────

export interface ResearchState {
  query: string;
  taxonomy: ResearchTaxonomy;
  subQuestions: SubQuestion[];
  sources: SourceEntry[];
  findings: GroundedFinding[];
  contradictions: InternalContradiction[];
  openQuestions: string[];
  gaps: GapRecord[];
  claimGraph: ClaimEdge[];
  currentPhase: ResearchPhase;
  budget: BudgetState;
  flags: {
    taxonomyRevised: boolean;
    audited: boolean;
    loopCount: number;
  };
  gapTargets: string[];
  allQuestions: string[];
  resolvedGaps: GapRecord[];
  searchClusters: SearchCluster[];
  diary: string[];
  searchAttempts: string[];
  workerReports: Record<string, WorkerReport>;
  contentQuality: Record<string, ContentQualityAssessment>;
  subQuestionCoverage: SubQuestionCoverage[];
  language?: { code: string; style: string };
}

// ── Worker reports ────────────────────────────────────────────────────────

export interface WorkerSource {
  url: string;
  title: string;
  snippet: string;
  sourceType: SourceType;
  domain: string;
}

export interface WorkerFinding {
  claim: string;
  evidenceExcerpt: string;
  evidenceDirectness: EvidenceDirectness;
  claimType: ClaimType;
  sourceIndices: number[];
}

export interface WorkerReport {
  id: string;
  question: string;
  sources: WorkerSource[];
  findings: WorkerFinding[];
  subThreadIds: string[];
  tokensUsed: number;
  durationMs: number;
}

// ── Research report (synthesis output) ────────────────────────────────────

export interface ResearchReportTheme {
  title: string;
  narrative: string;
  findings?: string[];
}

export interface ResearchReport {
  query: string;
  classification: QueryClassification;
  depth: ResearchDepth;
  degradationMode: 'deep' | 'source_note_synthesis';
  executiveSummary: string;
  narrativeMarkdown: string;
  themes: ResearchReportTheme[];
  contradictions: InternalContradiction[];
  uncertainties: string[];
  sourceNotes: string[];
  openQuestions: string[];
  limitations: string[];
  sourceCount: number;
  sourceTypeCount: number;
  sourceDiversity: { type: string; count: number }[];
  findingCount: number;
  evidenceSources: {
    index: number;
    title: string;
    url: string;
    sourceType: string;
    tier?: string;
    domain: string;
  }[];
  findingClusters?: FindingCluster[];
  findingClusterEdges?: FindingClusterEdge[];
  extractedCitations?: string[];
  noSourcesExplicit?: boolean;
}

// ── Research result ───────────────────────────────────────────────────────

export interface ResearchProgress {
  phase: string;
  percent?: number;
  message?: string;
}

export interface ResearchResult {
  report: ResearchReport;
  timeline: ResearchProgress[];
  canonicalFindings?: GroundedFinding[];
}
