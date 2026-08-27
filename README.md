# Trellis

Deep research orchestration and longitudinal knowledge graph, exposed as a standalone MCP service. Trellis takes research queries, coordinates multi-phase investigation through pluggable search providers, and projects findings into a durable, event-sourced knowledge graph with claims, evidence, and contradiction tracking. Under active extraction from [search-mcp](../search-mcp/); the full architecture is at [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

```bash
# Global (requires Node >= 20.16)
npm install -g trellis

# Or run directly
npx trellis --version

# Docker
docker build -t trellis .
```

## Quick Start

```bash
# Start a research run
trellis run "your research query"

# View claims and sources
trellis search <query>
trellis claim <id> [--observations] [--evidence] [--relations]
trellis source <id>

# List runs and watch a run's lifecycle
trellis runs [--status <status>] [--family <id>]
trellis watch <run-id>

# Operator curation
trellis merge <source> <survivor> --reason R --actor A --seq N
trellis split <source> --input <file> --reason R --actor A --seq N
trellis retract <target-id> --kind claim|observation --reason R --actor A --seq N

# Diagnostics and maintenance
trellis doctor [--provider]
trellis verify
trellis migrate
trellis rebuild read-model

# Backup / export / restore
trellis backup <bundle-directory>
trellis export <events.jsonl>
trellis restore <bundle-directory> [--replace]

# Start HTTP server (loopback only — see docs/CONFIGURATION.md)
trellis serve [--port N]
```

## MCP

Trellis exposes a standalone MCP server with two tool families:

**`research`** tool actions:
- `start` — start a research run (query, strategy, depth, family/thread scoping)
- `status` — poll run status
- `list` — list runs with optional status/family filter
- `history` — lifecycle event history for a run
- `cancel` — cancel a running run
- `retry` — retry a failed run
- `rollback` — roll back a completed run
- `continue` — continue research on an existing family

**`knowledge`** tool actions:
- `families` / `threads` — workspace navigation
- `claims` / `evidence` / `contradictions` / `gaps` — knowledge graph queries
- `entity` — entity lookup by ID or label
- `belief` — epistemic view of a claim (confidence, evidence chain)
- `why` — provenance drill-down for a claim
- `timeline` — chronological change history
- `changes` — event-level change feed since a sequence number
- `research-next` — gap-driven next-step suggestions for a family
- `family-view` — aggregate workspace dashboard for a family

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data model.

## HTTP Mode

`trellis serve` starts a loopback-only HTTP server bound to `127.0.0.1`.  It is **not** exposed to the network by default — this is an intentional trust boundary (Phase 8).  To access it from outside the process, use an SSH tunnel or reverse proxy.

## Docker

```bash
docker build -t trellis .
docker run --rm -v trellis-data:/data trellis run "your query"
```

Requires `--network host` for HTTP mode inside the container.  See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for volume mounts, permissions, and full configuration reference.

## Docs

- [Configuration Reference](docs/CONFIGURATION.md) — all env vars, Docker usage, HTTP endpoints, shutdown behavior
- [Architecture Decisions](docs/ARCHITECTURE.md) — data model, event vocabulary, design rationale
- [Equivalence Notes](docs/EQUIVALENCE_NOTES.md) — Trellis vs search-mcp capability mapping
- [Research Roadmap](docs/research-roadmap.md) — post-audit evolution priorities, 10-project comparison

## Development

```bash
# Watch mode
npm run dev

# Build + run
npm run build
npm start

# Tests
npm test
```
