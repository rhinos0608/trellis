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

// ── Shared constants ─────────────────────────────────────────────────────────

const GAP_CHECK_INTERVAL = 4;
const MAX_IDLE_CHECKS = 2;
const TOOL_CONTENT_LIMIT = 8000;
const MODERATOR_TOKEN_FLOOR = 20000;
const MODERATOR_TIME_FLOOR_MS = 30000;
const MODERATOR_MAX_GAPS = 3;
const MODERATOR_MAX_FOLLOW_UPS = 2;

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

function extractThought(text: string): string {
  const thoughtMatch =
    /THOUGHT:\s*([\s\S]*?)(?=\n?\s*(?:ACTION|ANSWER):|$)/i.exec(text);
  return thoughtMatch?.[1]?.trim() ?? '';
}

function tryParseAnswer(text: string, thought: string): ParsedResponse | null {
  const answerMatch = /ANSWER:\s*([\s\S]*)/i.exec(text);
  if (!answerMatch) return null;
  return {
    type: 'answer',
    content: (answerMatch[1] ?? '').trim(),
    thought,
    raw: text,
  };
}

function parseArgsText(argsText: string): Record<string, unknown> {
  try {
    return JSON.parse(argsText) as Record<string, unknown>;
  } catch {
    return { _rawArgs: argsText };
  }
}

function tryParseAction(text: string, thought: string): ParsedResponse | null {
  const actionMatch = /ACTION:\s*(\S+)/i.exec(text);
  if (!actionMatch) return null;
  const argsMatch = /ARGUMENTS:\s*([\s\S]*?)(?=\n(?:THOUGHT|ACTION|ANSWER):|$)/i.exec(
    text,
  );
  const argsText = argsMatch?.[1]?.trim() ?? '';
  return {
    type: 'action',
    thought,
    tool: (actionMatch[1] ?? '').trim(),
    args: parseArgsText(argsText),
    raw: text,
  };
}

function parseAgentResponse(text: string): ParsedResponse {
  const thought = extractThought(text);
  return (
    tryParseAnswer(text, thought) ??
    tryParseAction(text, thought) ?? {
      type: 'error',
      message: 'Could not parse response',
      thought,
      content: text,
      raw: text,
    }
  );
}

// ── Agent tools ───────────────────────────────────────────────────────────

interface AgentTool {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<{ content: string; error?: string }>;
}

interface ToolResult {
  content: string;
  error?: string;
}

function invalidArgsResult(message: string): ToolResult {
  return { content: message, error: 'invalid_args' };
}

function getStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function formatIndexedHits<T extends { title: string; url: string }>(
  hits: T[],
  formatHit: (hit: T, index: number) => string,
): string {
  return hits.map(formatHit).join('\n\n');
}

interface QueryToolOptions<T extends { title: string; url: string }> {
  name: string;
  description: string;
  phase: string;
  limit: number;
  search: (query: string) => Promise<T[]>;
  formatHit: (hit: T, index: number) => string;
}

function makeQueryTool<T extends { title: string; url: string }>(
  ctx: StrategyContext,
  options: QueryToolOptions<T>,
): AgentTool {
  return {
    name: options.name,
    description: options.description,
    execute: async (args) => {
      const query = getStringArg(args, 'query');
      if (query === null) return invalidArgsResult('query must be a string');
      const hits = await options.search(query);
      ctx.budget.recordToolCall();
      return { content: formatIndexedHits(hits, options.formatHit) };
    },
  };
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function rejectUnsafeUrl(ctx: StrategyContext, url: string, err: unknown): ToolResult {
  ctx.budget.recordToolCall();
  logger.debug({ ...safeErrorLog(err), urlBytes: Buffer.byteLength(url, 'utf8') }, 'Agent rejected unsafe URL');
  return { content: `URL rejected: ${err instanceof Error ? err.message : 'validation failed'}`, error: 'invalid_url' };
}

interface WebReadResult {
  url: string;
  title?: string;
  content: string;
  contentHash?: string;
}

function findOrCreateWebSource(
  ctx: StrategyContext,
  url: string,
  result: WebReadResult,
): string | undefined {
  const existingSource = ctx.state.getSources().find((s) => s.url === url);
  if (existingSource) return existingSource.id;
  return ctx.state.addSource({
    id: `src_${randomUUID().slice(0, 12)}`,
    title: result.title ?? url,
    url,
    sourceType: 'web',
    domain: extractDomain(url),
    accessDate: new Date().toISOString(),
    isPrimary: false,
    relevantSubQuestions: [],
    extractionStatus: 'pending',
    subQuestionId: '',
    ...(result.contentHash !== undefined ? { contentHash: result.contentHash } : {}),
  });
}

async function runSourceExtraction(
  ctx: StrategyContext,
  sourceId: string,
  url: string,
  title: string | undefined,
  result: WebReadResult,
): Promise<number> {
  const extractionResult = await extractClaimsFromSource(
    {
      source: {
        id: sourceId,
        title: title ?? url,
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
  const extracted = extractionResult.status === 'extracted' || extractionResult.status === 'unavailable';
  if (extracted) {
    ctx.state.markSourceExtracted(sourceId);
  } else {
    ctx.state.markSourceFailed(sourceId);
  }
  return extractionResult.findings.length;
}

function buildWebReadTool(ctx: StrategyContext): AgentTool {
  return {
    name: 'web_read',
    description: 'Read a URL and extract its content. Args: { url: string }',
    execute: async (args) => {
      const url = getStringArg(args, 'url');
      if (url === null) return invalidArgsResult('url must be a string');
      try {
        validateFetchableUrl(url);
      } catch (err) {
        return rejectUnsafeUrl(ctx, url, err);
      }

      let result: WebReadResult;
      try {
        result = await ctx.provider.read(providerCallContext(ctx, { phase: 'agent_read' }), url);
      } catch (err) {
        ctx.budget.recordToolCall();
        return { content: `Read failed: ${err instanceof Error ? err.message : String(err)}`, error: 'read_error' };
      }
      ctx.budget.recordToolCall();

      const sourceId = findOrCreateWebSource(ctx, url, result);
      if (!sourceId) return { content: result.content.slice(0, TOOL_CONTENT_LIMIT) };

      const findingCount = await runSourceExtraction(ctx, sourceId, url, result.title, result);
      return { content: result.content.slice(0, TOOL_CONTENT_LIMIT) + `\n[Extracted ${String(findingCount)} grounded claims]` };
    },
  };
}

function hasAcademicSearch(ctx: StrategyContext): boolean {
  return ctx.provider.capabilities.academic;
}

function hasRedditSearch(ctx: StrategyContext): boolean {
  return ctx.provider.capabilities.community.reddit && ctx.provider.reddit !== undefined;
}

function hasHackernewsSearch(ctx: StrategyContext): boolean {
  return ctx.provider.capabilities.community.hackernews && ctx.provider.hackernews !== undefined;
}

function buildAgentTools(ctx: StrategyContext): AgentTool[] {
  const tools: AgentTool[] = [
    makeQueryTool(ctx, {
      name: 'search_web',
      description: 'Search the web for information. Args: { query: string }',
      phase: 'agent_search',
      limit: 10,
      search: (q) => ctx.provider.search(providerCallContext(ctx, { phase: 'agent_search' }), q, { limit: 10 }),
      formatHit: (h, i) => `[${String(i + 1)}] ${h.title} — ${h.url}\n${h.snippet ?? ''}`,
    }),
    buildWebReadTool(ctx),
  ];

  if (hasAcademicSearch(ctx)) {
    tools.push(
      makeQueryTool(ctx, {
        name: 'search_academic',
        description: 'Search academic sources. Args: { query: string }',
        phase: 'agent_academic',
        limit: 5,
        search: (q) => ctx.provider.academic(providerCallContext(ctx, { phase: 'agent_academic' }), q, { limit: 5 }),
        formatHit: (h, i) => `[${String(i + 1)}] ${h.title} — ${h.url}`,
      }),
    );
  }

  if (hasRedditSearch(ctx)) {
    if (ctx.provider.reddit === undefined) throw new Error('reddit search unavailable');
    const redditSearch = ctx.provider.reddit.bind(ctx.provider);
    tools.push(
      makeQueryTool(ctx, {
        name: 'search_reddit',
        description: 'Search Reddit. Args: { query: string }',
        phase: 'agent_reddit',
        limit: 5,
        search: (q) => redditSearch(providerCallContext(ctx, { phase: 'agent_reddit' }), q, { limit: 5 }),
        formatHit: (h, i) => `[${String(i + 1)}] ${h.title} — ${h.url} (score: ${String(h.score)})`,
      }),
    );
  }

  if (hasHackernewsSearch(ctx)) {
    if (ctx.provider.hackernews === undefined) throw new Error('hackernews search unavailable');
    const hackernewsSearch = ctx.provider.hackernews.bind(ctx.provider);
    tools.push(
      makeQueryTool(ctx, {
        name: 'search_hackernews',
        description: 'Search Hacker News. Args: { query: string }',
        phase: 'agent_hackernews',
        limit: 5,
        search: (q) => hackernewsSearch(providerCallContext(ctx, { phase: 'agent_hackernews' }), q, { limit: 5 }),
        formatHit: (h, i) => `[${String(i + 1)}] ${h.title} — ${h.url}`,
      }),
    );
  }

  return tools;
}

function describeTools(tools: AgentTool[]): string {
  return tools.map((t) => `  ${t.name}: ${t.description}`).join('\n');
}

// ── Plan helpers ──────────────────────────────────────────────────────────

function buildPlanPrompt(query: string, priorKnowledge: string): string {
  return `You are a research planner. Given the following research question, produce a structured research plan.

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPlanScope(obj: Record<string, unknown>): obj is Record<string, unknown> & { scope: string } {
  return typeof obj.scope === 'string';
}

function hasNonEmptyPerspectives(obj: Record<string, unknown>): boolean {
  return Array.isArray(obj.perspectives) && obj.perspectives.length > 0;
}

function isValidPlanPayload(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && hasPlanScope(raw) && hasNonEmptyPerspectives(raw);
}

function isPerspective(value: unknown): value is { name: string; question: string } {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && typeof value.question === 'string';
}

function extractValidPerspectives(raw: unknown[]): { name: string; question: string }[] {
  return raw.filter(isPerspective);
}

function sanitizeStringList(raw: unknown, itemLimit: number, maxItems: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.slice(0, itemLimit))
    .slice(0, maxItems);
}

function toResearchPlan(obj: Record<string, unknown>): ResearchPlan | null {
  const validPerspectives = extractValidPerspectives(obj.perspectives as unknown[]);
  if (validPerspectives.length === 0) return null;
  const scope = obj.scope as string;
  return {
    scope: scope.slice(0, 2000),
    assumptions: sanitizeStringList(obj.assumptions, 500, 10),
    perspectives: validPerspectives.slice(0, 8),
    falsificationQuestions: sanitizeStringList(obj.falsificationQuestions, 1000, 5),
  };
}

function logInvalidPlan(): null {
  logger.warn('Agent plan LLM returned invalid structure, proceeding without plan');
  return null;
}

// ── Prior knowledge helpers ───────────────────────────────────────────────

interface PriorKnowledge {
  knownClaims: string[];
  knownGaps: string[];
}

function hasUsablePrior(prior: PriorKnowledge | undefined): prior is PriorKnowledge {
  return prior !== undefined && (prior.knownClaims.length > 0 || prior.knownGaps.length > 0);
}

function formatPriorKnowledge(prior: PriorKnowledge): string {
  return `
PRIOR KNOWLEDGE (from previous research on this topic):
Known claims: ${prior.knownClaims.slice(0, 10).join('; ')}
Known open gaps: ${prior.knownGaps.slice(0, 5).join('; ')}`;
}

async function collectPriorKnowledge(ctx: StrategyContext): Promise<string> {
  if (!ctx.getPriorKnowledge) return '';
  try {
    const prior = await ctx.getPriorKnowledge();
    return hasUsablePrior(prior) ? formatPriorKnowledge(prior) : '';
  } catch {
    // non-fatal — proceed without prior knowledge
    return '';
  }
}

function appendRunStateSummary(priorKnowledge: string, ctx: StrategyContext): string {
  const findingCount = ctx.state.getFindings().length;
  const sourceCount = ctx.state.getSources().length;
  const hasRunState = findingCount > 0 || sourceCount > 0;
  if (!hasRunState) return priorKnowledge;
  return priorKnowledge + `
CURRENT RUN STATE: ${String(sourceCount)} sources, ${String(findingCount)} findings already collected.`;
}

async function persistPlanIfNeeded(plan: ResearchPlan | null, ctx: StrategyContext): Promise<void> {
  if (plan === null || !ctx.persistPlan) return;
  try {
    await ctx.persistPlan(plan, 'created');
  } catch {
    // non-fatal
  }
}

function setupPlanSubQuestions(plan: ResearchPlan | null, ctx: StrategyContext): void {
  if (plan === null) return;
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

// ── React loop helpers ────────────────────────────────────────────────────

interface HistoryEntry {
  role: 'assistant' | 'tool' | 'system';
  thought?: string;
  action?: string;
  args?: Record<string, unknown>;
  tool?: string;
  content?: string;
  error?: string;
}

interface LoopState {
  iteration: number;
  toolCallsSinceGapCheck: number;
  consecutiveIdleChecks: number;
}

function initialLoopState(): LoopState {
  return { iteration: 0, toolCallsSinceGapCheck: 0, consecutiveIdleChecks: 0 };
}

interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }

function assistantEntryToMessage(entry: HistoryEntry): LlmMessage | null {
  if (entry.action) {
    return {
      role: 'assistant',
      content: `THOUGHT: ${entry.thought ?? ''}\nACTION: ${entry.action}\nARGUMENTS: ${JSON.stringify(entry.args ?? {})}`,
    };
  }
  if (entry.content) return { role: 'assistant', content: entry.content };
  return null;
}

function historyEntryToMessage(entry: HistoryEntry): LlmMessage | null {
  if (entry.role === 'assistant') return assistantEntryToMessage(entry);
  if (entry.role === 'tool') {
    return {
      role: 'user',
      content: `[Tool result from ${entry.tool ?? 'unknown'}]:\n${entry.content ?? ''}`,
    };
  }
  if (entry.error) return { role: 'user', content: `[Error]: ${entry.error}` };
  return null;
}

function buildLlmMessages(
  systemPrompt: string,
  query: string,
  gapContext: string | undefined,
  history: HistoryEntry[],
): LlmMessage[] {
  const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const entry of history.slice(-8)) {
    const message = historyEntryToMessage(entry);
    if (message) messages.push(message);
  }
  const isFirstTurn = history.length === 0;
  messages.push({
    role: 'user',
    content: isFirstTurn
      ? `Research question: ${query}\n\nBegin searching for information.${gapContext ?? ''}`
      : `Continue research. If you have enough information, provide your ANSWER.${gapContext ?? ''}`,
  });
  return messages;
}

function buildGapSummary(ctx: StrategyContext, gapAnalyzer: GapAnalyzer): { gapContext: string; foundGaps: boolean } {
  const coverage = ctx.state.computeSubQuestionCoverage();
  const gaps = gapAnalyzer.analyze(coverage);
  const openGaps = gaps.filter((g) => g.status === 'open');
  if (openGaps.length === 0) return { gapContext: '', foundGaps: false };
  const gapSummary = openGaps
    .slice(0, 5)
    .map((g) => `- [P${String(g.priority)}] ${g.description}`)
    .join('\n');
  return {
    gapContext: `\n\nCOVERAGE GAPS detected:\n${gapSummary}\nUse this signal to guide your next search, but you choose the action.`,
    foundGaps: true,
  };
}

function shouldRunGapCheck(state: LoopState): boolean {
  return state.toolCallsSinceGapCheck >= GAP_CHECK_INTERVAL;
}

function shouldStopIdle(state: LoopState): boolean {
  return state.consecutiveIdleChecks >= MAX_IDLE_CHECKS;
}

function refreshGapContext(state: LoopState, ctx: StrategyContext, gapAnalyzer: GapAnalyzer): string {
  if (!shouldRunGapCheck(state)) return '';
  state.toolCallsSinceGapCheck = 0;
  const { gapContext, foundGaps } = buildGapSummary(ctx, gapAnalyzer);
  state.consecutiveIdleChecks = foundGaps ? 0 : state.consecutiveIdleChecks + 1;
  return gapContext;
}

async function reportAgentStep(
  ctx: StrategyContext,
  iteration: number,
  maxIterations: number,
  tool: string,
): Promise<void> {
  const progress = 5 + Math.round((iteration / maxIterations) * 85);
  try {
    await ctx.reportProgress({
      phase: 'agent_step',
      percent: progress,
      message: `Agent step ${String(iteration)}/${String(maxIterations)}: ${tool}`,
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
}

async function reportAgentPhase(
  ctx: StrategyContext,
  phase: string,
  percent: number,
  message: string,
): Promise<void> {
  try {
    await ctx.reportProgress({
      phase,
      percent,
      message,
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
}

function recordAssistantAction(
  history: HistoryEntry[],
  parsed: { thought: string; tool: string; args?: Record<string, unknown> },
): void {
  const entry: HistoryEntry = { role: 'assistant' };
  if (parsed.thought) entry.thought = parsed.thought;
  entry.action = parsed.tool;
  if (parsed.args) entry.args = parsed.args;
  history.push(entry);
}

function recordToolResult(
  history: HistoryEntry[],
  tool: string,
  result: ToolResult,
): void {
  history.push({ role: 'tool', tool, content: result.content.slice(0, TOOL_CONTENT_LIMIT) });
}

function recordParseError(history: HistoryEntry[], parsed: ParsedResponse, response: string): void {
  const entry: HistoryEntry = { role: 'assistant' };
  if (parsed.thought) entry.thought = parsed.thought;
  entry.content = response;
  if (parsed.message) entry.error = parsed.message;
  history.push(entry);
}

function checkpointStarted(
  ctx: StrategyContext,
  stepIndex: number,
  tool: string,
  args: Record<string, unknown>,
  thought: string,
  history: HistoryEntry[],
): void {
  if (ctx.checkpointStep) {
    ctx.checkpointStep(stepIndex, 'started', { tool, args, thought }, history);
  }
}

function checkpointCompleted(
  ctx: StrategyContext,
  stepIndex: number,
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult,
  history: HistoryEntry[],
): void {
  if (ctx.checkpointStep) {
    ctx.checkpointStep(
      stepIndex,
      'completed',
      { tool, args, content: result.content.slice(0, TOOL_CONTENT_LIMIT), error: result.error },
      history,
    );
  }
}

// ── Moderator helpers ─────────────────────────────────────────────────────

interface ModeratorGapInput {
  plan: ResearchPlan | null;
  query: string;
  systemPrompt: string;
  loopEndIteration: number;
  ctx: StrategyContext;
}

interface ModeratorGap {
  question: string;
  reason: string;
  involvedPerspectives: string[];
}

function isModeratorPlanEligible(plan: ResearchPlan | null, ctx: StrategyContext): plan is ResearchPlan {
  if (plan === null || plan.perspectives.length < 2) return false;
  return ctx.state.getFindings().length > 0;
}

function hasModeratorCallBudget(ctx: StrategyContext): boolean {
  return ctx.budget.snapshot().toolCallsUsed >= 3;
}

function hasModeratorRemainingBudget(ctx: StrategyContext): boolean {
  const rem = ctx.budget.remaining();
  return rem.tokens >= MODERATOR_TOKEN_FLOOR && rem.timeMs >= MODERATOR_TIME_FLOOR_MS;
}

function isModeratorGap(value: unknown): value is ModeratorGap {
  if (!isRecord(value)) return false;
  if (typeof value.question !== 'string') return false;
  return true;
}

function normalizeModeratorGap(gap: ModeratorGap): ModeratorGap {
  return {
    question: gap.question,
    reason: typeof gap.reason === 'string' ? gap.reason : '',
    involvedPerspectives: Array.isArray(gap.involvedPerspectives)
      ? gap.involvedPerspectives.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

function parseModeratorGaps(raw: unknown): ModeratorGap[] {
  if (!isRecord(raw) || !Array.isArray(raw.gaps)) return [];
  return (raw.gaps as unknown[])
    .filter(isModeratorGap)
    .map(normalizeModeratorGap)
    .slice(0, MODERATOR_MAX_GAPS);
}

function groupFindingsBySubQuestion(
  findings: { claim: string; subQuestionIds: string[] }[],
): Map<string, { claim: string }[]> {
  const bySq = new Map<string, { claim: string }[]>();
  for (const f of findings) {
    for (const sqId of f.subQuestionIds) {
      const arr = bySq.get(sqId) ?? [];
      arr.push({ claim: f.claim });
      bySq.set(sqId, arr);
    }
  }
  return bySq;
}

function buildCoverageLines(
  coverage: { status: string; subQuestionText: string; sourceCount: number; findingCount: number }[],
): string {
  return coverage
    .map((c) => `  - [${c.status}] ${c.subQuestionText} (${String(c.sourceCount)} sources, ${String(c.findingCount)} findings)`)
    .join('\n');
}

function buildFindingsLines(
  coverage: { subQuestionId: string; subQuestionText: string }[],
  findingsBySq: Map<string, { claim: string }[]>,
): string {
  return coverage
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
}

function buildContradictionSection(
  contradictions: { claimA: string; claimB: string; contradictionType: string }[],
): string {
  if (contradictions.length === 0) return '';
  const cLines = contradictions
    .slice(0, 5)
    .map((c) => `  - ${c.claimA} vs ${c.claimB} (${c.contradictionType})`)
    .join('\n');
  return `\nKNOWN CONTRADICTIONS:\n${cLines}`;
}

function buildModeratorPrompt(
  plan: ResearchPlan,
  coverageText: string,
  findingsText: string,
  contradictionSection: string,
): string {
  const perspectiveLines = plan.perspectives
    .map((p) => `  - ${p.name}: ${p.question}`)
    .join('\n');
  return `You are a research moderator. Review the current research state and identify the most important coverage gaps.

PERSPECTIVES:
${perspectiveLines}

SUB-QUESTION COVERAGE:
${coverageText}

FINDINGS BY SUB-QUESTION:
${findingsText}${contradictionSection}

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
}

function buildModeratorGapContext(gap: ModeratorGap): string {
  return `\n\nMODERATOR GAP FOLLOW-UP: ${gap.question}\nReason: ${gap.reason}\nRelated perspectives: ${gap.involvedPerspectives.join(', ')}\nUse this to guide your next search.`;
}

// ── AgentStrategy ─────────────────────────────────────────────────────────

export class AgentStrategy implements ResearchStrategy {
  readonly name = 'agent';
  readonly description = 'LLM-driven ReAct agent with tool-calling.';
  readonly requiresLlm = true;

  private maxIterations: number;
  private tools: AgentTool[] = [];
  private history: HistoryEntry[] = [];

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

    const priorKnowledge = appendRunStateSummary(await collectPriorKnowledge(ctx), ctx);
    const plan = await this.generatePlan(query, priorKnowledge, ctx);
    await persistPlanIfNeeded(plan, ctx);
    setupPlanSubQuestions(plan, ctx);

    const systemPrompt = this.buildSystemPrompt(plan, priorKnowledge);
    const gapAnalyzer = new GapAnalyzer(ctx.state);
    const loop = initialLoopState();
    this.restoreFromCheckpoint(ctx, loop);

    await this.runReactLoop(query, ctx, systemPrompt, gapAnalyzer, loop);
    await this.runModeratorGapFinding({ plan, query, systemPrompt, loopEndIteration: loop.iteration, ctx });

    if (ctx.abortSignal?.aborted) {
      logger.info('Agent research aborted, skipping post-processing');
      return this.abortedResult(query);
    }

    await reportAgentPhase(ctx, 'agent_complete', 90, 'Agent research loop complete, finalizing');
    return this.finalize(ctx);
  }

  async close(): Promise<void> {
    this.history = [];
  }

  private restoreFromCheckpoint(ctx: StrategyContext, loop: LoopState): void {
    if (ctx.resumeState === undefined) return;
    const rs = ctx.resumeState;
    this.history = rs.history as HistoryEntry[];
    ctx.state.fromJSON(rs.strategyState);
    ctx.budget.restore(rs.budgetState);
    loop.toolCallsSinceGapCheck = 0;
    loop.consecutiveIdleChecks = 0;
    loop.iteration = rs.stepIndex + 1;
  }

  private async replayPendingTool(ctx: StrategyContext, loop: LoopState): Promise<void> {
    const rs = ctx.resumeState;
    if (rs === undefined) return;
    if (rs.status !== 'started') return;
    const pendingTool = rs.pendingTool;
    if (!pendingTool) return;
    const toolResult = await this.executeTool(pendingTool.name, pendingTool.args);
    // History already has the assistant entry from the checkpoint — don't re-add
    recordToolResult(this.history, pendingTool.name, toolResult);
    loop.toolCallsSinceGapCheck++;
    checkpointCompleted(ctx, rs.stepIndex, pendingTool.name, pendingTool.args, toolResult, this.history);
  }

  private async runReactLoop(
    query: string,
    ctx: StrategyContext,
    systemPrompt: string,
    gapAnalyzer: GapAnalyzer,
    loop: LoopState,
  ): Promise<void> {
    await this.replayPendingTool(ctx, loop);
    while (loop.iteration < this.maxIterations) {
      if (ctx.abortSignal?.aborted) break;
      if (ctx.budget.isExhausted()) break;
      loop.iteration++;
      const gapContext = refreshGapContext(loop, ctx, gapAnalyzer);
      if (shouldStopIdle(loop)) {
        logger.info({ iteration: loop.iteration }, 'Agent stopping: no gaps, LLM idle');
        break;
      }
      const shouldBreak = await this.runSingleStep(query, ctx, systemPrompt, gapContext, loop);
      if (shouldBreak) break;
    }
  }

  private async runSingleStep(
    query: string,
    ctx: StrategyContext,
    systemPrompt: string,
    gapContext: string,
    loop: LoopState,
  ): Promise<boolean> {
    const response = await this.callLlm(systemPrompt, query, ctx, gapContext);
    if (response === null) return true;
    const parsed = parseAgentResponse(response);
    if (parsed.type === 'answer') return true;
    if (parsed.type === 'action' && parsed.tool) {
      await this.handleActionStep(ctx, parsed.thought, parsed.tool, parsed.args ?? {}, loop.iteration);
      loop.toolCallsSinceGapCheck++;
      return false;
    }
    if (parsed.type === 'error') recordParseError(this.history, parsed, response);
    return false;
  }

  private async handleActionStep(
    ctx: StrategyContext,
    thought: string,
    tool: string,
    args: Record<string, unknown>,
    iteration: number,
  ): Promise<void> {
    checkpointStarted(ctx, iteration, tool, args, thought, this.history);
    const toolResult = await this.executeTool(tool, args);
    recordAssistantAction(this.history, { thought, tool, args });
    recordToolResult(this.history, tool, toolResult);
    checkpointCompleted(ctx, iteration, tool, args, toolResult, this.history);
    await reportAgentStep(ctx, iteration, this.maxIterations, tool);
  }

  private finalize(ctx: StrategyContext): ResearchResult {
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
    void reportAgentPhase(ctx, 'agent_complete', 95, 'Agent research complete');
    return {
      report,
      timeline: [{ phase: 'complete' }],
      canonicalFindings: [...state.findings],
    };
  }

  private abortedResult(query: string): ResearchResult {
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

  // ── Plan generation ───────────────────────────────────────────────────

  private async generatePlan(
    query: string,
    priorKnowledge: string,
    ctx: StrategyContext,
  ): Promise<ResearchPlan | null> {
    if (!ctx.llm) return null;
    const prompt = buildPlanPrompt(query, priorKnowledge);
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
    if (!isValidPlanPayload(raw)) return logInvalidPlan();
    return toResearchPlan(raw);
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
    const planSection = plan === null ? '' : this.buildPlanSection(plan);
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

  private buildPlanSection(plan: ResearchPlan): string {
    const perspectiveLines = plan.perspectives
      .map((p) => `  - ${p.name}: ${p.question}`)
      .join('\n');
    return `
RESEARCH PLAN:
Scope: ${plan.scope}
Assumptions: ${plan.assumptions.join('; ')}
Perspectives to investigate:
${perspectiveLines}
Falsification questions:
${plan.falsificationQuestions.map((q) => `  - ${q}`).join('\n')}`;
  }

  // ── LLM call ──────────────────────────────────────────────────────────

  private async callLlm(
    systemPrompt: string,
    query: string,
    ctx: StrategyContext,
    gapContext?: string,
  ): Promise<string | null> {
    if (!ctx.llm) return null;
    const messages = buildLlmMessages(systemPrompt, query, gapContext, this.history);
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

  private async runModeratorGapFinding(input: ModeratorGapInput): Promise<void> {
    const { plan, query, systemPrompt, loopEndIteration, ctx } = input;
    if (!isModeratorPlanEligible(plan, ctx)) return;
    if (!hasModeratorCallBudget(ctx)) return;
    if (!hasModeratorRemainingBudget(ctx)) return;

    const gaps = await this.fetchModeratorGaps(plan, ctx);
    if (gaps.length === 0) return;
    await reportAgentPhase(
      ctx,
      'moderator_gap_followup',
      88,
      `Moderator identified ${String(gaps.length)} gap(s), running follow-up iterations`,
    );
    await this.runModeratorFollowUps({ gaps, query, systemPrompt, loopEndIteration, ctx });
  }

  private async fetchModeratorGaps(plan: ResearchPlan, ctx: StrategyContext): Promise<ModeratorGap[]> {
    const coverage = ctx.state.computeSubQuestionCoverage();
    const state = ctx.state.getState();
    const findingsBySq = groupFindingsBySubQuestion(ctx.state.getFindings());
    const prompt = buildModeratorPrompt(
      plan,
      buildCoverageLines(coverage),
      buildFindingsLines(coverage, findingsBySq),
      buildContradictionSection(state.contradictions),
    );
    if (!ctx.llm) return [];
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
    if (!resp.success) return [];
    return parseModeratorGaps(parseJsonFromText<unknown>(resp.content));
  }

  private async runModeratorFollowUps(input: {
    gaps: ModeratorGap[];
    query: string;
    systemPrompt: string;
    loopEndIteration: number;
    ctx: StrategyContext;
  }): Promise<void> {
    const { gaps, query, systemPrompt, loopEndIteration, ctx } = input;
    // At most 2 follow-up iterations using existing ReAct machinery
    const maxFollowUps = Math.min(MODERATOR_MAX_FOLLOW_UPS, gaps.length);
    for (let i = 0; i < maxFollowUps; i++) {
      if (!hasModeratorRemainingBudget(ctx)) break;
      if (ctx.abortSignal?.aborted) break;
      const gap = gaps[i];
      if (!gap) break;
      const shouldStop = await this.runModeratorFollowUpStep(query, systemPrompt, loopEndIteration + i + 1, gap, ctx);
      if (shouldStop) break;
    }
  }

  private async runModeratorFollowUpStep(
    query: string,
    systemPrompt: string,
    stepIdx: number,
    gap: ModeratorGap,
    ctx: StrategyContext,
  ): Promise<boolean> {
    const gapContext = buildModeratorGapContext(gap);
    const response = await this.callLlm(systemPrompt, query, ctx, gapContext);
    if (response === null) return true;
    const parsed = parseAgentResponse(response);
    if (parsed.type !== 'action' || !parsed.tool) return true;
    await this.handleActionStep(ctx, parsed.thought, parsed.tool, parsed.args ?? {}, stepIdx);
    return false;
  }
}
