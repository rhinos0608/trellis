import { describe, expect, it } from 'vitest';
import { ResearchToolSchema } from '../../../src/mcp/schemas.js';

describe('MCP research input bounds', () => {
  it('rejects blank queries and invalid pagination values', () => {
    expect(ResearchToolSchema.safeParse({ action: 'start', query: '   ' }).success).toBe(false);
    expect(ResearchToolSchema.safeParse({ action: 'list', limit: 0 }).success).toBe(false);
    expect(ResearchToolSchema.safeParse({ action: 'list', beforeSeq: -1 }).success).toBe(false);
  });

  it('rejects non-positive retry deadlines', () => {
    expect(ResearchToolSchema.safeParse({ action: 'retry', runId: 'run-1', deadlineMs: 0 }).success).toBe(false);
  });
});
