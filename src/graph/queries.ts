/**
 * Read-side query functions operating on a ProjectionState.
 * These are pure read functions — no mutations, no persistence.
 * The ProjectionState is owned and mutated by projection handlers;
 * these just query it.
 */

import type { ProjectionState } from '../store/projectionState.js';
import type { Claim, CanonicalEntity, Evidence, Gap, Contradiction } from './types.js';

// ── Claim queries ────────────────────────────────────────────────────────────

/**
 * Get all claims for a given family.
 */
export function getClaimsByFamily(
  state: ProjectionState,
  familyId: string,
): Claim[] {
  const ids = state.claimsByFamilyId.get(familyId);
  if (!ids) return [];
  const claims: Claim[] = [];
  for (const id of ids) {
    const claim = state.claims.get(id);
    if (claim) claims.push(claim);
  }
  return claims;
}

/**
 * Get all evidence records for a given claim.
 */
export function getEvidenceForClaim(
  state: ProjectionState,
  claimId: string,
): Evidence[] {
  const ids = state.evidenceByClaimId.get(claimId);
  if (!ids) return [];
  const evidence: Evidence[] = [];
  for (const id of ids) {
    const e = state.evidence.get(id);
    if (e) evidence.push(e);
  }
  return evidence;
}

// ── Contradiction queries ────────────────────────────────────────────────────

/**
 * Get all contradictions for a given family.
 */
export function getContradictionsByFamily(
  state: ProjectionState,
  familyId: string,
): Contradiction[] {
  const results: Contradiction[] = [];
  for (const c of state.contradictions.values()) {
    if (c.familyId === familyId) results.push(c);
  }
  return results;
}

// ── Gap queries ──────────────────────────────────────────────────────────────

/**
 * Get all gaps for a given family.
 */
export function getGapsByFamily(
  state: ProjectionState,
  familyId: string,
): Gap[] {
  const results: Gap[] = [];
  for (const g of state.gaps.values()) {
    if (g.familyId === familyId) results.push(g);
  }
  return results;
}

// ── Entity queries ───────────────────────────────────────────────────────────

/**
 * Get an entity by ID.
 */
export function getEntityById(
  state: ProjectionState,
  entityId: string,
): CanonicalEntity | undefined {
  return state.entities.get(entityId);
}

/**
 * Find an entity by its label (case-insensitive exact match).
 */
export function findEntityByLabel(
  state: ProjectionState,
  label: string,
): CanonicalEntity | undefined {
  const lowerLabel = label.toLowerCase();
  for (const entity of state.entities.values()) {
    if (entity.label.toLowerCase() === lowerLabel) return entity;
  }
  return undefined;
}
