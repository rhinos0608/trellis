/**
 * Phase 16 Stage A — MCP server must exit cleanly (code 0) within a bounded
 * time on SIGTERM: scheduler shutdown → provider close → transport close →
 * DB last, then the event loop drains naturally.
 *
 * Uses the real subprocess-spawn convention from test/cli/cli.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('MCP server SIGTERM shutdown', () => {
  it('exits 0 within a bounded time after SIGTERM', { timeout: 30_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-mcp-sig-'));
    const bin = path.join(import.meta.dirname ?? '.', '..', '..', 'dist', 'mcp', 'server.js');
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, TRELLIS_DB_PATH: path.join(dir, 'test.db'), LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));

    try {
      // Wait until the server is up (it connects the stdio transport and logs).
      const deadline = Date.now() + 15_000;
      while (!/started|listening|server/i.test(stderrChunks.join('')) || child.exitCode !== null) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Give the bootstrap a beat to finish connecting the transport.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const startedAt = Date.now();
      child.kill('SIGTERM');
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP server did not exit within 10s of SIGTERM')), 10_000);
        child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(exit).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
