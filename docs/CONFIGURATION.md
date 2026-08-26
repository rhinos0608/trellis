# Trellis — Configuration Reference

## Environment Variables

All variables are read from the process environment. If a `.env` file exists at the project root, it is loaded via [dotenv](https://github.com/motdotla/dotenv) as a fallback beneath process environment values and above built-in defaults.

| Variable | Description | Default | Sensitive |
|---|---|---|---|
| `TRELLIS_DB_PATH` | Path to the SQLite event-store database file | `~/.cache/trellis/trellis.db` | No |
| `TRELLIS_LLM_API_KEY` | API key for the research orchestrator's LLM | Falls back to `OPENAI_API_KEY` | **Yes** — redacted in logs |
| `TRELLIS_LLM_BASE_URL` | Base URL for the LLM endpoint | Falls back to `OPENAI_BASE_URL` | No |
| `TRELLIS_LLM_MODEL` | Model name for the LLM | Falls back to `OPENAI_MODEL` | No |
| `TRELLIS_SEARCH_MCP_PATH` | Path to search-mcp's MCP server entrypoint | *(empty — provider disabled)* | No |
| `TRELLIS_SEARCH_MCP_COMMAND` | Command to spawn the search-mcp child process | `node` | No |
| `TRELLIS_SEARCH_MCP_ARGS` | Space-separated args (used when `TRELLIS_SEARCH_MCP_PATH` is unset) | *(empty)* | No |
| `TRELLIS_HTTP_PORT` | Port for `trellis serve` (Phase 8 loopback HTTP server) | `0` (random) | No |
| `LOG_LEVEL` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` | `info` | No |

### Precedence

Process environment → `.env` file → defaults.  A shell-exported variable always wins over `.env`.

### Sensitive Variables

`TRELLIS_LLM_API_KEY` and any `apiKey` / `authorization` value flowing through structured logs are automatically censored by Pino's `redact` option.  The specific redacted key paths are:

- `apiKey`
- `apiToken`
- `authorization`
- `headers.authorization`
- `req.headers.authorization`
- `config.llm.apiKey`
- `llm.apiKey`

**Known limitation:** Redaction is key-based only.  If an API key or secret appears as a *value* inside a field named something else (e.g., `data: "sk-..."`), it will not be caught.  Broader adversarial-content redaction is a separate, later concern.

---

## Database

Trellis uses a single SQLite file as its event store.  The path is controlled by `TRELLIS_DB_PATH`.

**Single-process / single-writer constraint:** Do not run two Trellis processes against the same database file concurrently (outside of coordinated backup/restore operations).  SQLite does not support concurrent writers safely.

The database is migrated and self-healed during runtime initialization for write-capable CLI commands and on every HTTP server start. Offline `restore`, `backup`, and `export` skip migrations and self-healing; use `trellis migrate` explicitly first when needed.

---

## Docker

### Running

```bash
# Pull/build
docker build -t trellis .

# Basic CLI usage (interactive, read-only)
docker run --rm -v trellis-data:/data trellis --version

# Run migrate + doctor
docker run --rm -v trellis-data:/data trellis migrate
docker run --rm -v trellis-data:/data trellis doctor

# Start a research run
docker run --rm -v trellis-data:/data trellis run "your research query"
```

### Volume Mount

`-v trellis-data:/data` mounts a named Docker volume at `/data`.  The Trellis SQLite database lives at `/data/trellis.db` by default.  All `backup`, `restore`, and `export` commands operate against this path.

```bash
# Backup
docker run --rm -v trellis-data:/data -v $(pwd):/backup trellis backup /backup/my-backup

# Restore (offline command — no initCliRuntime)
docker run --rm -v trellis-data:/data -v $(pwd):/backup trellis restore /backup/my-backup

# Export event log as JSONL
docker run --rm -v trellis-data:/data -v $(pwd):/output trellis export /output/events.jsonl
```

**Permissions:** The container runs as the `node` user (UID 1000).  If you mount a host directory (not a named volume), ensure it is writable by that UID:

```bash
mkdir -p ./trellis-data && chown 1000:1000 ./trellis-data
docker run --rm -v ./trellis-data:/data trellis doctor
```

Named volumes handle ownership automatically.

### HTTP Mode in Docker

The HTTP server binds **loopback-only** (`127.0.0.1`) by design — Trellis's HTTP interface is not exposed to the network.  Inside a Docker container with default bridge networking, the loopback address is isolated to the container itself.

To access the HTTP server from the host, you need `--network host`:

```bash
docker run --rm --network host -v trellis-data:/data trellis serve
```

This is an **intentional, operator-controlled tradeoff**: bridge networking provides network isolation, while host networking trades it for loopback accessibility.  This is not a recommended default — it requires explicit operator understanding of the security implications.  For production exposure, use an SSH tunnel or reverse proxy the operator sets up outside Trellis's scope.

### Single-Process Constraint in Docker

Each container should run one Trellis process.  Do not launch two containers against the same mounted volume with both performing writes.  Read-only containers (e.g., `doctor`, `backup`, `search`) against a volume that another process is writing to require a supported concurrent-read SQLite configuration such as WAL mode; shared writers remain unsupported.

---

## HTTP Server

`trellis serve` starts the loopback HTTP server.

### Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/healthz` | GET | Liveness probe — returns `{ status: "ok", version: "..." }`.  Always 200 if the process is alive. |
| `/readyz` | GET | Readiness probe — pure read-only, never triggers migrations, rebuild, or provider initialization. |
| `/v1/research/runs` | POST / GET | Research orchestration — start a run (POST), list runs (GET). |
| `/v1/research/runs/:id` | GET | Run status. |
| `/v1/research/runs/:id/history` | GET | Full lifecycle event history for a run. |
| `/v1/research/runs/:id/events` | GET | SSE stream of run lifecycle events. |
| `/v1/research/runs/:id/cancel` \| `/v1/research/runs/:id/retry` | POST | Cancel or retry a run. |
| `/v1/research/families/:id/continue` | POST | Continue research on an existing family. |
| `/v1/knowledge/status` | GET | Knowledge read-model status. |
| `/v1/claims`, `/v1/claims/:id` (+ `/observations`, `/evidence`, `/relations`) | GET | Knowledge graph claim queries. |
| `/v1/sources`, `/v1/sources/:id` | GET | Source records. |

### Loopback-Only Trust Boundary

The server explicitly validates that every request arrives from `127.0.0.1`, `localhost`, or `[::1]`.  Requests from any other host are rejected with `400 INVALID_HOST`.  This is Phase 8's trust boundary decision and is enforced at the HTTP handler level — not a firewall rule.

---

## Shutdown Behavior

### SIGINT / SIGTERM

Both signals trigger a graceful shutdown:

1. The scheduler stops accepting new runs.
2. Every active run is aborted and a `RUN_INTERRUPTED` event is emitted (with `reason: "process shutdown"`).
3. The server drains in-flight requests (up to 5 seconds), then force-closes lingering sockets.
4. The database connection is closed cleanly.

### RUN_INTERRUPTED Recovery

If a run was interrupted by process shutdown (not user cancellation), it appears in the terminal event history as `RUN_INTERRUPTED`.  On the next invocation, `trellis doctor` will surface it.  The run cannot be resumed — it must be restarted with `trellis run`.

---

## Version

The Trellis version string (`0.1.0` and onwards) is defined in `package.json` and read at runtime by `src/version.ts`.  It surfaces in:

- `trellis --version` (CLI)
- `GET /healthz` response
- Archive manifest headers (backup bundles)
- Structured log `version` field

---

## Native CLI vs Docker

| | Native | Docker |
|---|---|---|
| Install | `npm install -g trellis` or `npx` | `docker build -t trellis .` |
| DB location | `~/.cache/trellis/trellis.db` | `/data/trellis.db` (volume mount) |
| Permissions | Current user | `node` user (UID 1000) |
| Network access | Direct | Requires `--network host` for HTTP |

---

## Quick-Start

```bash
# Install
npm install -g trellis

# Set LLM key
export TRELLIS_LLM_API_KEY="sk-..."

# Run a research query
trellis run "What are the tradeoffs of SQLite vs PostgreSQL for event sourcing?"

# Check health
trellis doctor

# Start HTTP server (loopback only)
trellis serve
```
