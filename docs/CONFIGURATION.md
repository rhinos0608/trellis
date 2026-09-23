# Trellis — Configuration Reference

## Environment Variables

All variables are read from the process environment. If a `.env` file exists at the project root, it is loaded via [dotenv](https://github.com/motdotla/dotenv) as a fallback beneath process environment values and above built-in defaults.

| Variable | Description | Default | Sensitive |
|---|---|---|---|
| `TRELLIS_DB_PATH` | Path to the SQLite event-store database file | `~/.cache/trellis/trellis.db` | No |
| `TRELLIS_LLM_API_KEY` | API key for an HTTP LLM endpoint; not needed for Pi-backed model IDs | Falls back to `OPENAI_API_KEY` | **Yes** — redacted in logs |
| `TRELLIS_LLM_BASE_URL` | Base URL for an HTTP LLM endpoint; omit for Pi-backed model IDs | Falls back to `OPENAI_BASE_URL` | No |
| `TRELLIS_LLM_MODEL` | Model name, or exact Pi `provider/model` ID when using Pi auth | Falls back to `OPENAI_MODEL` | No |
| `TRELLIS_SEARCH_MCP_PATH` | Path to search-mcp's MCP server entrypoint | *(empty — provider disabled)* | No |
| `TRELLIS_SEARCH_MCP_COMMAND` | Command to spawn the search-mcp child process | `node` | No |
| `TRELLIS_SEARCH_MCP_ARGS` | Space-separated args (used when `TRELLIS_SEARCH_MCP_PATH` is unset) | *(empty)* | No |
| `TRELLIS_PI_NORTHSTAR_AUTODETECT` | Single on-switch for the pi-northstar provider (`1`/`true` = on) | *(off — provider disabled)* | No |
| `TRELLIS_HTTP_PORT` | Port for `trellis serve` (Phase 8 loopback HTTP server) | `0` (random) | No |
| `LOG_LEVEL` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` | `info` | No |

### Precedence

Process environment → `.env` file → defaults.  A shell-exported variable always wins over `.env`.

### Pi-backed LLM model IDs

When `TRELLIS_LLM_BASE_URL` is set, Trellis keeps using its OpenAI-compatible HTTP
transport. When no base URL is set, an exact `provider/model` value in
`TRELLIS_LLM_MODEL` can use the installed `pi` CLI instead. Trellis requires the
Pi auth store (`${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json`) to exist, passes
only the model ID, and lets Pi resolve/refresh credentials from that store. No
`TRELLIS_LLM_API_KEY`, provider API key, or base URL is required or forwarded for
this path.

The Pi child runs non-interactively with sessions, tools, extensions, skills,
prompt templates, themes, context files, and project approval disabled. Its
environment is allowlisted to process/runtime paths and locale/certificate settings;
provider API-key environment variables and Trellis LLM secrets are excluded.

### pi-northstar provider (Phase 1, default off)

When `TRELLIS_PI_NORTHSTAR_AUTODETECT=1`, Trellis uses Northstar's public CLI
commands per provider call (P1 surfaces: web search, fetch, academic research, GitHub).
The binary is resolved in order: `pi-northstar` on `PATH` (parent-process PATH
is used for discovery only and never forwarded), a sibling Northstar checkout under
`../Pi-Atlas`, `../Pi-Northstar`, or `../Northstar`, then local `./bin/pi-northstar.mjs`.
No command/args override exists — one on-switch only.
When enabled but unresolvable, provider creation fails closed with an actionable error.
The child receives only `PI_SEARCH_*` variables (no `PATH`) — Trellis secrets
(e.g. `TRELLIS_LLM_API_KEY`) are never forwarded. Provider results are untrusted
evidence served under provider name `pi-northstar`; Pi provenance markers pass
through mapping verbatim.

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
| `/v1/research/runs/:id/cancel` | POST | Cancel a run. |
| `/v1/research/runs/:id/retry` | POST | Retry a failed run. Accepts `idempotencyKey` and `deadlineMs`. |
| `/v1/research/families/:id/continue` | POST | Continue research on an existing family. Accepts `depth` and `idempotencyKey`. |
| `/v1/knowledge/status` | GET | Knowledge read-model status (version, lastAppliedSeq, ready/dirty). |
| `/v1/claims` | GET | List claims. Query params: `familyId`, `threadId`, `epistemicStatus`, `contradictionState`, `q`, `cursor`, `limit`. |
| `/v1/claims/:id` | GET | Single claim by ID. |
| `/v1/claims/:id/observations` | GET | Observation history for a claim. |
| `/v1/claims/:id/evidence` | GET | Evidence linked to a claim. Query params: `stance`, `cursor`, `limit`. |
| `/v1/claims/:id/relations` | GET | Claim relations (from/to/either). Query params: `direction`, `relation`, `cursor`, `limit`. |
| `/v1/sources` | GET | List sources. Query params: `q`, `domain`, `sourceType`, `extractionStatus`, `cursor`, `limit`. |
| `/v1/sources/:id` | GET | Single source by ID. |

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

## CLI Commands

All commands accept `--db <path>`, `--json`, and `--help/-h` as global flags.

| Command | Description |
|---|---|
| `trellis run <query>` | Start a research run, wait until terminal |
| `trellis search <query> [--kind claims\|sources\|all] [--limit N]` | Full-text search over claims/sources |
| `trellis claim <id> [--observations] [--evidence] [--relations]` | Show a claim with optional children |
| `trellis source <id>` | Show a source |
| `trellis runs [--status <s>] [--family <id>] [--limit N]` | List research runs |
| `trellis watch <run-id> [--timeout ms]` | Follow a run's lifecycle events until terminal |
| `trellis merge <source> <survivor>` | Merge source claim into survivor claim (curation) |
| `trellis split <source> --input <file>` | Split a claim per a partition plan JSON file |
| `trellis retract <target-id> --kind claim\|observation` | Retract or restore a claim/observation |
| `trellis curate-relation add \| remove` | Add or remove a curated claim relation |
| `trellis override-stance <evidence-id> supports\|opposes` | Override an evidence record's stance |
| `trellis doctor [--provider]` | Read-only diagnostics |
| `trellis verify` | Strict full-scan event-store + read-model verification |
| `trellis migrate` | Apply pending migrations (idempotent) |
| `trellis rebuild read-model` | Rebuild derived state |
| `trellis serve [--port N]` | Start the loopback HTTP server |
| `trellis backup <bundle-directory>` | Snapshot the event store into a verifiable bundle |
| `trellis export <events.jsonl>` | Export the event log as newline-delimited JSON |
| `trellis restore <bundle-directory> [--replace]` | Restore the event store from a verifiable bundle |

Curation commands (`merge`, `split`, `retract`, `curate-relation`, `override-stance`) require `--reason`, `--actor`, and `--seq` flags for idempotency and provenance.

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
