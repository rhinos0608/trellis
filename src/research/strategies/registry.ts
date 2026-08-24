/**
 * Strategy registry — holds registered research strategies.
 * Ported from search-mcp strategies/registry.ts — no module singleton.
 */

import type { ResearchStrategy, StrategyContext, StrategyFactory } from './types.js';

export interface StrategyInfo {
  name: string;
  description: string;
  requiresLlm: boolean;
}

export class StrategyRegistry {
  private factories = new Map<string, StrategyFactory>();

  register(name: string, factory: StrategyFactory): void {
    this.factories.set(name, factory);
  }

  create(name: string, ctx: StrategyContext): ResearchStrategy {
    const factory = this.factories.get(name);
    if (!factory) {
      const available = [...this.factories.keys()].join(', ');
      throw new Error(`Unknown strategy: ${name}. Available: ${available}`);
    }
    return factory(ctx);
  }

  selectDefault(ctx: StrategyContext): string {
    if (ctx.depth === 'tree') return 'tree';
    if (ctx.deterministic) return 'pipeline';
    if (ctx.llm) return 'agent';
    return 'pipeline';
  }

  listAvailable(ctx: StrategyContext): StrategyInfo[] {
    return [...this.factories.entries()].map(([, factory]) => {
      const s = factory(ctx);
      return {
        name: s.name,
        description: s.description,
        requiresLlm: s.requiresLlm,
      };
    });
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }
}
