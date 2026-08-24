/**
 * Evidence alignment scoring — lexical anchor overlap between claim text
 * and evidence text.  Ported from search-mcp/src/research/provenance.ts
 * assessEvidenceAlignment().  Produces EvidenceAlignment shapes as-is
 * from graph/types.ts.
 *
 * The semantic/hybrid enrichment path (embedTexts + mergeSemanticAlignment)
 * is NOT ported here because it requires the embedding provider — callers
 * can layer that on top by replacing method + score + semanticScore when
 * embeddings are available.  The lexical path is self-contained.
 */

import type { EvidenceAlignment } from './types.js';

// ── Stop words (subset from provenance.ts) ──────────────────────────────────

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'because',
  'been',
  'being',
  'but',
  'can',
  'could',
  'does',
  'for',
  'from',
  'has',
  'have',
  'into',
  'its',
  'may',
  'more',
  'not',
  'now',
  'of',
  'official',
  'on',
  'or',
  'released',
  'release',
  'says',
  'since',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'what',
  'when',
  'which',
  'with',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function contentTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9@._/-]+/)
      .map((token: string) => token.replace(/^[._/-]+|[._/-]+$/g, ''))
      .filter((token: string) => token.length > 2 && !STOP_WORDS.has(token)),
  );
}

function anchorTerms(text: string): string[] {
  const anchors = new Set<string>();
  for (const match of text.matchAll(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi))
    anchors.add(match[0].toLowerCase());
  for (const match of text.matchAll(/\bv?\d+(?:\.\d+)*(?:-[\w.]+)?\b/gi))
    anchors.add(match[0].toLowerCase());
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) anchors.add(match[0]);
  const namedDate =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/gi;
  for (const match of text.matchAll(namedDate)) anchors.add(match[0].toLowerCase());
  return [...anchors];
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AssessableFinding {
  claim: string;
  evidenceText?: string;
}

/**
 * Assess evidence alignment between a claim and its supporting evidence
 * using lexical anchor overlap — the same algorithm as search-mcp's
 * provenance.ts assessEvidenceAlignment(), without the embedding-based
 * hybrid layer.
 */
export function assessEvidenceAlignment(
  finding: AssessableFinding,
): EvidenceAlignment {
  const evidenceText = finding.evidenceText ?? '';
  const claimTerms = contentTerms(finding.claim);
  const evidenceTerms = contentTerms(evidenceText);
  const matchedTerms: string[] = [...claimTerms]
    .filter((term: string) => evidenceTerms.has(term))
    .sort();
  const lexicalScore: number =
    claimTerms.size === 0 || evidenceTerms.size === 0
      ? 0
      : matchedTerms.length / Math.min(claimTerms.size, evidenceTerms.size);
  const anchors = anchorTerms(finding.claim);
  const missingAnchorTerms: string[] = anchors.filter(
    (anchor: string) => !evidenceText.toLowerCase().includes(anchor),
  );
  const anchorScore: number =
    anchors.length === 0
      ? lexicalScore
      : (anchors.length - missingAnchorTerms.length) / anchors.length;
  const score: number = Math.max(
    0,
    Math.min(1, anchors.length > 0 ? Math.min(lexicalScore, anchorScore) : lexicalScore),
  );
  const snippet = evidenceText.trim().slice(0, 240);
  return {
    score,
    method: 'lexical_anchor_overlap',
    matchedTerms: matchedTerms.slice(0, 12),
    missingAnchorTerms,
    ...(snippet ? { evidenceSnippet: snippet } : {}),
    explanation:
      missingAnchorTerms.length > 0
        ? `Evidence does not contain anchor term(s): ${missingAnchorTerms.join(', ')}.`
        : `Evidence shares ${String(matchedTerms.length)} content term(s) with the claim.`,
  };
}
