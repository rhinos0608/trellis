/**
 * Research synthesizer — transforms structured state into a narrative report.
 * Ported from search-mcp synthesizer.ts — produces markdown FROM structured claims,
 * not as the source of claims.
 */

import type {
  ResearchState,
  Finding,
  SourceEntry,
  InternalContradiction,
  ResearchReport,
} from './internalTypes.js';
import { buildFindingLinkage, clusterIdByFindingId } from './findingLinkage.js';
import { classifySourceAuthority } from './provenance.js';

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function decapitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export class ResearchSynthesizer {
  private state: ResearchState;

  constructor(state: ResearchState) {
    this.state = state;
  }

  synthesize(): ResearchReport {
    const linkage = buildFindingLinkage(this.state.findings);
    const clusterByFinding = clusterIdByFindingId(linkage.clusters);
    const findings = this.state.findings.map((finding) => {
      const clusterId = clusterByFinding.get(finding.id);
      return clusterId ? { ...finding, clusterId } : finding;
    });
    const sources = this.state.sources;
    const contradictions = this.state.contradictions;

    const RELEVANCE_THRESHOLD = 0.72;
    const admissibleFindings = findings.filter(
      (f) => f.relevanceScore === undefined || f.relevanceScore >= RELEVANCE_THRESHOLD,
    );

    const byType = new Map<string, number>();
    for (const s of sources) {
      byType.set(s.sourceType, (byType.get(s.sourceType) ?? 0) + 1);
    }
    const sourceDiversity = [...byType.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    const degradationMode: ResearchReport['degradationMode'] =
      admissibleFindings.length === 0 ? 'source_note_synthesis' : 'deep';

    const curated = this.curateEvidenceSources(sources, findings);
    const evidenceSources = curated.map((c, i) => ({
      index: i + 1,
      title: c.title,
      url: c.url,
      sourceType: c.sourceType,
      ...(c.authorityClass ? { authorityClass: c.authorityClass } : {}),
      tier: c.tier,
      domain: c.domain,
    }));

    const report: ResearchReport = {
      query: this.state.query,
      classification: this.inferClassification(),
      depth: this.inferDepth(),
      degradationMode,
      executiveSummary: this.buildExecutiveSummary(admissibleFindings),
      narrativeMarkdown: this.buildNarrativeMarkdown(
        admissibleFindings,
        this.state.subQuestions,
        sources,
        contradictions,
      ),
      themes: this.buildThemes(admissibleFindings, this.state.subQuestions),
      contradictions,
      uncertainties: this.buildUncertainties(contradictions),
      sourceNotes: this.buildSourceNotes(sources, byType),
      openQuestions: this.state.openQuestions,
      limitations: this.buildLimitations(sources, byType, degradationMode),
      sourceCount: sources.length,
      sourceTypeCount: byType.size,
      sourceDiversity,
      findingCount: findings.length,
      evidenceSources,
      findingClusters: linkage.clusters,
      findingClusterEdges: linkage.edges,
    };

    return report;
  }

  // ── Evidence source curation (simplified) ──────────────────────────────

  private curateEvidenceSources(
    sources: SourceEntry[],
    _findings: Finding[],
  ): (SourceEntry & { tier: string; authorityClass?: string })[] {
    return sources
      .filter(
        (s) =>
          s.usageStatus !== 'discarded' &&
          s.usageStatus !== 'failed' &&
          s.extractionStatus !== 'failed',
      )
      .map((s) => {
        const authority = classifySourceAuthority(s);
        const tier =
          authority === 'official_spec' || authority === 'official_changelog'
            ? 'primary'
            : authority === 'official_repo' || authority === 'package_registry'
              ? 'secondary'
              : 'tertiary';
        return { ...s, tier, authorityClass: authority };
      })
      .sort((a, b) => {
        const tierOrder = { primary: 0, secondary: 1, tertiary: 2 };
        const diff =
          tierOrder[a.tier as keyof typeof tierOrder] - tierOrder[b.tier as keyof typeof tierOrder];
        if (diff !== 0) return diff;
        return (b.qualityScore ?? 0) - (a.qualityScore ?? 0);
      });
  }

  // ── Internal builders ──────────────────────────────────────────────────

  private inferClassification(): ResearchReport['classification'] {
    const counts: Record<string, number> = {};
    for (const sq of this.state.subQuestions) {
      counts[sq.classification] = (counts[sq.classification] ?? 0) + 1;
    }
    let maxCount = 0;
    let best: ResearchReport['classification'] = 'explainer';
    for (const [key, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        best = key as ResearchReport['classification'];
      }
    }
    return best;
  }

  private inferDepth(): ResearchReport['depth'] {
    const srcCount = this.state.sources.length;
    if (srcCount <= 10) return 'quick';
    if (srcCount <= 25) return 'standard';
    if (srcCount <= 60) return 'deep';
    return 'exhaustive';
  }

  private buildExecutiveSummary(findings: Finding[]): string {
    if (findings.length === 0) {
      return '[Source-note synthesis only] No findings extracted during this research run.';
    }
    const sqIdsWithFindings = new Set<string>();
    for (const f of findings) {
      for (const sqId of f.subQuestionIds) sqIdsWithFindings.add(sqId);
    }
    const coveredCount = sqIdsWithFindings.size;
    const totalSQs = this.state.subQuestions.length;
    const unresolved = this.state.contradictions.filter(
      (c) => c.resolutionStatus !== 'resolved',
    );

    const parts: string[] = [];
    parts.push(
      `This research found ${String(findings.length)} claims covering ${String(coveredCount)} of ${String(totalSQs)} research questions.`,
    );
    if (unresolved.length > 0) {
      parts.push(
        `${String(unresolved.length)} unresolved ${unresolved.length === 1 ? 'contradiction was' : 'contradictions were'} identified between sources.`,
      );
    }
    return parts.join(' ');
  }

  private buildThemes(
    findings: Finding[],
    subQuestions: ResearchState['subQuestions'],
  ): { title: string; narrative: string }[] {
    const themeMap = new Map<
      string,
      { title: string; claims: string[]; sourceIds: string[] }
    >();

    for (const sq of subQuestions) {
      const sqFindings = findings.filter((f) =>
        f.subQuestionIds.includes(sq.id),
      );
      if (sqFindings.length === 0) continue;
      themeMap.set(sq.id, {
        title: sq.text,
        claims: sqFindings.map((f) => f.claim),
        sourceIds: [...new Set(sqFindings.flatMap((f) => f.sourceIds))],
      });
    }

    const orphanFindings = findings.filter(
      (f) =>
        !f.subQuestionIds.some((id) =>
          subQuestions.some((sq) => sq.id === id),
        ),
    );
    if (orphanFindings.length > 0) {
      themeMap.set('orphan', {
        title: 'Additional Findings',
        claims: orphanFindings.map((f) => f.claim),
        sourceIds: [
          ...new Set(orphanFindings.flatMap((f) => f.sourceIds)),
        ],
      });
    }

    return Array.from(themeMap.values()).map((t) => ({
      title: t.title,
      narrative: this.buildThemeNarrative(t.claims),
    }));
  }

  private buildThemeNarrative(claims: string[]): string {
    if (claims.length === 0) return 'No findings available for this theme.';
    const parts: string[] = [];
    if (claims[0]) parts.push(claims[0] + '.');
    for (let i = 1; i < Math.min(claims.length, 5); i++) {
      const claim = claims[i];
      if (claim) parts.push('Sources indicate ' + claim.toLowerCase() + '.');
    }
    return parts.join(' ');
  }

  private buildUncertainties(contradictions: InternalContradiction[]): string[] {
    const uncertainties: string[] = [];
    const unresolved = contradictions.filter(
      (c) => c.resolutionStatus !== 'resolved',
    );
    for (const c of unresolved.slice(0, 3)) {
      uncertainties.push(
        `Sources disagree: "${c.claimA}" vs "${c.claimB}".${c.likelyExplanation ? ` Possible explanation: ${c.likelyExplanation}` : ''}`,
      );
    }
    return uncertainties;
  }

  private buildSourceNotes(
    sources: SourceEntry[],
    byType: Map<string, number>,
  ): string[] {
    if (sources.length === 0) return ['No sources were analyzed.'];
    const notes: string[] = [];
    const breakdown = Array.from(byType.entries())
      .map(([t, c]) => `${String(c)} ${t}`)
      .join(', ');
    notes.push(
      `Analysis based on ${String(sources.length)} sources across ${String(byType.size)} types (${breakdown}).`,
    );
    const primaryCount = sources.filter((s) => s.isPrimary).length;
    if (primaryCount > 0) {
      notes.push(
        `${String(primaryCount)} primary sources were included.`,
      );
    }
    return notes;
  }

  private buildLimitations(
    _sources: SourceEntry[],
    byType: Map<string, number>,
    degradationMode?: ResearchReport['degradationMode'],
  ): string[] {
    const limitations: string[] = [];
    if (degradationMode === 'source_note_synthesis') {
      limitations.push(
        'This report is based on source-note synthesis only — no structured findings were extracted.',
      );
    }
    if (byType.size <= 2) {
      limitations.push(
        `Source diversity is limited — only ${String(byType.size)} source type(s) found.`,
      );
    }
    return limitations;
  }

  private buildNarrativeMarkdown(
    findings: Finding[],
    subQuestions: ResearchState['subQuestions'],
    sources: SourceEntry[],
    contradictions: InternalContradiction[],
  ): string {
    const parts: string[] = [];
    parts.push(`# Research Report: ${this.state.query}\n`);
    parts.push(`## Executive Summary\n${this.buildExecutiveSummary(findings)}\n`);

    const sourceIndex = this.buildSourceIndex(findings, sources);

    for (const sq of subQuestions) {
      const sqFindings = findings.filter((f) =>
        f.subQuestionIds.includes(sq.id),
      );
      parts.push(`## ${sq.text}\n`);
      if (sqFindings.length === 0) {
        parts.push('*No findings discovered for this sub-question.*\n');
        continue;
      }
      const sentences: string[] = [];
      for (let i = 0; i < Math.min(sqFindings.length, 6); i++) {
        const f = sqFindings[i];
        if (!f) continue;
        const refs = this.formatSourceRefs(f.sourceIds, sourceIndex);
        const prefix = i === 0 ? '' : i % 2 === 0 ? 'Additionally, ' : 'Sources indicate that ';
        sentences.push(
          `${prefix}${i === 0 ? capitalize(f.claim) : decapitalize(f.claim)}${refs ? ' ' + refs : ''}.`,
        );
      }
      parts.push(sentences.join(' '));
      parts.push('');
    }

    if (contradictions.length > 0) {
      parts.push('## Contradictions & Debates\n');
      for (const c of contradictions) {
        parts.push(`- **${c.claimA}** vs **${c.claimB}**`);
        if (c.likelyExplanation) parts.push(`  - ${c.likelyExplanation}`);
        parts.push(`  - Status: ${c.resolutionStatus}\n`);
      }
    }

    const usedSources = sources.filter(
      (s) => s.usageStatus !== 'discarded' && s.usageStatus !== 'failed',
    );
    parts.push('## Sources\n');
    for (const [i, s] of usedSources.entries()) {
      parts.push(
        `${String(i + 1)}. [${s.title}](${s.url}) (${s.sourceType}, domain: ${s.domain})\n`,
      );
    }

    return parts.join('\n');
  }

  private buildSourceIndex(
    findings: Finding[],
    sources: SourceEntry[],
  ): Map<string, number> {
    const backedSourceIds = new Set<string>();
    for (const f of findings) {
      for (const sid of f.sourceIds) backedSourceIds.add(sid);
    }
    const index = new Map<string, number>();
    let displayIdx = 0;
    for (const s of sources) {
      if (backedSourceIds.has(s.id) || findings.length === 0) {
        displayIdx++;
        index.set(s.id, displayIdx);
      }
    }
    return index;
  }

  private formatSourceRefs(
    sourceIds: string[],
    sourceIndex: Map<string, number>,
  ): string {
    const refs = sourceIds
      .map((sid) => sourceIndex.get(sid))
      .filter((n): n is number => n !== undefined)
      .map((n) => `[Source ${String(n)}]`)
      .join(', ');
    return refs ? `(${refs})` : '';
  }
}
