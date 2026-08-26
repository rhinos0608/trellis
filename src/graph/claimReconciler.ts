import type {
  Claim,
  ClaimAssertion,
  ClaimObservation,
  ClaimReconciliation,
} from './types.js';
import type { ProjectionState } from '../store/projectionState.js';

export interface PlannedClaimObservation {
  observation: ClaimObservation;
  reconciliation: ClaimReconciliation;
}

const MAX_CANDIDATES = 5;
export const RECONCILER_VERSION = 3 as const;

// Ambiguity guard constants — same values as workspace/familyResolver.ts
// for cross-module consistency. Defined locally per module policy.
const AMBIGUITY_MIN_GAP = 0.10;

function normalize(text: string): string {
  return text.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function words(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter(Boolean));
}

function jaccard(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function assertionText(assertion: ClaimAssertion): string {
  return [assertion.subjectText, assertion.predicate, assertion.objectText ?? ''].join(' ');
}

function sameKey(observation: ClaimObservation, claim: Claim): boolean {
  if (observation.canonicalKey.subject !== claim.canonicalKey.subject
    || observation.canonicalKey.predicate !== claim.canonicalKey.predicate
    || observation.canonicalKey.quantifierCanonical !== claim.canonicalKey.quantifierCanonical) return false;
  // objectText must be canonically equivalent (exact or both absent)
  const leftObj = normalize(observation.objectText ?? '');
  const rightObj = normalize(claim.objectText ?? '');
  if (leftObj !== rightObj) return false;
  // temporal scope must be compatible — different periods without replacement → not same
  const ls = observation.temporalScope;
  const rs = claim.temporalScope;
  if (ls && rs) {
    const lPeriod = ls.eventDate ?? ls.version ?? '';
    const rPeriod = rs.eventDate ?? rs.version ?? '';
    if (lPeriod !== '' && rPeriod !== '' && lPeriod !== rPeriod) return false;
  }
  return true;
}

function numericCompatibility(observation: ClaimObservation, claim: Claim): boolean | undefined {
  const left = observation.quantifier;
  const right = claim.quantifier;
  if (!left || !right) return undefined;
  if (left.unit !== right.unit || left.comparisonType !== right.comparisonType) return false;
  const scale = Math.max(Math.abs(left.value), Math.abs(right.value), 1);
  return Math.abs(left.value - right.value) / scale <= 0.1;
}

function scorePair(observation: ClaimObservation, claim: Claim): number {
  if (sameKey(observation, claim)
    && observation.polarity === claim.polarity
    && numericCompatibility(observation, claim) !== false) return 1;
  // Entity-equality signal: same subjectEntityId is a strong positive
  // scope signal but must not short-circuit; predicate/object/polarity
  // and temporal compatibility still determine the final score.
  const obsEntity = observation.subjectEntityId;
  const claimEntity = claim.subjectEntityId;
  const entityMatch = obsEntity !== undefined && claimEntity !== undefined && obsEntity === claimEntity;
  const entityMismatch = obsEntity !== undefined && claimEntity !== undefined && obsEntity !== claimEntity;
  if (entityMismatch) return 0;
  const text = jaccard(assertionText(observation), assertionText(claim));
  const numeric = numericCompatibility(observation, claim);
  // v1 transparent weights: text 70%, numeric 15%, polarity 10%, hedge 5%.
  const numericScore = numeric === undefined ? 0.5 : numeric ? 1 : 0;
  const polarityScore = observation.polarity === claim.polarity ? 1 : 0;
  const hedgeScore = observation.hedge === claim.hedge ? 1 : 0;
  const base = Math.max(0, Math.min(1, text * 0.7 + numericScore * 0.15 + polarityScore * 0.1 + hedgeScore * 0.05));
  return entityMatch ? Math.max(base, 0.85) : base;
}

function newer(observation: ClaimObservation, claim: Claim): boolean {
  const left = observation.temporalScope;
  const right = claim.temporalScope;
  if (!left || !right) return false;
  if (left.eventDate && right.eventDate) return left.eventDate > right.eventDate;
  if (left.version && right.version) {
    const a = /\d+(?:\.\d+)*/.exec(left.version)?.[0];
    const b = /\d+(?:\.\d+)*/.exec(right.version)?.[0];
    if (a && b) {
      const av = a.split('.').map(Number);
      const bv = b.split('.').map(Number);
      for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (av[i] ?? 0) > (bv[i] ?? 0);
      }
    }
  }
  return false;
}

function hasReplacementSignal(observation: ClaimObservation, claim: Claim): boolean {
  return /\b(replaces?|supersedes?|deprecated|deprecates?|removed|no longer supported)\b/i.test(
    assertionText(observation),
  ) && newer(observation, claim);
}

function isNarrowing(observation: ClaimObservation, claim: Claim): boolean {
  return observation.polarity === 'conditional'
    || (observation.hedge !== claim.hedge && claim.hedge === 'certain')
    || /\b(only|unless|when|if|provided|limited to|under)\b/i.test(assertionText(observation));
}

function isElaboration(observation: ClaimObservation, claim: Claim): boolean {
  const sameSubjectPredicate = normalize(observation.subjectText) === normalize(claim.subjectText)
    && normalize(observation.predicate) === normalize(claim.predicate);
  const oldObject = normalize(claim.objectText ?? '');
  const newObject = normalize(observation.objectText ?? '');
  return sameSubjectPredicate && newObject.length > oldObject.length && newObject.includes(oldObject);
}

function sameScope(observation: ClaimObservation, claim: Claim): boolean {
  const subjectMatch = observation.canonicalKey.subject === claim.canonicalKey.subject;
  const predicateMatch = observation.canonicalKey.predicate === claim.canonicalKey.predicate;
  if (!subjectMatch || !predicateMatch) return false;
  // Object text overlap for scope relevance
  const leftObj = normalize(observation.objectText ?? '');
  const rightObj = normalize(claim.objectText ?? '');
  if (leftObj !== '' && rightObj !== '' && jaccard(leftObj, rightObj) < 0.3) return false;
  // Temporal scope: same period or both absent
  const ls = observation.temporalScope;
  const rs = claim.temporalScope;
  if (ls && rs) {
    const lPeriod = ls.eventDate ?? ls.version ?? '';
    const rPeriod = rs.eventDate ?? rs.version ?? '';
    if (lPeriod !== '' && rPeriod !== '' && lPeriod !== rPeriod) return false;
  }
  return true;
}

function classify(
  observation: ClaimObservation,
  claim: Claim,
  score: number,
  topScore?: number,
  secondScore?: number,
): ClaimReconciliation['classification'] {
  const numeric = numericCompatibility(observation, claim);
  const scoped = sameScope(observation, claim);
  // Polarity/numeric contradictions only when claims share the same scope
  if (scoped && observation.polarity !== claim.polarity && observation.polarity !== 'conditional' && claim.polarity !== 'conditional') return 'contradiction';
  if (scoped && numeric === false) return 'contradiction';
  if (hasReplacementSignal(observation, claim)) return 'supersedes';
  if (isNarrowing(observation, claim)) return 'qualification';
  if (isElaboration(observation, claim)) return 'elaboration';
  // Entity-equality hard negative: different subjectEntityId → never same_claim
  const obsEntity = observation.subjectEntityId;
  const claimEntity = claim.subjectEntityId;
  if (obsEntity && claimEntity && obsEntity !== claimEntity && score >= 0.92) return 'near_duplicate';
  if (sameKey(observation, claim) || (score >= 0.92 && scoped)) {
    // Ambiguity downgrade: if top-2 scores are near-tied and neither is an exact
    // canonical-key or entity-id match, downgrade same_claim → near_duplicate.
    if (topScore !== undefined && secondScore !== undefined
      && topScore - secondScore < AMBIGUITY_MIN_GAP
      && !sameKey(observation, claim)) {
      return 'near_duplicate';
    }
    return 'same_claim';
  }
  if (score >= 0.78) return 'near_duplicate';
  return 'new_claim';
}

function rationale(classification: ClaimReconciliation['classification'], score: number): string {
  return `Deterministic lexical reconciliation: ${classification} (score=${score.toFixed(3)}).`;
}

/**
 * Strip Claim-only fields from a Claim, leaving only the ClaimAssertion
 * subset that claimAssertionPayload's z.strictObject schema accepts.
 * TypeScript enforces completeness: if Claim adds a field that isn't in
 * ClaimAssertion, this destructuring will error.
 */
function assertionFromClaim({
  id: _, familyId: _f, threadId: _t, currentObservationId: _coid,
  confidence: _conf, epistemicStatus: _eps, contradictionState: _cs,
  firstSeenRunId: _fsr, firstSeenAt: _fsa, lastSeenRunId: _lsr,
  lastSeenAt: _lsa, observationIds: _oi, evidenceIds: _ei,
  observationCount: _oc, supportingEvidenceCount: _sec,
  opposingEvidenceCount: _oec, confidenceHistory: _ch,
  revisionHistory: _rh, curationStatus: _curs,
  mergedIntoClaimId: _mic, splitIntoClaimIds: _sic,
  lastCuration: _lc, ...assertion
}: Claim): ClaimAssertion {
  return assertion;
}

export interface PlanClaimObservationOptions {
  /** Seams for future semantic resolution — not implemented yet. */
  semanticCandidates?: (obs: ClaimObservation) => Claim[];
  /** Seams for future semantic adjudication — not implemented yet. */
  adjudicate?: (obs: ClaimObservation, candidates: Claim[]) => ClaimReconciliation['classification'] | undefined;
}

export function planClaimObservation(
  observation: ClaimObservation,
  state: ProjectionState,
  _options?: PlanClaimObservationOptions,
): PlannedClaimObservation {
  const claims = [...(state.claimsByFamilyId.get(observation.familyId) ?? [])]
    .map((id) => state.claims.get(id))
    .filter((claim): claim is Claim => claim !== undefined);
  const scored = claims.map((claim) => ({ claim, score: scorePair(observation, claim) }));
  scored.sort((a, b) => {
    const scoreOrder = b.score - a.score;
    return scoreOrder !== 0 ? scoreOrder : a.claim.id.localeCompare(b.claim.id, 'en-US');
  });
  const top = scored.slice(0, MAX_CANDIDATES);
  const best = top[0];
  const topScore = best?.score;
  const secondScore = top[1]?.score;
  const classification = best ? classify(observation, best.claim, best.score, topScore, secondScore) : 'new_claim';
  const createsClaim = classification === 'new_claim' || classification === 'near_duplicate' || classification === 'elaboration' || classification === 'qualification' || classification === 'contradiction';
  const canonicalClaimId = createsClaim ? `claim_${observation.id}` : best?.claim.id ?? `claim_${observation.id}`;
  const method = best !== undefined && sameKey(observation, best.claim) ? 'canonical_key_exact'
    : (topScore !== undefined && topScore >= 0.92 && sameScope(observation, best!.claim)) ? 'entity_aware_v3'
    : 'lexical_rules_v2';
  const reconciliation: ClaimReconciliation = {
    observationId: observation.id,
    classification,
    canonicalClaimId,
    ...(best && classification !== 'new_claim' ? { matchedClaimId: best.claim.id } : {}),
    score: best?.score ?? 0,
    method,
    rationale: rationale(classification, best?.score ?? 0),
    reconcilerVersion: RECONCILER_VERSION,
    candidates: top.flatMap(({ claim, score }) => {
      const candidateClassification = classify(observation, claim, score, topScore, secondScore);
      if (candidateClassification === 'new_claim') return [];
      return [{ claimId: claim.id, classification: candidateClassification, score }];
    }),
  };
  if (classification === 'supersedes' && best) {
    reconciliation.supersedes = {
      previousObservationId: best.claim.currentObservationId ?? best.claim.observationIds?.[0] ?? best.claim.id,
      // Snapshot, not a live reference: the projection handler copies this
      // into claim.revisionHistory[].before, and a back-reference to the
      // claim itself would create a cycle that breaks JSON serialization
      // of events (appendEvents) and checkpoints.
      previousAssertion: structuredClone(assertionFromClaim(best.claim)),
    };
  }
  return { observation, reconciliation };
}

