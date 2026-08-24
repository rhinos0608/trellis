/**
 * In-flight pruning engine — prevents unbounded state growth during research.
 * Ported from search-mcp pruning.ts.
 */

import { logger } from '../logger.js';
import type { BudgetTracker } from './budget.js';
import { type ResearchStateEngine } from './state.js';
import type {
  Finding,
  SourceEntry,
  GapRecord,
  ResearchState,
} from './internalTypes.js';

function sourceRank(s: SourceEntry): number {
  return (s.qualityScore ?? 0) + (s.relevanceScore ?? 0) + (s.freshnessScore ?? 0);
}

function findingConfidence(f: Finding): number {
  let score = 0;
  if (f.evidenceDirectness === 'direct') score += 3;
  else if (f.evidenceDirectness === 'near-direct') score += 1;
  score += Math.min(f.sourceIds.length, 5);
  if (f.caveats && f.caveats.length > 0) score -= 1;
  return score;
}

export class PruningEngine {
  tierFindings(findings: Finding[]): {
    confirmed: Finding[];
    corroborated: Finding[];
    unverified: Finding[];
  } {
    const confirmed: Finding[] = [];
    const corroborated: Finding[] = [];
    const unverified: Finding[] = [];
    for (const f of findings) {
      const count = f.sourceIds.length;
      if (count >= 3) confirmed.push(f);
      else if (count === 2) corroborated.push(f);
      else unverified.push(f);
    }
    return { confirmed, corroborated, unverified };
  }

  evictSources(state: ResearchStateEngine, tracker: BudgetTracker): number {
    const snapshot = state.getState();
    const sources = snapshot.sources;
    if (sources.length === 0) return 0;

    const findingSourceIds = new Set<string>();
    for (const f of snapshot.findings) {
      for (const sid of f.sourceIds) findingSourceIds.add(sid);
    }

    const toRemove = new Set<string>();
    const STALE_SOURCE_AGE_MS = 120_000;
    const now = Date.now();
    for (const s of sources) {
      if (
        s.extractionStatus === 'pending' &&
        !findingSourceIds.has(s.id) &&
        new Date(s.accessDate).getTime() < now - STALE_SOURCE_AGE_MS
      ) {
        toRemove.add(s.id);
      }
    }

    const maxSources = tracker.profile.maxSources * 2;
    const remaining = sources.filter((s) => !toRemove.has(s.id));
    if (remaining.length > maxSources) {
      remaining.sort((a, b) => {
        const diff = sourceRank(a) - sourceRank(b);
        if (diff !== 0) return diff;
        return (
          new Date(a.accessDate).getTime() - new Date(b.accessDate).getTime()
        );
      });
      const toEvict = remaining.slice(0, remaining.length - maxSources);
      for (const s of toEvict) toRemove.add(s.id);
      logger.info(
        { evicted: toEvict.length, reason: 'cap', cap: maxSources },
        'Pruning: capped sources',
      );
    }

    if (toRemove.size > 0) {
      const prunedSources = sources.filter((s) => !toRemove.has(s.id));
      const newState: ResearchState = { ...snapshot, sources: prunedSources };
      state.fromJSON(newState);
    }

    return toRemove.size;
  }

  enforceStateGuard(state: ResearchStateEngine, tracker: BudgetTracker): number {
    const snapshot = state.getState();
    let sources = snapshot.sources;
    let findings = snapshot.findings;
    let gaps = snapshot.gaps;

    const maxEntries = tracker.profile.maxStateEntries;
    const totalEntries = sources.length + findings.length + gaps.length;
    if (totalEntries <= maxEntries) return 0;

    let totalEvicted = 0;
    let entriesToRemove = totalEntries - maxEntries;

    // Stage A: Sources with zero findings
    const findingSourceIds = new Set<string>();
    for (const f of findings) {
      for (const sid of f.sourceIds) findingSourceIds.add(sid);
    }
    const sourcesWithoutFindings: SourceEntry[] = [];
    const sourcesWithFindings: SourceEntry[] = [];
    for (const s of sources) {
      if (findingSourceIds.has(s.id)) sourcesWithFindings.push(s);
      else sourcesWithoutFindings.push(s);
    }
    if (sourcesWithoutFindings.length > 0) {
      sourcesWithoutFindings.sort((a, b) => sourceRank(a) - sourceRank(b));
      const toRemove = Math.min(sourcesWithoutFindings.length, entriesToRemove);
      sources = [...sourcesWithFindings, ...sourcesWithoutFindings.slice(toRemove)];
      totalEvicted += toRemove;
      entriesToRemove -= toRemove;
      if (entriesToRemove <= 0) {
        this.applyState(state, snapshot, sources, findings, gaps);
        return totalEvicted;
      }
    }

    // Stage B: Drop lowest-confidence unverified findings
    const { unverified } = this.tierFindings(findings);
    if (unverified.length > 0) {
      unverified.sort((a, b) => findingConfidence(a) - findingConfidence(b));
      const unverifiedIds = new Set(unverified.map((f) => f.id));
      const nonUnverified = findings.filter((f) => !unverifiedIds.has(f.id));
      const toRemove = Math.min(unverified.length, entriesToRemove);
      const keepCount = unverified.length - toRemove;
      const keptUnverified = unverified.slice(keepCount);
      findings = [...nonUnverified, ...keptUnverified];
      totalEvicted += toRemove;
      entriesToRemove -= toRemove;
      if (entriesToRemove <= 0) {
        this.applyState(state, snapshot, sources, findings, gaps);
        return totalEvicted;
      }
    }

    // Stage C: Evict oldest gap records
    if (gaps.length > 0 && entriesToRemove > 0) {
      gaps.sort((a, b) => a.priority - b.priority);
      const toRemove = Math.min(gaps.length, entriesToRemove);
      gaps = gaps.slice(toRemove);
      totalEvicted += toRemove;
    }

    this.applyState(state, snapshot, sources, findings, gaps);
    return totalEvicted;
  }

  private applyState(
    state: ResearchStateEngine,
    snapshot: ResearchState,
    sources: SourceEntry[],
    findings: Finding[],
    gaps: GapRecord[],
  ): void {
    state.fromJSON({ ...snapshot, sources, findings, gaps });
  }
}
