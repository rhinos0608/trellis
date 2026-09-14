/**
 * Out-of-process pi-northstar CLI client.
 *
 * Spawns `pi-northstar call TOOL JSON_ARGS` as a child process per call
 * (Option A: CLI subprocess). No persistent child process — each call is
 * one short-lived spawn, so `close()` is a no-op retained for interface
 * symmetry with the search-mcp adapter.
 *
 * Error classification reuses research/retry.ts (`classifyError`), with the
 * same `classification`/`operation` carrier fields the search-mcp client
 * attaches, so retry + circuit-breaker behavior stays consistent across
 * providers.
 *
 * Child environment is allowlisted: only `PI_SEARCH_*` variables are forwarded.
 * No `PATH` (spawn targets are absolute resolved paths; `.mjs` runs under
 * `process.execPath`). Everything else — including `TRELLIS_LLM_API_KEY` —
 * is never passed to the child.
 */

import { spawn } from 'node:child_process';
import {
  withRetry,
  classifyError,
  CircuitBreaker,
  type RetryOptions,
} from '../../research/retry.js';
import type { ProviderCallContext } from '../types.js';

export interface PiNorthstarToolCallResult {
  /** Unwrapped CLI `data` field (the BackendCallResult: { content, details }). */
  data: unknown;
  /** Raw content blocks, when present. */
  content: unknown[];
}

/** Resolved spawn target: base command + base args (e.g. node + [script.mjs]). */
export interface ResolvedPiNorthstar {
  command: string;
  args: string[];
  /** Where the binary was found (for diagnostics). */
  source: 'path' | 'sibling' | 'local';
}

export interface PiNorthstarExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface PiNorthstarExecOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** Injectable process runner (tests substitute a fake; default uses spawn). */
export type PiNorthstarExecutor = (
  command: string,
  args: string[],
  opts: PiNorthstarExecOptions,
) => Promise<PiNorthstarExecResult>;

export interface PiNorthstarClient {
  /** Call a pi-northstar TOOL with args. Returns the unwrapped result. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: ProviderCallContext,
  ): Promise<PiNorthstarToolCallResult>;
  /** No-op (per-call spawn has nothing persistent to release). */
  close(): Promise<void>;
}

/** A client whose status/config discovery result is retained. */
export interface DiscoveredPiNorthstarClient extends PiNorthstarClient {
  readonly status: unknown;
}

/** Max stdout bytes retained per call (matches the 10 MiB MCP cap). */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Build the child environment: only `PI_SEARCH_*` entries. No `PATH`.
 * Never forwards Trellis secrets (e.g. `TRELLIS_LLM_API_KEY`).
 */
export function buildPiNorthstarEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith('PI_SEARCH_')) out[key] = value;
  }
  return out;
}

/** Default executor: spawn + collect stdout/stderr with timeout + abort. */
export function spawnPiNorthstar(
  command: string,
  args: string[],
  opts: PiNorthstarExecOptions,
): Promise<PiNorthstarExecResult> {
  return new Promise<PiNorthstarExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: buildPiNorthstarEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Raw byte chunks: concatenated then decoded once at close so a
    // multi-byte UTF-8 sequence split across chunks (or cut by the byte
    // cap) never decodes as mojibake.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        const err = new Error(
          `pi-northstar call timed out after ${String(opts.timeoutMs)}ms`,
        );
        (err as unknown as Record<string, unknown>).code = 'ETIMEDOUT';
        (err as unknown as Record<string, unknown>).operation = 'callTool';
        reject(err);
      });
    }, Math.max(1, opts.timeoutMs));
    timer.unref();

    const onAbort = (): void => {
      settle(() => {
        child.kill('SIGKILL');
        const reason: unknown = opts.signal.reason;
        reject(reason instanceof Error ? reason : new Error('Aborted'));
      });
    };
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const len = chunk.length;
      if (stdoutBytes + len > MAX_OUTPUT_BYTES) {
        const room = MAX_OUTPUT_BYTES - stdoutBytes;
        // Slice bytes, not decoded text: decoding happens once at close
        // from the concatenated buffer, so a cap cut mid-sequence yields
        // at most one trailing U+FFFD instead of mojibake.
        if (room > 0) {
          stdoutChunks.push(chunk.subarray(0, room));
          stdoutBytes += room;
        }
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += len;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      let kept = 0;
      for (const c of stderrChunks) kept += c.length;
      if (kept >= 8192) return;
      const room = 8192 - kept;
      stderrChunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
    });
    child.on('error', (err: Error) => {
      opts.signal.removeEventListener('abort', onAbort);
      settle(() => {
        // Deterministic spawn failures (bad path, non-executable) must not
        // retry: classifyError() would otherwise treat them as TRANSIENT.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'ENOENT') {
          const rec = err as unknown as Record<string, unknown>;
          rec.operation = 'callTool';
          rec.classification = 'PERMANENT';
        }
        reject(err);
      });
    });
    child.on('close', (code: number | null) => {
      opts.signal.removeEventListener('abort', onAbort);
      settle(() => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        resolve({ stdout, stderr, exitCode: code });
      });
    });
  });
}

/** Envelope codes that are client-side/usage failures — never retried. */
const PERMANENT_ENVELOPE_CODES = new Set([
  'unknown_command',
  'unknown_tool',
  'invalid_request',
  'invalid_args',
  'validation_error',
  'unsupported_option',
]);

function permanentError(message: string, code?: string, rawDetail?: string): Error {
  const err = new Error(message);
  const rec = err as unknown as Record<string, unknown>;
  rec.operation = 'callTool';
  rec.classification = 'PERMANENT';
  if (code !== undefined) rec.code = code;
  // Raw diagnostic detail preserved ONLY for local debugging; never
  // included in the default error message (avoids log injection).
  if (rawDetail !== undefined && rawDetail.length > 0) rec.rawDetail = rawDetail;
  return err;
}

/**
 * Parse one `pi-northstar call` stdout payload into an unwrapped result.
 * Throws a classified Error on process failure or `ok:false` envelopes.
 */
export function parseCallOutput(
  tool: string,
  exec: PiNorthstarExecResult,
): PiNorthstarToolCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(exec.stdout);
  } catch {
    if (exec.exitCode !== 0 && exec.exitCode !== null) {
      throw permanentError(
        `pi-northstar call ${tool} failed (exit ${String(exec.exitCode)})`,
        undefined,
        exec.stderr.trim().slice(0, 500),
      );
    }
    // Deterministic parse failure (non-JSON/truncated stdout): PERMANENT so
    // the caller does not burn 3 retries on an undeliverable payload.
    throw permanentError(`pi-northstar call ${tool} returned non-JSON output`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw permanentError(`pi-northstar call ${tool} returned unexpected output shape`);
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.ok === false) {
    const nested = envelope.error as Record<string, unknown> | undefined;
    const code = typeof nested?.code === 'string' ? nested.code : undefined;
    const message = typeof nested?.message === 'string' ? nested.message : 'unknown error';
    if (code !== undefined && PERMANENT_ENVELOPE_CODES.has(code)) {
      throw permanentError(`pi-northstar call ${tool} failed: ${code}: ${message}`, code);
    }
    const err = new Error(`pi-northstar call ${tool} failed: ${code ?? 'error'}: ${message}`);
    const rec = err as unknown as Record<string, unknown>;
    rec.operation = 'callTool';
    if (code !== undefined) rec.code = code;
    throw err;
  }
  const data = envelope.data;
  let content: unknown[] = [];
  if (data !== null && typeof data === 'object') {
    const maybe = (data as Record<string, unknown>).content;
    if (Array.isArray(maybe)) content = maybe;
  }
  return { data, content };
}

/**
 * Create a pi-northstar CLI client. Each `callTool` spawns
 * `<command> <baseArgs...> call <tool> <jsonArgs>`.
 */
export function createPiNorthstarClient(
  resolved: ResolvedPiNorthstar,
  opts?: { executor?: PiNorthstarExecutor; retry?: RetryOptions; status?: unknown },
): DiscoveredPiNorthstarClient {
  const executor = opts?.executor ?? spawnPiNorthstar;
  const breaker = new CircuitBreaker();

  const raw: PiNorthstarClient = {
    async callTool(
      name: string,
      args: Record<string, unknown>,
      ctx: ProviderCallContext,
    ): Promise<PiNorthstarToolCallResult> {
      const timeoutMs = Math.max(1, ctx.deadlineAt - Date.now());
      const exec = await executor(
        resolved.command,
        [...resolved.args, 'call', name, JSON.stringify(args)],
        { signal: ctx.signal, timeoutMs },
      );
      return parseCallOutput(name, exec);
    },
    close: () => Promise.resolve(),
  };

  const retryClient: PiNorthstarClient = {
    async callTool(
      name: string,
      args: Record<string, unknown>,
      ctx: ProviderCallContext,
    ): Promise<PiNorthstarToolCallResult> {
      return withRetry(() => raw.callTool(name, args, ctx), {
        ...opts?.retry,
        signal: ctx.signal,
        shouldRetry: (err: unknown) => {
          const record = err as Record<string, unknown>;
          if (record.classification === 'PERMANENT') return false;
          return classifyError(err) === 'TRANSIENT';
        },
      });
    },
    close: () => {
      return raw.close();
    },
  };

  const client: DiscoveredPiNorthstarClient = Object.assign(
    {
      async callTool(
        name: string,
        args: Record<string, unknown>,
        ctx: ProviderCallContext,
      ): Promise<PiNorthstarToolCallResult> {
        return breaker.execute(() => retryClient.callTool(name, args, ctx));
      },
      close: () => {
      return retryClient.close();
    },
    } satisfies PiNorthstarClient,
    { status: opts?.status ?? null },
  );
  return client;
}
