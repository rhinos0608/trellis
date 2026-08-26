/**
 * Out-of-process MCP client that spawns search-mcp via stdio transport.
 *
 * Communicates over the real MCP protocol — no TypeScript imports of
 * search-mcp internals. Spawns the server as a child process using
 * config().searchProvider.command and args.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TrellisConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import { withRetry, classifyError, CircuitBreaker, type RetryOptions } from '../../research/retry.js';
import { TRELLIS_VERSION } from '../../version.js';

export interface ToolCallResult {
  /** Parsed tool result data (JSON-deserialized from MCP response). */
  data: unknown;
  /** Raw MCP content blocks. */
  content: unknown[];
}

export interface SearchMcpCallOptions {
  signal: AbortSignal;
  deadlineAt: number;
}

export interface SearchMcpClient {
  /** Call an MCP tool by name with arguments. Returns parsed result. */
  callTool(name: string, args: Record<string, unknown>, options: SearchMcpCallOptions): Promise<ToolCallResult>;
  /** Shut down the transport and child process. */
  close(): Promise<void>;
}

/** A client whose connect-time listTools() result is retained. */
export interface DiscoveredSearchMcpClient extends SearchMcpClient {
  /** Tool names reported by the server at connect time. */
  readonly toolNames: string[];
}

/**
 * Create an MCP client that spawns search-mcp as a child process.
 * Connects via stdio transport and initializes the MCP handshake.
 */
export async function createSearchMcpClient(
  cfg: TrellisConfig,
): Promise<DiscoveredSearchMcpClient> {
  const { command, args } = cfg.searchProvider;

  // Explicit 10 MiB cap — SDK default is also 10 MiB but we pin it
  // so a future SDK version change can't silently alter this safety bound.
  const MAX_MCP_BUFFER = 10 * 1024 * 1024;
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: 'pipe',
    maxBufferSize: MAX_MCP_BUFFER,
  });

  const client = new Client({ name: 'trellis', version: TRELLIS_VERSION });
  await client.connect(transport);

  // Verify connection and discover available tools (kept for capability mapping)
  const { tools } = await client.listTools();
  const toolNames = tools.map((t) => t.name);
  logger.info(
    { tools: toolNames },
    'search-mcp server connected, tools discovered',
  );

  const retryClient = wrapClientWithRetry({
    async callTool(
      name: string,
      args: Record<string, unknown>,
      options: SearchMcpCallOptions,
    ): Promise<ToolCallResult> {
      const remainingMs = Math.max(1, options.deadlineAt - Date.now());
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { signal: options.signal, timeout: remainingMs, maxTotalTimeout: remainingMs },
      );
      return parseToolResult(result);
    },

    async close(): Promise<void> {
      await client.close();
    },
  });

  // ONE breaker per client (persists across calls), OUTSIDE the retry wrapper:
  // an exhausted retry sequence counts as ONE failure toward the window, and
  // an open breaker short-circuits before any retry attempt is made.
  const breaker = new CircuitBreaker();
  return withDiscoveredTools({
    async callTool(
      name: string,
      args: Record<string, unknown>,
      options: SearchMcpCallOptions,
    ): Promise<ToolCallResult> {
      return breaker.execute(() => retryClient.callTool(name, args, options));
    },

    close: () => retryClient.close(),
  }, toolNames);
}

/** Attach discovered tool names to a client (shared by both factories). */
function withDiscoveredTools(client: SearchMcpClient, toolNames: string[]): DiscoveredSearchMcpClient {
  return Object.assign(client, { toolNames });
}

/**
 * Wrap a SearchMcpClient with retry logic for transient failures.
 * Exported for direct use and testing; also applied inside createSearchMcpClient.
 */
export function wrapClientWithRetry(
  client: SearchMcpClient,
  opts?: RetryOptions,
): SearchMcpClient {
  return {
    async callTool(
      name: string,
      args: Record<string, unknown>,
      options: SearchMcpCallOptions,
    ): Promise<ToolCallResult> {
      return withRetry(() => client.callTool(name, args, options), {
        ...opts,
        signal: options.signal,
        shouldRetry: (err) => {
          const record = err as Record<string, unknown>;
          if (record.classification === 'PERMANENT') return false;
          return opts?.shouldRetry ? opts.shouldRetry(err) : classifyError(err) === 'TRANSIENT';
        },
      });
    },
    close: () => client.close(),
  };
}

/**
 * Create an MCP client from an existing transport (for testing).
 */
export async function createSearchMcpClientWithTransport(
  transport: Transport,
): Promise<DiscoveredSearchMcpClient> {
  const client = new Client({ name: 'trellis', version: TRELLIS_VERSION });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const toolNames = tools.map((t) => t.name);

  return withDiscoveredTools({
    async callTool(
      name: string,
      args: Record<string, unknown>,
      options: SearchMcpCallOptions,
    ): Promise<ToolCallResult> {
      const remainingMs = Math.max(1, options.deadlineAt - Date.now());
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { signal: options.signal, timeout: remainingMs, maxTotalTimeout: remainingMs },
      );
      return parseToolResult(result);
    },

    async close(): Promise<void> {
      await client.close();
    },
  }, toolNames);
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
    const err = new Error('MCP tool call failed');
    (err as unknown as Record<string, unknown>).operation = 'callTool';
    (err as unknown as Record<string, unknown>).classification = 'PERMANENT';
    // Raw diagnostic detail preserved ONLY for local debugging;
    // never included in the default error message (avoids log injection).
    if (typeof textContent === 'string' && textContent.length > 0) {
      (err as unknown as Record<string, unknown>).rawDetail = textContent;
    }
    // Preserve the JSON-RPC code when the server includes one so
    // classifyError() can tell validation failures from transient ones.
    const rpcCode = result.code;
    if (typeof rpcCode === 'number') {
      (err as unknown as Record<string, unknown>).code = rpcCode;
    }
    throw err;
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
