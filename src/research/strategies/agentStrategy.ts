/**
 * Agent strategy — LLM-driven ReAct agent for deep research.
 * Simplified from search-mcp agentStrategy.ts — routes through ResearchProvider.
 */

import { logger } from '../../logger.js';
import { providerCallContext, type ResearchStrategy, type StrategyContext } from './types.js';
import type { ResearchResult } from '../internalTypes.js';

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
      const result = await ctx.provider.read(providerCallContext(ctx, { phase: 'agent_read' }), url);
      ctx.budget.recordToolCall();
      return { content: result.content.slice(0, 8000) };
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
      return {
        report: {
          query,
          classification: 'explainer',
          depth: ctx.depth,
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

    logger.info({ query }, 'Agent strategy starting');
    ctx.state.initialize(query, ctx.budget);

    const systemPrompt = this.buildSystemPrompt();
    let iteration = 0;
    let finalAnswer: string | null = null;

    while (iteration < this.maxIterations) {
      if (ctx.abortSignal?.aborted) break;
      if (ctx.budget.isExhausted()) break;
      iteration++;

      const response = await this.callLlm(systemPrompt, query, ctx);
      if (response === null) break;

      const parsed = parseAgentResponse(response);

      if (parsed.type === 'answer') {
        finalAnswer = parsed.content ?? 'No answer provided.';
        break;
      }

      if (parsed.type === 'action' && parsed.tool) {
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

    finalAnswer ??= await this.synthesizeFallback(query, ctx);

    // Store result as a finding
    ctx.state.addFinding({
      claim: finalAnswer.slice(0, 200),
      normalizedClaim: finalAnswer.slice(0, 200).toLowerCase(),
      evidenceExcerpt: finalAnswer,
      evidenceDirectness: 'secondary',
      claimType: 'primary',
      sourceIds: [],
      subQuestionIds: [],
      lastUpdated: new Date().toISOString(),
    });

    try {
      await ctx.reportProgress({
        phase: 'agent_complete',
        percent: 95,
        message: 'Agent research complete',
        counts: {
          providerCalls: ctx.budget.snapshot().toolCallsUsed,
          tokensUsed: ctx.budget.snapshot().tokensUsed,
        },
      });
    } catch {
      // non-fatal
    }

    const state = ctx.state.getState();
    const report = new (await import('../synthesizer.js')).ResearchSynthesizer(state).synthesize();

    return {
      report,
      timeline: [{ phase: 'complete' }],
      canonicalFindings: [...state.findings],
    };
  }

  async close(): Promise<void> {
    this.history = [];
  }

  private buildSystemPrompt(): string {
    const today = new Date().toISOString().slice(0, 10);
    const toolDesc = describeTools(this.tools);

    return `You are an exhaustive research agent. Today's date: ${today}.

RULES:
1. Search for information before answering. Do NOT answer from memory.
2. Use AT LEAST 3 different tool types.
3. When you have enough information, provide your ANSWER.

RESPONSE FORMAT:
THOUGHT: <reasoning>
ACTION: <tool_name>
ARGUMENTS: {"key": "value"}

THOUGHT: <summary>
ANSWER: <comprehensive answer with citations>

Available tools:
${toolDesc}`;
  }

  private async callLlm(
    systemPrompt: string,
    query: string,
    ctx: StrategyContext,
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
        content: `Research question: ${query}\n\nBegin searching for information.`,
      });
    } else {
      messages.push({
        role: 'user',
        content: 'Continue research. If you have enough information, provide your ANSWER.',
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

  private async synthesizeFallback(query: string, ctx: StrategyContext): Promise<string> {
    if (!ctx.llm) return 'Research could not be completed without an LLM.';
    const sources = ctx.state
      .getSources()
      .map((s, i) => `[${String(i + 1)}] ${s.title} — ${s.url}`)
      .join('\n');

    const resp = await ctx.llm.callOrchestrator({
      messages: [
        {
          role: 'system',
          content: 'Synthesize research findings into a comprehensive answer with source citations.',
        },
        {
          role: 'user',
          content: `Research question: ${query}\n\nSources:\n${sources}\n\nSynthesize a comprehensive answer.`,
        },
      ],
      temperature: 0.5,
      maxTokens: 4000,
      ...(ctx.providerCtx
        ? { runId: ctx.providerCtx.runId, traceId: ctx.providerCtx.trace.traceId }
        : { runId: ctx.runContext.researchRunId }),
    });
    ctx.budget.recordToolCall();

    return resp.success ? resp.content : 'Research incomplete.';
  }
}
