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

const claimAssertionPayload = z.strictObject({
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
});

export const claimAcceptedPayload = claimAssertionPayload.extend({
  id: z.string(), familyId: z.string(), threadId: z.string().optional(),
  epistemicStatus: z.enum(['consensus', 'contested', 'emerging', 'speculative', 'unknown']).optional(), confidence: z.number(),
  contradictionState: z.enum(['none', 'contested', 'resolved']), firstSeenRunId: z.string(), lastSeenRunId: z.string(),
});

const claimReconciliationPayload = z.strictObject({
  observationId: z.string(),
  classification: z.enum(['same_claim', 'near_duplicate', 'elaboration', 'qualification', 'contradiction', 'supersedes', 'new_claim']),
  canonicalClaimId: z.string(), matchedClaimId: z.string().optional(),
  score: z.number().min(0).max(1),
  method: z.enum(['canonical_key_exact', 'lexical_rules_v1', 'lexical_rules_v2', 'legacy_import']),
  rationale: z.string(), reconcilerVersion: z.union([z.literal(1), z.literal(2)]),
  candidates: z.array(z.strictObject({
    claimId: z.string(), classification: z.enum(['same_claim', 'near_duplicate', 'elaboration', 'qualification', 'contradiction', 'supersedes']), score: z.number().min(0).max(1),
  })).max(5),
  supersedes: z.strictObject({ previousObservationId: z.string(), previousAssertion: claimAssertionPayload }).optional(),
}).superRefine((r, ctx) => {
  if (r.classification === 'new_claim' && r.matchedClaimId !== undefined) ctx.addIssue({ code: 'custom', path: ['matchedClaimId'], message: 'new_claim forbids matchedClaimId' });
  if (r.classification !== 'new_claim' && r.matchedClaimId === undefined) ctx.addIssue({ code: 'custom', path: ['matchedClaimId'], message: 'classification requires matchedClaimId' });
  if ((r.classification === 'same_claim' || r.classification === 'supersedes') && r.canonicalClaimId !== r.matchedClaimId) ctx.addIssue({ code: 'custom', path: ['canonicalClaimId'], message: 'canonicalClaimId must equal matchedClaimId' });
  if (['near_duplicate', 'elaboration', 'qualification', 'contradiction'].includes(r.classification) && r.canonicalClaimId === r.matchedClaimId) ctx.addIssue({ code: 'custom', path: ['canonicalClaimId'], message: 'canonicalClaimId must differ from matchedClaimId' });
  if (r.classification === 'supersedes' && r.supersedes === undefined) ctx.addIssue({ code: 'custom', path: ['supersedes'], message: 'supersedes required' });
  if (r.classification !== 'supersedes' && r.supersedes !== undefined) ctx.addIssue({ code: 'custom', path: ['supersedes'], message: 'supersedes forbidden' });
});

export const claimObservedPayload = z.strictObject({ observation: claimAssertionPayload.extend({ id: z.string(), familyId: z.string(), threadId: z.string().optional(), runId: z.string(), observedAt: z.string(), confidence: z.number(), sourceIds: z.array(z.string()), extractionVersion: z.string() }), reconciliation: claimReconciliationPayload });

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

export const evidenceLinkedPayloadV1 = z.strictObject({
  id: z.string(),
  claimId: z.string(),
  sourceId: z.string(),
  excerpt: z.string().optional(),
  alignment: evidenceAlignment.optional(),
  runId: z.string(),
});
export const evidenceLinkedPayload = evidenceLinkedPayloadV1;
export const evidenceLinkedPayloadV2 = evidenceLinkedPayloadV1.extend({
  observationId: z.string(),
  stance: z.enum(['supports', 'opposes', 'context']),
});

// ── Edge / claim-relation events ──────────────────────────────────────

export const edgeAddedPayload = z.strictObject({
  id: z.string(),
  fromClaimId: z.string(),
  toClaimId: z.string(),
  relation: z.enum([
    'same_claim', 'near_duplicate', 'supports',
    'elaborates', 'qualifies', 'contradicts', 'background',
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

export const sourceObservedPayload = z.strictObject({
  sourceId: z.string(),
  observedSourceId: z.string(),
  canonicalUrl: z.string(),
  url: z.string(),
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
  contentHash: z.string().optional(),
  runId: z.string(),
  observedAt: z.string(),
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

// ── Curation events (Phase 9 Stage 1) ──────────────────────────────

/** Sane bounds for operator-supplied free-text/identifier fields — documented
 * via named constants so tests and call sites share one source of truth. */
export const CURATION_COMMAND_ID_MAX_LENGTH = 100;
export const CURATION_REASON_MAX_LENGTH = 200;

const evidenceStance = z.enum(['supports', 'opposes', 'context']);
const retractionStatus = z.enum(['active', 'retracted']);

export const curationContext = z.strictObject({
  commandId: z.string().min(1).max(CURATION_COMMAND_ID_MAX_LENGTH),
  reason: z.string().min(1).max(CURATION_REASON_MAX_LENGTH),
  expectedSeq: z.number().int().nonnegative(),
});

export const claimMergedPayload = z
  .strictObject({
    curation: curationContext,
    sourceClaimId: z.string(),
    survivorClaimId: z.string(),
    affectedObservationIds: z.array(z.string()),
    affectedEvidenceIds: z.array(z.string()),
    affectedRelationIds: z.array(z.string()),
    affectedContradictionIds: z.array(z.string()),
    affectedGapIds: z.array(z.string()),
  })
  .superRefine((r, ctx) => {
    if (r.sourceClaimId === r.survivorClaimId) ctx.addIssue({ code: 'custom', path: ['survivorClaimId'], message: 'sourceClaimId must differ from survivorClaimId' });
  });

export const claimSplitResult = z.strictObject({
  claimId: z.string(),
  currentObservationId: z.string(),
  observationIds: z.array(z.string()).min(1),
  evidenceIds: z.array(z.string()),
});

export const claimSplitPayload = z
  .strictObject({
    curation: curationContext,
    sourceClaimId: z.string(),
    results: z.array(claimSplitResult).min(2),
  })
  .superRefine((r, ctx) => {
    r.results.forEach((result, i) => {
      if (!result.observationIds.includes(result.currentObservationId)) ctx.addIssue({ code: 'custom', path: ['results', i, 'currentObservationId'], message: 'currentObservationId must be a member of observationIds' });
    });
    const claimIds = r.results.map((result) => result.claimId);
    if (new Set(claimIds).size !== claimIds.length) ctx.addIssue({ code: 'custom', path: ['results'], message: 'duplicate result claimIds' });
    const observationIds = r.results.flatMap((result) => result.observationIds);
    if (new Set(observationIds).size !== observationIds.length) ctx.addIssue({ code: 'custom', path: ['results'], message: 'duplicate result observationIds' });
    const evidenceIds = r.results.flatMap((result) => result.evidenceIds);
    if (new Set(evidenceIds).size !== evidenceIds.length) ctx.addIssue({ code: 'custom', path: ['results'], message: 'duplicate result evidenceIds' });
  });

export const claimRetractionSetPayload = z
  .strictObject({
    curation: curationContext,
    target: z.strictObject({ kind: z.enum(['claim', 'observation']), id: z.string() }),
    previousStatus: retractionStatus,
    newStatus: retractionStatus,
    observationIds: z.array(z.string()).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.previousStatus === r.newStatus) ctx.addIssue({ code: 'custom', path: ['newStatus'], message: 'no-op status transition rejected' });
  });

export const curatedRelationSnapshot = z.strictObject({
  id: z.string(),
  fromClaimId: z.string(),
  toClaimId: z.string(),
  relation: z.enum(['same_claim', 'near_duplicate', 'supports', 'elaborates', 'qualifies', 'contradicts', 'background']),
  strength: z.enum(['strong', 'weak']),
  score: z.number(),
  rationale: z.string().optional(),
  runId: z.string(),
});

export const claimRelationCuratedPayload = z
  .strictObject({
    curation: curationContext,
    relationId: z.string(),
    before: curatedRelationSnapshot.nullable(),
    after: curatedRelationSnapshot.nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.before === null && r.after === null) ctx.addIssue({ code: 'custom', path: ['after'], message: 'before and after must not both be null' });
    if (r.after !== null && r.after.id !== r.relationId) ctx.addIssue({ code: 'custom', path: ['after'], message: 'after.id must equal relationId' });
    if (r.before !== null && r.before.id !== r.relationId) ctx.addIssue({ code: 'custom', path: ['before'], message: 'before.id must equal relationId' });
  });

export const evidenceStanceOverriddenPayload = z.strictObject({
  curation: curationContext,
  evidenceId: z.string(),
  claimId: z.string(),
  previousStance: evidenceStance.nullable(),
  newStance: evidenceStance,
});
