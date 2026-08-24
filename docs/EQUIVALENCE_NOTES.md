# search-mcp deep_research vs Trellis: Capability Equivalence Notes

Source of truth for search-mcp: `src/tools/standalone/deepResearch.ts` (tool description/schema).

## What search-mcp's `deep_research` tool provides

| Capability | search-mcp | Trellis |
|---|---|---|
| **Actions** | `start`, `poll`, `list`, `cancel`, `save`, `run` | `start`, `status`, `cancel`, `rollback` |
| **Query** | `query` (10–5000 chars) | `query` (same) |
| **Depth profiles** | `quick`, `standard`, `deep`, `exhaustive`, `tree` | Same set inherited via budget profiles |
| **Strategy selection** | `agent`, `pipeline`, `tree` | Same — `PipelineStrategy` + `AgentStrategy` registered dynamically |
| **Max runtime override** | `maxTimeMs` (10s–45min) | Not exposed through MCP surface (budget profile defaults) |
| **Deterministic mode** | `deterministic` flag (no LLM calls) | Not exposed; strategy registry falls back to pipeline when no LLM configured |
| **Auto-save to disk** | `save` flag, writes to `~/.cache/search-mcp/research-results/` | Not applicable — event store is authoritative; no JSON file export |
| **Job listing** | `list` returns all known job summaries | Not exposed; status is per-runId only |
| **Rollback** | Not available | `rollback` action — reverts pure_run_local events via RUN_ROLLED_BACK |
| **Family/workspace scoping** | Not available (no family concept) | `familyId` parameter — explicit family or auto-resolved |
| **KG hook** | `kgHook.onDeepResearchComplete` — post-hoc narrative re-extraction into knowledge graph | Deleted by design (architecture §1 #1) — structured events replace narrative re-extraction |
| **MCP progress notifications** | `sendNotification` for progress updates during research | Not wired through MCP surface yet (progress callback exists internally) |

## Key architectural differences

1. **Persistence model.** search-mcp uses in-memory `jobManager` singleton + JSON files on disk for result persistence. Trellis uses append-only event store (SQLite) with deterministic projection rebuild. No data lives only in memory.

2. **Knowledge graph integration.** search-mcp's KG is a separate system reached via `kgHook` — `narrativeMarkdown` is extracted a second time through an LLM. Trellis emits `CLAIM_ACCEPTED`, `EVIDENCE_LINKED`, etc. directly as events — no re-extraction, no narrative roundtrip.

3. **Longitudinal scope.** search-mcp operates per-run with no cross-run accumulation. Trellis tracks `firstSeenRunId`/`lastSeenRunId` on claims and accumulates across runs within a family.

4. **Rollback.** search-mcp has no rollback concept. Trellis supports selective run rollback with compensation events for cross_run_mutation types.

## Capability gaps (Trellis today)

| Gap | Severity | Notes |
|---|---|---|
| `list` action | Low | Could add via `listFamilies` + run status queries on ProjectionState. Not needed for MCP agent workflows. |
| `save` / JSON export | Low | Full narrative export can be added as a read-only view over the projection. Non-blocking. |
| `maxTimeMs` override | Low | Budget profiles already have `maxTimeMs`; just needs schema exposure on the MCP tool. |
| `deterministic` flag | Low | Already works implicitly (no LLM → pipeline strategy). Explicit flag would be a schema-only change. |
| `run` convenience action | Low | Poll-until-done wrapper. Can be implemented client-side or as a separate action. |
| Progress notifications | Medium | `onProgress` callback exists in `StrategyContext`. MCP `notifications/progress` not wired yet. |
| `narrativeMarkdown` rendering | Medium | Produced by `ResearchSynthesizer` internally but not exposed through MCP knowledge surface. Could be added as a `narrative` action on the knowledge tool. |
| Tree strategy | Not implemented | `tree` strategy type exists in the union but no `TreeStrategy` class. Only `pipeline` and `agent` are registered. |
