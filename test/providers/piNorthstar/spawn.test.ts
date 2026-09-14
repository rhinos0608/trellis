/**
 * Integration tests for the real spawn path (`spawnPiNorthstar`).
 * Spawns `node -e` as a fake pi-northstar — no binary required.
 * Default-off behavior is untouched: these tests call the executor directly
 * with an injected script, never touching provider autodetect.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCallOutput,
  spawnPiNorthstar,
} from '../../../src/providers/piNorthstar/client.js';

const NODE = process.execPath;

function opts(overrides?: { signal?: AbortSignal; timeoutMs?: number }): {
  signal: AbortSignal;
  timeoutMs: number;
} {
  return {
    signal: overrides?.signal ?? new AbortController().signal,
    timeoutMs: overrides?.timeoutMs ?? 10_000,
  };
}

describe('spawnPiNorthstar', () => {
  it('captures ok stdout for parseCallOutput', async () => {
    const exec = await spawnPiNorthstar(
      NODE,
      ['-e', 'console.log(JSON.stringify({ ok: true, data: { content: [], details: { a: 1 } } }))'],
      opts(),
    );
    expect(exec.exitCode).toBe(0);
    const out = parseCallOutput('web_search', exec);
    expect(out.data).toEqual({ content: [], details: { a: 1 } });
  });

  it('surfaces envelope errors with exit 0 stdout', async () => {
    const exec = await spawnPiNorthstar(
      NODE,
      [
        '-e',
        'console.log(JSON.stringify({ ok: false, error: { code: "invalid_args", message: "bad" } }))',
      ],
      opts(),
    );
    expect(() => parseCallOutput('web_search', exec)).toThrowError(/invalid_args/);
    try {
      parseCallOutput('web_search', exec);
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Record<string, unknown>).classification).toBe('PERMANENT');
    }
  });

  it('kills on timeout with ETIMEDOUT', async () => {
    await expect(
      spawnPiNorthstar(NODE, ['-e', 'setTimeout(() => {}, 30_000)'], opts({ timeoutMs: 100 })),
    ).rejects.toThrowError(/timed out/);
    try {
      await spawnPiNorthstar(
        NODE,
        ['-e', 'setTimeout(() => {}, 30_000)'],
        opts({ timeoutMs: 100 }),
      );
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    }
  });

  it('kills on abort', async () => {
    const controller = new AbortController();
    const pending = spawnPiNorthstar(
      NODE,
      ['-e', 'setTimeout(() => {}, 30_000)'],
      opts({ signal: controller.signal, timeoutMs: 30_000 }),
    );
    setTimeout(() => {
      controller.abort(new Error('stop'));
    }, 50);
    await expect(pending).rejects.toThrowError(/stop/);
  });

  it('truncates stdout at the byte cap without mojibake', async () => {
    // 4M × U+20AC (3 bytes each) = 12 MiB > 10 MiB cap.
    const exec = await spawnPiNorthstar(
      NODE,
      ['-e', 'process.stdout.write("€".repeat(4 * 1024 * 1024))'],
      opts({ timeoutMs: 30_000 }),
    );
    expect(exec.exitCode).toBe(0);
    // Raw bytes were capped at exactly MAX_BYTES = 3_495_253 full € + 1 stray
    // byte; the stray byte decodes to one trailing U+FFFD (which re-encodes
    // to 3 bytes, so byteLength of the string reads MAX_BYTES + 2).
    expect(exec.stdout.length).toBe(3_495_253 + 1);
    // No lone surrogates: every multi-byte sequence decoded cleanly.
    expect(exec.stdout).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(exec.stdout).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // 10 MiB is not a multiple of 3, so the cap cuts one € mid-sequence:
    // exactly one trailing replacement char, none elsewhere.
    expect(exec.stdout.endsWith('�')).toBe(true);
    expect(exec.stdout.slice(0, -1)).not.toContain('�');
  }, 30_000);
});
