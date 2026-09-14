/**
 * Generation-guarded provider owner registry: name → shared provider.
 *
 * Extends the searchMcp/owner.ts pattern (left untouched) to any named
 * provider — e.g. `pi-northstar` — so every entrypoint shares exactly one
 * instance per provider name. `closeOwnedProvider()` forgets the cached
 * instance(s); idempotent and safe to call when nothing was created.
 */

import type { ResearchProvider } from './types.js';
import { loadConfig } from '../config/index.js';
import type { TrellisConfig } from '../config/index.js';
import { logger, safeErrorLog } from '../logger.js';

interface OwnerEntry {
  instance: ResearchProvider | null;
  creating: Promise<ResearchProvider> | null;
  closing: Promise<void> | null;
  closeGeneration: number;
}

const owners = new Map<string, OwnerEntry>();

function entryFor(name: string): OwnerEntry {
  let entry = owners.get(name);
  if (!entry) {
    entry = { instance: null, creating: null, closing: null, closeGeneration: 0 };
    owners.set(name, entry);
  }
  return entry;
}

export type OwnedProviderFactory = (
  cfg: TrellisConfig,
) => Promise<ResearchProvider>;

/**
 * Get (or lazily create) the shared provider for `name`. Concurrent first
 * calls share one creation attempt; creations from a pre-close generation
 * never publish.
 */
export async function getOwnedProvider(
  name: string,
  factory: OwnedProviderFactory,
  config?: TrellisConfig,
): Promise<ResearchProvider> {
  const entry = entryFor(name);
  for (;;) {
    while (entry.closing !== null) await entry.closing;
    if (entry.instance) return entry.instance;
    const gen = entry.closeGeneration;
    entry.creating ??= factory(config ?? loadConfig())
      .then((provider) => {
        if (gen === entry.closeGeneration) {
          entry.instance = provider;
          logger.info({ provider: name }, 'Owned provider initialized');
        }
        return provider;
      })
      .finally(() => {
        entry.creating = null;
      });
    const provider = await entry.creating;
    if (gen === entry.closeGeneration) return provider;
  }
}

/**
 * Close and forget the cached provider for `name` (or all names when
 * omitted). Idempotent; never throws.
 */
export async function closeOwnedProvider(name?: string): Promise<void> {
  const names = name === undefined ? [...owners.keys()] : [name];
  for (const key of names) {
    const entry = owners.get(key);
    if (!entry) continue;
    entry.closing ??= (async () => {
      entry.closeGeneration++;
      const pending = entry.creating;
      entry.creating = null;
      const cached = entry.instance;
      entry.instance = null;
      const created = pending === null ? null : await pending.catch(() => null);
      try {
        await (cached ?? created)?.close?.();
      } catch (err: unknown) {
        logger.warn({ ...safeErrorLog(err), provider: key }, 'Owned provider close failed');
      }
    })();
    try {
      await entry.closing;
    } finally {
      entry.closing = null;
    }
  }
}

/** Test hook: drop cached instances without closing. */
export function resetOwnerRegistryForTests(): void {
  owners.clear();
}
