/**
 * Pipeline strategy — fixed 7-phase research pipeline: decompose → discover →
 * extract → gap → audit → synthesize. Works with or without LLM.
 *
 * Ported from search-mcp pipelineStrategy.ts — all acquisition routes through
 * ResearchProvider, structured output produced directly.
 */

import { randomUUID } from 'node:crypto';
import { logger, safeErrorLog } from '../../logger.js';
import { providerCallContext, type ResearchStrategy, type StrategyContext } from './types.js';
import type { ResearchResult, SubQuestion, SourceEntry } from '../internalTypes.js';
import type { SourceType } from '../../graph/types.js';
import { validateFetchableUrl } from '../../providers/searchMcp/urlPolicy.js';
import { GapAnalyzer, GapFiller, planGapAcquisitions } from '../gapAnalysis.js';
import { PruningEngine } from '../pruning.js';
import { extractClaimsFromSource } from '../claimExtraction.js';
import { ResearchSynthesizer } from '../synthesizer.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeId(): string {
  return randomUUID().slice(0, 12);
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Simple rule-based query decomposition — splits the query into sub-questions.
 * In production this would use the LLM, but this keeps the pipeline functional
 * without requiring an LLM.
 */
function decomposeQuery(query: string): SubQuestion[] {
  // Generate sub-questions based on common research dimensions
  const dimensions = [
    'What are the key facts and definitions?',
    'What are the main advantages and benefits?',
    'What are the limitations or drawbacks?',
    'How does it compare to alternatives?',
    'What is the current state and recent developments?',
  ];

  return dimensions.map((text, i) => ({
    id: makeId(),
    text: `${query} — ${text}`,
    classification: 'explainer',
    evidenceType: 'general',
    preferredSources: [],
    freshnessRequirement: 'any',
    failureModes: [],
    budgetPriority: i < 3 ? 1 : 2,
    status: 'pending' as const,
  }));
}

// ── PipelineStrategy ───────────────────────────────────────────────────────

export class PipelineStrategy implements ResearchStrategy {
  readonly name = 'pipeline';
  readonly description =
    'Fixed pipeline: decompose → discover → extract → gap → synthesize. Works with or without LLM.';
  readonly requiresLlm = false;

  private pruning = new PruningEngine();
  private progress: { phase: string; percent?: number; message?: string }[] = [];

  async analyze(query: string, ctx: StrategyContext): Promise<ResearchResult> {
    const startTime = Date.now();
    this.progress = [];
    ctx.state.initialize(query, ctx.budget);

    logger.info({ query, depth: ctx.depth }, 'Pipeline research started');
    await this.reportProgress(ctx, 0, 'Starting research', 'initializing');

    try {
      // Phase 1: Decomposition
      const subQuestions = decomposeQuery(query);
      ctx.state.setSubQuestions(subQuestions);
      ctx.state.transitionTo('decomposition');
      await this.reportProgress(
        ctx,
        10,
        `Decomposed into ${String(subQuestions.length)} sub-questions`,
        'decomposition',
      );

      if (ctx.budget.isExhausted()) {
        return this.synthesizePartial(ctx, startTime);
      }

      // Phase 2: Discovery — use ResearchProvider
      ctx.state.transitionTo('discovery');
      await this.discoverSources(query, subQuestions, ctx);
      await this.reportProgress(
        ctx,
        30,
        `Discovered ${String(ctx.state.sourceCount())} sources`,
        'discovery',
      );

      if (ctx.budget.isExhausted()) {
        return this.synthesizePartial(ctx, startTime);
      }

      // Phase 3: Extraction — use ResearchProvider.read on discovered sources
      ctx.state.transitionTo('extraction');
      await this.extractFindings(subQuestions, ctx);
      await this.reportProgress(
        ctx,
        50,
        `Extracted ${String(ctx.state.findingCount())} findings`,
        'extraction',
      );

      // Phase 4: Gap analysis — iterative acquisition loop
      ctx.state.transitionTo('gap_analysis');
      const gapAnalyzer = new GapAnalyzer(ctx.state);
      const gapFiller = new GapFiller(ctx.state, ctx.budget);

      while (gapFiller.shouldContinueLoop()) {
        const coverage = ctx.state.computeSubQuestionCoverage();
        const gaps = gapAnalyzer.analyze(coverage);

        // Record gaps into state (gap tracking)
        await gapFiller.fillGaps(gaps);

        // Plan acquisitions from detected gaps
        const acquisitions = planGapAcquisitions(gaps, ctx.state, ctx.provider.capabilities);
        if (acquisitions.length === 0) break;

        // Execute top acquisitions (max 3 per round to bound cost)
        const toExecute = acquisitions.slice(0, 3);
        let acquired = 0;

        for (const ac of toExecute) {
          if (ctx.budget.isExhausted()) break;
          if (ctx.abortSignal?.aborted) break;

          try {
            ctx.budget.recordToolCall();
            let hits: Awaited<ReturnType<typeof ctx.provider.search>> = [];

            const searchOpts = ac.searchOpts
              ? Object.fromEntries(
                  Object.entries(ac.searchOpts).filter(([, v]) => v !== undefined),
                )
              : {};

            if (ac.method === 'academic' && ctx.provider.capabilities.academic) {
              hits = await ctx.provider.academic(
                providerCallContext(ctx, { phase: 'gap_acquisition' }),
                ac.query,
                searchOpts as import('../../providers/types.js').AcademicOpts,
              );
            } else if (ac.method === 'reddit' && ctx.provider.capabilities.community?.reddit && ctx.provider.reddit) {
              hits = await ctx.provider.reddit(
                providerCallContext(ctx, { phase: 'gap_acquisition' }),
                ac.query,
                searchOpts as import('../../providers/types.js').SearchOpts,
              );
            } else if (ac.method === 'hackernews' && ctx.provider.capabilities.community?.hackernews && ctx.provider.hackernews) {
              hits = await ctx.provider.hackernews(
                providerCallContext(ctx, { phase: 'gap_acquisition' }),
                ac.query,
                searchOpts as import('../../providers/types.js').SearchOpts,
              );
            } else if (ac.method === 'github' && ctx.provider.capabilities.code) {
              hits = await ctx.provider.search(
                providerCallContext(ctx, { phase: 'gap_acquisition' }),
                ac.query + ' site:github.com',
                searchOpts as import('../../providers/types.js').SearchOpts,
              );
            } else if (ac.method === 'stackoverflow' && ctx.provider.capabilities.community?.stackoverflow) {
              hits = await ctx.provider.search(
                providerCallContext(ctx, { phase: 'gap_acquisition' }),
                ac.query + ' site:stackoverflow.com',
                searchOpts as import('../../providers/types.js').SearchOpts,
              );
            } else if (ac.method === 'search') {
              hits = await ctx.provider.search(
                providerCallContext(ctx, { phase: 'gap_acquisition' }),
                ac.query,
                searchOpts as import('../../providers/types.js').SearchOpts,
              );
            }

            const limit = ac.searchOpts?.limit ?? 10;
            for (const hit of hits.slice(0, limit)) {
              if (ctx.budget.isExhausted()) break;

              const domain = (() => {
                try {
                  return new URL(hit.url).hostname.replace(/^www\./, '');
                } catch {
                  return hit.url;
                }
              })();

              const sourceType: SourceType = ac.method === 'search' ? 'web' : (ac.method as SourceType);
              const sourceEntry: SourceEntry = {
                id: makeId(),
                title: hit.title,
                url: hit.url,
                sourceType,
                domain,
                accessDate: nowISO(),
                ...(('publishedAt' in hit && (hit as { publishedAt?: string }).publishedAt !== undefined) ? { publishedDate: (hit as { publishedAt: string }).publishedAt } : {}),
                isPrimary: ac.method === 'academic',
                relevantSubQuestions: ac.targetSubQuestionIds,
                extractionStatus: 'pending',
                subQuestionId: '',
              };

              const addedId = ctx.state.addSource(sourceEntry);
              if (addedId === '') break;
              acquired++;
            }
          } catch {
            // non-fatal, continue
          }
        }

        if (acquired === 0) break; // zero-yield round → stop (prevents spin)

        ctx.state.incrementLoop();
      }

      // Extract findings from gap-acquired sources
      await this.extractFindings(subQuestions, ctx);

      await this.reportProgress(ctx, 65, 'Gap analysis complete', 'gap_analysis');

      // Phase 5: Post-processing — dedup + contradiction detection
      ctx.state.transitionTo('post_processing');
      const postResult = ctx.state.postProcessFindings();
      logger.info(
        { merged: postResult.merged, contradictions: postResult.contradictions },
        'Post-processing complete',
      );

      // Phase 6: Audit
      ctx.state.transitionTo('audit');
      ctx.state.markAudited();
      await this.reportProgress(ctx, 75, 'Audit complete', 'audit');

      // Phase 7: Synthesis
      ctx.state.transitionTo('synthesis');
      const result = this.synthesizeResults(ctx, startTime);

      // Final pruning
      try {
        this.pruning.enforceStateGuard(ctx.state, ctx.budget);
      } catch (e) {
        logger.warn({ ...safeErrorLog(e) }, 'Final pruning failed');
      }

      return result;
    } catch (err) {
      logger.error({ ...safeErrorLog(err) }, 'Pipeline research failed');
      ctx.state.transitionTo('complete');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.progress = [];
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  private async discoverSources(
    query: string,
    subQuestions: SubQuestion[],
    ctx: StrategyContext,
  ): Promise<void> {
    const queries = [
      query,
      ...subQuestions.slice(0, 4).map((sq) => sq.text),
    ];

    for (const q of queries) {
      if (ctx.budget.isExhausted()) break;
      if (ctx.abortSignal?.aborted) break;

      try {
        // One logical call per search, regardless of hit count (failures included).
        ctx.budget.recordToolCall();
        const hits = await ctx.provider.search(providerCallContext(ctx, { phase: 'discovery' }), q, { limit: 10 });
        for (const hit of hits) {
          if (ctx.budget.isExhausted()) break;

          const domain = (() => {
            try {
              return new URL(hit.url).hostname.replace(/^www\./, '');
            } catch {
              return hit.url;
            }
          })();

          const sourceEntry: SourceEntry = {
            id: makeId(),
            title: hit.title,
            url: hit.url,
            sourceType: 'web',
            domain,
            accessDate: nowISO(),
            ...(hit.publishedAt !== undefined ? { publishedDate: hit.publishedAt } : {}),
            isPrimary: false,
            relevantSubQuestions: subQuestions
              .filter((sq) => q.includes(sq.text.slice(0, 20)))
              .map((sq) => sq.id),
            extractionStatus: 'pending',
            subQuestionId: '',
          };

          const addedId = ctx.state.addSource(sourceEntry);
          if (addedId === '') break; // capacity reached
        }
      } catch (err) {
        logger.warn({ ...safeErrorLog(err), query: q }, 'Search failed');
      }

      // Also try academic search if available
      if (ctx.provider.capabilities.academic) {
        try {
          // One logical call per academic search, regardless of hit count.
          ctx.budget.recordToolCall();
          const academicHits = await ctx.provider.academic(providerCallContext(ctx, { phase: 'discovery' }), q, { limit: 5 });
          for (const hit of academicHits) {
            if (ctx.budget.isExhausted()) break;

            const domain = (() => {
              try {
                return new URL(hit.url).hostname.replace(/^www\./, '');
              } catch {
                return hit.url;
              }
            })();

            const sourceEntry: SourceEntry = {
              id: makeId(),
              title: hit.title,
              url: hit.url,
              sourceType: 'academic',
              domain,
              accessDate: nowISO(),
              ...(hit.publishedAt !== undefined ? { publishedDate: hit.publishedAt } : {}),
              isPrimary: true,
              relevantSubQuestions: [],
              extractionStatus: 'pending',
              subQuestionId: '',
            };
            ctx.state.addSource(sourceEntry);
          }
        } catch {
          // academic search unavailable
        }
      }
    }
  }

  // ── Extraction ─────────────────────────────────────────────────────────

  private async extractFindings(
    _subQuestions: SubQuestion[],
    ctx: StrategyContext,
  ): Promise<void> {
    const pendingSources = ctx.state
      .getSources()
      .filter((s) => s.extractionStatus === 'pending');

    for (const source of pendingSources) {
      if (ctx.budget.isExhausted()) break;
      if (ctx.abortSignal?.aborted) break;
      if (!ctx.budget.recordExtraction()) break;

      try {
        // Validate URL before sending to provider — skip unsafe URLs
        try {
          validateFetchableUrl(source.url);
        } catch (err) {
          logger.debug({ ...safeErrorLog(err), sourceId: source.id, urlBytes: Buffer.byteLength(source.url, 'utf8') }, 'Skipping URL that failed validation');
          ctx.state.markSourceFailed(source.id);
          continue;
        }
        // Count the read even if it fails — it consumed a call slot.
        ctx.budget.recordToolCall();
        const result = await ctx.provider.read(providerCallContext(ctx, { phase: 'extraction' }), source.url);
        ctx.state.markSourceExtracted(source.id);

        // Run structured claim extraction
        const extractionResult = await extractClaimsFromSource(
          {
            source: {
              id: source.id,
              title: source.title,
              url: source.url,
              sourceType: source.sourceType,
              isPrimary: source.isPrimary,
              ...(source.publishedDate !== undefined ? { publishedDate: source.publishedDate } : {}),
              relevantSubQuestions: source.relevantSubQuestions,
            },
            query: ctx.state.getState().query,
            subQuestions: ctx.state.getSubQuestions(),
            content: result.content,
            contentHash: result.contentHash ?? '',
          },
          { ...(ctx.llm !== undefined ? { llm: ctx.llm } : {}), budget: ctx.budget, ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}) },
        );

        // Add grounded findings to state
        for (const f of extractionResult.findings) {
          ctx.state.addFinding(f);
        }

        // Mark extraction status
        if (extractionResult.status === 'extracted') {
          ctx.state.markSourceExtracted(source.id);
        } else if (extractionResult.status === 'failed') {
          ctx.state.markSourceFailed(source.id);
        } else if (extractionResult.status === 'unavailable') {
          // No LLM — zero factual claims is correct behavior
          ctx.state.markSourceExtracted(source.id);
        }
      } catch (err) {
        logger.warn({ ...safeErrorLog(err), sourceId: source.id, urlBytes: Buffer.byteLength(source.url, 'utf8') }, 'Extraction failed');
        ctx.state.markSourceFailed(source.id);
      }
    }
  }

  // ── Synthesis ──────────────────────────────────────────────────────────

  private synthesizeResults(
    ctx: StrategyContext,
    startTime: number,
  ): ResearchResult {
    const state = ctx.state.getState();
    const report = new ResearchSynthesizer(state).synthesize();

    ctx.state.transitionTo('complete');
    const elapsed = Date.now() - startTime;
    logger.info(
      { elapsedMs: elapsed, findings: report.findingCount },
      'Pipeline research complete',
    );

    return {
      report,
      timeline: this.progress,
      canonicalFindings: [...state.findings],
    };
  }

  private synthesizePartial(
    ctx: StrategyContext,
    startTime: number,
  ): ResearchResult {
    logger.warn('Budget exhausted, synthesizing partial results');
    return this.synthesizeResults(ctx, startTime);
  }

  private async reportProgress(
    ctx: StrategyContext,
    progress: number,
    message?: string,
    phase?: string,
  ): Promise<void> {
    const clamped = Math.max(0, Math.min(100, progress));
    const entry: { phase: string; percent?: number; message?: string } = { phase: phase ?? 'unknown' };
    if (clamped > 0) entry.percent = clamped;
    if (message !== undefined) entry.message = message;
    this.progress.push(entry);
    try {
      await ctx.reportProgress({
        phase: phase ?? 'unknown',
        ...(clamped > 0 ? { percent: clamped } : {}),
        ...(message !== undefined ? { message } : {}),
        counts: {
          sourcesDiscovered: ctx.state.sourceCount(),
          findings: ctx.state.findingCount(),
          subquestionsTotal: ctx.state.getSubQuestions().length,
        },
      });
    } catch {
      // non-fatal
    }
  }
}
