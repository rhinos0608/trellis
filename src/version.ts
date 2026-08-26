/**
 * Single source of truth for the Trellis version string.
 *
 * Reads the root package.json ONCE at module load, using the same dynamic
 * read mechanism previously inlined in src/cli/main.ts. Resolved relative
 * to this module so it works from src/ (tsx/vitest) and from dist/ after
 * tsc compilation.
 */
import { readFileSync } from 'node:fs';

function readVersion(): string {
  // src/version.ts → ../package.json ; dist/version.js → ../../package.json
  for (const candidate of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')) as {
        version?: string;
      };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // Candidate location does not exist (src vs dist layout) — try the next one.
    }
  }
  return 'unknown';
}

export const TRELLIS_VERSION: string = readVersion();
