/**
 * Process-wide lazy provider owner — exactly ONE search-mcp provider instance
 * (and therefore one MCP child process) per process, shared by every
 * entrypoint (MCP server, HTTP server, CLI). closeProvider() terminates it;
 * idempotent and safe to call even if the provider was never created.
 */

import type { ResearchProvider } from '../types.js';
import { loadConfig } from '../../config/index.js';
import type { TrellisConfig } from '../../config/index.js';
import { logger, safeErrorLog } from '../../logger.js';

let instance: ResearchProvider | null = null;
let creating: Promise<ResearchProvider> | null = null;
/** Shared in-flight close — concurrent closeProvider() calls await ONE close. */
let closing: Promise<void> | null = null;
/** Bumped when a close starts; creations from an older generation must not publish. */
let closeGeneration = 0;

async function createProvider(config?: TrellisConfig): Promise<ResearchProvider> {
  const cfg = config ?? loadConfig();
  if (cfg.searchProvider.args.length === 0) {
    throw new Error(
      'Search provider not configured. Set TRELLIS_SEARCH_MCP_PATH to point at the search-mcp entrypoint, then retry.',
    );
  }
  try {
    const { createSearchMcpProvider } = await import('./index.js');
    return await createSearchMcpProvider(cfg);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to connect to search-mcp provider: ${msg}. Is search-mcp built and reachable?`,
      { cause: err },
    );
  }
}

/**
 * Get (or lazily create) the process-wide provider. Concurrent first calls
 * share one creation attempt.
 */
export async function getProvider(
  config?: TrellisConfig,
  factory: (cfg: TrellisConfig) => Promise<ResearchProvider> = createProvider,
): Promise<ResearchProvider> {
  for (;;) {
    // Never return an instance a concurrent close is tearing down (or is
    // about to tear down via an awaited in-flight creation).
    while (closing !== null) await closing;
    if (instance) return instance;
    const gen = closeGeneration;
    creating ??= factory(config ?? loadConfig())
      .then((provider) => {
        // If a close captured this creation mid-flight, IT owns shutting the
        // provider down — publishing here would cache a closed singleton.
        if (gen === closeGeneration) {
          instance = provider;
          logger.info('Search provider initialized');
        }
        return provider;
      })
      .finally(() => {
        creating = null;
      });
    const provider = await creating;
    if (gen === closeGeneration) return provider;
    // A concurrent close consumed this creation — loop and build a fresh one.
  }
}

/** Close and forget the cached provider. Idempotent; never throws. */
export async function closeProvider(): Promise<void> {
  closing ??= (async () => {
    closeGeneration++;
    // Capture any in-flight creation so ITS provider gets closed too instead
    // of leaking a freshly-spawned child process no one will ever close.
    const pending = creating;
    creating = null;
    const cached = instance;
    instance = null;
    const created = pending === null ? null : await pending.catch(() => null);
    try {
      await (cached ?? created)?.close?.();
    } catch (err: unknown) {
      logger.warn({ ...safeErrorLog(err) }, 'Provider close failed');
    }
  })();
  try {
    await closing;
  } finally {
    closing = null;
  }
}

/** Test hook: drop cached instance without closing (owner tests only). */
export function resetProviderOwnerForTests(): void {
  instance = null;
  creating = null;
  closing = null;
  closeGeneration++;
}
