/**
 * Phase 16 Stage A — single version source.
 * TRELLIS_VERSION must match package.json and be the only version literal
 * used across CLI manifests, MCP identity, provider client, and HTTP probes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TRELLIS_VERSION } from '../src/version.js';

describe('TRELLIS_VERSION single source', () => {
  it('matches root package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    expect(pkg.version).toBeTruthy();
    expect(TRELLIS_VERSION).toBe(pkg.version);
  });
});
