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
trellis claim <id>

# Run diagnostics
trellis doctor

# Start HTTP server (loopback only — see docs/CONFIGURATION.md)
trellis serve
```

## MCP

Trellis exposes a standalone MCP server with two tool families:

- `research` — start, status, cancel, rollback research runs
- `knowledge` — query families, threads, claims, evidence, entities

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
