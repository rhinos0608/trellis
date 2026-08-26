/**
 * Adaptive gap analysis — detects knowledge gaps and generates follow-up tasks.
 * Ported from search-mcp gapAnalysis.ts.
 */

import { randomUUID } from 'node:crypto';
import type {
  GapRecord,
  GapCategory,
  SourceType,
  SubQuestionCoverage,
} from './internalTypes.js';
import type { ResearchCapabilities, SearchOpts } from '../providers/types.js';
import { logger } from '../logger.js';
import type { ResearchStateEngine } from './state.js';
import type { BudgetTracker } from './budget.js';

const RECENCY_THRESHOLD_MS = 365 * 24 * 60 * 60 * 1000;

function gapId(): string {
  return randomUUID().slice(0, 12);
}

function defaultPriority(category: GapCategory): number {
  switch (category) {
    case 'unanswered_sub_question': return 1;
    case 'low_confidence': return 2;
    case 'missing_source_type': return 3;
    case 'missing_recency': return 4;
    case 'overrepresented_viewpoint': return 3;
    case 'unresolvable_contradiction': return 2;
    case 'thin_coverage': return 1;
    case 'single_source_dependency': return 1;
    case 'low_content_depth': return 2;
    case 'promotional_bias': return 2;
  }
}

function gapKey(
  category: GapCategory,
  subQuestionId?: string,
  relatedFindingId?: string,
): string {
  return `${category}::${subQuestionId ?? ''}::${relatedFindingId ?? ''}`;
}

export class GapAnalyzer {
  constructor(private state: ResearchStateEngine) {}

  analyze(coverage?: SubQuestionCoverage[]): GapRecord[] {
    const gaps: GapRecord[] = [];
    gaps.push(...this.unansweredSubQuestions());
    gaps.push(...this.missingSourceTypes());
    gaps.push(...this.missingRecency());
    gaps.push(...this.overrepresentedViewpoints());
    if (coverage) {
      gaps.push(...this.thinCoverage(coverage));
    }
    return gaps;
  }

  private unansweredSubQuestions(): GapRecord[] {
    const state = this.state.getState();
    const pending = state.subQuestions.filter((sq) => sq.status === 'pending');
    return pending.map((sq) => ({
      id: gapId(),
      category: 'unanswered_sub_question' as const,
      description: `Sub-question not addressed: "${sq.text}"`,
      subQuestionId: sq.id,
      status: 'open' as const,
      suggestedActions: [
        `Search for "${sq.text}" using web and preferred sources`,
      ],
      priority: defaultPriority('unanswered_sub_question'),
    }));
  }

  private missingSourceTypes(): GapRecord[] {
    const state = this.state.getState();
    if (state.sources.length === 0) return [];
    const present = new Set(state.sources.map((s) => s.sourceType));
    if (present.size >= 3) return [];

    const allTypes: SourceType[] = [
      'academic', 'web', 'github', 'reddit', 'hackernews',
      'stackoverflow', 'documentation', 'news', 'youtube',
    ];
    const underrepresented = allTypes.filter((t) => !present.has(t));
    return [
      {
        id: gapId(),
        category: 'missing_source_type' as const,
        description: `Only ${String(present.size)} source type(s) represented. Need more diversity.`,
        status: 'open' as const,
        suggestedActions: [
          'Expand search to include underrepresented source categories',
          ...(underrepresented.length > 0
            ? [`Try: ${underrepresented.slice(0, 4).join(', ')}`]
            : []),
        ],
        priority: defaultPriority('missing_source_type'),
        missingSourceTypes: underrepresented,
      },
    ];
  }

  private missingRecency(): GapRecord[] {
    const state = this.state.getState();
    const now = Date.now();
    const threshold = now - RECENCY_THRESHOLD_MS;
    const gaps: GapRecord[] = [];

    for (const finding of state.findings) {
      if (!finding.freshnessSensitive || finding.sourceIds.length === 0) continue;
      const sources = state.sources.filter((s) =>
        finding.sourceIds.includes(s.id),
      );
      const allOld =
        sources.length > 0 &&
        sources.every((s) => {
          if (!s.publishedDate) return true;
          return new Date(s.publishedDate).getTime() < threshold;
        });
      if (allOld) {
        gaps.push({
          id: gapId(),
          category: 'missing_recency' as const,
          description: `Freshness-sensitive finding relies on old sources: "${finding.claim}"`,
          relatedFindingId: finding.id,
          status: 'open' as const,
          suggestedActions: [
            `Search for recent updates about: "${finding.claim}"`,
            'Apply date filters for sources from the last 12 months',
          ],
          priority: defaultPriority('missing_recency'),
        });
      }
    }
    return gaps;
  }

  private overrepresentedViewpoints(): GapRecord[] {
    const state = this.state.getState();
    if (state.sources.length === 0) return [];
    const typeCounts: Record<string, number> = {};
    for (const s of state.sources) {
      typeCounts[s.sourceType] = (typeCounts[s.sourceType] ?? 0) + 1;
    }
    const total = state.sources.length;
    const gaps: GapRecord[] = [];
    for (const [type, count] of Object.entries(typeCounts)) {
      const fraction = count / total;
      if (fraction > 0.7) {
        gaps.push({
          id: gapId(),
          category: 'overrepresented_viewpoint' as const,
          description: `Source type "${type}" dominates (${(fraction * 100).toFixed(0)}%). Bias risk.`,
          status: 'open' as const,
          suggestedActions: [
            `Balance over-represented type "${type}"`,
            'Actively seek alternative viewpoints',
          ],
          priority: defaultPriority('overrepresented_viewpoint'),
          dominantSourceType: type,
        });
      }
    }
    return gaps;
  }

  private thinCoverage(coverage: SubQuestionCoverage[]): GapRecord[] {
    const gaps: GapRecord[] = [];
    const dedupKeys = new Set<string>();
    const state = this.state.getState();

    for (const sq of coverage) {
      if (sq.status !== 'thin' && sq.status !== 'uncovered') continue;
      const subQuestion = state.subQuestions.find((s) => s.id === sq.subQuestionId);
      if (subQuestion?.status === 'unresolvable') continue;

      const category: GapCategory =
        sq.uniqueDomainCount <= 1 ? 'single_source_dependency' : 'thin_coverage';
      const key = gapKey(category, sq.subQuestionId);
      if (dedupKeys.has(key)) continue;
      dedupKeys.add(key);

      gaps.push({
        id: gapId(),
        category,
        description: `Sub-question "${sq.subQuestionText}" has only ${String(sq.sourceCount)} source(s) from ${String(sq.uniqueDomainCount)} domain(s)`,
        subQuestionId: sq.subQuestionId,
        status: 'open' as const,
        suggestedActions: [
          `Search with broader terms for: "${sq.subQuestionText}"`,
          'Try alternative search backends (academic, GitHub, Reddit)',
        ],
        priority: defaultPriority(category),
      });
    }
    return gaps;
  }
}

// ── Gap acquisition planning ─────────────────────────────────────────────

export interface GapAcquisition {
  gapId: string;
  method: 'search' | 'academic' | 'github' | 'reddit' | 'hackernews' | 'stackoverflow';
  query: string;
  searchOpts?: { freshness?: SearchOpts['freshness']; limit?: number };
  targetSubQuestionIds: string[];
}

/** Map a source type name to the corresponding GapAcquisition method, gated by capabilities. */
function sourceTypeToAcqMethod(
  sourceType: string,
  caps: ResearchCapabilities,
): GapAcquisition['method'] | null {
  switch (sourceType) {
    case 'academic': return caps.academic ? 'academic' : null;
    case 'github': return caps.code ? 'github' : null;
    case 'reddit': return caps.community.reddit ? 'reddit' : null;
    case 'hackernews': return caps.community.hackernews ? 'hackernews' : null;
    case 'stackoverflow': return caps.community.stackoverflow ? 'stackoverflow' : null;
    default: return null;
  }
}

/**
 * Pure planner: decides what acquisition SHOULD happen for each gap.
 * No provider calls, no I/O — returns a list of GapAcquisition instructions
 * that the strategy layer can dispatch.
 *
 * Handles: unanswered_sub_question, missing_recency, single_source_dependency,
 * thin_coverage, missing_source_type (capability-gated),
 * overrepresented_viewpoint (routes to non-dominant type).
 */
export function planGapAcquisitions(
  gaps: GapRecord[],
  state: ResearchStateEngine,
  caps: ResearchCapabilities,
): GapAcquisition[] {
  const sqMap = new Map(state.getState().subQuestions.map((sq) => [sq.id, sq]));
  const findingMap = new Map(state.getState().findings.map((f) => [f.id, f]));
  const acquisitions: GapAcquisition[] = [];

  for (const gap of gaps) {
    switch (gap.category) {
      case 'unanswered_sub_question': {
        if (!gap.subQuestionId) break;
        const sq = sqMap.get(gap.subQuestionId);
        if (!sq) break;
        acquisitions.push({
          gapId: gap.id,
          method: 'search',
          query: sq.text,
          searchOpts: { limit: 10 },
          targetSubQuestionIds: [gap.subQuestionId],
        });
        break;
      }
      case 'missing_recency': {
        if (!gap.relatedFindingId) break;
        const finding = findingMap.get(gap.relatedFindingId);
        if (!finding) break;
        const targetIds = gap.subQuestionId ? [gap.subQuestionId] : [];
        acquisitions.push({
          gapId: gap.id,
          method: 'search',
          query: finding.claim,
          searchOpts: { freshness: 'year', limit: 10 },
          targetSubQuestionIds: targetIds,
        });
        break;
      }
      case 'single_source_dependency': {
        if (!gap.subQuestionId) break;
        const sq = sqMap.get(gap.subQuestionId);
        if (!sq) break;
        const method = caps.academic ? 'academic' as const : 'search' as const;
        acquisitions.push({
          gapId: gap.id,
          method,
          query: sq.text,
          searchOpts: { limit: 10 },
          targetSubQuestionIds: [gap.subQuestionId],
        });
        break;
      }
      case 'thin_coverage': {
        if (!gap.subQuestionId) break;
        const sq = sqMap.get(gap.subQuestionId);
        if (!sq) break;
        acquisitions.push({
          gapId: gap.id,
          method: 'search',
          query: sq.text,
          searchOpts: { limit: 15 },
          targetSubQuestionIds: [gap.subQuestionId],
        });
        break;
      }
      case 'missing_source_type': {
        // Parse missing types from suggestedActions "Try: type1, type2, ..."
        const missingTypes = gap.missingSourceTypes ?? [];
        if (missingTypes.length === 0) break;
        const sqQuery = state.getState().taxonomy.originalQuery;
        for (const missingType of missingTypes) {
          const method = sourceTypeToAcqMethod(missingType, caps);
          if (!method) continue;
          acquisitions.push({
            gapId: gap.id,
            method,
            query: sqQuery,
            searchOpts: { limit: 10 },
            targetSubQuestionIds: gap.subQuestionId ? [gap.subQuestionId] : [],
          });
        }
        break;
      }
      case 'overrepresented_viewpoint': {
        // Parse dominant type from description: Source type "X" dominates...
        const dominantType = gap.dominantSourceType;
        if (!dominantType) break;
        // Prefer academic if available and not dominant, else first non-dominant available
        let chosenMethod: GapAcquisition['method'] | null = null;
        if (dominantType !== 'academic' && caps.academic) {
          chosenMethod = 'academic';
        } else {
          const candidates: [string, GapAcquisition['method']][] = [
            ['github', 'github'],
            ['reddit', 'reddit'],
            ['hackernews', 'hackernews'],
            ['stackoverflow', 'stackoverflow'],
          ];
          for (const [type, m] of candidates) {
            if (type !== dominantType && sourceTypeToAcqMethod(type, caps)) {
              chosenMethod = m;
              break;
            }
          }
        }
        if (!chosenMethod) break;
        acquisitions.push({
          gapId: gap.id,
          method: chosenMethod,
          query: state.getState().taxonomy.originalQuery,
          searchOpts: { limit: 10 },
          targetSubQuestionIds: gap.subQuestionId ? [gap.subQuestionId] : [],
        });
        break;
      }
    }
  }

  return acquisitions;
}

export class GapFiller {
  constructor(
    private state: ResearchStateEngine,
    private budget: BudgetTracker,
  ) {}

  async fillGaps(
    gaps: GapRecord[],
  ): Promise<{ filled: number; remaining: GapRecord[] }> {
    const existingKeys = new Set(
      this.state.getOpenGaps().map((g) =>
        gapKey(g.category, g.subQuestionId, g.relatedFindingId),
      ),
    );
    let filled = 0;
    const remaining: GapRecord[] = [];
    for (const gap of gaps) {
      const key = gapKey(gap.category, gap.subQuestionId, gap.relatedFindingId);
      if (existingKeys.has(key)) {
        remaining.push(gap);
        continue;
      }
      const addedId = this.state.addGap(gap);
      if (addedId === '') {
        remaining.push(gap);
        continue;
      }
      existingKeys.add(key);
      filled++;
    }
    this.budget.recordGapLoop();
    return { filled, remaining };
  }

  shouldContinueLoop(): boolean {
    if (this.budget.isExhausted()) return false;
    const currentLoops = this.budget.snapshot().gapLoopsUsed;
    const minGapLoops = this.budget.profile.minGapLoops;

    const state = this.state.getState();
    const hasThinCoverage = state.subQuestions.some((sq) => {
      const sqSources = state.sources.filter((s) =>
        s.relevantSubQuestions.includes(sq.id),
      );
      if (sqSources.length === 0) return true;
      const domains = new Set(sqSources.map((s) => s.domain));
      return sqSources.length < 2 || domains.size < 2;
    });
    if (hasThinCoverage) return true;

    const openGaps = this.state.getOpenGaps();
    if (openGaps.length === 0) return false;
    if (currentLoops < minGapLoops) return true;
    if (openGaps.every((g) => g.priority > 3)) return false;

    const wellCoveredCount = state.subQuestions.filter((sq) => {
      const sqSources = state.sources.filter((s) =>
        s.relevantSubQuestions.includes(sq.id),
      );
      const sourceTypes = new Set(sqSources.map((s) => s.sourceType));
      return sqSources.length >= 3 && sourceTypes.size >= 2;
    }).length;
    const wellCoveredRatio =
      state.subQuestions.length > 0
        ? wellCoveredCount / state.subQuestions.length
        : 0;

    const hasHighPriorityGaps = openGaps.some((g) => g.priority <= 2);
    if (
      !hasHighPriorityGaps &&
      wellCoveredRatio > 0.5 &&
      currentLoops >= state.subQuestions.length
    ) {
      logger.info(
        { wellCoveredRatio, currentLoops },
        'gap: high coverage, stopping',
      );
      return false;
    }

    if (
      !hasHighPriorityGaps &&
      currentLoops >= Math.max(2, minGapLoops) &&
      wellCoveredRatio >= 0.3
    ) {
      logger.info(
        { wellCoveredRatio, currentLoops, minGapLoops },
        'gap: niche topic, stopping',
      );
      return false;
    }

    return true;
  }
}
