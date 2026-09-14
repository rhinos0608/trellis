/**
 * Fix: when required tools are missing, createSearchMcpProvider must close
 * the already-connected client before re-throwing — otherwise the spawned
 * MCP child process leaks.
 */
import { describe, expect, it, vi } from 'vitest';

const closeMock = vi.fn(async (): Promise<void> => {});

vi.mock('../../../src/providers/searchMcp/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/searchMcp/client.js')>();
  return {
    ...actual,
    createSearchMcpClient: vi.fn(async () => ({
      toolNames: ['youtube'], // missing web_search/web_crawl
      callTool: async () => ({ data: null, content: [] }),
      close: closeMock,
    })),
  };
});

const { createSearchMcpProvider } = await import('../../../src/providers/searchMcp/index.js');
import type { TrellisConfig } from '../../../src/config/index.js';

function makeConfig(): TrellisConfig {
  return {
    storage: { dbPath: ':memory:' },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'echo', args: ['x'] },
    piNorthstar: { autoDetect: false },
    logLevel: 'silent',
  };
}

describe('missing-tools startup does not leak the client', () => {
  it('closes the connected client before re-throwing the validation error', async () => {
    await expect(createSearchMcpProvider(makeConfig()))
      .rejects.toThrow(/missing required tool\(s\): web_search, web_crawl/);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
