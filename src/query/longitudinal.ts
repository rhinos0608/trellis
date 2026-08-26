/**
 * Longitudinal query functions — Stage 6 Wave A.
 * Pure read functions over ProjectionState and the event log.
 * No mutations, no I/O beyond the event store reads.
 */

import type { ProjectionState } from '../store/projectionState.js';
import type { queryEvents as queryEventsFn } from '../store/events.js';
import type { TrellisEventType } from '../store/eventTypes.js';
import type { Evidence, Source, AuthorityClass } from '../graph/types.js';
import {
  getClaimsByFamily,
  getEvidenceForClaim,
  getContradictionsByFamily,
  getGapsByFamily,
} from '../graph/queries.js';
import { getFamilyById } from '../workspace/queries.js';
import type {
  BeliefView,
  EvidenceSummary,
  ProvenanceView,
  ProvenanceChain,
  TimelineEntry,
  ChangeEntry,
  ChangeSet,
  RankedGap,
  FamilyView,
} from './longitudinalTypes.js';

// ── Authority ranking (lower = higher authority) ────────────────────

const AUTHORITY_RANK: Record<AuthorityClass, number> = {
  official_spec: 0,
  official_changelog: 1,
  official_repo: 2,
  official_vendor: 3,
  package_registry: 4,
  vendor_sdk_docs: 5,
  third_party_analysis: 6,
  news: 7,
  encyclopedia: 8,
  forum_social: 9,
  unknown: 10,
};

function authorityRank(a?: AuthorityClass): number {
  return a !== undefined ? (AUTHORITY_RANK[a] ?? 10) : 11;
}

function evidenceToSummary(e: Evidence, sources: Map<string, Source>): EvidenceSummary {
  const source = sources.get(e.sourceId);
  const summary: EvidenceSummary = {
    id: e.id,
    sourceId: e.sourceId,
  };
  if (source?.title !== undefined) summary.sourceTitle = source.title;
  if (source?.domain !== undefined) summary.sourceDomain = source.domain;
  if (source?.authorityClass !== undefined) summary.authorityClass = source.authorityClass;
  if (e.stance !== undefined) summary.stance = e.stance;
  if (e.excerpt !== undefined) summary.excerpt = e.excerpt;
  return summary;
}

function pickStrongest(
  evidenceList: Evidence[],
  stance: 'supports' | 'opposes',
  sources: Map<string, Source>,
): EvidenceSummary | undefined {
  const filtered = evidenceList.filter((e) => e.stance === stance);
  if (filtered.length === 0) return undefined;
  filtered.sort((a, b) => authorityRank(sources.get(a.sourceId)?.authorityClass) - authorityRank(sources.get(b.sourceId)?.authorityClass));
  const best = filtered[0];
  return best !== undefined ? evidenceToSummary(best, sources) : undefined;
}

function briefEventDescription(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case 'CLAIM_OBSERVED': {
      const obs = payload.observation as Record<string, unknown> | undefined;
      const recon = payload.reconciliation as Record<string, unknown> | undefined;
      const text = obs?.subjectText as string | undefined;
      const cls = recon?.classification as string | undefined;
      return cls === 'new_claim' ? `New claim: ${text ?? 'unknown'}` : `Updated claim: ${text ?? 'unknown'}`;
    }
    case 'EVIDENCE_LINKED':
      return `Evidence linked to claim ${(payload as Record<string, unknown>).claimId as string ?? 'unknown'}`;
    case 'CONTRADICTION_IDENTIFIED':
      return `Contradiction identified between claims ${(payload as Record<string, unknown>).claimIdA as string ?? '?'} and ${(payload as Record<string, unknown>).claimIdB as string ?? '?'}`;
    case 'CONTRADICTION_RESOLVED':
      return `Contradiction resolved: ${(payload as Record<string, unknown>).contradictionId as string ?? 'unknown'}`;
    case 'GAP_OPENED':
      return `Gap opened: ${((payload as Record<string, unknown>).question as string | undefined)?.slice(0, 80) ?? 'unknown'}`;
    case 'GAP_RESOLVED':
      return `Gap resolved: ${(payload as Record<string, unknown>).gapId as string ?? 'unknown'}`;
    case 'SOURCE_CHANGED':
      return 'Source content changed';
    case 'SOURCE_OBSERVED':
      return `Source observed: ${((payload as Record<string, unknown>).title as string | undefined) ?? ((payload as Record<string, unknown>).domain as string | undefined) ?? 'unknown'}`;
    case 'CLAIM_MERGED':
      return 'Claim merged';
    case 'CLAIM_SPLIT':
      return 'Claim split';
    case 'CLAIM_RETRACTION_SET':
      return 'Claim retraction changed';
    case 'CLAIM_RELATION_CURATED':
      return 'Claim relation curated';
    case 'EVIDENCE_STANCE_OVERRIDDEN':
      return 'Evidence stance overridden';
    default:
      return eventType;
  }
}

// ── getBelief ───────────────────────────────────────────────────────

export function getBelief(state: ProjectionState, claimId: string): BeliefView | null {
  const claim = state.claims.get(claimId);
  if (!claim) return null;

  const evidenceList = getEvidenceForClaim(state, claimId);
  const supporting = evidenceList.filter((e) => e.stance === 'supports');
  const opposing = evidenceList.filter((e) => e.stance === 'opposes');

  const assertion = [claim.subjectText, claim.predicate, claim.objectText].filter(Boolean).join(' ');

  const view: BeliefView = {
    claimId,
    assertion,
    confidence: claim.confidence,
    contradictionState: claim.contradictionState,
    supportingEvidenceCount: supporting.length,
    opposingEvidenceCount: opposing.length,
  };
  if (claim.epistemicStatus !== undefined) view.epistemicStatus = claim.epistemicStatus;
  const strongestSup = pickStrongest(evidenceList, 'supports', state.sources);
  if (strongestSup !== undefined) view.strongestSupporting = strongestSup;
  const strongestOpp = pickStrongest(evidenceList, 'opposes', state.sources);
  if (strongestOpp !== undefined) view.strongestOpposing = strongestOpp;

  return view;
}

// ── getProvenance ───────────────────────────────────────────────────

export function getProvenance(state: ProjectionState, claimId: string): ProvenanceView | null {
  const claim = state.claims.get(claimId);
  if (!claim) return null;

  const claimObsIds = state.observationsByClaimId.get(claimId);
  const obsIds = claimObsIds ? [...claimObsIds] : [];

  // Group evidence by observationId for efficient lookup
  const evidenceByObsId = new Map<string, Evidence[]>();
  const unattributedEvidence: Evidence[] = [];
  const allEvidence = getEvidenceForClaim(state, claimId);
  for (const e of allEvidence) {
    if (e.observationId) {
      let list = evidenceByObsId.get(e.observationId);
      if (!list) {
        list = [];
        evidenceByObsId.set(e.observationId, list);
      }
      list.push(e);
    } else {
      unattributedEvidence.push(e);
    }
  }

  const obsIdSet = new Set(obsIds);
  const chains: ProvenanceChain[] = obsIds.map((obsId) => ({
    observationId: obsId,
    evidence: (evidenceByObsId.get(obsId) ?? []).map((e) => evidenceToSummary(e, state.sources)),
  }));

  const result: ProvenanceView = { claimId, observationCount: obsIds.length, chains };
  if (unattributedEvidence.length > 0) {
    result.unattributedEvidence = unattributedEvidence.map((e) => evidenceToSummary(e, state.sources));
  }
  for (const e of allEvidence) {
    if (e.observationId && !obsIdSet.has(e.observationId)) {
      if (!result.unattributedEvidence) result.unattributedEvidence = [];
      result.unattributedEvidence.push(evidenceToSummary(e, state.sources));
    }
  }
  return result;
}

// ── getTimeline ─────────────────────────────────────────────────────

export function getTimeline(
  deps: { queryEvents: typeof queryEventsFn },
  target: { claimId?: string; sourceId?: string; contradictionId?: string; gapId?: string },
  opts?: { limit?: number },
): TimelineEntry[] {
  const { queryEvents: qe } = deps;
  let events;

  if (target.claimId) {
    // Direct events where entityId = claimId
    const direct = qe({ entityId: target.claimId });
    // EVIDENCE_LINKED events: entityId = evidence.id, not claimId
    // Must query broadly and filter by payload.claimId
    const evidenceEvents = qe({ eventType: 'EVIDENCE_LINKED' as TrellisEventType })
      .filter((ev) => (ev.payload as Record<string, unknown>)?.claimId === target.claimId);
    // Dedup by seq
    const seen = new Set<number>();
    events = [...direct, ...evidenceEvents].filter((ev) => {
      if (seen.has(ev.seq)) return false;
      seen.add(ev.seq);
      return true;
    });
  } else if (target.sourceId) {
    events = qe({ entityId: target.sourceId });
  } else if (target.contradictionId) {
    events = qe({ entityId: target.contradictionId });
  } else if (target.gapId) {
    events = qe({ entityId: target.gapId });
  } else {
    return [];
  }

  events.sort((a, b) => a.seq - b.seq);

  const entries: TimelineEntry[] = events.map((ev) => {
    const entry: TimelineEntry = {
      eventType: ev.eventType,
      timestamp: ev.timestamp,
      seq: ev.seq,
      description: briefEventDescription(ev.eventType, ev.payload as Record<string, unknown>),
    };
    if (ev.entityId !== null && ev.entityId !== undefined) entry.entityId = ev.entityId;
    return entry;
  });

  if (opts?.limit !== undefined && entries.length > opts.limit) {
    return entries.slice(0, opts.limit);
  }
  return entries;
}

// ── getChanges ──────────────────────────────────────────────────────

const CLAIM_RELEVANT_TYPES = new Set<string>([
  'CLAIM_OBSERVED',
  'EVIDENCE_LINKED',
  'CONTRADICTION_IDENTIFIED',
  'CONTRADICTION_RESOLVED',
  'GAP_OPENED',
  'GAP_RESOLVED',
  'SOURCE_CHANGED',
  'CLAIM_MERGED',
  'CLAIM_SPLIT',
  'CLAIM_RETRACTION_SET',
  'CLAIM_RELATION_CURATED',
  'EVIDENCE_STANCE_OVERRIDDEN',
]);

function extractFamilyId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.familyId === 'string') return payload.familyId;
  const obs = payload.observation;
  if (obs && typeof obs === 'object' && typeof (obs as Record<string, unknown>).familyId === 'string') {
    return (obs as Record<string, unknown>).familyId as string;
  }
  return undefined;
}

function entryFromEvent(ev: { eventType: string; seq: number; timestamp: string; entityId?: string | null; payload: unknown }): ChangeEntry {
  const entry: ChangeEntry = {
    eventType: ev.eventType,
    seq: ev.seq,
    timestamp: ev.timestamp,
    description: briefEventDescription(ev.eventType, ev.payload as Record<string, unknown>),
  };
  if (ev.entityId !== null && ev.entityId !== undefined) entry.entityId = ev.entityId;
  return entry;
}

export function getChanges(
  deps: { queryEvents: typeof queryEventsFn },
  sinceSeq: number,
  opts?: { familyId?: string; limit?: number },
): ChangeSet {
  const { queryEvents: qe } = deps;
  const limit = opts?.limit ?? 200;
  const all = qe({ afterSeq: sinceSeq, limit });

  // Filter to claim-relevant types
  let relevant = all.filter((ev) => CLAIM_RELEVANT_TYPES.has(ev.eventType));

  // Family filter: only filter events that carry a familyId
  if (opts?.familyId) {
    relevant = relevant.filter((ev) => {
      const payload = ev.payload as Record<string, unknown>;
      const fid = extractFamilyId(payload);
      // Include events that have no familyId concept (family-agnostic)
      if (fid === undefined) return true;
      return fid === opts.familyId;
    });
  }

  const result: ChangeSet = {
    sinceSeq,
    newClaims: [],
    updatedClaims: [],
    supersededClaims: [],
    newEvidence: [],
    contradictionsOpened: [],
    contradictionsResolved: [],
    gapsOpened: [],
    gapsResolved: [],
    sourcesChanged: [],
    curationEvents: [],
    otherEvents: [],
  };

  for (const ev of relevant) {
    const entry = entryFromEvent(ev);
    const payload = ev.payload as Record<string, unknown>;

    switch (ev.eventType) {
      case 'CLAIM_OBSERVED': {
        const recon = payload.reconciliation as Record<string, unknown> | undefined;
        const classification = recon?.classification as string | undefined;
        if (classification === 'supersedes') {
          result.supersededClaims.push(entry);
        } else if (classification === 'new_claim') {
          result.newClaims.push(entry);
        } else {
          result.updatedClaims.push(entry);
        }
        break;
      }
      case 'EVIDENCE_LINKED':
        result.newEvidence.push(entry);
        break;
      case 'CONTRADICTION_IDENTIFIED':
        result.contradictionsOpened.push(entry);
        break;
      case 'CONTRADICTION_RESOLVED':
        result.contradictionsResolved.push(entry);
        break;
      case 'GAP_OPENED':
        result.gapsOpened.push(entry);
        break;
      case 'GAP_RESOLVED':
        result.gapsResolved.push(entry);
        break;
      case 'SOURCE_CHANGED':
        result.sourcesChanged.push(entry);
        break;
      case 'CLAIM_MERGED':
      case 'CLAIM_SPLIT':
      case 'CLAIM_RETRACTION_SET':
      case 'CLAIM_RELATION_CURATED':
      case 'EVIDENCE_STANCE_OVERRIDDEN':
        result.curationEvents.push(entry);
        break;
      default:
        result.otherEvents.push(entry);
        break;
    }
  }

  return result;
}

// ── rankResearchNext ────────────────────────────────────────────────

export function rankResearchNext(state: ProjectionState, familyId: string): RankedGap[] {
  const targets: RankedGap[] = [];

  for (const gap of state.gaps.values()) {
    if (
      gap.familyId === familyId &&
      (gap.status === 'open' || gap.status === 'partially_resolved') &&
      gap.question.trim() !== ''
    ) {
      let score = gap.priority;
      // Boost single-source-dependency gaps (lower score = higher priority)
      if (gap.category === 'single_source_dependency') {
        score -= 0.5;
      }
      const target: RankedGap = {
        id: gap.id,
        type: 'gap',
        question: gap.question.trim(),
        status: gap.status,
        priority: gap.priority,
        score,
        familyId: gap.familyId,
      };
      if (gap.category !== undefined) target.category = gap.category;
      if (gap.threadId !== undefined) target.threadId = gap.threadId;
      targets.push(target);
    }
  }

  for (const contradiction of state.contradictions.values()) {
    if (
      contradiction.familyId === familyId &&
      contradiction.resolutionStatus === 'unresolved'
    ) {
      targets.push({
        id: contradiction.id,
        type: 'contradiction',
        question: (contradiction.followUpSearchRecommended?.trim() || contradiction.likelyExplanation?.trim()) ?? `Contradiction ${contradiction.id}`,
        status: contradiction.resolutionStatus,
        priority: 2,
        score: 2,
        familyId: contradiction.familyId,
      });
    }
  }

  targets.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return targets;
}

// ── synthesizeFamilyView ────────────────────────────────────────────

export function synthesizeFamilyView(state: ProjectionState, familyId: string): FamilyView | null {
  const family = getFamilyById(state, familyId);
  if (!family) return null;

  const claims = getClaimsByFamily(state, familyId);
  const beliefs = claims
    .map((c) => getBelief(state, c.id))
    .filter((b): b is BeliefView => b !== null);

  const contradictions = getContradictionsByFamily(state, familyId).map((c) => ({
    id: c.id,
    claimIdA: c.claimIdA,
    claimIdB: c.claimIdB,
    type: c.contradictionType,
    status: c.resolutionStatus,
    explanation: c.likelyExplanation,
  }));

  const gaps = getGapsByFamily(state, familyId).map((g) => ({
    id: g.id,
    question: g.question,
    category: g.category,
    status: g.status,
    priority: g.priority,
  }));

  // Collect unique source IDs across all claims in this family
  const sourceIdSet = new Set<string>();
  for (const claim of claims) {
    const evidence = getEvidenceForClaim(state, claim.id);
    for (const e of evidence) {
      sourceIdSet.add(e.sourceId);
    }
  }
  const sourceIds = [...sourceIdSet];

  const researchNext = rankResearchNext(state, familyId);

  // Simple narrative markdown
  const claimSummaries = beliefs
    .map((b) => `- ${b.assertion} (confidence: ${b.confidence}, ${b.supportingEvidenceCount} supporting, ${b.opposingEvidenceCount} opposing)`)
    .join('\n');
  const contradictionSummary = contradictions.length > 0
    ? `\n\n## Contradictions\n${contradictions.map((c) => `- ${c.type}: ${c.status}`).join('\n')}`
    : '';
  const gapSummary = gaps.length > 0
    ? `\n\n## Open Gaps\n${gaps.map((g) => `- [${g.category}] ${g.question}`).join('\n')}`
    : '';

  const narrativeMarkdown = `# ${family.label}\n\n## Claims\n${claimSummaries || '(none)'}${contradictionSummary}${gapSummary}\n\n## Sources: ${sourceIds.length}`;

  return {
    familyId,
    familyLabel: family.label,
    claimCount: claims.length,
    beliefs,
    contradictions,
    gaps,
    sourceCount: sourceIds.length,
    sourceIds,
    researchNext,
    narrativeMarkdown,
  };
}
