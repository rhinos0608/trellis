/**
 * Research state engine — in-memory working state for a single run.
 * Ported from search-mcp state.ts, simplified.
 */

import { randomUUID } from 'node:crypto';
import type {
  ResearchState,
  ResearchPhase,
  SubQuestion,
  SubQuestionStatus,
  SourceEntry,
  Finding,
  InternalContradiction,
  InternalContradictionStatus,
  InternalContradictionType,
  GapRecord,
  GapStatus,
  ClaimEdge,
  WorkerReport,
  ContentQualityAssessment,
  SubQuestionCoverage,
  ResearchTaxonomy,
} from './internalTypes.js';
import { BudgetTracker } from './budget.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function makeId(): string {
  return randomUUID().slice(0, 12);
}

// ── Similarity helpers ─────────────────────────────────────────────────────

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(
    a.toLowerCase().split(/\s+/).filter((w) => w.length > 0),
  );
  const setB = new Set(
    b.toLowerCase().split(/\s+/).filter((w) => w.length > 0),
  );
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function trigramSimilarity(a: string, b: string): number {
  const textA = a.toLowerCase().replace(/\s+/g, ' ').trim();
  const textB = b.toLowerCase().replace(/\s+/g, ' ').trim();
  if (textA.length < 3 || textB.length < 3) return 0;
  const trigramsA = new Set<string>();
  const trigramsB = new Set<string>();
  for (let i = 0; i <= textA.length - 3; i++) trigramsA.add(textA.slice(i, i + 3));
  for (let i = 0; i <= textB.length - 3; i++) trigramsB.add(textB.slice(i, i + 3));
  if (trigramsA.size === 0 && trigramsB.size === 0) return 1;
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0;
  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }
  const union = trigramsA.size + trigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function combinedSimilarity(a: string, b: string): number {
  return Math.max(jaccardSimilarity(a, b), trigramSimilarity(a, b));
}

// ── ResearchStateEngine ────────────────────────────────────────────────────

export class ResearchStateEngine {
  private state: ResearchState;
  private budget: BudgetTracker;

  constructor(budget: BudgetTracker) {
    this.budget = budget;
    this.state = this.createInitialState();
  }

  private createInitialState(): ResearchState {
    return {
      query: '',
      taxonomy: { originalQuery: '', subQuestions: [], revised: false, revisionHistory: [] },
      subQuestions: [],
      sources: [],
      findings: [],
      contradictions: [],
      openQuestions: [],
      gaps: [],
      claimGraph: [],
      currentPhase: 'idle',
      budget: this.budget.snapshot(),
      flags: { taxonomyRevised: false, audited: false, loopCount: 0 },
      gapTargets: [],
      allQuestions: [],
      resolvedGaps: [],
      searchClusters: [],
      diary: [],
      searchAttempts: [],
      workerReports: {},
      contentQuality: {},
      subQuestionCoverage: [],
    };
  }

  initialize(query: string, budget: BudgetTracker): void {
    this.state = this.createInitialState();
    this.state.query = query;
    this.state.taxonomy.originalQuery = query;
    this.budget = budget;
    this.state.budget = this.budget.snapshot();
  }

  getState(): ResearchState {
    return { ...this.state, budget: this.budget.snapshot() };
  }

  getPhase(): ResearchPhase {
    return this.state.currentPhase;
  }

  transitionTo(phase: ResearchPhase): void {
    this.state.currentPhase = phase;
  }

  getBudget(): BudgetTracker {
    return this.budget;
  }

  // ── Sub-questions ──────────────────────────────────────────────────────

  setSubQuestions(questions: SubQuestion[]): void {
    this.state.subQuestions = questions;
    this.state.taxonomy.subQuestions = questions;
  }

  removeSubQuestionsFrom(index: number): void {
    if (index < this.state.subQuestions.length) {
      this.state.subQuestions = this.state.subQuestions.slice(0, index);
    }
    if (index < this.state.taxonomy.subQuestions.length) {
      this.state.taxonomy.subQuestions = this.state.taxonomy.subQuestions.slice(0, index);
    }
  }

  addSubQuestion(sq: SubQuestion): void {
    this.state.subQuestions.push(sq);
    this.state.taxonomy.subQuestions.push(sq);
  }

  getSubQuestions(status?: SubQuestionStatus): SubQuestion[] {
    if (!status) return [...this.state.subQuestions];
    return this.state.subQuestions.filter((sq) => sq.status === status);
  }

  updateSubQuestionStatus(id: string, status: SubQuestionStatus): void {
    const sq = this.state.subQuestions.find((s) => s.id === id);
    if (sq) sq.status = status;
  }

  // ── Taxonomy ───────────────────────────────────────────────────────────

  getTaxonomy(): ResearchTaxonomy {
    return { ...this.state.taxonomy };
  }

  reviseTaxonomy(taxonomy: ResearchTaxonomy): void {
    this.state.taxonomy = taxonomy;
    this.state.taxonomy.revised = true;
    this.state.taxonomy.revisionHistory.push(nowISO());
    this.state.flags.taxonomyRevised = true;
  }

  // ── Sources ────────────────────────────────────────────────────────────

  addSource(entry: SourceEntry): string {
    if (
      this.state.sources.length + this.state.findings.length + this.state.gaps.length >=
      this.budget.profile.maxStateEntries
    ) {
      return '';
    }
    this.budget.incrementStateEntries(1);
    this.state.sources.push(entry);
    return entry.id;
  }

  getSources(subQuestionId?: string): SourceEntry[] {
    if (!subQuestionId) return [...this.state.sources];
    return this.state.sources.filter((s) =>
      s.relevantSubQuestions.includes(subQuestionId),
    );
  }

  getSourcesByIds(ids: string[]): SourceEntry[] {
    const idSet = new Set(ids);
    return this.state.sources.filter((s) => idSet.has(s.id));
  }

  markSourceExtracted(id: string): void {
    const src = this.state.sources.find((s) => s.id === id);
    if (src) src.extractionStatus = 'extracted';
  }

  markSourceFailed(id: string): void {
    const src = this.state.sources.find((s) => s.id === id);
    if (src) src.extractionStatus = 'failed';
  }

  sourceCount(): number {
    return this.state.sources.length;
  }

  // ── Findings ───────────────────────────────────────────────────────────

  addFinding(finding: Omit<Finding, 'id' | 'createdAt'>): string {
    const id = makeId();
    if (
      this.state.sources.length + this.state.findings.length + this.state.gaps.length >=
      this.budget.profile.maxStateEntries
    ) {
      return '';
    }
    this.budget.incrementStateEntries(1);
    this.state.findings.push({ ...finding, id, createdAt: nowISO() });
    return id;
  }

  getFindings(subQuestionId?: string): Finding[] {
    if (!subQuestionId) return [...this.state.findings];
    return this.state.findings.filter((f) =>
      f.subQuestionIds.includes(subQuestionId),
    );
  }

  getFinding(id: string): Finding | undefined {
    return this.state.findings.find((f) => f.id === id);
  }

  mergeFindings(keepId: string, absorbId: string): void {
    const keep = this.state.findings.find((f) => f.id === keepId);
    const absorb = this.state.findings.find((f) => f.id === absorbId);
    if (!keep || !absorb) return;
    keep.sourceIds = [...new Set([...keep.sourceIds, ...absorb.sourceIds])];
    keep.subQuestionIds = [
      ...new Set([...keep.subQuestionIds, ...absorb.subQuestionIds]),
    ];
    keep.lastUpdated = nowISO();
    this.state.findings = this.state.findings.filter((f) => f.id !== absorbId);
  }

  findingCount(): number {
    return this.state.findings.length;
  }

  // ── Contradictions ─────────────────────────────────────────────────────

  detectContradictions(): InternalContradiction[] {
    const newContradictions: InternalContradiction[] = [];
    const directionPairs: [string, string][] = [
      ['increase', 'decrease'],
      ['improve', 'reduce'],
      ['faster', 'slower'],
      ['better', 'worse'],
      ['more', 'less'],
      ['higher', 'lower'],
      ['grow', 'shrink'],
    ];
    const negateWords = new Set([
      'not', 'cannot', "doesn't", "don't", "isn't", "aren't", "won't",
    ]);

    for (const f1 of this.state.findings) {
      for (const f2 of this.state.findings) {
        if (f1.id >= f2.id) continue;
        const sharedSq = f1.subQuestionIds.some((id) =>
          f2.subQuestionIds.includes(id),
        );
        const topicSimilar =
          !sharedSq &&
          jaccardSimilarity(f1.normalizedClaim, f2.normalizedClaim) > 0.35;
        if (!sharedSq && !topicSimilar) continue;

        const f1Text = f1.claim.toLowerCase();
        const f2Text = f2.claim.toLowerCase();
        const f1Words = new Set(f1Text.split(/\s+/));
        const f2Words = new Set(f2Text.split(/\s+/));

        let contradictionType: InternalContradictionType | null = null;
        let explanation = '';

        // Negation check
        const f1Negates = [...negateWords].some((w) => f1Words.has(w));
        const f2Negates = [...negateWords].some((w) => f2Words.has(w));
        if (
          f1Negates !== f2Negates &&
          sharedSq &&
          jaccardSimilarity(f1.normalizedClaim, f2.normalizedClaim) > 0.3
        ) {
          contradictionType = 'factual_disagreement';
          explanation = 'One claim negates the other on shared topic';
        }

        // Directional check
        if (!contradictionType && topicSimilar) {
          for (const [dirA, dirB] of directionPairs) {
            const a1 = f1Text.includes(dirA) || f1Text.includes(dirB);
            const a2 = f2Text.includes(dirA) || f2Text.includes(dirB);
            if (
              a1 && a2 &&
              ((f1Text.includes(dirA) && f2Text.includes(dirB)) ||
                (f1Text.includes(dirB) && f2Text.includes(dirA)))
            ) {
              contradictionType = 'factual_disagreement';
              explanation = `Claims disagree on direction: "${dirA}" vs "${dirB}"`;
              break;
            }
          }
        }

        if (contradictionType) {
          const id = makeId();
          newContradictions.push({
            id,
            claimA: f1.claim,
            claimB: f2.claim,
            sourceIdsA: [...f1.sourceIds],
            sourceIdsB: [...f2.sourceIds],
            contradictionType,
            resolutionStatus: 'unresolved',
            ...(explanation ? { likelyExplanation: explanation } : {}),
          });
        }
      }
    }

    for (const c of newContradictions) {
      const exists = this.state.contradictions.some(
        (existing) =>
          existing.claimA === c.claimA && existing.claimB === c.claimB,
      );
      if (!exists) this.state.contradictions.push(c);
    }

    return this.state.contradictions;
  }

  addContradiction(c: InternalContradiction): void {
    this.state.contradictions.push(c);
  }

  setContradictions(contradictions: InternalContradiction[]): void {
    this.state.contradictions = contradictions;
  }

  resolveContradiction(
    id: string,
    status: InternalContradictionStatus,
    explanation?: string,
  ): void {
    const c = this.state.contradictions.find((c) => c.id === id);
    if (!c) return;
    c.resolutionStatus = status;
    if (explanation) c.likelyExplanation = explanation;
  }

  getUnresolvedContradictions(): InternalContradiction[] {
    return this.state.contradictions.filter(
      (c) => c.resolutionStatus === 'unresolved',
    );
  }

  contradictionCount(): number {
    return this.state.contradictions.length;
  }

  // ── Gaps ───────────────────────────────────────────────────────────────

  addGap(gap: GapRecord): string {
    if (
      this.state.sources.length + this.state.findings.length + this.state.gaps.length >=
      this.budget.profile.maxStateEntries
    ) {
      return '';
    }
    this.budget.incrementStateEntries(1);
    this.state.gaps.push(gap);
    return gap.id;
  }

  getOpenGaps(): GapRecord[] {
    return this.state.gaps.filter(
      (g) => g.status === 'open' || g.status === 'in_progress',
    );
  }

  updateGapStatus(id: string, status: GapStatus): void {
    const g = this.state.gaps.find((g) => g.id === id);
    if (g) g.status = status;
  }

  closeGap(id: string): void {
    this.updateGapStatus(id, 'resolved');
  }

  // ── Open questions ─────────────────────────────────────────────────────

  addOpenQuestion(question: string): void {
    this.state.openQuestions.push(question);
  }

  getOpenQuestions(): string[] {
    return [...this.state.openQuestions];
  }

  // ── Claim graph ────────────────────────────────────────────────────────

  addClaimEdge(edge: ClaimEdge): void {
    this.state.claimGraph.push(edge);
  }

  // ── Worker reports ─────────────────────────────────────────────────────

  addWorkerReport(report: WorkerReport): void {
    this.state.workerReports[report.id] = report;
  }

  workerReportCount(): number {
    return Object.keys(this.state.workerReports).length;
  }

  // ── Content quality ────────────────────────────────────────────────────

  setContentQuality(url: string, quality: ContentQualityAssessment): void {
    this.state.contentQuality[url] = quality;
  }

  // ── Coverage ───────────────────────────────────────────────────────────

  computeSubQuestionCoverage(): SubQuestionCoverage[] {
    const coverage: SubQuestionCoverage[] = [];
    for (const sq of this.state.subQuestions) {
      const sqSources = this.state.sources.filter((s) =>
        s.relevantSubQuestions.includes(sq.id),
      );
      const sqFindings = this.state.findings.filter((f) =>
        f.subQuestionIds.includes(sq.id),
      );
      const domains = new Set(sqSources.map((s) => s.domain));
      const contentDepths = sqSources
        .map((s) => this.state.contentQuality[s.url]?.contentDepth)
        .filter((d): d is number => d !== undefined);
      const avgDepth =
        contentDepths.length > 0
          ? contentDepths.reduce((a, b) => a + b, 0) / contentDepths.length
          : 0;
      const hasPromo = sqSources.some(
        (s) => this.state.contentQuality[s.url]?.isPromotional === true,
      );
      const sourceTypes = [...new Set(sqSources.map((s) => s.sourceType))];

      let status: SubQuestionCoverage['status'];
      if (sqFindings.length === 0 && sqSources.length === 0) {
        status = 'uncovered';
      } else if (sqSources.length < 2 || domains.size < 2) {
        status = 'thin';
      } else if (hasPromo || avgDepth < 0.4) {
        status = 'risky';
      } else {
        status = 'adequate';
      }

      coverage.push({
        subQuestionId: sq.id,
        subQuestionText: sq.text,
        sourceCount: sqSources.length,
        uniqueDomainCount: domains.size,
        findingCount: sqFindings.length,
        averageContentDepth: avgDepth,
        hasPromotionalSources: hasPromo,
        sourceTypes,
        status,
      });
    }
    this.state.subQuestionCoverage = coverage;
    return coverage;
  }

  getSubQuestionCoverage(): SubQuestionCoverage[] {
    return [...this.state.subQuestionCoverage];
  }

  isCoverageAdequate(): boolean {
    return (
      this.state.subQuestionCoverage.length > 0 &&
      this.state.subQuestionCoverage.every((c) => c.status === 'adequate')
    );
  }

  // ── Post-processing ────────────────────────────────────────────────────

  postProcessFindings(): { merged: number; contradictions: number } {
    if (this.state.findings.length === 0)
      return { merged: 0, contradictions: 0 };
    const merged = this.deduplicateFindings();
    const contradictionCount = this.detectContradictions().length;
    return { merged, contradictions: contradictionCount };
  }

  private deduplicateFindings(): number {
    const findings = this.state.findings;
    const toMerge: { keepId: string; absorbId: string }[] = [];
    const absorbed = new Set<string>();

    for (let i = 0; i < findings.length; i++) {
      const fi = findings[i];
      if (fi === undefined || absorbed.has(fi.id)) continue;
      for (let j = i + 1; j < findings.length; j++) {
        const fj = findings[j];
        if (fj === undefined || absorbed.has(fj.id)) continue;
        const sim = combinedSimilarity(fi.normalizedClaim, fj.normalizedClaim);
        const sharedSq = fi.subQuestionIds.some((id) =>
          fj.subQuestionIds.includes(id),
        );
        const sharedSource = fi.sourceIds.some((id) =>
          fj.sourceIds.includes(id),
        );
        if (sim >= 0.72 || (sim >= 0.56 && (sharedSq || sharedSource))) {
          toMerge.push({ keepId: fi.id, absorbId: fj.id });
          absorbed.add(fj.id);
        }
      }
    }

    for (const { keepId, absorbId } of toMerge) {
      this.mergeFindings(keepId, absorbId);
    }
    return toMerge.length;
  }

  // ── Serialization ──────────────────────────────────────────────────────

  toJSON(): ResearchState {
    return this.getState();
  }

  fromJSON(state: ResearchState): void {
    this.state = {
      query: state.query,
      taxonomy: state.taxonomy,
      subQuestions: state.subQuestions.map((sq) => ({ ...sq })),
      sources: state.sources.map((s) => ({ ...s })),
      findings: state.findings.map((f) => ({ ...f })),
      contradictions: state.contradictions.map((c) => ({ ...c })),
      openQuestions: [...state.openQuestions],
      gaps: state.gaps.map((g) => ({ ...g })),
      claimGraph: state.claimGraph.map((e) => ({ ...e })),
      currentPhase: state.currentPhase,
      budget: { ...state.budget },
      flags: { ...state.flags },
      gapTargets: [...state.gapTargets],
      allQuestions: [...state.allQuestions],
      resolvedGaps: state.resolvedGaps.map((g) => ({ ...g })),
      searchClusters: state.searchClusters.map((c) => ({ ...c })),
      diary: [...state.diary],
      searchAttempts: [...state.searchAttempts],
      workerReports: { ...state.workerReports },
      contentQuality: { ...state.contentQuality },
      subQuestionCoverage: state.subQuestionCoverage.map((c) => ({ ...c })),
      ...(state.language ? { language: { ...state.language } } : {}),
    };
    this.budget.restore(state.budget);
  }

  // ── Flags ──────────────────────────────────────────────────────────────

  isTaxonomyRevised(): boolean {
    return this.state.flags.taxonomyRevised;
  }

  markAudited(): void {
    this.state.flags.audited = true;
  }

  isAudited(): boolean {
    return this.state.flags.audited;
  }

  incrementLoop(): void {
    this.state.flags.loopCount++;
  }

  loopCount(): number {
    return this.state.flags.loopCount;
  }

  appendDiary(entry: string): void {
    this.state.diary.push(entry);
    if (this.state.diary.length > 50) {
      this.state.diary = this.state.diary.slice(-50);
    }
  }
}
