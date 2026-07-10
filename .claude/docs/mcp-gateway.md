# MCP Gateway

Agent-facing reference for this repository. Read when modifying gateway code or integration points.

## Architecture

The gateway is an **HTTP-to-stdio JSON-RPC proxy** on port 9100. It rewrites AI tool config files so MCP traffic routes to `http://localhost:9100/<server>/mcp` instead of spawning per-session stdio children. One shared child per stateless server, one child per session for stateful servers.

Supports multiple AI tools simultaneously: Claude, Cursor, Windsurf, Cline, and custom tools. Each gets its own config backup and hot-reload watcher.

Key modules (all in `src/`):

| Module | Purpose |
|--------|---------|
| `src/server.ts` | Hono HTTP routes, JSON-RPC proxy, session management, DELETE endpoints, client registration |
| `src/child-pool.ts` | Child process lifecycle, request routing, stdout parsing, idle reaper |
| `src/config-rewriter.ts` | Atomic backup/rewrite/restore of `~/.claude.json`, hot-reload via fs.watch |
| `src/clients.ts` | Multi-AI client registration, per-client backup/rewrite/restore, auto-detection |
| `src/npx-resolver.ts` | Resolves npx/uvx commands to direct binary paths (7-day cache) |
| `src/classification.ts` | Stateless/stateful classification with user overrides |
| `src/health.ts` | `/health` endpoint with server stats, memory usage, and registered clients |
| `src/index.ts` | CLI entry point and lifecycle management |
| `src/types.ts` | TypeScript interfaces |

## The Orphan Problem

Without the gateway, MCP servers are **stdio children of Claude**. When Claude dies, they get SIGPIPE and die automatically — no cleanup needed.

With the gateway, MCP servers are **children of the gateway process**. When Claude dies, the children survive as orphans because the gateway (their parent) is still alive. SIGPIPE doesn't apply. This is why explicit cleanup was needed.

## Session Lifecycle & Cleanup

### PID Tracking

The gateway tracks which Claude process owns each MCP session:

- `X-Client-Pid` HTTP header (set by config rewriter)
- `clientInfo.pid` in the MCP `initialize` request

Stored in `sessionClientPid` map (`src/child-pool.ts`).

### Session-Level Activity

Every request to ANY server in a session updates `sessionLastActivity`. This prevents killing Chrome DevTools just because the user is actively using Serena instead. The entire session stays alive as long as any part of it is active.

### Three Cleanup Layers

| Layer | Trigger | Latency | Mechanism |
|-------|---------|---------|-----------|
| Extension-driven | Terminal close / stale reaper | Immediate | `DELETE /sessions/by-pid/:pid` before SIGTERM |
| Gateway Phase 2 | Client PID no longer exists | ~60s | `process.kill(pid, 0)` detects dead process |
| Gateway Phase 3 | No requests for 30 min | 30 min | Idle timeout fallback (no PID tracked) |

### DELETE Endpoints

- `DELETE /sessions/by-pid/:pid` — Kill ALL stateful children owned by a client PID (primary cleanup path)
- `DELETE /sessions/:sessionId` — Kill all stateful children for a specific session
- `DELETE /:serverName/mcp` — Kill a specific server's child for a session

### Reaper Details (`src/child-pool.ts`)

Runs every 60 seconds (`REAPER_INTERVAL_MS`). Three phases per cycle:

1. **Phase 1**: Clean up dead children (process exited but still in pool)
2. **Phase 2**: Check `sessionClientPid` — if PID is dead (ESRCH), kill session immediately
3. **Phase 3**: For sessions without a known PID, apply 30-minute idle timeout (`SESSION_IDLE_TIMEOUT_MS`)

## Independence Guarantee

The gateway and any editor extension are **independent components**. Users can have either without the other.

### Gateway without an extension

- Reads `~/.claude.json` directly (no VS Code dependency)
- Has its own CLI (`immorterm-mcp-gateway start/stop/status/doctor`)
- Reaper handles all cleanup autonomously:
  - Phase 2: PID detection catches dead clients within 60s
  - Phase 3: 30-min idle timeout as safety net
- No extension imports, HTTP-only interface

### Extension without Gateway

- `isGatewayEnabled()` returns `false` → all gateway code paths skip
- `cleanupGatewaySessionByPid()` is a safe no-op (guards on `isGatewayEnabled() && state.healthy`)
- Status bar hides gateway indicator
- No gateway process spawned

**Design principle**: Each side guards against the other's absence. Never assumes co-existence.

## Build & Deploy

```bash
# Build
npm ci && npm run build    # compiles src/ → dist/

# Start (detached)
node dist/index.js start

# Start (foreground, for debugging)
node dist/index.js start --foreground

# Stop
node dist/index.js stop

# Verify
curl -s http://localhost:9100/health | jq .
```

To restart a running gateway: find PID from `~/.immorterm/mcp-gateway/state.json`, kill it, start new. Or use `stop` + `start`.

## Multi-AI Support

The gateway auto-detects installed AI tools on startup and rewrites their configs:

| Tool | Config Path | Auto-detected |
|------|-------------|---------------|
| Claude | `~/.claude.json` | Yes (primary) |
| Cursor | `~/.cursor/mcp.json` | Yes |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | Yes |
| Cline | VS Code globalStorage `cline_mcp_settings.json` | Yes |
| Copilot | Per-project `.vscode/mcp.json` | No (use `/projects/register`) |
| Custom | Any path | No (use `/clients/register`) |

### Client Registration API

- `POST /clients/register` — Register an AI tool: `{ "tool": "cursor", "configPath?": "/custom/path" }`
- `GET /clients` — List registered clients
- `GET /clients/detect` — Auto-detect installed AI tools

### Per-Client Backups

Each client gets its own backup file: `~/.immorterm/mcp-gateway/config-backup-<tool>.json`. Backups are append-only (same as Claude's `config-backup.json`). On shutdown or crash recovery, all clients are restored.

### How It Works

1. On startup, `detectInstalledTools()` checks known config paths
2. Each detected tool's config is backed up and rewritten (stdio → HTTP gateway)
3. `fs.watch` monitors each config file for hot-reload
4. On shutdown, all configs are restored from their per-client backups

All AI tools share the same MCP server child pool — a server spawned for Claude can serve Cursor requests too (for stateless servers).

## Gotchas

- **Spawn race condition**: Multiple sessions can request the same stateful server simultaneously. `pendingSpawns` map in `src/child-pool.ts` deduplicates concurrent spawn attempts for the same `serverName:sessionId` key.
- **Stateful idle timeout is 30 min, not 5 min**: Stateful children (Serena, Playwright) maintain conversation state. A user might pause for 20 minutes mid-debugging. The 30-min timeout is a safety net, not an activity detector.
- **Config hot-reload**: `src/config-rewriter.ts` watches `~/.claude.json` with `fs.watch`. When a user runs `claude mcp add`, the gateway detects the new entry and wraps it automatically.
- **npx cache**: Resolved binary paths are cached for 7 days in `~/.immorterm/mcp-gateway/npx-cache.json`. Stale cache can cause issues if a package updates its binary location.
