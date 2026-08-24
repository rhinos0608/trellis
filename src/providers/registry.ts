/**
 * Provider registry — register and fetch ResearchProvider instances by name.
 */

import type { ResearchProvider } from './types.js';

const providers = new Map<string, ResearchProvider>();

/** Register a provider. Overwrites if name already exists. */
export function registerProvider(provider: ResearchProvider): void {
  providers.set(provider.name, provider);
}

/** Fetch a registered provider by name, or undefined. */
export function getProvider(name: string): ResearchProvider | undefined {
  return providers.get(name);
}

/** List all registered provider names. */
export function listProviders(): string[] {
  return [...providers.keys()];
}

/** Remove a provider by name. */
export function unregisterProvider(name: string): boolean {
  return providers.delete(name);
}

/** Remove all providers. Useful for testing. */
export function clearProviders(): void {
  providers.clear();
}
