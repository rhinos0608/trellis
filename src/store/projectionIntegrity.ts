/**
 * Evidence-required projection invariant — verify-only (not append-time).
 *
 * Every Claim (except merged/split tombstones) must have at least one
 * Evidence record whose claimId matches it, whose referenced Source exists.
 * evidenceIds on Claim and evidenceByClaimId reverse index must agree.
 */

import type { ProjectionState } from './projectionState.js';

export interface ProjectionIntegrityResult {
  matches: boolean;
  mismatches: string[];
}

export function verifyProjectionIntegrity(state: ProjectionState): ProjectionIntegrityResult {
  const mismatches: string[] = [];

  // Build evidenceByClaimId from authoritative state.evidence as source of truth
  const authoritativeByClaim = new Map<string, Set<string>>();
  for (const ev of state.evidence.values()) {
    if (!state.claims.has(ev.claimId)) {
      mismatches.push(`evidence ${ev.id}: references nonexistent claim ${ev.claimId}`);
    }
    // Evidence counts only if its referenced Source actually exists
    if (!state.sources.has(ev.sourceId)) {
      mismatches.push(`evidence ${ev.id}: references nonexistent source ${ev.sourceId}`);
      continue;
    }
    let set = authoritativeByClaim.get(ev.claimId);
    if (set === undefined) { set = new Set(); authoritativeByClaim.set(ev.claimId, set); }
    set.add(ev.id);
  }

  for (const [claimId, claim] of state.claims) {
    // Merged/split tombstones are excluded from the invariant
    if (claim.curationStatus === 'merged' || claim.curationStatus === 'split') continue;

    const realEvidence = authoritativeByClaim.get(claimId);
    const hasEvidence = realEvidence !== undefined && realEvidence.size > 0;

    if (!hasEvidence) {
      mismatches.push(`claim ${claimId}: no valid evidence (retracted claims still require provenance)`);
      continue;
    }

    // Check evidenceIds is an EXACT SET match against authoritative evidence.
    // Missing entries: evidence exists for this claim but isn't in evidenceIds.
    const claimEvidenceIds = new Set(claim.evidenceIds ?? []);
    for (const evId of realEvidence) {
      if (!claimEvidenceIds.has(evId)) {
        mismatches.push(`claim ${claimId}: evidenceId ${evId} missing from claim.evidenceIds (evidence exists but not listed)`);
      }
    }
    // Extra entries: evidenceIds references evidence that doesn't belong to this claim.
    for (const evId of claimEvidenceIds) {
      if (!realEvidence.has(evId)) {
        if (!state.evidence.has(evId)) {
          mismatches.push(`claim ${claimId}: evidenceId ${evId} references nonexistent evidence record`);
        } else {
          mismatches.push(`claim ${claimId}: evidenceId ${evId} not owned by this claim (belongs elsewhere)`);
        }
      }
    }

    // Check evidenceByClaimId reverse index agrees with authoritative evidence
    const indexedIds = state.evidenceByClaimId.get(claimId);
    if (indexedIds !== undefined) {
      for (const evId of indexedIds) {
        if (!authoritativeByClaim.get(claimId)?.has(evId)) {
          mismatches.push(`claim ${claimId}: evidenceByClaimId contains ${evId} not in authoritative evidence`);
        }
      }
    }
    // Also check the reverse: every authoritative evidence should be in the index
    for (const evId of realEvidence) {
      if (!indexedIds?.has(evId)) {
        mismatches.push(`claim ${claimId}: authoritative evidence ${evId} missing from evidenceByClaimId index`);
      }
    }
  }

  // Reverse-index keys must point at real claims and entries must belong to key.
  for (const [claimId, indexedIds] of state.evidenceByClaimId) {
    if (!state.claims.has(claimId)) {
      mismatches.push(`evidenceByClaimId contains nonexistent claim ${claimId}`);
      continue;
    }
    for (const evId of indexedIds) {
      const evidence = state.evidence.get(evId);
      if (evidence !== undefined && evidence.claimId !== claimId) {
        mismatches.push(`claim ${claimId}: evidenceByClaimId entry ${evId} belongs to ${evidence.claimId}`);
      }
    }
  }

  return { matches: mismatches.length === 0, mismatches };
}
