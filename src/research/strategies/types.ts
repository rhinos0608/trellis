/**
 * Strategy interface for deep research.
 * Ported from search-mcp strategies/types.ts.
 */

import type { ResearchStateEngine } from '../state.js';
import type { BudgetTracker } from '../budget.js';
import type { LlmClient } from '../llm/client.js';
import { randomUUID } from 'node:crypto';
import type { ProviderCallContext, ResearchProvider } from '../../providers/types.js';
import type { ResearchResult, ResearchDepth } from '../internalTypes.js';
import type { RunContext, RunProgressUpdate } from '../types.js';
import type { TrellisConfig } from '../../config/index.js';

// ── Resume state ─────────────────────────────────────────────────────────

/** State carried from a step checkpoint for automatic resume after crash. */
export interface ResumeState {
  stepIndex: number;
  status: 'started' | 'completed';
  history: unknown[];
  strategyState: import('../internalTypes.js').ResearchState;
  budgetState: import('../internalTypes.js').BudgetState;
  pendingTool?: { name: string; args: Record<string, unknown>; thought?: string };
}

// ── StrategyContext ───────────────────────────────────────────────────────

// ── Research plan (STORM-style) ──────────────────────────────────────────

export interface ResearchPlanPerspective {
  /** e.g. "historian/primary-source", "implementer/practitioner", "skeptic/critic" */
  name: string;
  /** The sub-question from this perspective */
  question: string;
}

export interface ResearchPlan {
  scope: string;
  assumptions: string[];
  perspectives: ResearchPlanPerspective[];
  falsificationQuestions: string[];
}

export function providerCallContext(
  ctx: StrategyContext,
  fields?: { phase?: string; subquestionId?: string },
): ProviderCallContext {
  // Prefer the scheduler-provided call context: real run deadline, real trace
  // root. Each strategy phase gets a fresh spanId under the same trace.
  const root = ctx.providerCtx;
  return {
    signal: root?.signal ?? ctx.abortSignal ?? new AbortController().signal,
    runId: root?.runId ?? ctx.runContext.researchRunId,
    deadlineAt: root?.deadlineAt ?? Date.now() + 5 * 60_000,
    trace: {
      traceId: root?.trace.traceId ?? `${ctx.runContext.researchRunId}-${randomUUID().slice(0, 12)}`,
      spanId: randomUUID().slice(0, 12),
      ...(root !== undefined ? { parentSpanId: root.trace.spanId } : {}),
      ...fields,
    },
  };
}

export interface StrategyContext {
  state: ResearchStateEngine;
  budget: BudgetTracker;
  provider: ResearchProvider;
  llm?: LlmClient | undefined;
  config: TrellisConfig;
  runContext: RunContext;
  abortSignal?: AbortSignal | undefined;
  /** Scheduler-provided ProviderCallContext (real deadlineAt/trace). Set for scheduled runs. */
  providerCtx?: ProviderCallContext | undefined;
  reportProgress: (update: RunProgressUpdate) => Promise<void>;
  depth: ResearchDepth;
  deterministic?: boolean;
  /** Persist a research plan as an event (RESEARCH_PLAN_CREATED or REVISED). */
  persistPlan?: (
    plan: ResearchPlan,
    kind: 'created' | 'revised',
    reason?: string,
  ) => Promise<void>;
  /** Retrieve prior knowledge (claims/gaps) for this family from durable state. */
  getPriorKnowledge?: () => Promise<
    { knownClaims: string[]; knownGaps: string[] } | undefined
  >;
  /** Resume state from a step checkpoint — set by scheduler for interrupted runs. */
  resumeState?: ResumeState;
  /** Checkpoint a step boundary — called by strategy before/after tool execution. */
  checkpointStep?: (stepIndex: number, status: 'started' | 'completed', pendingWrite: unknown, history: unknown[]) => void;
}

// ── ResearchStrategy ──────────────────────────────────────────────────────

export interface ResearchStrategy {
  readonly name: string;
  readonly description: string;
  readonly requiresLlm: boolean;
  analyze(query: string, ctx: StrategyContext): Promise<ResearchResult>;
  close?(): Promise<void>;
}

