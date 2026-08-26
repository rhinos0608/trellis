/**
 * Result shapes for the longitudinal query surface — Stage 6 Wave A.
 * Minimal, JSON-serializable. References existing graph types by ID
 * plus a few denormalized display fields.
 */

import type {
  AuthorityClass,
  ClaimContradictionState,
  ContradictionResolutionStatus,
  EpistemicStatus,
  EvidenceStance,
  GapCategory,
  GapStatus,
} from '../graph/types.js';

// ── Evidence summary (reused across views) ──────────────────────────

export interface EvidenceSummary {
  id: string;
  sourceId: string;
  sourceTitle?: string | undefined;
  sourceDomain?: string | undefined;
  authorityClass?: AuthorityClass | undefined;
  stance?: EvidenceStance | undefined;
  excerpt?: string | undefined;
}

// ── Belief view ─────────────────────────────────────────────────────

export interface BeliefView {
  claimId: string;
  assertion: string;
  confidence: number;
  epistemicStatus?: EpistemicStatus | undefined;
  contradictionState: ClaimContradictionState;
  supportingEvidenceCount: number;
  opposingEvidenceCount: number;
  strongestSupporting?: EvidenceSummary | undefined;
  strongestOpposing?: EvidenceSummary | undefined;
}

// ── Provenance (why-chain) ──────────────────────────────────────────

export interface ProvenanceChain {
  observationId: string;
  evidence: EvidenceSummary[];
}

export interface ProvenanceView {
  claimId: string;
  observationCount: number;
  chains: ProvenanceChain[];
  unattributedEvidence?: EvidenceSummary[];
}

// ── Timeline ────────────────────────────────────────────────────────

export interface TimelineEntry {
  eventType: string;
  timestamp: string;
  seq: number;
  description: string;
  entityId?: string | undefined;
}

// ── Changes ─────────────────────────────────────────────────────────

export interface ChangeEntry {
  eventType: string;
  seq: number;
  timestamp: string;
  entityId?: string | undefined;
  description: string;
}

export interface ChangeSet {
  sinceSeq: number;
  newClaims: ChangeEntry[];
  updatedClaims: ChangeEntry[];
  supersededClaims: ChangeEntry[];
  newEvidence: ChangeEntry[];
  contradictionsOpened: ChangeEntry[];
  contradictionsResolved: ChangeEntry[];
  gapsOpened: ChangeEntry[];
  gapsResolved: ChangeEntry[];
  sourcesChanged: ChangeEntry[];
  curationEvents: ChangeEntry[];
  otherEvents: ChangeEntry[];
}

// ── Ranked gaps ─────────────────────────────────────────────────────

export interface RankedGap {
  id: string;
  type: 'gap' | 'contradiction';
  question: string;
  category?: GapCategory | undefined;
  status: GapStatus | ContradictionResolutionStatus;
  priority: number;
  score: number;
  familyId: string;
  threadId?: string | undefined;
}

// ── Family view ─────────────────────────────────────────────────────

export interface FamilyView {
  familyId: string;
  familyLabel: string;
  claimCount: number;
  beliefs: BeliefView[];
  contradictions: {
    id: string;
    claimIdA: string;
    claimIdB: string;
    type: string;
    status: string;
    explanation?: string | undefined;
  }[];
  gaps: {
    id: string;
    question: string;
    category: string;
    status: string;
    priority: number;
  }[];
  sourceCount: number;
  sourceIds: string[];
  researchNext: RankedGap[];
  narrativeMarkdown?: string | undefined;
}
