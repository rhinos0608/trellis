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
