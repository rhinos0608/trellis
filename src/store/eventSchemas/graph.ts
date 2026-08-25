/**
 * Zod schemas for graph-domain event payloads: entity, claim, evidence,
 * contradiction, gap, source, and claim-relation events.
 *
 * Each schema matches the ACTUAL payload shape produced at call sites
 * (runService.ts, projectionHandlers tests, rollback.ts), not the full
 * domain type. Fields absent from the call site are optional.
 */
import { z } from 'zod';
import { jsonValue, jsonMetadata } from './common.js';

// ── Entity events ─────────────────────────────────────────────────────

export const nodeAddedPayload = z.strictObject({
  id: z.string(),
  label: z.string(),
  canonicalLabel: z.string().nullable(),
  entityType: z.string(),
  aliases: z.array(z.string()),
  extractionConfidence: z.number().nullable(),
  firstSeenRunId: z.string(),
  lastUpdatedRunId: z.string(),
  metadata: jsonMetadata,
  releaseMeta: z
    .strictObject({
      owner: z.string().optional(),
      ecosystem: z.string().optional(),
      packageName: z.string().optional(),
      repo: z.string().optional(),
      version: z.string().optional(),
      releaseDate: z.string().optional(),
      entityType: z.string().optional(),
    })
    .optional(),
});

export const nodeRelabeledPayload = z.strictObject({
  targetId: z.string(),
  oldLabel: z.string(),
  newLabel: z.string(),
});

export const nodeMetadataUpdatedPayload = z.strictObject({
  targetId: z.string(),
  field: z.string(),
  oldValue: jsonValue,
  newValue: jsonValue,
});

/** EXTRACTION_CONFIDENCE_REVISED and RELATIONSHIP_STRENGTH_REVISED share the same shape. */
export const extractionConfidenceRevisedPayload = nodeMetadataUpdatedPayload;
export const relationshipStrengthRevisedPayload = nodeMetadataUpdatedPayload;

export const entityMergeSnapshot = z.strictObject({
  id: z.string(),
  label: z.string(),
  aliases: z.array(z.string()),
  metadata: jsonMetadata,
  claimIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
});

export const entityMergedPayload = z.strictObject({
  survivorId: z.string(),
  mergedIds: z.array(z.string()),
  mergedSnapshots: z.array(entityMergeSnapshot),
});

export const entitySplitPayload = z.strictObject({
  originalId: z.string(),
  originalSnapshot: z.strictObject({
    label: z.string(),
    aliases: z.array(z.string()),
    metadata: jsonMetadata,
  }),
  resultingIds: z.array(z.string()),
  restoredSnapshots: z.array(entityMergeSnapshot).optional(),
});

// ── Claim events ──────────────────────────────────────────────────────

export const claimAcceptedPayload = z.strictObject({
  id: z.string(),
  familyId: z.string(),
  threadId: z.string().optional(),
  subjectEntityId: z.string().optional(),
  subjectText: z.string(),
  predicate: z.string(),
  objectEntityId: z.string().optional(),
  objectText: z.string().optional(),
  quantifier: z
    .strictObject({
      value: z.number(),
      unit: z.string(),
      comparisonType: z.enum(['increase', 'decrease', 'absolute', 'ratio']),
      baseline: z.string().optional(),
      originalText: z.string().optional(),
    })
    .optional(),
  polarity: z.enum(['asserted', 'negated', 'conditional']),
  hedge: z.enum(['certain', 'likely', 'possible', 'speculative']),
  epistemicStatus: z
    .enum(['consensus', 'contested', 'emerging', 'speculative', 'unknown'])
    .optional(),
  evidenceType: z.enum(['study', 'benchmark', 'claim', 'opinion', 'anecdote']),
  temporalScope: z
    .strictObject({
      eventType: z.enum([
        'released', 'announced', 'proposed', 'documented',
        'discussed', 'updated', 'deprecated', 'unknown',
      ]),
      eventDate: z.string().optional(),
      publicationDate: z.string().optional(),
      version: z.string().optional(),
      dateConfidence: z.enum(['exact', 'inferred', 'publication_only', 'unknown']),
    })
    .optional(),
  confidence: z.number(),
  authorityClass: z
    .enum([
      'official_spec', 'official_changelog', 'official_repo', 'official_vendor',
      'package_registry', 'vendor_sdk_docs', 'third_party_analysis', 'news',
      'encyclopedia', 'forum_social', 'unknown',
    ])
    .optional(),
  authorityRequirement: z
    .enum(['primary_required', 'primary_preferred', 'secondary_ok', 'any_ok'])
    .optional(),
  supportLevel: z.enum(['primary', 'secondary', 'weak', 'conflicting']).optional(),
  canonicalKey: z.strictObject({
    subject: z.string(),
    predicate: z.string(),
    quantifierCanonical: z.string().optional(),
  }),
  contradictionState: z.enum(['none', 'contested', 'resolved']),
  firstSeenRunId: z.string(),
  lastSeenRunId: z.string(),
});

// ── Evidence events ───────────────────────────────────────────────────

export const evidenceAlignment = z.strictObject({
  score: z.number(),
  method: z.enum([
    'lexical_anchor_overlap', 'semantic_vector_overlap', 'hybrid_lexical_semantic',
  ]),
  matchedTerms: z.array(z.string()),
  missingAnchorTerms: z.array(z.string()),
  semanticScore: z.number().optional(),
  evidenceSnippet: z.string().optional(),
  explanation: z.string(),
});

export const evidenceLinkedPayload = z.strictObject({
  id: z.string(),
  claimId: z.string(),
  sourceId: z.string(),
  excerpt: z.string().optional(),
  alignment: evidenceAlignment.optional(),
  runId: z.string(),
});

// ── Edge / claim-relation events ──────────────────────────────────────

export const edgeAddedPayload = z.strictObject({
  id: z.string(),
  fromClaimId: z.string(),
  toClaimId: z.string(),
  relation: z.enum([
    'same_claim', 'near_duplicate', 'supports',
    'elaborates', 'contradicts', 'background',
  ]),
  strength: z.enum(['strong', 'weak']),
  score: z.number(),
  rationale: z.string().optional(),
  runId: z.string(),
});

export const edgeRemovedPayload = z.strictObject({
  edgeId: z.string(),
});

// ── Contradiction events ──────────────────────────────────────────────

export const contradictionIdentifiedPayload = z.strictObject({
  id: z.string(),
  familyId: z.string(),
  claimIdA: z.string(),
  claimIdB: z.string(),
  contradictionType: z.enum([
    'factual_disagreement', 'benchmark_disagreement', 'terminology_mismatch',
    'time_version_mismatch', 'scope_mismatch', 'implementation_specific',
    'opinion_tradeoff', 'vendor_vs_independent', 'academic_vs_practitioner',
  ]),
  resolutionStatus: z.enum([
    'unresolved', 'resolved', 'superseded', 'source_error', 'scope_distinction',
  ]),
  likelyExplanation: z.string().optional(),
  followUpSearchRecommended: z.string().optional(),
  firstSeenRunId: z.string(),
  resolvedRunId: z.string().optional(),
});

export const contradictionResolvedPayload = z.strictObject({
  contradictionId: z.string(),
  previousStatus: z.enum([
    'unresolved', 'resolved', 'superseded', 'source_error', 'scope_distinction',
  ]),
  newStatus: z.enum([
    'unresolved', 'resolved', 'superseded', 'source_error', 'scope_distinction',
  ]),
  resolvedBy: z.string().optional(),
});

/** Legacy — no call sites in current codebase. Permissive. */
export const contradictionFlaggedPayload = z.json();

// ── Gap events ────────────────────────────────────────────────────────

export const gapOpenedPayload = z.strictObject({
  id: z.string(),
  familyId: z.string(),
  threadId: z.string().optional(),
  question: z.string(),
  category: z.enum([
    'unanswered_sub_question', 'low_confidence', 'unresolvable_contradiction',
    'missing_source_type', 'missing_recency', 'overrepresented_viewpoint',
    'thin_coverage', 'low_content_depth', 'single_source_dependency',
    'promotional_bias',
  ]),
  status: z.enum(['open', 'in_progress', 'partially_resolved', 'resolved', 'deferred', 'unresolvable']),
  priority: z.number(),
  relatedClaimId: z.string().optional(),
  relatedContradictionId: z.string().optional(),
  resolution: z.strictObject({
    answer: z.string(),
    evidenceSummary: z.string(),
  }).optional(),
  firstSeenRunId: z.string(),
  resolvedRunId: z.string().optional(),
});

export const gapResolvedPayload = z.strictObject({
  gapId: z.string(),
  previousStatus: z.enum(['open', 'in_progress', 'partially_resolved', 'resolved', 'deferred', 'unresolvable']),
  newStatus: z.enum(['open', 'in_progress', 'partially_resolved', 'resolved', 'deferred', 'unresolvable']),
  resolution: z
    .strictObject({
      answer: z.string(),
      evidenceSummary: z.string(),
    })
    .optional(),
});

// ── Source events ─────────────────────────────────────────────────────

export const sourceAddedPayload = z.strictObject({
  id: z.string(),
  url: z.string(),
  canonicalUrl: z.string().optional(),
  title: z.string().optional(),
  domain: z.string(),
  sourceType: z.enum([
    'academic', 'web', 'github', 'reddit', 'hackernews', 'stackoverflow',
    'documentation', 'official_docs', 'official_blog', 'package_registry',
    'vendor_docs', 'forum', 'social', 'news', 'patent', 'pubmed',
    'wikipedia', 'podcast', 'producthunt', 'youtube', 'browser-interactive',
    'openalex', 'crossref', 'datacite', 'ror', 'semantic_scholar',
    'gdelt', 'wikidata', 'unknown',
  ]),
  authorityClass: z
    .enum([
      'official_spec', 'official_changelog', 'official_repo', 'official_vendor',
      'package_registry', 'vendor_sdk_docs', 'third_party_analysis', 'news',
      'encyclopedia', 'forum_social', 'unknown',
    ])
    .optional(),
  qualityScore: z.number().optional(),
  isPrimary: z.boolean(),
  extractionStatus: z.enum(['pending', 'extracted', 'failed']),
  usageStatus: z
    .enum(['searched', 'selected', 'read', 'used', 'discarded', 'failed'])
    .optional(),
  discardReason: z
    .enum([
      'duplicate', 'stale', 'low_relevance', 'thin_content',
      'extraction_failed', 'bot_challenge', 'paywall', 'no_findings',
      'unsupported', 'budget_exceeded',
    ])
    .optional(),
  contentHash: z.string(),
  retrievedAt: z.string(),
  publishedAt: z.string().optional(),
  firstSeenRunId: z.string(),
});

export const sourceReadPayload = z.strictObject({
  sourceId: z.string(),
});

export const sourceChangedPayload = z.strictObject({
  sourceId: z.string(),
  oldContentHash: z.string(),
  newContentHash: z.string(),
});

export const sourceRetractedPayload = z.strictObject({
  sourceId: z.string(),
  reasonType: z.string(),
  wasUsageStatus: z.string().optional(),
});
