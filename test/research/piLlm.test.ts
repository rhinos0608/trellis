import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../../src/research/llm/client.js';
import {
  buildPiCliArgs,
  buildPiCliEnv,
  isPiModelId,
  resolvePiCliAuth,
  type PiCliExecutor,
} from '../../src/research/llm/piCli.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function tempPiLayout(): { root: string; home: string; bin: string; pi: string } {
  const root = mkdtempSync(join(tmpdir(), 'trellis-pi-llm-'));
  cleanup.push(root);
  const home = join(root, 'home');
  const agent = join(home, '.pi', 'agent');
  const bin = join(root, 'bin');
  mkdirSync(agent, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(agent, 'auth.json'), '{}');
  const pi = join(bin, 'pi');
  writeFileSync(pi, '#!/bin/sh\nexit 0\n');
  chmodSync(pi, 0o755);
  return { root, home, bin, pi };
}

describe('Pi model transport', () => {
  it('recognizes exact provider/model IDs without thinking suffixes', () => {
    expect(isPiModelId('openai-codex/gpt-5.6-sol')).toBe(true);
    expect(isPiModelId('openrouter/openai/gpt-5')).toBe(true);
    expect(isPiModelId('gpt-5.6-sol')).toBe(false);
    expect(isPiModelId('openai-codex/gpt-5.6-sol:high')).toBe(false);
  });

  it('detects Pi only when both executable and auth store exist', () => {
    const { home, bin, pi } = tempPiLayout();
    expect(resolvePiCliAuth({ home, pathEnv: bin, env: {} })).toEqual({
      command: pi,
      authPath: join(home, '.pi', 'agent', 'auth.json'),
    });
    rmSync(join(home, '.pi', 'agent', 'auth.json'));
    expect(resolvePiCliAuth({ home, pathEnv: bin, env: {} })).toBeUndefined();
  });

  it('does not forward Trellis or provider API keys into the Pi child', () => {
    const env = buildPiCliEnv({
      HOME: '/tmp/home',
      PATH: '/usr/bin',
      PI_CODING_AGENT_DIR: '/tmp/pi-agent',
      OPENAI_API_KEY: 'openai-secret',
      TRELLIS_LLM_API_KEY: 'trellis-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
    });
    expect(env.HOME).toBe('/tmp/home');
    expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/pi-agent');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TRELLIS_LLM_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('builds a non-interactive no-tools invocation with only a model ID', () => {
    const args = buildPiCliArgs(
      'openai-codex/gpt-5.6-sol',
      [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Say hello.' },
      ],
      'json_object',
    );
    expect(args).toContain('--print');
    expect(args).toContain('--no-session');
    expect(args).toContain('--no-tools');
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('openai-codex/gpt-5.6-sol');
    expect(args).not.toContain('--api-key');
  });

  it('routes LlmClient through Pi without a base URL or API key', async () => {
    let seenCommand = '';
    let seenArgs: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const executor: PiCliExecutor = (command, args, opts) => {
      seenCommand = command;
      seenArgs = args;
      seenEnv = opts.env;
      return Promise.resolve({
        stdout: '{"answer":"ok"}\n',
        stderr: '',
        exitCode: 0,
      });
    };
    const client = new LlmClient({
      model: 'openai-codex/gpt-5.6-sol',
      piCommand: '/opt/homebrew/bin/pi',
      piExecutor: executor,
    });
    const response = await client.callJSON<{ answer: string }>({
      model: 'orchestrator',
      responseFormat: 'json_object',
      messages: [{ role: 'user', content: 'Return JSON.' }],
    });
    expect(response.success).toBe(true);
    if (response.success) expect(response.data.answer).toBe('ok');
    expect(seenCommand).toBe('/opt/homebrew/bin/pi');
    expect(seenArgs).toContain('openai-codex/gpt-5.6-sol');
    expect(seenArgs).not.toContain('--api-key');
    expect(seenEnv.OPENAI_API_KEY).toBeUndefined();
  });
});
