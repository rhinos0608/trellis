import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig piNorthstar', () => {
  it('defaults to autodetect off (single switch, no command/args)', () => {
    const cfg = loadConfig();
    expect(cfg.piNorthstar.autoDetect).toBe(false);
    expect(cfg.piNorthstar).toEqual({ autoDetect: false });
  });

  it('parses AUTODETECT truthiness', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'True']) {
      vi.stubEnv('TRELLIS_PI_NORTHSTAR_AUTODETECT', truthy);
      expect(loadConfig().piNorthstar.autoDetect).toBe(true);
    }
    for (const falsy of ['0', 'false', 'yes', '', 'anything-else']) {
      vi.stubEnv('TRELLIS_PI_NORTHSTAR_AUTODETECT', falsy);
      expect(loadConfig().piNorthstar.autoDetect).toBe(false);
    }
  });

  it('ignores legacy COMMAND/ARGS env (single on-switch only)', () => {
    vi.stubEnv('TRELLIS_PI_NORTHSTAR_COMMAND', '/usr/local/bin/pi-northstar');
    vi.stubEnv('TRELLIS_PI_NORTHSTAR_ARGS', '--flag value');
    const cfg = loadConfig();
    expect(cfg.piNorthstar).toEqual({ autoDetect: false });
  });
});
