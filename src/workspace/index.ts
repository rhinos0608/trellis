// Workspace domain — families, threads, resolvers, projection handlers, queries.
// Owned by Worker 4.

export { resolveFamily, type FamilyResolution } from './familyResolver.js';
export { resolveThread, type ThreadResolution } from './threadResolver.js';
export { workspaceEventHandlers } from './projectionHandlers.js';
export { getFamilyById, listFamilies, getThreadsByFamily, findFamilyByManifestMatch } from './queries.js';
