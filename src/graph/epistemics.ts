/**
 * Epistemic/temporal state machine — derives confidence, support level,
 * epistemic status, and contradiction state for a claim from its
 * projection state (observations, evidence, sources, contradictions).
 *
 * Pure, deterministic. No side effects.
 *
 * Replaces inline confidence means in projectionHandlers.ts and
 * subsumes the contradiction detection that lived in
 * contradictionDetection.ts (rule-based contradiction detection is
 * now handled at observation-reception time via the claim reconciler;
 * this module computes the *derived state* from whatever contradictions
 * already exist in the graph).
 */

import type { ProjectionState } from '../store/projectionState.js';
import type {
  Claim,
  ClaimObservation,
  Evidence,
  AuthorityClass,
  ClaimEvidenceType,
  EpistemicStatus,
  ClaimContradictionState,
  SupportLevel,
} from './types.js';

// ── Weight maps ────────────────────────────────────────────────────────────

/** Source authority weight — higher = more trustworthy. */
const AUTHORITY_WEIGHT: Record<AuthorityClass, number> = {
  official_spec: 1.0,
  official_changelog: 0.95,
  official_repo: 0.9,
  official_vendor: 0.85,
  package_registry: 0.8,
  vendor_sdk_docs: 0.75,
  third_party_analysis: 0.7,
  news: 0.65,
  encyclopedia: 0.6,
  forum_social: 0.4,
  unknown: 0.5,
};

/** Evidence type directness weight. */
const EVIDENCE_TYPE_WEIGHT: Record<ClaimEvidenceType, number> = {
  study: 1.0,
  benchmark: 1.0,
  claim: 0.7,
  opinion: 0.5,
  anecdote: 0.4,
};

// ponytail: half-life ~365 days. Source older than 2yr gets floor=0.5.
const RECENCY_HALF_LIFE_MS = 365.25 * 24 * 3600 * 1000;
const RECENCY_FLOOR = 0.5;

// ── Public API ─────────────────────────────────────────────────────────────

export interface DerivedEpistemics {
  confidence: number;
  supportLevel: SupportLevel;
  epistemicStatus: EpistemicStatus;
  contradictionState: ClaimContradictionState;
}

/**
 * Derive epistemic state for a claim from projection state.
 *
 * @param state  Current projection state (observations, evidence, sources, contradictions)
 * @param claim  The claim to evaluate
 * @param now    ISO timestamp for freshness decay (defaults to now)
 */
export function deriveEpistemicState(
  state: ProjectionState,
  claim: Claim,
  now?: string,
): DerivedEpistemics {
  const nowMs = now ? new Date(now).getTime() : Date.now();

  const observationIds = claim.observationIds ?? [];
  const evidenceIds = claim.evidenceIds ?? [];

  // ── Resolve active observations, evidence, sources ────────────────────
  const observations: ClaimObservation[] = [];
  for (const id of observationIds) {
    const obs = state.claimObservations.get(id);
    if (obs && (obs.curationStatus ?? 'active') === 'active') {
      observations.push(obs);
    }
  }

  const activeEvidence: Evidence[] = [];
  for (const id of evidenceIds) {
    const e = state.evidence.get(id);
    if (e) {
      // Skip evidence whose observation was retracted
      if (e.observationId !== undefined) {
        const obs = state.claimObservations.get(e.observationId);
        if (obs?.curationStatus === 'retracted') continue;
      }
      activeEvidence.push(e);
    }
  }

  // ── Contradiction state ───────────────────────────────────────────────
  const contradictionState = computeContradictionState(state, claim);

  // ── Confidence ────────────────────────────────────────────────────────
  const confidence = computeConfidence(observations, state, nowMs, activeEvidence);

  // ── Domain independence ───────────────────────────────────────────────
  const domains = collectDomains(observations, state, activeEvidence);

  // ── Epistemic status ──────────────────────────────────────────────────
  const epistemicStatus = computeEpistemicStatus(
    observations,
    contradictionState,
    domains,
    activeEvidence,
  );

  // ── Support level ─────────────────────────────────────────────────────
  const supportLevel = computeSupportLevel(
    contradictionState,
    observations,
    state,
  );

  return { confidence, supportLevel, epistemicStatus, contradictionState };
}

// ── Internals ──────────────────────────────────────────────────────────────

function computeContradictionState(
  state: ProjectionState,
  claim: Claim,
): ClaimContradictionState {
  let hasUnresolved = false;
  let hasResolved = false;

  for (const c of state.contradictions.values()) {
    if (c.claimIdA !== claim.id && c.claimIdB !== claim.id) continue;
    if (c.resolutionStatus === 'unresolved') {
      hasUnresolved = true;
    } else {
      hasResolved = true;
    }
  }

  if (hasUnresolved) return 'contested';
  if (hasResolved) return 'resolved';

  // Mixed evidence stance → contested even without explicit Contradiction rows
  let sup = 0;
  let opp = 0;
  for (const eId of claim.evidenceIds ?? []) {
    const e = state.evidence.get(eId);
    if (!e) continue;
    if (e.observationId !== undefined) {
      const obs = state.claimObservations.get(e.observationId);
      if (obs?.curationStatus === 'retracted') continue;
    }
    if (e.stance === 'supports') sup++;
    else if (e.stance === 'opposes') opp++;
  }
  if (sup > 0 && opp > 0) return 'contested';

  return 'none';
}

function computeConfidence(
  observations: ClaimObservation[],
  state: ProjectionState,
  nowMs: number,
  activeEvidence: Evidence[],
): number {
  if (observations.length === 0) return 0;

  // Weighted mean of active observations
  let totalWeight = 0;
  let weightedSum = 0;

  for (const obs of observations) {
    const authWeight = resolveAuthorityWeight(obs, state);
    const directness = EVIDENCE_TYPE_WEIGHT[obs.evidenceType];
    const freshness = resolveFreshness(obs, state, nowMs);
    const weight = authWeight * directness * freshness;

    totalWeight += weight;
    weightedSum += weight * obs.confidence;
  }

  let base = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Opposing evidence dampening
  const supporting = activeEvidence.filter((e) => e.stance === 'supports');
  const opposing = activeEvidence.filter((e) => e.stance === 'opposes');

  if (opposing.length > 0 && (supporting.length > 0 || observations.length > 0)) {
    // Weight opposing evidence by their source authority
    let opposingAuthority = 0;
    for (const e of opposing) {
      const src = state.sources.get(e.sourceId);
      opposingAuthority += src?.authorityClass
        ? AUTHORITY_WEIGHT[src.authorityClass]
        : 0.5;
    }
    const opposingPenalty = Math.min(opposingAuthority / Math.max(supporting.length, 1), 0.8);
    base = clamp(base * (1 - opposingPenalty), 0, 1);
  }

  return Math.round(base * 1000) / 1000; // 3 decimal places
}

function resolveAuthorityWeight(
  obs: ClaimObservation,
  state: ProjectionState,
): number {
  // Observation-level authorityClass first, then fall back to source authority
  if (obs.authorityClass) {
    return AUTHORITY_WEIGHT[obs.authorityClass];
  }

  // Look up source authority via observation's sourceIds
  for (const srcId of obs.sourceIds) {
    const src = state.sources.get(srcId);
    if (src?.authorityClass) {
      return AUTHORITY_WEIGHT[src.authorityClass];
    }
  }

  return 0.5; // unknown
}

function resolveFreshness(
  obs: ClaimObservation,
  state: ProjectionState,
  nowMs: number,
): number {
  // Try to find source timestamp from observation's sourceIds
  let latestMs = 0;
  for (const srcId of obs.sourceIds) {
    const src = state.sources.get(srcId);
    if (src?.publishedAt) {
      const t = new Date(src.publishedAt).getTime();
      if (t > latestMs) latestMs = t;
    } else if (src?.retrievedAt) {
      const t = new Date(src.retrievedAt).getTime();
      if (t > latestMs) latestMs = t;
    }
  }

  if (latestMs === 0) {
    // Fall back to observation observedAt
    latestMs = new Date(obs.observedAt).getTime();
  }

  const ageMs = Math.max(0, nowMs - latestMs);
  const decay = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
  return Math.max(RECENCY_FLOOR, decay);
}

function collectDomains(
  observations: ClaimObservation[],
  state: ProjectionState,
  activeEvidence?: Evidence[],
): Set<string> {
  const domains = new Set<string>();
  for (const obs of observations) {
    for (const srcId of obs.sourceIds) {
      const src = state.sources.get(srcId);
      if (src?.domain) domains.add(src.domain);
    }
  }
  if (activeEvidence) {
    for (const e of activeEvidence) {
      const src = state.sources.get(e.sourceId);
      if (src?.domain) domains.add(src.domain);
    }
  }
  return domains;
}

function computeEpistemicStatus(
  observations: ClaimObservation[],
  contradictionState: ClaimContradictionState,
  domains: Set<string>,
  activeEvidence: Evidence[],
): EpistemicStatus {
  // No evidence at all
  if (observations.length === 0) return 'unknown';

  // Contested contradictions take priority
  if (contradictionState === 'contested') return 'contested';

  // Check for authoritative support
  const hasSubstantialEvidence =
    activeEvidence.length > 0 || observations.length >= 2;
  const multiDomain = domains.size >= 2;

  // Cross-domain corroboration heuristic — not true source independence;
  // multiple sites citing the same press release still count as separate domains.
  if (observations.length >= 2 && multiDomain) {
    return 'consensus';
  }

  if (hasSubstantialEvidence) return 'emerging';

  // Weak/anecdotal only
  const allWeak = observations.every(
    (o) => o.evidenceType === 'opinion' || o.evidenceType === 'anecdote',
  );
  if (allWeak) return 'speculative';

  // Single observation with some substance
  if (observations.length === 1) return 'speculative';

  return 'emerging';
}

function computeSupportLevel(
  contradictionState: ClaimContradictionState,
  observations: ClaimObservation[],
  state: ProjectionState,
): SupportLevel {
  if (contradictionState === 'contested') return 'conflicting';
  if (observations.length === 0) return 'weak';

  // Find the highest authority among observations
  let maxAuth = 0;
  for (const obs of observations) {
    const w = resolveAuthorityWeight(obs, state);
    if (w > maxAuth) maxAuth = w;
  }

  if (maxAuth >= 0.85) return 'primary';
  if (maxAuth >= 0.6) return 'secondary';
  return 'weak';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
