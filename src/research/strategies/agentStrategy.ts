/**
 * Agent strategy — LLM-driven ReAct agent for deep research.
 * Simplified from search-mcp agentStrategy.ts — routes through ResearchProvider.
 *
 * Enhancements over the basic ReAct loop:
 * 1. Pre-loop LLM-generated research plan (persisted as event)
 * 2. Prior-knowledge awareness from durable state
 * 3. Periodic gap analysis injected into context
 * 4. Output parity with pipeline strategy (postProcess + audit + synthesize)
 * 5. Gap-driven stop condition (no actionable gaps + idle LLM)
 * 6. STORM-style moderator gap-finding (runs once after main loop)
 */

import { logger, safeErrorLog } from '../../logger.js';
import { providerCallContext, type ResearchStrategy, type StrategyContext, type ResearchPlan } from './types.js';
import type { ResearchResult } from '../internalTypes.js';
import { validateFetchableUrl } from '../../providers/searchMcp/urlPolicy.js';
import { extractClaimsFromSource } from '../claimExtraction.js';
import { GapAnalyzer } from '../gapAnalysis.js';
import { ResearchSynthesizer } from '../synthesizer.js';
import { parseJsonFromText } from '../llm/client.js';
import { randomUUID } from 'node:crypto';

// ── Agent response parsing ────────────────────────────────────────────────

interface ParsedResponse {
  type: 'action' | 'answer' | 'error';
  thought: string;
  tool?: string;
  args?: Record<string, unknown>;
  content?: string;
  message?: string;
  raw?: string;
}

function parseAgentResponse(text: string): ParsedResponse {
  const thoughtMatch =
    /THOUGHT:\s*([\s\S]*?)(?=\n?\s*(?:ACTION|ANSWER):|$)/i.exec(text);
  const actionMatch = /ACTION:\s*(\S+)/i.exec(text);
  const argsMatch = /ARGUMENTS:\s*([\s\S]*?)(?=\n(?:THOUGHT|ACTION|ANSWER):|$)/i.exec(
    text,
  );
  const answerMatch = /ANSWER:\s*([\s\S]*)/i.exec(text);

  if (answerMatch) {
    return {
      type: 'answer',
      content: (answerMatch[1] ?? '').trim(),
      thought: thoughtMatch?.[1]?.trim() ?? '',
      raw: text,
    };
  }

  if (actionMatch) {
    const argsText = argsMatch?.[1]?.trim() ?? '';
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsText) as Record<string, unknown>;
    } catch {
      args = { _rawArgs: argsText };
    }
    return {
      type: 'action',
      thought: thoughtMatch?.[1]?.trim() ?? '',
      tool: (actionMatch[1] ?? '').trim(),
      args,
      raw: text,
    };
  }

  return {
    type: 'error',
    message: 'Could not parse response',
    thought: thoughtMatch?.[1]?.trim() ?? '',
    content: text,
    raw: text,
  };
}

// ── Agent tools ───────────────────────────────────────────────────────────

interface AgentTool {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<{ content: string; error?: string }>;
}

function buildAgentTools(ctx: StrategyContext): AgentTool[] {
  const tools: AgentTool[] = [];

  // Search tool
  tools.push({
    name: 'search_web',
    description: 'Search the web for information. Args: { query: string }',
    execute: async (args) => {
      const q = args.query;
      if (typeof q !== 'string') return { content: 'query must be a string', error: 'invalid_args' };
      const hits = await ctx.provider.search(providerCallContext(ctx, { phase: 'agent_search' }), q, { limit: 10 });
      ctx.budget.recordToolCall();
      return {
        content: hits
          .map((h, i) => `[${String(i + 1)}] ${h.title} — ${h.url}\n${h.snippet ?? ''}`)
          .join('\n\n'),
      };
    },
  });

  // Read tool
  tools.push({
    name: 'web_read',
    description: 'Read a URL and extract its content. Args: { url: string }',
    execute: async (args) => {
      const url = args.url;
      if (typeof url !== 'string') return { content: 'url must be a string', error: 'invalid_args' };
      // Validate URL before sending to provider — reject unsafe URLs
      try {
        validateFetchableUrl(url);
      } catch (err) {
        ctx.budget.recordToolCall();
        logger.debug({ ...safeErrorLog(err), urlBytes: Buffer.byteLength(url, 'utf8') }, 'Agent rejected unsafe URL');
        return { content: `URL rejected: ${err instanceof Error ? err.message : 'validation failed'}`, error: 'invalid_url' };
      }

      let result: { url: string; title?: string; content: string; contentHash?: string };
      try {
        result = await ctx.provider.read(providerCallContext(ctx, { phase: 'agent_read' }), url);
      } catch (err) {
        ctx.budget.recordToolCall();
        return { content: `Read failed: ${err instanceof Error ? err.message : String(err)}`, error: 'read_error' };
      }
      ctx.budget.recordToolCall();

      // Find-or-create SourceEntry
      const domain = (() => {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
      })();
      const existingSource = ctx.state.getSources().find((s) => s.url === url);
      const sourceId = existingSource?.id ?? ctx.state.addSource({
        id: `src_${randomUUID().slice(0, 12)}`,
        title: result.title ?? url,
        url,
        sourceType: 'web',
        domain,
        accessDate: new Date().toISOString(),
        isPrimary: false,
        relevantSubQuestions: [],
        extractionStatus: 'pending',
        subQuestionId: '',
        ...(result.contentHash !== undefined ? { contentHash: result.contentHash } : {}),
      });
      if (!sourceId) return { content: result.content.slice(0, 8000) };

      // Run structured claim extraction on full content
      const extractionResult = await extractClaimsFromSource(
        {
          source: {
            id: sourceId,
            title: result.title ?? url,
            url,
            sourceType: 'web',
            isPrimary: false,
            relevantSubQuestions: [],
          },
          query: ctx.state.getState().query,
          subQuestions: ctx.state.getSubQuestions(),
          content: result.content,
          contentHash: result.contentHash ?? '',
        },
        { ...(ctx.llm !== undefined ? { llm: ctx.llm } : {}), budget: ctx.budget, ...(ctx.abortSignal !== undefined ? { signal: ctx.abortSignal } : {}) },
      );

      for (const f of extractionResult.findings) ctx.state.addFinding(f);
      if (extractionResult.status === 'extracted' || extractionResult.status === 'unavailable') {
        ctx.state.markSourceExtracted(sourceId);
      } else {
        ctx.state.markSourceFailed(sourceId);
      }

      return { content: result.content.slice(0, 8000) + `\n[Extracted ${String(extractionResult.findings.length)} grounded claims]` };
    },
  });

  // Academic search
  if (ctx.provider.capabilities.academic) {
    tools.push({
      name: 'search_academic',
      description: 'Search academic sources. Args: { query: string }',
      execute: async (args) => {
        const q = args.query;
        if (typeof q !== 'string') return { content: 'query must be a string', error: 'invalid_args' };
        const hits = await ctx.provider.academic(providerCallContext(ctx, { phase: 'agent_academic' }), q, { limit: 5 });
        ctx.budget.recordToolCall();
        return {
          content: hits
            .map((h, i) => `[${String(i + 1)}] ${h.title} — ${h.url}`)
            .join('\n'),
        };
      },
    });
  }

  // Community search (Reddit/HN)
  if (ctx.provider.capabilities.community.reddit && ctx.provider.reddit) {
    const redditSearch = ctx.provider.reddit.bind(ctx.provider);
    tools.push({
      name: 'search_reddit',
      description: 'Search Reddit. Args: { query: string }',
      execute: async (args) => {
        const q = args.query;
        if (typeof q !== 'string') return { content: 'query must be a string', error: 'invalid_args' };
        const hits = await redditSearch(providerCallContext(ctx, { phase: 'agent_reddit' }), q, { limit: 5 });
        ctx.budget.recordToolCall();
        return {
          content: hits
            .map((h, i) => `[${String(i + 1)}] ${h.title} — ${h.url} (score: ${String(h.score)})`)
            .join('\n'),
        };
      },
    });
  }

  if (ctx.provider.capabilities.community.hackernews && ctx.provider.hackernews) {
    const hackernewsSearch = ctx.provider.hackernews.bind(ctx.provider);
    tools.push({
      name: 'search_hackernews',
      description: 'Search Hacker News. Args: { query: string }',
      execute: async (args) => {
        const q = args.query;
        if (typeof q !== 'string') return { content: 'query must be a string', error: 'invalid_args' };
        const hits = await hackernewsSearch(providerCallContext(ctx, { phase: 'agent_hackernews' }), q, { limit: 5 });
        ctx.budget.recordToolCall();
        return {
          content: hits.map((h, i) => `[${String(i + 1)}] ${h.title} — ${h.url}`).join('\n'),
        };
      },
    });
  }

  return tools;
}

function describeTools(tools: AgentTool[]): string {
  return tools.map((t) => `  ${t.name}: ${t.description}`).join('\n');
}

// ── AgentStrategy ─────────────────────────────────────────────────────────

export class AgentStrategy implements ResearchStrategy {
  readonly name = 'agent';
  readonly description = 'LLM-driven ReAct agent with tool-calling.';
  readonly requiresLlm = true;

  private maxIterations: number;
  private tools: AgentTool[] = [];
  private history: {
    role: 'assistant' | 'tool' | 'system';
    thought?: string;
    action?: string;
    args?: Record<string, unknown>;
    tool?: string;
    content?: string;
    error?: string;
  }[] = [];

  constructor(ctx: StrategyContext) {
    // LLM availability is enforced upstream (startRun precondition + ctx.llm);
    // no API-key gate here — local OpenAI-compatible servers run without auth.
    this.maxIterations = 30;
    this.tools = buildAgentTools(ctx);
  }

  async analyze(query: string, ctx: StrategyContext): Promise<ResearchResult> {
    if (!ctx.llm) {
      logger.info('No LLM available, agent strategy produces empty result');
      return this.emptyResult(query, ctx.depth);
    }

    logger.info({ query }, 'Agent strategy starting');
    ctx.state.initialize(query, ctx.budget);

    // ── Phase 0: Prior-knowledge awareness ──────────────────────────────
    let priorKnowledge = '';
    if (ctx.getPriorKnowledge) {
      try {
        const prior = await ctx.getPriorKnowledge();
        if (prior && (prior.knownClaims.length > 0 || prior.knownGaps.length > 0)) {
          priorKnowledge = `
PRIOR KNOWLEDGE (from previous research on this topic):
Known claims: ${prior.knownClaims.slice(0, 10).join('; ')}
Known open gaps: ${prior.knownGaps.slice(0, 5).join('; ')}`;
        }
      } catch {
        // non-fatal — proceed without prior knowledge
      }
    }

    // Also include what the current run state already knows
    const existingFindings = ctx.state.getFindings();
    const existingSources = ctx.state.getSources();
    if (existingFindings.length > 0 || existingSources.length > 0) {
      priorKnowledge += `
CURRENT RUN STATE: ${String(existingSources.length)} sources, ${String(existingFindings.length)} findings already collected.`;
    }

    // ── Phase 1: Generate research plan ─────────────────────────────────
    const plan = await this.generatePlan(query, priorKnowledge, ctx);
    if (plan !== null && ctx.persistPlan) {
      try {
        await ctx.persistPlan(plan, 'created');
      } catch {
        // non-fatal
      }
    }

    // Set up sub-questions from the plan's perspectives
    if (plan !== null) {
      const subQuestions = plan.perspectives.map((p) => ({
        id: randomUUID().slice(0, 12),
        text: p.question,
        classification: 'explainer' as const,
        evidenceType: 'general' as const,
        preferredSources: [] as never[],
        freshnessRequirement: 'any',
        failureModes: [],
        budgetPriority: 1,
        status: 'pending' as const,
      }));
      ctx.state.setSubQuestions(subQuestions);
    }

    // ── Phase 2: ReAct loop with gap-driven context ─────────────────────
    const systemPrompt = this.buildSystemPrompt(plan, priorKnowledge);
    const gapAnalyzer = new GapAnalyzer(ctx.state);
    let iteration = 0;
    let toolCallsSinceGapCheck = 0;
    let consecutiveIdleChecks = 0;
    const GAP_CHECK_INTERVAL = 4;
    const MAX_IDLE_CHECKS = 2;

    // ── Resume from checkpoint ──────────────────────────────────────────
    if (ctx.resumeState !== undefined) {
      const rs = ctx.resumeState;
      this.history = rs.history as typeof this.history;
      ctx.state.fromJSON(rs.strategyState);
      ctx.budget.restore(rs.budgetState);
      toolCallsSinceGapCheck = 0;
      consecutiveIdleChecks = 0;

      if (rs.status === 'started' && rs.pendingTool !== undefined) {
        // Re-execute the tool that was interrupted
        const toolResult = await this.executeTool(rs.pendingTool.name, rs.pendingTool.args);
        const assistantEntry: { role: 'assistant'; thought?: string; action?: string; args?: Record<string, unknown> } = { role: 'assistant' };
        if (rs.pendingTool.thought) assistantEntry.thought = rs.pendingTool.thought;
        assistantEntry.action = rs.pendingTool.name;
        assistantEntry.args = rs.pendingTool.args;
        // History already has the assistant entry from the checkpoint — don't re-add
        this.history.push({
          role: 'tool',
          tool: rs.pendingTool.name,
          content: toolResult.content.slice(0, 8000),
        });
        toolCallsSinceGapCheck++;
        // Checkpoint the completed step
        if (ctx.checkpointStep) {
          ctx.checkpointStep(rs.stepIndex, 'completed', { tool: rs.pendingTool.name, args: rs.pendingTool.args, content: toolResult.content.slice(0, 8000), error: toolResult.error }, this.history);
        }
      }
      // Skip to next iteration after last completed step
      iteration = rs.stepIndex + 1;
    }

    while (iteration < this.maxIterations) {
      if (ctx.abortSignal?.aborted) break;
      if (ctx.budget.isExhausted()) break;
      iteration++;

      // Periodic gap analysis (every N tool calls)
      let gapContext = '';
      if (toolCallsSinceGapCheck >= GAP_CHECK_INTERVAL) {
        toolCallsSinceGapCheck = 0;
        const coverage = ctx.state.computeSubQuestionCoverage();
        const gaps = gapAnalyzer.analyze(coverage);
        const openGaps = gaps.filter((g) => g.status === 'open');
        if (openGaps.length > 0) {
          const gapSummary = openGaps
            .slice(0, 5)
            .map((g) => `- [P${String(g.priority)}] ${g.description}`)
            .join('\n');
          gapContext = `\n\nCOVERAGE GAPS detected:\n${gapSummary}\nUse this signal to guide your next search, but you choose the action.`;
          consecutiveIdleChecks = 0;
        } else {
          consecutiveIdleChecks++;
        }
      }

      // Stop when no actionable gaps and LLM idle for consecutive checks
      if (consecutiveIdleChecks >= MAX_IDLE_CHECKS) {
        logger.info({ iteration }, 'Agent stopping: no gaps, LLM idle');
        break;
      }

      const response = await this.callLlm(systemPrompt, query, ctx, gapContext);
      if (response === null) break;

      const parsed = parseAgentResponse(response);

      if (parsed.type === 'answer') {
        break;
      }

      if (parsed.type === 'action' && parsed.tool) {
        // Checkpoint: before tool call (started)
        if (ctx.checkpointStep) {
          ctx.checkpointStep(iteration, 'started', { tool: parsed.tool, args: parsed.args ?? {}, thought: parsed.thought }, this.history);
        }
        const toolResult = await this.executeTool(parsed.tool, parsed.args ?? {});
        const assistantEntry: { role: 'assistant'; thought?: string; action?: string; args?: Record<string, unknown> } = { role: 'assistant' };
        if (parsed.thought) assistantEntry.thought = parsed.thought;
        assistantEntry.action = parsed.tool;
        if (parsed.args) assistantEntry.args = parsed.args;
        this.history.push(assistantEntry);
        this.history.push({
          role: 'tool',
          tool: parsed.tool,
          content: toolResult.content.slice(0, 8000),
        });
        // Checkpoint: after tool call (completed)
        if (ctx.checkpointStep) {
          ctx.checkpointStep(iteration, 'completed', { tool: parsed.tool, args: parsed.args ?? {}, content: toolResult.content.slice(0, 8000), error: toolResult.error }, this.history);
        }

        toolCallsSinceGapCheck++;
        const progress = 5 + Math.round((iteration / this.maxIterations) * 85);
        try {
          await ctx.reportProgress({
            phase: 'agent_step',
            percent: progress,
            message: `Agent step ${String(iteration)}/${String(this.maxIterations)}: ${parsed.tool}`,
            counts: {
              sourcesDiscovered: ctx.state.sourceCount(),
              findings: ctx.state.findingCount(),
              providerCalls: ctx.budget.snapshot().toolCallsUsed,
              tokensUsed: ctx.budget.snapshot().tokensUsed,
            },
          });
        } catch {
          // non-fatal
        }
        continue;
      }

      if (parsed.type === 'error') {
        const errorEntry: { role: 'assistant'; thought?: string; content?: string; error?: string } = { role: 'assistant' };
        if (parsed.thought) errorEntry.thought = parsed.thought;
        errorEntry.content = response;
        if (parsed.message) errorEntry.error = parsed.message;
        this.history.push(errorEntry);
      }
    }

    // ── Phase 2b: Moderator gap-finding (STORM-style) ────────────────────
    await this.runModeratorGapFinding(plan, query, systemPrompt, iteration, ctx);

    // ── Phase 3: Output parity — post-process, audit, synthesize ────────
    if (ctx.abortSignal?.aborted) {
      logger.info('Agent research aborted, skipping post-processing');
      return {
        report: {
          query,
          classification: 'explainer',
          depth: 'standard',
          degradationMode: 'source_note_synthesis',
          executiveSummary: '',
          narrativeMarkdown: '',
          themes: [],
          contradictions: [],
          uncertainties: [],
          sourceNotes: [],
          openQuestions: [],
          limitations: [],
          sourceCount: 0,
          sourceTypeCount: 0,
          sourceDiversity: [],
          findingCount: 0,
          evidenceSources: [],
        },
        timeline: [{ phase: 'aborted' }],
        canonicalFindings: [],
      };
    }

    try {
      await ctx.reportProgress({
        phase: 'agent_complete',
        percent: 90,
        message: 'Agent research loop complete, finalizing',
        counts: {
          sourcesDiscovered: ctx.state.sourceCount(),
          findings: ctx.state.findingCount(),
          providerCalls: ctx.budget.snapshot().toolCallsUsed,
          tokensUsed: ctx.budget.snapshot().tokensUsed,
        },
      });
    } catch {
      // non-fatal
    }

    // Post-processing: dedup + contradiction detection (mirrors pipeline)
    const postResult = ctx.state.postProcessFindings();
    logger.info(
      { merged: postResult.merged, contradictions: postResult.contradictions },
      'Agent post-processing complete',
    );

    // Audit
    ctx.state.markAudited();

    // Synthesis
    const state = ctx.state.getState();
    const report = new ResearchSynthesizer(state).synthesize();

    try {
      await ctx.reportProgress({
        phase: 'agent_complete',
        percent: 95,
        message: 'Agent research complete',
        counts: {
          sourcesDiscovered: ctx.state.sourceCount(),
          findings: ctx.state.findingCount(),
          providerCalls: ctx.budget.snapshot().toolCallsUsed,
          tokensUsed: ctx.budget.snapshot().tokensUsed,
        },
      });
    } catch {
      // non-fatal
    }

    return {
      report,
      timeline: [{ phase: 'complete' }],
      canonicalFindings: [...state.findings],
    };
  }

  async close(): Promise<void> {
    this.history = [];
  }

  // ── Plan generation ───────────────────────────────────────────────────

  private async generatePlan(
    query: string,
    priorKnowledge: string,
    ctx: StrategyContext,
  ): Promise<ResearchPlan | null> {
    if (!ctx.llm) return null;

    const prompt = `You are a research planner. Given the following research question, produce a structured research plan.

Question: ${query}${priorKnowledge}

Generate a JSON object (no markdown fences) with this exact structure:
{
  "scope": "<1-2 sentence scope statement>",
  "assumptions": ["<assumption 1>", ...],
  "perspectives": [
    {"name": "<perspective name, e.g. historian/primary-source>", "question": "<specific sub-question from this angle>"}
  ],
  "falsificationQuestions": ["<what evidence would prove current understanding wrong?>", ...]
}

Choose 3-6 perspectives relevant to THIS specific query. Examples of perspective names: historian/primary-source, implementer/practitioner, skeptic/critic, current-state, comparison, technical-deep-dive, user-experience, economic-analysis, regulatory, future-outlook. Pick only what fits.

Output ONLY the JSON object.`;

    const resp = await ctx.llm.callOrchestrator({
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.3,
      maxTokens: 2000,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(ctx.providerCtx
        ? { runId: ctx.providerCtx.runId, traceId: ctx.providerCtx.trace.traceId }
        : { runId: ctx.runContext.researchRunId }),
    });
    ctx.budget.recordToolCall();

    if (!resp.success) return null;

    const raw = parseJsonFromText<unknown>(resp.content);
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      logger.warn('Agent plan LLM returned invalid structure, proceeding without plan');
      return null;
    }
    const obj = raw as Record<string, unknown>;

    if (
      typeof obj.scope !== 'string' ||
      !Array.isArray(obj.perspectives) ||
      obj.perspectives.length === 0
    ) {
      logger.warn('Agent plan LLM returned invalid structure, proceeding without plan');
      return null;
    }

    // Validate perspective shape — filter out invalid entries rather than coercing
    const validPerspectives = (obj.perspectives as unknown[]).filter(
      (p): p is { name: string; question: string } =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Record<string, unknown>).name === 'string' &&
        typeof (p as Record<string, unknown>).question === 'string',
    );
    if (validPerspectives.length === 0) return null;

    return {
      scope: obj.scope.slice(0, 2000),
      assumptions: Array.isArray(obj.assumptions)
        ? (obj.assumptions as unknown[])
            .filter((a): a is string => typeof a === 'string')
            .map((a) => a.slice(0, 500))
            .slice(0, 10)
        : [],
      perspectives: validPerspectives.slice(0, 8),
      falsificationQuestions: Array.isArray(obj.falsificationQuestions)
        ? (obj.falsificationQuestions as unknown[])
            .filter((f): f is string => typeof f === 'string')
            .map((f) => f.slice(0, 1000))
            .slice(0, 5)
        : [],
    };
  }

  // ── Empty result (no LLM) ─────────────────────────────────────────────

  private emptyResult(query: string, depth: ResearchResult['report']['depth']): ResearchResult {
    return {
      report: {
        query,
        classification: 'explainer',
        depth,
        degradationMode: 'source_note_synthesis',
        executiveSummary: 'LLM was unavailable. Agent strategy could not proceed.',
        narrativeMarkdown: 'Agent research could not be completed: no LLM configured.',
        themes: [],
        contradictions: [],
        uncertainties: ['LLM unavailable'],
        sourceNotes: [],
        openQuestions: [query],
        limitations: ['Agent strategy requires an LLM.'],
        sourceCount: 0,
        sourceTypeCount: 0,
        sourceDiversity: [],
        findingCount: 0,
        evidenceSources: [],
      },
      timeline: [{ phase: 'complete' }],
    };
  }

  // ── System prompt ─────────────────────────────────────────────────────

  private buildSystemPrompt(plan: ResearchPlan | null, priorKnowledge: string): string {
    const today = new Date().toISOString().slice(0, 10);
    const toolDesc = describeTools(this.tools);

    let planSection = '';
    if (plan !== null) {
      const perspectiveLines = plan.perspectives
        .map((p) => `  - ${p.name}: ${p.question}`)
        .join('\n');
      planSection = `
RESEARCH PLAN:
Scope: ${plan.scope}
Assumptions: ${plan.assumptions.join('; ')}
Perspectives to investigate:
${perspectiveLines}
Falsification questions:
${plan.falsificationQuestions.map((q) => `  - ${q}`).join('\n')}`;
    }

    return `You are an exhaustive research agent. Today's date: ${today}.${priorKnowledge}${planSection}

RULES:
1. You MUST search then read at least one source before answering.
2. You MUST use web_read to extract full content before claiming findings.
3. Use AT LEAST 3 different tool types before answering.
4. Durable findings come from web_read, not from your final answer.
5. Your final answer may summarize existing findings but cannot introduce new evidence.
6. When you have enough information, provide your ANSWER.

RESPONSE FORMAT:
THOUGHT: <reasoning>
ACTION: <tool_name>
ARGUMENTS: {"key": "value"}

THOUGHT: <summary>
ANSWER: <comprehensive answer with citations>

Available tools:
${toolDesc}`;
  }

  // ── LLM call ──────────────────────────────────────────────────────────

  private async callLlm(
    systemPrompt: string,
    query: string,
    ctx: StrategyContext,
    gapContext?: string,
  ): Promise<string | null> {
    if (!ctx.llm) return null;

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt },
    ];

    const recentHistory = this.history.slice(-8);
    for (const entry of recentHistory) {
      if (entry.role === 'assistant') {
        if (entry.action) {
          messages.push({
            role: 'assistant',
            content: `THOUGHT: ${entry.thought ?? ''}\nACTION: ${entry.action}\nARGUMENTS: ${JSON.stringify(entry.args ?? {})}`,
          });
        } else if (entry.content) {
          messages.push({ role: 'assistant', content: entry.content });
        }
      } else if (entry.role === 'tool') {
        messages.push({
          role: 'user',
          content: `[Tool result from ${entry.tool ?? 'unknown'}]:\n${entry.content ?? ''}`,
        });
      } else if (entry.error) {
        messages.push({ role: 'user', content: `[Error]: ${entry.error}` });
      }
    }

    if (this.history.length === 0) {
      messages.push({
        role: 'user',
        content: `Research question: ${query}\n\nBegin searching for information.${gapContext ?? ''}`,
      });
    } else {
      messages.push({
        role: 'user',
        content: `Continue research. If you have enough information, provide your ANSWER.${gapContext ?? ''}`,
      });
    }

    const resp = await ctx.llm.callOrchestrator({
      messages,
      temperature: 0.7,
      maxTokens: 4000,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(ctx.providerCtx
        ? { runId: ctx.providerCtx.runId, traceId: ctx.providerCtx.trace.traceId }
        : { runId: ctx.runContext.researchRunId }),
    });

    // One logical LLM call = one call slot, success or failure (same counter
    // as search-provider calls).
    ctx.budget.recordToolCall();

    return resp.success ? resp.content : null;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; error?: string }> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      const available = this.tools.map((t) => t.name).join(', ');
      return { content: `Unknown tool: ${name}. Available: ${available}`, error: 'unknown tool' };
    }
    try {
      return await tool.execute(args);
    } catch (err) {
      return {
        content: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        error: 'tool error',
      };
    }
  }

  // ── Moderator gap-finding (STORM-style, runs once after main loop) ───

  private async runModeratorGapFinding(
    plan: ResearchPlan | null,
    query: string,
    systemPrompt: string,
    loopEndIteration: number,
    ctx: StrategyContext,
  ): Promise<void> {
    // Gate: need 2+ perspectives AND findings present
    if (plan === null || plan.perspectives.length < 2) return;
    const allFindings = ctx.state.getFindings();
    if (allFindings.length === 0) return;

    // Budget gate: 3+ tool calls, 20k tokens, 30s remaining
    const snap = ctx.budget.snapshot();
    if (snap.toolCallsUsed < 3) return;
    const rem = ctx.budget.remaining();
    if (rem.tokens < 20000 || rem.timeMs < 30000) return;

    const coverage = ctx.state.computeSubQuestionCoverage();
    const state = ctx.state.getState();

    // Group findings by subQuestionId
    const findingsBySq = new Map<string, { claim: string }[]>();
    for (const f of allFindings) {
      for (const sqId of f.subQuestionIds) {
        const arr = findingsBySq.get(sqId) ?? [];
        arr.push({ claim: f.claim });
        findingsBySq.set(sqId, arr);
      }
    }

    const perspectiveLines = plan.perspectives
      .map((p) => `  - ${p.name}: ${p.question}`)
      .join('\n');

    const coverageLines = coverage
      .map((c) => `  - [${c.status}] ${c.subQuestionText} (${String(c.sourceCount)} sources, ${String(c.findingCount)} findings)`)
      .join('\n');

    const findingsLines = coverage
      .map((c) => {
        const sqFindings = findingsBySq.get(c.subQuestionId) ?? [];
        if (sqFindings.length === 0) return '';
        const lines = sqFindings
          .slice(0, 5)
          .map((f) => `    - ${f.claim}`)
          .join('\n');
        return `  - ${c.subQuestionText}:\n${lines}`;
      })
      .filter(Boolean)
      .join('\n');

    // Contradictions if locally available
    const contradictions = state.contradictions;
    let contradictionSection = '';
    if (contradictions.length > 0) {
      const cLines = contradictions
        .slice(0, 5)
        .map((c) => `  - ${c.claimA} vs ${c.claimB} (${c.contradictionType})`)
        .join('\n');
      contradictionSection = `\nKNOWN CONTRADICTIONS:\n${cLines}`;
    }

    const prompt = `You are a research moderator. Review the current research state and identify the most important coverage gaps.

PERSPECTIVES:
${perspectiveLines}

SUB-QUESTION COVERAGE:
${coverageLines}

FINDINGS BY SUB-QUESTION:
${findingsLines}${contradictionSection}

Identify at most 3 critical gaps — areas where the research is weakest or most likely to be misleading. For each gap, specify a targeted search query.

Respond with ONLY a JSON object (no markdown fences):
{
  "gaps": [
    {
      "question": "<targeted search query to fill this gap>",
      "reason": "<why this gap matters>",
      "involvedPerspectives": ["<perspective name>"]
    }
  ]
}

If no critical gaps exist, return {"gaps": []}.`;

    if (!ctx.llm) return;
    const resp = await ctx.llm.callOrchestrator({
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.3,
      maxTokens: 1500,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      ...(ctx.providerCtx
        ? { runId: ctx.providerCtx.runId, traceId: ctx.providerCtx.trace.traceId }
        : { runId: ctx.runContext.researchRunId }),
    });
    ctx.budget.recordToolCall();

    if (!resp.success) return;

    // Parse and validate moderator JSON response (same pattern as generatePlan)
    const raw = parseJsonFromText<unknown>(resp.content);
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.gaps)) return;

    interface ModeratorGap {
      question: string;
      reason: string;
      involvedPerspectives: string[];
    }
    const gaps = (obj.gaps as unknown[])
      .filter(
        (g): g is ModeratorGap =>
          typeof g === 'object' &&
          g !== null &&
          typeof (g as Record<string, unknown>).question === 'string',
      )
      .slice(0, 3);

    if (gaps.length === 0) return;

    try {
      await ctx.reportProgress({
        phase: 'moderator_gap_followup',
        percent: 88,
        message: `Moderator identified ${String(gaps.length)} gap(s), running follow-up iterations`,
        counts: {
          sourcesDiscovered: ctx.state.sourceCount(),
          findings: ctx.state.findingCount(),
          providerCalls: ctx.budget.snapshot().toolCallsUsed,
          tokensUsed: ctx.budget.snapshot().tokensUsed,
        },
      });
    } catch {
      // non-fatal
    }

    // At most 2 follow-up iterations using existing ReAct machinery
    const maxFollowUps = Math.min(2, gaps.length);
    for (let i = 0; i < maxFollowUps; i++) {
      // Re-check budget before each follow-up
      const r = ctx.budget.remaining();
      if (r.tokens < 20000 || r.timeMs < 30000) break;
      if (ctx.abortSignal?.aborted) break;

      const gap = gaps[i];
      if (!gap) break;
      const gapContext = `\n\nMODERATOR GAP FOLLOW-UP: ${gap.question}\nReason: ${gap.reason}\nRelated perspectives: ${gap.involvedPerspectives.join(', ')}\nUse this to guide your next search.`;

      const response = await this.callLlm(systemPrompt, query, ctx, gapContext);
      if (response === null) break;

      const parsed = parseAgentResponse(response);
      if (parsed.type !== 'action' || !parsed.tool) break;

      const stepIdx = loopEndIteration + i + 1;
      if (ctx.checkpointStep) {
        ctx.checkpointStep(stepIdx, 'started', { tool: parsed.tool, args: parsed.args ?? {}, thought: parsed.thought }, this.history);
      }
      const toolResult = await this.executeTool(parsed.tool, parsed.args ?? {});
      const assistantEntry: { role: 'assistant'; thought?: string; action?: string; args?: Record<string, unknown> } = { role: 'assistant' };
      if (parsed.thought) assistantEntry.thought = parsed.thought;
      assistantEntry.action = parsed.tool;
      if (parsed.args) assistantEntry.args = parsed.args;
      this.history.push(assistantEntry);
      this.history.push({
        role: 'tool',
        tool: parsed.tool,
        content: toolResult.content.slice(0, 8000),
      });
      if (ctx.checkpointStep) {
        ctx.checkpointStep(stepIdx, 'completed', { tool: parsed.tool, args: parsed.args ?? {}, content: toolResult.content.slice(0, 8000), error: toolResult.error }, this.history);
      }
    }
  }
}