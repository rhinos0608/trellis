// Provider abstraction — register and use ResearchProvider implementations.

export type { ResearchProvider, ResearchCapabilities } from './types.js';
export {
  registerProvider,
  getProvider,
  listProviders,
  unregisterProvider,
  clearProviders,
} from './registry.js';
export { createSearchMcpProvider, createSearchMcpProviderFromClient } from './searchMcp/index.js';
export {
  createPiNorthstarProvider,
  createPiNorthstarProviderFromClient,
  resolvePiNorthstarCommand,
  isPiNorthstarEnabled,
  piNorthstarCapabilities,
  PI_NORTHSTAR_PROVIDER_NAME,
} from './piNorthstar/index.js';
export {
  getOwnedProvider,
  closeOwnedProvider,
  resetOwnerRegistryForTests,
  type OwnedProviderFactory,
} from './ownerRegistry.js';
