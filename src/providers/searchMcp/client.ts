/**
 * Out-of-process MCP client that spawns search-mcp via stdio transport.
 *
 * Communicates over the real MCP protocol — no TypeScript imports of
 * search-mcp internals. Spawns the server as a child process using
 * config().searchProvider.command and args.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { TrellisConfig } from '../../config/index.js';
import { logger } from '../../logger.js';

export interface ToolCallResult {
  /** Parsed tool result data (JSON-deserialized from MCP response). */
  data: unknown;
  /** Raw MCP content blocks. */
  content: unknown[];
}

export interface SearchMcpClient {
  /** Call an MCP tool by name with arguments. Returns parsed result. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  /** Shut down the transport and child process. */
  close(): Promise<void>;
}

/**
 * Create an MCP client that spawns search-mcp as a child process.
 * Connects via stdio transport and initializes the MCP handshake.
 */
export async function createSearchMcpClient(
  cfg: TrellisConfig,
): Promise<SearchMcpClient> {
  const { command, args } = cfg.searchProvider;

  const transport = new StdioClientTransport({
    command,
    args,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'trellis', version: '0.1.0' });
  await client.connect(transport);

  // Verify connection and list available tools
  const { tools } = await client.listTools();
  logger.info(
    { tools: tools.map((t) => t.name) },
    'search-mcp server connected, tools discovered',
  );

  return {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolCallResult> {
      const result = await client.callTool({ name, arguments: args });
      return parseToolResult(result);
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

/**
 * Create an MCP client from an existing transport (for testing).
 */
export async function createSearchMcpClientWithTransport(
  transport: StdioClientTransport,
): Promise<SearchMcpClient> {
  const client = new Client({ name: 'trellis', version: '0.1.0' });
  await client.connect(transport);

  return {
    async callTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolCallResult> {
      const result = await client.callTool({ name, arguments: args });
      return parseToolResult(result);
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}

/**
 * Parse the raw MCP CallToolResult into a usable ToolCallResult.
 *
 * search-mcp wraps responses with makeResult() -> successResponse(), producing
 * a JSON-RPC response where the text content is JSON:
 * { tool: "...", data: <actual result>, duration: N }
 *
 * The MCP SDK's callTool() returns { content: [{ type: "text", text: "..." }], isError?: boolean }.
 */
function parseToolResult(raw: unknown): ToolCallResult {
  if (raw === null || typeof raw !== 'object') {
    return { data: raw, content: [] };
  }

  const result = raw as Record<string, unknown>;

  // Check for MCP error responses
  if (result.isError === true) {
    const textContent = extractTextContent(result);
    throw new Error(`MCP tool error: ${textContent ?? 'unknown error'}`);
  }

  const content = Array.isArray(result.content) ? result.content : [];
  const textContent = extractTextContent(result);

  if (textContent === null) {
    return { data: undefined, content };
  }

  // Try to parse the text as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(textContent);
  } catch {
    // Not JSON — return as-is
    return { data: textContent, content };
  }

  // search-mcp wraps with makeResult -> { tool, data, duration, meta }
  // Unwrap the "data" field if present
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'data' in parsed &&
    !('content' in parsed)
  ) {
    return { data: (parsed as Record<string, unknown>).data, content };
  }

  return { data: parsed, content };
}

/** Extract the first text blob from an MCP CallToolResult. */
function extractTextContent(result: Record<string, unknown>): string | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as Record<string, unknown>).type === 'text'
    ) {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}
