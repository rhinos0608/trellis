import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export interface ResolvedPiCli {
  command: string;
  authPath: string;
}

export interface PiCliExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface PiCliExecOptions {
  signal: AbortSignal;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export type PiCliExecutor = (
  command: string,
  args: string[],
  opts: PiCliExecOptions,
) => Promise<PiCliExecResult>;

// eslint-disable-next-line no-control-regex
const MODEL_ID = /^(?![\s\S]*[\x00-\x1f\x7f])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+/-]+$/;
const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max)$/;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function isPiModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    MODEL_ID.test(value) &&
    !THINKING_SUFFIX.test(value)
  );
}

function regularFile(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolvePiCliAuth(opts?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  pathEnv?: string;
}): ResolvedPiCli | undefined {
  const env = opts?.env ?? process.env;
  const home = opts?.home ?? env.HOME ?? homedir();
  const configuredAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir && configuredAgentDir.length > 0
    ? configuredAgentDir
    : join(home, '.pi', 'agent');
  const authPath = join(agentDir, 'auth.json');
  if (!regularFile(authPath)) return undefined;

  const pathEnv = opts?.pathEnv ?? env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return { command: candidate, authPath };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function buildPiCliEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'PI_CODING_AGENT_DIR',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ] as const;
  const out: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const key of allowed) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function spawnPiCli(
  command: string,
  args: string[],
  opts: PiCliExecOptions,
): Promise<PiCliExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new Error(`Pi model call timed out after ${String(opts.timeoutMs)}ms`));
      });
    }, Math.max(1, opts.timeoutMs));
    timer.unref();

    const onAbort = (): void => {
      finish(() => {
        child.kill('SIGKILL');
        const reason: unknown = opts.signal.reason;
        reject(reason instanceof Error ? reason : new Error('Pi model call aborted'));
      });
    };
    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const room = MAX_OUTPUT_BYTES - stdoutBytes;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stdout.push(kept);
      stdoutBytes += kept.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const room = 16_384 - stderrBytes;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderr.push(kept);
      stderrBytes += kept.length;
    });
    child.on('error', (error) => {
      finish(() => { reject(error); });
    });
    child.on('close', (exitCode) => {
      finish(() => {
        resolvePromise({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
        });
      });
    });
  });
}

export function buildPiCliArgs(
  model: string,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  responseFormat?: 'text' | 'json_object',
): string[] {
  const systems = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content);
  if (responseFormat === 'json_object') {
    systems.push('Return only valid JSON. Do not wrap the JSON in markdown fences.');
  }
  const systemPrompt = systems.join('\n\n').trim() || 'You are a helpful assistant.';
  const prompt = messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}:\n${message.content}`)
    .join('\n\n')
    .trim();

  return [
    '--print',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--mode',
    'text',
    '--model',
    model,
    '--system-prompt',
    systemPrompt,
    '--',
    prompt,
  ];
}
