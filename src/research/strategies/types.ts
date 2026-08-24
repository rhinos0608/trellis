/**
 * Strategy interface for deep research.
 * Ported from search-mcp strategies/types.ts.
 */

import type { ResearchStateEngine } from '../state.js';
import type { BudgetTracker } from '../budget.js';
import type { LlmClient } from '../llm/client.js';
import type { ResearchProvider } from '../../providers/types.js';
import type { ResearchResult, ResearchDepth } from '../internalTypes.js';
import type { RunContext } from '../types.js';
import type { TrellisConfig } from '../../config/index.js';

// ── Progress callback ──────────────────────────────────────────────────────

export type ProgressCallback = (
  progress: number,
  message?: string,
  phase?: string,
  partials?: {
    sourceCount?: number;
    findingCount?: number;
    subQuestionCount?: number;
    classification?: string;
  },
) => void | Promise<void>;

// ── StrategyContext ───────────────────────────────────────────────────────

export interface StrategyContext {
  state: ResearchStateEngine;
  budget: BudgetTracker;
  provider: ResearchProvider;
  llm?: LlmClient | undefined;
  config: TrellisConfig;
  runContext: RunContext;
  abortSignal?: AbortSignal | undefined;
  onProgress?: ProgressCallback | undefined;
  depth: ResearchDepth;
  deterministic?: boolean;
}

// ── ResearchStrategy ──────────────────────────────────────────────────────

export interface ResearchStrategy {
  readonly name: string;
  readonly description: string;
  readonly requiresLlm: boolean;
  analyze(query: string, ctx: StrategyContext): Promise<ResearchResult>;
  close?(): Promise<void>;
}

// ── StrategyFactory ───────────────────────────────────────────────────────

export type StrategyFactory = (ctx: StrategyContext) => ResearchStrategy;
