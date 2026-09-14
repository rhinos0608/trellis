/**
 * Longitudinal query functions — Stage 6 Wave A.
 * Pure read functions over ProjectionState and the event log.
 * No mutations, no I/O beyond the event store reads.
 */

import type { ProjectionState } from '../store/projectionState.js';
import type { queryEvents as queryEventsFn, queryEvidenceLinkedEventsByClaimId as queryEvidenceLinkedEventsByClaimIdFn } from '../store/events.js';
import type { TrellisEventType } from '../store/eventTypes.js';
import type { Evidence, Source, AuthorityClass, Claim, Contradiction, Gap } from '../graph/types.js';
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

type Payload = Record<string, unknown>;
interface FamilyEvent {
  eventType: string;
  payload: unknown;
}
interface LogEvent {
  eventType: string;
  seq: number;
  timestamp: string;
  entityId?: string | null;
  payload: unknown;
}

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
  if (a === undefined) return AUTHORITY_RANK.unknown + 1;
  return AUTHORITY_RANK[a];
}

// ── Evidence summaries ──────────────────────────────────────────────

function applySourceFields(summary: EvidenceSummary, source: Source | undefined): void {
  if (source === undefined) return;
  if (source.title !== undefined) summary.sourceTitle = source.title;
  summary.sourceDomain = source.domain;
  if (source.authorityClass !== undefined) summary.authorityClass = source.authorityClass;
}

function applyEvidenceFields(summary: EvidenceSummary, e: Evidence): void {
  if (e.stance !== undefined) summary.stance = e.stance;
  if (e.excerpt !== undefined) summary.excerpt = e.excerpt;
}

function evidenceToSummary(e: Evidence, sources: Map<string, Source>): EvidenceSummary {
  const summary: EvidenceSummary = { id: e.id, sourceId: e.sourceId };
  applySourceFields(summary, sources.get(e.sourceId));
  applyEvidenceFields(summary, e);
  return summary;
}

function strongestFirst(a: Evidence, b: Evidence, sources: Map<string, Source>): number {
  return authorityRank(sources.get(a.sourceId)?.authorityClass) - authorityRank(sources.get(b.sourceId)?.authorityClass);
}

function pickStrongest(
  evidenceList: Evidence[],
  stance: 'supports' | 'opposes',
  sources: Map<string, Source>,
): EvidenceSummary | undefined {
  const filtered = evidenceList.filter((e) => e.stance === stance);
  const best = filtered.sort((a, b) => strongestFirst(a, b, sources))[0];
  if (best === undefined) return undefined;
  return evidenceToSummary(best, sources);
}

// ── Event descriptions (dispatch table keeps each branch tiny) ──────

function describeClaimObserved(payload: Payload): string {
  const obs = payload.observation as Payload | undefined;
  const recon = payload.reconciliation as Payload | undefined;
  const text = (obs?.subjectText as string | undefined) ?? 'unknown';
  const isNew = (recon?.classification as string | undefined) === 'new_claim';
  return isNew ? `New claim: ${text}` : `Updated claim: ${text}`;
}

function describeEvidenceLinked(payload: Payload): string {
  return `Evidence linked to claim ${payload.claimId as string}`;
}

function describeContradictionIdentified(payload: Payload): string {
  return `Contradiction identified between claims ${payload.claimIdA as string} and ${payload.claimIdB as string}`;
}

function describeContradictionResolved(payload: Payload): string {
  return `Contradiction resolved: ${payload.contradictionId as string}`;
}

function describeGapOpened(payload: Payload): string {
  const question = (payload.question as string | undefined) ?? 'unknown';
  return `Gap opened: ${question.slice(0, 80)}`;
}

function describeGapResolved(payload: Payload): string {
  return `Gap resolved: ${payload.gapId as string}`;
}

function describeSourceObserved(payload: Payload): string {
  const label = ((payload.title as string | undefined) ?? (payload.domain as string | undefined)) ?? 'unknown';
  return `Source observed: ${label}`;
}

const EVENT_DESCRIBERS: Record<string, (payload: Payload) => string> = {
  CLAIM_OBSERVED: describeClaimObserved,
  EVIDENCE_LINKED: describeEvidenceLinked,
  CONTRADICTION_IDENTIFIED: describeContradictionIdentified,
  CONTRADICTION_RESOLVED: describeContradictionResolved,
  GAP_OPENED: describeGapOpened,
  GAP_RESOLVED: describeGapResolved,
  SOURCE_CHANGED: () => 'Source content changed',
  SOURCE_OBSERVED: describeSourceObserved,
  CLAIM_MERGED: () => 'Claim merged',
  CLAIM_SPLIT: () => 'Claim split',
  CLAIM_RETRACTION_SET: () => 'Claim retraction changed',
  CLAIM_RELATION_CURATED: () => 'Claim relation curated',
  EVIDENCE_STANCE_OVERRIDDEN: () => 'Evidence stance overridden',
};

function briefEventDescription(eventType: string, payload: Record<string, unknown>): string {
  const describe = EVENT_DESCRIBERS[eventType];
  if (describe === undefined) return eventType;
  return describe(payload);
}

// ── getBelief ───────────────────────────────────────────────────────

function countByStance(evidenceList: Evidence[], stance: 'supports' | 'opposes'): number {
  return evidenceList.filter((e) => e.stance === stance).length;
}

function claimAssertionText(claim: Claim): string {
  return [claim.subjectText, claim.predicate, claim.objectText].filter(Boolean).join(' ');
}

export function getBelief(state: ProjectionState, claimId: string): BeliefView | null {
  const claim = state.claims.get(claimId);
  if (!claim) return null;

  const evidenceList = getEvidenceForClaim(state, claimId);
  const view: BeliefView = {
    claimId,
    assertion: claimAssertionText(claim),
    confidence: claim.confidence,
    contradictionState: claim.contradictionState,
    supportingEvidenceCount: countByStance(evidenceList, 'supports'),
    opposingEvidenceCount: countByStance(evidenceList, 'opposes'),
  };
  if (claim.epistemicStatus !== undefined) view.epistemicStatus = claim.epistemicStatus;
  const strongestSup = pickStrongest(evidenceList, 'supports', state.sources);
  if (strongestSup !== undefined) view.strongestSupporting = strongestSup;
  const strongestOpp = pickStrongest(evidenceList, 'opposes', state.sources);
  if (strongestOpp !== undefined) view.strongestOpposing = strongestOpp;

  return view;
}

// ── getProvenance ───────────────────────────────────────────────────

function observationIdsForClaim(state: ProjectionState, claimId: string): string[] {
  const ids = state.observationsByClaimId.get(claimId);
  return ids ? [...ids] : [];
}

function pushToBucket(map: Map<string, Evidence[]>, key: string, e: Evidence): void {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(e);
}

function groupEvidenceByObservation(allEvidence: Evidence[]): { byObsId: Map<string, Evidence[]>; unattributed: Evidence[] } {
  const byObsId = new Map<string, Evidence[]>();
  const unattributed: Evidence[] = [];
  for (const e of allEvidence) {
    if (e.observationId) pushToBucket(byObsId, e.observationId, e);
    else unattributed.push(e);
  }
  return { byObsId, unattributed };
}

function buildProvenanceChains(obsIds: string[], byObsId: Map<string, Evidence[]>, sources: Map<string, Source>): ProvenanceChain[] {
  return obsIds.map((observationId) => ({
    observationId,
    evidence: (byObsId.get(observationId) ?? []).map((e) => evidenceToSummary(e, sources)),
  }));
}

function isOrphanObservation(e: Evidence, obsIdSet: Set<string>): boolean {
  return e.observationId !== undefined && !obsIdSet.has(e.observationId);
}

function collectProvenanceView(
  claimId: string,
  obsIds: string[],
  chains: ProvenanceChain[],
  unattributed: Evidence[],
  orphans: Evidence[],
  sources: Map<string, Source>,
): ProvenanceView {
  const result: ProvenanceView = { claimId, observationCount: obsIds.length, chains };
  const extra = [...unattributed, ...orphans];
  if (extra.length > 0) result.unattributedEvidence = extra.map((e) => evidenceToSummary(e, sources));
  return result;
}

export function getProvenance(state: ProjectionState, claimId: string): ProvenanceView | null {
  const claim = state.claims.get(claimId);
  if (!claim) return null;

  const obsIds = observationIdsForClaim(state, claimId);
  const obsIdSet = new Set(obsIds);
  const allEvidence = getEvidenceForClaim(state, claimId);
  const { byObsId, unattributed } = groupEvidenceByObservation(allEvidence);
  const chains = buildProvenanceChains(obsIds, byObsId, state.sources);
  const orphans = allEvidence.filter((e) => isOrphanObservation(e, obsIdSet));
  return collectProvenanceView(claimId, obsIds, chains, unattributed, orphans, state.sources);
}

// ── getTimeline ─────────────────────────────────────────────────────

interface TimelineDeps {
  queryEvents: typeof queryEventsFn;
  queryEvidenceLinkedEventsByClaimId?: typeof queryEvidenceLinkedEventsByClaimIdFn;
}
interface TimelineTarget {
  claimId?: string;
  sourceId?: string;
  contradictionId?: string;
  gapId?: string;
}

function fetchEvidenceEventsForClaim(deps: TimelineDeps, claimId: string): { eventType: string; seq: number; timestamp: string; entityId?: string | null; payload: unknown }[] {
  if (deps.queryEvidenceLinkedEventsByClaimId) return deps.queryEvidenceLinkedEventsByClaimId(claimId);
  const scanned = deps.queryEvents({ eventType: 'EVIDENCE_LINKED' as TrellisEventType });
  return scanned.filter((ev) => (ev.payload as Payload).claimId === claimId);
}

function dedupEventsBySeq<T extends { seq: number }>(events: T[]): T[] {
  const seen = new Set<number>();
  return events.filter((ev) => {
    if (seen.has(ev.seq)) return false;
    seen.add(ev.seq);
    return true;
  });
}

function fetchClaimTimelineEvents(deps: TimelineDeps, claimId: string): TimelineDeps['queryEvents'] extends never ? never : ReturnType<TimelineDeps['queryEvents']> {
  const direct = deps.queryEvents({ entityId: claimId });
  const evidenceEvents = fetchEvidenceEventsForClaim(deps, claimId);
  return dedupEventsBySeq([...direct, ...evidenceEvents]) as ReturnType<TimelineDeps['queryEvents']>;
}

function hasEntityId(ev: { entityId?: string | null }): ev is { entityId: string } {
  return ev.entityId !== null && ev.entityId !== undefined;
}

function toTimelineEntry(ev: { eventType: string; seq: number; timestamp: string; entityId?: string | null; payload: unknown }): TimelineEntry {
  const entry: TimelineEntry = {
    eventType: ev.eventType,
    timestamp: ev.timestamp,
    seq: ev.seq,
    description: briefEventDescription(ev.eventType, ev.payload as Record<string, unknown>),
  };
  if (hasEntityId(ev)) entry.entityId = ev.entityId;
  return entry;
}

function applyTimelineLimit(entries: TimelineEntry[], limit: number | undefined): TimelineEntry[] {
  if (limit !== undefined && entries.length > limit) return entries.slice(0, limit);
  return entries;
}

export function getTimeline(
  deps: TimelineDeps,
  target: TimelineTarget,
  opts?: { limit?: number },
): TimelineEntry[] {
  if (target.claimId) {
    const events = [...fetchClaimTimelineEvents(deps, target.claimId)].sort((a, b) => a.seq - b.seq);
    return applyTimelineLimit(events.map(toTimelineEntry), opts?.limit);
  }
  if (target.sourceId) {
    const events = deps.queryEvents({ entityId: target.sourceId }).sort((a, b) => a.seq - b.seq);
    return applyTimelineLimit(events.map(toTimelineEntry), opts?.limit);
  }
  if (target.contradictionId) {
    const events = deps.queryEvents({ entityId: target.contradictionId }).sort((a, b) => a.seq - b.seq);
    return applyTimelineLimit(events.map(toTimelineEntry), opts?.limit);
  }
  if (target.gapId) {
    const events = deps.queryEvents({ entityId: target.gapId }).sort((a, b) => a.seq - b.seq);
    return applyTimelineLimit(events.map(toTimelineEntry), opts?.limit);
  }
  return [];
}

// ── Family resolution (pipeline of small per-type stages) ───────────

function addClaimFamily(state: ProjectionState, families: Set<string>, claimId: string | undefined): void {
  if (claimId === undefined) return;
  const claim = state.claims.get(claimId);
  if (claim !== undefined) families.add(claim.familyId);
}

function addClaimIdList(state: ProjectionState, families: Set<string>, ids: (string | undefined)[]): void {
  for (const id of ids) addClaimFamily(state, families, id);
}

function resolveEvidenceLinked(payload: Payload, state: ProjectionState, families: Set<string>): void {
  addClaimFamily(state, families, payload.claimId as string | undefined);
}

function resolveContradictionIdentified(payload: Payload, state: ProjectionState, families: Set<string>): void {
  addClaimIdList(state, families, [payload.claimIdA as string | undefined, payload.claimIdB as string | undefined]);
}

function resolveContradictionResolved(payload: Payload, state: ProjectionState, families: Set<string>): void {
  const contradictionId = payload.contradictionId as string | undefined;
  if (contradictionId === undefined) return;
  const contr = state.contradictions.get(contradictionId);
  if (contr === undefined) return;
  families.add(contr.familyId);
  addClaimFamily(state, families, contr.claimIdA);
  addClaimFamily(state, families, contr.claimIdB);
}

function resolveGapOpened(payload: Payload, state: ProjectionState, families: Set<string>): void {
  addClaimFamily(state, families, payload.relatedClaimId as string | undefined);
}

function resolveGapResolved(payload: Payload, state: ProjectionState, families: Set<string>): void {
  const gap = state.gaps.get(payload.gapId as string);
  if (gap !== undefined) families.add(gap.familyId);
}

// Cache for source-to-family index within getChanges
let _sourceFamilyIndex: Map<string, Set<string>> | undefined;
let _sourceFamilyIndexStateId: ProjectionState | undefined;

function buildSourceFamilyIndex(state: ProjectionState): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const evIds of state.evidenceByClaimId.values()) {
    for (const evId of evIds) {
      const e = state.evidence.get(evId);
      if (e === undefined) continue;
      const claim = state.claims.get(e.claimId);
      if (claim === undefined) continue;
      pushToFamilySet(idx, e.sourceId, claim.familyId);
    }
  }
  return idx;
}

function pushToFamilySet(idx: Map<string, Set<string>>, sourceId: string, familyId: string): void {
  let fams = idx.get(sourceId);
  if (fams === undefined) {
    fams = new Set<string>();
    idx.set(sourceId, fams);
  }
  fams.add(familyId);
}

function getSourceFamilyIndex(state: ProjectionState): Map<string, Set<string>> {
  if (_sourceFamilyIndex === undefined || _sourceFamilyIndexStateId !== state) {
    _sourceFamilyIndex = buildSourceFamilyIndex(state);
    _sourceFamilyIndexStateId = state;
  }
  return _sourceFamilyIndex;
}

function resolveSourceChanged(payload: Payload, state: ProjectionState, families: Set<string>): void {
  const sourceId = payload.sourceId as string | undefined;
  if (sourceId === undefined) return;
  const fams = getSourceFamilyIndex(state).get(sourceId);
  if (fams === undefined) return;
  for (const f of fams) families.add(f);
}

function resolveClaimMerged(payload: Payload, state: ProjectionState, families: Set<string>): void {
  addClaimIdList(state, families, [
    payload.sourceClaimId as string | undefined,
    payload.survivorClaimId as string | undefined,
  ]);
}

function claimIdFromSplitResult(r: unknown): string | undefined {
  if (r === null || r === undefined || typeof r !== 'object') return undefined;
  return (r as Payload).claimId as string | undefined;
}

function resolveClaimSplit(payload: Payload, state: ProjectionState, families: Set<string>): void {
  addClaimFamily(state, families, payload.sourceClaimId as string | undefined);
  const results = payload.results as unknown[] | undefined;
  if (results === undefined) return;
  addClaimIdList(state, families, results.map(claimIdFromSplitResult));
}

function resolveRetractionClaimTarget(state: ProjectionState, families: Set<string>, target: Payload): void {
  if (target.kind === 'claim') addClaimFamily(state, families, target.id as string);
}

function resolveRetractionObservationTarget(state: ProjectionState, families: Set<string>, target: Payload): void {
  if (target.kind !== 'observation') return;
  const claimId = state.observationToClaimId.get(target.id as string);
  if (claimId !== undefined) addClaimFamily(state, families, claimId);
}

function resolveClaimRetraction(payload: Payload, state: ProjectionState, families: Set<string>): void {
  const target = payload.target as Payload | undefined;
  if (target === undefined) return;
  resolveRetractionClaimTarget(state, families, target);
  resolveRetractionObservationTarget(state, families, target);
}

function isRelationSnapshot(snap: unknown): snap is Payload {
  return snap !== null && snap !== undefined && typeof snap === 'object';
}

function addRelationSnapshotFamilies(state: ProjectionState, families: Set<string>, snap: unknown): void {
  if (!isRelationSnapshot(snap)) return;
  addClaimIdList(state, families, [snap.fromClaimId as string | undefined, snap.toClaimId as string | undefined]);
}

function resolveClaimRelation(payload: Payload, state: ProjectionState, families: Set<string>): void {
  addRelationSnapshotFamilies(state, families, payload.before);
  addRelationSnapshotFamilies(state, families, payload.after);
}

function resolveEvidenceStance(payload: Payload, state: ProjectionState, families: Set<string>): void {
  addClaimFamily(state, families, payload.claimId as string | undefined);
}

type FamilyResolver = (payload: Payload, state: ProjectionState, families: Set<string>) => void;

const FAMILY_RESOLVERS: Record<string, FamilyResolver> = {
  EVIDENCE_LINKED: resolveEvidenceLinked,
  CONTRADICTION_IDENTIFIED: resolveContradictionIdentified,
  CONTRADICTION_RESOLVED: resolveContradictionResolved,
  GAP_OPENED: resolveGapOpened,
  GAP_RESOLVED: resolveGapResolved,
  SOURCE_CHANGED: resolveSourceChanged,
  CLAIM_MERGED: resolveClaimMerged,
  CLAIM_SPLIT: resolveClaimSplit,
  CLAIM_RETRACTION_SET: resolveClaimRetraction,
  CLAIM_RELATION_CURATED: resolveClaimRelation,
  EVIDENCE_STANCE_OVERRIDDEN: resolveEvidenceStance,
};

/**
 * Resolve the owning family/families of an event by following referenced IDs
 * through the current ProjectionState. Returns undefined (excluded from
 * family-scoped feed) when the owning family cannot be determined.
 */
function resolveEventFamilyIds(
  ev: FamilyEvent,
  state: ProjectionState,
): Set<string> | undefined {
  const payload = ev.payload as Payload;
  const families = new Set<string>();
  const directFamilyId = extractFamilyId(payload);
  if (directFamilyId !== undefined) families.add(directFamilyId);
  FAMILY_RESOLVERS[ev.eventType]?.(payload, state, families);
  return families.size > 0 ? families : undefined;
}

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

function isRecord(value: unknown): value is Payload {
  return value !== null && typeof value === 'object';
}

function nestedObservationFamilyId(payload: Payload): string | undefined {
  const obs = payload.observation;
  if (!isRecord(obs)) return undefined;
  const familyId = obs.familyId;
  return typeof familyId === 'string' ? familyId : undefined;
}

function extractFamilyId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.familyId === 'string') return payload.familyId;
  return nestedObservationFamilyId(payload);
}

function hasEntityIdValue(ev: { entityId?: string | null }): ev is { entityId: string } {
  return ev.entityId !== null && ev.entityId !== undefined;
}

function entryFromEvent(ev: LogEvent): ChangeEntry {
  const entry: ChangeEntry = {
    eventType: ev.eventType,
    seq: ev.seq,
    timestamp: ev.timestamp,
    description: briefEventDescription(ev.eventType, ev.payload as Record<string, unknown>),
  };
  if (hasEntityIdValue(ev)) entry.entityId = ev.entityId;
  return entry;
}

// ── getChanges ──────────────────────────────────────────────────────

interface ChangesDeps {
  queryEvents: typeof queryEventsFn;
  state?: ProjectionState;
}

function fetchChangeCandidates(qe: ChangesDeps['queryEvents'], sinceSeq: number, familyId: string | undefined, limit: number): { eventType: string; seq: number; timestamp: string; entityId?: string | null; payload: unknown }[] {
  const batchSize = familyId ? Math.max(limit * 5, 200) : limit;
  const all = qe({ afterSeq: sinceSeq, limit: batchSize });
  return all.filter((ev) => CLAIM_RELEVANT_TYPES.has(ev.eventType));
}

function eventBelongsToFamily(ev: FamilyEvent, state: ProjectionState, familyId: string): boolean {
  return resolveEventFamilyIds(ev, state)?.has(familyId) === true;
}

function eventHasPayloadFamilyId(ev: { payload: unknown }, familyId: string): boolean {
  return extractFamilyId(ev.payload as Payload) === familyId;
}

function filterChangesByFamily(
  events: { eventType: string; payload: unknown }[],
  state: ProjectionState | undefined,
  familyId: string | undefined,
): { eventType: string; payload: unknown }[] {
  if (familyId === undefined) return events;
  if (state !== undefined) return events.filter((ev) => eventBelongsToFamily(ev, state, familyId));
  // Fallback: no state available, use payload-local familyId only.
  // This excludes events whose family membership can only be resolved
  // through ProjectionState (e.g. EVIDENCE_LINKED, SOURCE_CHANGED,
  // curation events) and is not equivalent to the state-backed path.
  return events.filter((ev) => eventHasPayloadFamilyId(ev, familyId));
}

function newEmptyChangeSet(sinceSeq: number): ChangeSet {
  return {
    sinceSeq,
    newClaims: [],
    updatedClaims: [],
    supersededClaims: [],
    contradictionsOpened: [],
    contradictionsResolved: [],
    gapsOpened: [],
    gapsResolved: [],
    newEvidence: [],
    sourcesChanged: [],
    curationEvents: [],
    otherEvents: [],
  };
}

function bucketClaimObserved(result: ChangeSet, entry: ChangeEntry, payload: Payload): void {
  const recon = payload.reconciliation as Payload | undefined;
  const classification = recon?.classification as string | undefined;
  if (classification === 'supersedes') result.supersededClaims.push(entry);
  else if (classification === 'new_claim') result.newClaims.push(entry);
  else result.updatedClaims.push(entry);
}

function isCurationEventType(eventType: string): boolean {
  return (
    eventType === 'CLAIM_MERGED' ||
    eventType === 'CLAIM_SPLIT' ||
    eventType === 'CLAIM_RETRACTION_SET' ||
    eventType === 'CLAIM_RELATION_CURATED' ||
    eventType === 'EVIDENCE_STANCE_OVERRIDDEN'
  );
}

function bucketChangeEvent(result: ChangeSet, eventType: string, entry: ChangeEntry, payload: Payload): void {
  if (eventType === 'CLAIM_OBSERVED') {
    bucketClaimObserved(result, entry, payload);
    return;
  }
  if (eventType === 'EVIDENCE_LINKED') result.newEvidence.push(entry);
  else if (eventType === 'CONTRADICTION_IDENTIFIED') result.contradictionsOpened.push(entry);
  else if (eventType === 'CONTRADICTION_RESOLVED') result.contradictionsResolved.push(entry);
  else if (eventType === 'GAP_OPENED') result.gapsOpened.push(entry);
  else if (eventType === 'GAP_RESOLVED') result.gapsResolved.push(entry);
  else if (eventType === 'SOURCE_CHANGED') result.sourcesChanged.push(entry);
  else if (isCurationEventType(eventType)) result.curationEvents.push(entry);
  else result.otherEvents.push(entry);
}

export function getChanges(
  deps: ChangesDeps,
  sinceSeq: number,
  opts?: { familyId?: string; limit?: number },
): ChangeSet {
  const { queryEvents: qe, state } = deps;
  const limit = opts?.limit ?? 200;

  // Fetch in bounded batches: when family-filtering, we need more raw events
  // than the requested limit to account for filtering, but cap the fetch
  // to prevent unbounded reads.
  const candidates = fetchChangeCandidates(qe, sinceSeq, opts?.familyId, limit);

  // Apply limit AFTER family filtering (fix pagination-before-filter bug)
  const relevant = filterChangesByFamily(candidates, state, opts?.familyId).slice(0, limit);

  const result = newEmptyChangeSet(sinceSeq);
  for (const ev of relevant) {
    const entry = entryFromEvent(ev as LogEvent);
    bucketChangeEvent(result, ev.eventType, entry, ev.payload as Payload);
  }

  return result;
}

// ── rankResearchNext ────────────────────────────────────────────────

function isOpenGapStatus(status: Gap['status']): boolean {
  return status === 'open' || status === 'partially_resolved';
}

function hasResearchQuestion(question: string): boolean {
  return question.trim() !== '';
}

function isRankableGap(gap: Gap, familyId: string): boolean {
  return gap.familyId === familyId && isOpenGapStatus(gap.status) && hasResearchQuestion(gap.question);
}

function gapResearchScore(gap: Gap): number {
  if (gap.category === 'single_source_dependency') return gap.priority - 0.5;
  return gap.priority;
}

function toRankedGap(gap: Gap): RankedGap {
  const target: RankedGap = {
    id: gap.id,
    type: 'gap',
    question: gap.question.trim(),
    status: gap.status,
    priority: gap.priority,
    score: gapResearchScore(gap),
    familyId: gap.familyId,
  };
  target.category = gap.category;
  if (gap.threadId !== undefined) target.threadId = gap.threadId;
  return target;
}

function isUnresolvedContradiction(c: Contradiction, familyId: string): boolean {
  return c.familyId === familyId && c.resolutionStatus === 'unresolved';
}

function contradictionQuestion(c: Contradiction): string {
  const followUp = c.followUpSearchRecommended?.trim();
  if (followUp) return followUp;
  const explanation = c.likelyExplanation?.trim();
  if (explanation) return explanation;
  return `Contradiction ${c.id}`;
}

function toRankedContradiction(contradiction: Contradiction): RankedGap {
  return {
    id: contradiction.id,
    type: 'contradiction',
    question: contradictionQuestion(contradiction),
    status: contradiction.resolutionStatus,
    priority: 2,
    score: 2,
    familyId: contradiction.familyId,
  };
}

function compareScore(a: RankedGap, b: RankedGap): number {
  return a.score - b.score;
}

function compareRanked(a: RankedGap, b: RankedGap): number {
  if (a.score !== b.score) return compareScore(a, b);
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function rankResearchNext(state: ProjectionState, familyId: string): RankedGap[] {
  const targets: RankedGap[] = [];

  for (const gap of state.gaps.values()) {
    if (isRankableGap(gap, familyId)) targets.push(toRankedGap(gap));
  }

  for (const contradiction of state.contradictions.values()) {
    if (isUnresolvedContradiction(contradiction, familyId)) targets.push(toRankedContradiction(contradiction));
  }

  targets.sort(compareRanked);

  return targets;
}

// ── synthesizeFamilyView ────────────────────────────────────────────

function beliefViewsForFamily(state: ProjectionState, familyId: string): BeliefView[] {
  return getClaimsByFamily(state, familyId)
    .map((c) => getBelief(state, c.id))
    .filter((b): b is BeliefView => b !== null);
}

function contradictionSummaries(state: ProjectionState, familyId: string): NonNullable<FamilyView['contradictions']> {
  return getContradictionsByFamily(state, familyId).map((c) => ({
    id: c.id,
    claimIdA: c.claimIdA,
    claimIdB: c.claimIdB,
    type: c.contradictionType,
    status: c.resolutionStatus,
    explanation: c.likelyExplanation,
  }));
}

function gapSummaries(state: ProjectionState, familyId: string): NonNullable<FamilyView['gaps']> {
  return getGapsByFamily(state, familyId).map((g) => ({
    id: g.id,
    question: g.question,
    category: g.category,
    status: g.status,
    priority: g.priority,
  }));
}

function sourceIdsForFamilyClaims(state: ProjectionState, claimIds: string[]): string[] {
  const sourceIdSet = new Set<string>();
  for (const claimId of claimIds) {
    for (const e of getEvidenceForClaim(state, claimId)) sourceIdSet.add(e.sourceId);
  }
  return [...sourceIdSet];
}

function buildFamilyNarrative(familyLabel: string, beliefs: BeliefView[], contradictions: { type: string; status: string }[], gaps: { category: string; question: string }[], sourceCount: number): string {
  const claimLines = beliefs
    .map((b) => `- ${b.assertion} (confidence: ${String(b.confidence)}, ${String(b.supportingEvidenceCount)} supporting, ${String(b.opposingEvidenceCount)} opposing)`)
    .join('\n');
  const contradictionSection = contradictions.length > 0
    ? `\n\n## Contradictions\n${contradictions.map((c) => `- ${c.type}: ${c.status}`).join('\n')}`
    : '';
  const gapSection = gaps.length > 0
    ? `\n\n## Open Gaps\n${gaps.map((g) => `- [${g.category}] ${g.question}`).join('\n')}`
    : '';
  return `# ${familyLabel}\n\n## Claims\n${claimLines || '(none)'}${contradictionSection}${gapSection}\n\n## Sources: ${String(sourceCount)}`;
}

export function synthesizeFamilyView(state: ProjectionState, familyId: string): FamilyView | null {
  const family = getFamilyById(state, familyId);
  if (!family) return null;

  const claims = getClaimsByFamily(state, familyId);
  const beliefs = beliefViewsForFamily(state, familyId);
  const contradictions = contradictionSummaries(state, familyId);
  const gaps = gapSummaries(state, familyId);
  const sourceIds = sourceIdsForFamilyClaims(state, claims.map((c) => c.id));
  const researchNext = rankResearchNext(state, familyId);
  const narrativeMarkdown = buildFamilyNarrative(family.label, beliefs, contradictions, gaps, sourceIds.length);

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
