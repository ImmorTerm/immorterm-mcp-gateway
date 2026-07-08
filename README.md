# immorterm-mcp-gateway

A shared MCP gateway proxy. Run one long-lived gateway process, and let every
AI coding session connect through it — instead of each session spawning its own
copy of every MCP server. Works with or without [ImmorTerm](https://github.com/ImmorTerm/immorterm).

**Result**: 96% memory reduction (11.7 GB → 56 MB), 97% process reduction (339 → 10).

## In Simple Words

**The problem you didn't know you had**: Every time you open an AI coding
session, it quietly launches a copy of every MCP tool you have — search, code
analysis, browser, etc. Open 20 sessions over a workday and you now have 300+
invisible processes eating 12 GB of RAM. Your laptop gets slow. Things start
crashing. You blame Chrome.

**The simple fix**: Instead of 20 copies of each tool, run one copy and let
everyone share it. That's what this gateway does — it sits in the middle, takes
requests from all your sessions, and routes them to a single set of shared
tools.

**What you get**: Your 300 processes become 10. Your 12 GB becomes 56 MB. Your
laptop stops sweating. And you didn't have to change how you use your AI tools
at all — it's completely invisible.

## Why This Exists

Claude Code (and most MCP clients) spawn every MCP server as a stdio child
process — **per session**. Open 21 sessions with 7 configured MCP servers, and
you get:

| Component | Count | Memory |
|-----------|-------|--------|
| npm exec wrappers | 148 | 6.1 GB (41 MB each, sitting idle) |
| Node.js MCP servers | 147 | 4.9 GB |
| Python/uvx tools | 42 | 0.4 GB |
| **Total** | **339** | **11.7 GB** |

The npm exec wrappers are the worst offender — each is a full Node.js process
(41 MB) that just spawns the actual binary and waits. That's 6.1 GB of pure
waste.

We discovered this while investigating OOM crashes that were killing the editor
entirely. The system hit 52 GB usage with 10 GB swap. MCP servers were the
single largest contributor.

Existing tools like `supergateway` can't solve this — it broadcasts MCP
responses to ALL connected clients instead of routing to the originating
client, breaking any shared-process scenario.

## How It Works

The gateway is a **transparent HTTP-to-stdio JSON-RPC proxy**. It is not an MCP
server itself — the child processes are the real MCP servers. The gateway just
routes traffic.

```
Session 1 ─┐
Session 2 ─┤  POST /:server/mcp
Session 3 ─┤─────────────────────→ Gateway (port 9100)
Session N ─┘                           │
                                       ├─→ [shared] context7 (1 child)
                                       ├─→ [shared] tavily (1 child)
                                       ├─→ [shared] magic (1 child)
                                       ├─→ [stateful] serena (N children)
                                       └─→ [stateful] playwright (N children)
```

On startup:

1. Reads `~/.claude.json` and finds all `type: "stdio"` MCP server entries
2. Creates an atomic backup at `~/.immorterm/mcp-gateway/config-backup.json`
3. Rewrites each stdio entry to `type: "http"` pointing at `http://localhost:9100/<name>/mcp`
4. Writes a `_mcp_gateway_ts` timestamp to trigger the client's config reload
5. Watches the config file for hot-reload (new servers added via `claude mcp add` are wrapped automatically)

On shutdown (or crash recovery), the original stdio configs are restored from backup.

After the gateway is running:

| Component | Count | Memory |
|-----------|-------|--------|
| Gateway process | 1 | ~20 MB |
| Shared child processes | 9 | ~36 MB |
| **Total** | **10** | **~56 MB** |

### Stateless vs Stateful

Not all MCP servers can be shared. The gateway classifies them:

- **Stateless** (default): One shared child process for all sessions. Requests
  are multiplexed via JSON-RPC IDs. Safe for servers that don't maintain
  conversational state (search APIs, code lookup, etc.)
- **Stateful**: One child process per MCP session. Required for servers that
  track state across requests (sequential-thinking, browser automation, etc.)

Built-in stateful servers: `sequential-thinking`, `serena`, `playwright`,
`chrome-devtools`, `puppeteer`.

You can override classification in `~/.immorterm/mcp-gateway/classification.json`:

```json
{
  "my-custom-server": { "mode": "stateful" },
  "another-server": { "mode": "stateless", "requestTimeout": 30000 }
}
```

### npx Resolution

The biggest memory win. When your MCP client configures:

```json
{ "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
```

Each session spawns an `npx` process (41 MB) that spawns the actual server
(34 MB). The gateway resolves the binary path once, caches it (7-day TTL), and
spawns the binary directly — eliminating the npm exec wrapper entirely. This
alone saves 6.1 GB across 21 sessions.

### Independent by Design

The gateway is a standalone process — it does not depend on any editor or
extension being present:

- Runs as a **detached Node.js process** — survives editor and host crashes
- Managed via **PID file locking** — prevents duplicate instances
- **Auto-recovery** with exponential backoff (30s → 60s → 120s cap) if the process dies
- Crash recovery restores `~/.claude.json` from backup if the gateway dies uncleanly

## Installation

```bash
npm install -g immorterm-mcp-gateway
immorterm-mcp-gateway start
```

Or run it from source:

```bash
git clone https://github.com/ImmorTerm/immorterm-mcp-gateway
cd immorterm-mcp-gateway
npm install
npm run build
node dist/index.js start
```

## CLI

```bash
immorterm-mcp-gateway start               # Start (detached)
immorterm-mcp-gateway start --foreground   # Start in foreground (debugging)
immorterm-mcp-gateway start --port 9200    # Custom port (default: 9100)
immorterm-mcp-gateway start --config PATH  # Custom claude.json path
immorterm-mcp-gateway stop                 # Stop gracefully (restores config)
immorterm-mcp-gateway status               # Show status
immorterm-mcp-gateway doctor               # Full diagnostic check
```

### Doctor

Runs health checks with detailed output:

```
immorterm-mcp-gateway doctor

  ✓ Gateway running (PID 12345, port 9100)
  ✓ Health endpoint OK — 9 servers, 11 children, 56 MB
    ○ context7 (stateless, 1 child, 142 reqs)
    ○ tavily (stateless, idle, 0 reqs)
    ◆ serena (stateful, 2 children, 89 reqs)
    ◆ playwright (stateful, 1 child, 23 reqs)
  ✓ Config backup valid (9 servers backed up)
  ✓ Claude config: 9 via gateway, 0 stdio, 2 other
  ✓ npx cache: 5 resolved path(s)
  ○ No classification overrides (using defaults)
  ✓ Log file: 0.3 MB

6 passed, 0 issue(s)
```

`◆` = stateful (per-session children) | `○` = stateless (shared child)

## Modules

| Module | Purpose |
|--------|---------|
| `server.ts` | Hono HTTP server, JSON-RPC proxy routes, session management |
| `child-pool.ts` | Child process lifecycle, request routing, stdout parsing |
| `config-rewriter.ts` | Atomic backup/rewrite/restore of `~/.claude.json`, hot-reload via fs.watch |
| `clients.ts` | Multi-client registration, per-client backup/rewrite/restore, auto-detection |
| `npx-resolver.ts` | Resolves npx/uvx commands to direct binary paths |
| `classification.ts` | Stateless/stateful classification with user overrides |
| `health.ts` | `/health` endpoint with server stats and memory usage |
| `index.ts` | CLI entry point and lifecycle management |
| `types.ts` | TypeScript interfaces |

## State Directory

```
~/.immorterm/mcp-gateway/
  state.json              # PID, port, uptime (exists while running)
  config-backup.json      # Original ~/.claude.json stdio entries
  npx-cache.json          # Resolved binary paths (7-day TTL)
  classification.json     # User overrides (optional)
  gateway.log             # Log file (auto-rotated at 5 MB)
  project-backups/        # Per-project .mcp.json backups
```

## Multi-Client Support

The gateway auto-detects installed AI tools on startup and rewrites their configs:

| Tool | Config Path |
|------|-------------|
| Claude | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | VS Code globalStorage `cline_mcp_settings.json` |
| Custom | Any path (register via `POST /clients/register`) |

Each client gets its own append-only backup at
`~/.immorterm/mcp-gateway/config-backup-<tool>.json`, restored on shutdown or
crash recovery. All clients share the same MCP server child pool — a server
spawned for one client can serve another's requests (for stateless servers).

## Session Lifecycle & Cleanup

### Why cleanup is needed

Without the gateway, MCP servers are **stdio children of the AI client**. When
the client dies, they get SIGPIPE and die automatically. With the gateway, MCP
servers are **children of the gateway process** — when a client dies, its
children survive as orphans because the gateway (their parent) is still alive.
This is why the gateway needs explicit cleanup.

### How sessions are tracked

The gateway tracks which client process owns each MCP session via:

- **`X-Client-Pid` HTTP header** — set by the config rewriter in `~/.claude.json`
- **`clientInfo.pid`** in the MCP `initialize` request

Both are stored in the `sessionClientPid` map. Activity is tracked at the
**session level** — any request to any server in a session updates the
session's last-activity timestamp. This prevents killing one server just
because a different server in the same session is being used.

### Cleanup layers

| Layer | Trigger | Latency | How it works |
|-------|---------|---------|-------------|
| **PID detection** | Client PID no longer exists | ~60s | Reaper checks `process.kill(pid, 0)` every 60s; ESRCH = dead client → kill all children |
| **Idle timeout** | No requests for 30 min | 30 min | Fallback for sessions without a known PID |

The reaper runs every 60 seconds with three phases per cycle:

1. **Phase 1** — Clean up dead children (process exited but still in pool)
2. **Phase 2** — Check `sessionClientPid` map; if PID is dead (`ESRCH`), kill session immediately
3. **Phase 3** — For sessions without a known PID, apply 30-minute idle timeout

### HTTP endpoints

```
DELETE /sessions/by-pid/:pid    Kill ALL stateful children owned by a client PID
DELETE /sessions/:sessionId     Kill all stateful children for a specific session
DELETE /:serverName/mcp         Kill a specific server's child for a session
```

## Dependencies

Minimal by design — the whole point is reducing memory:

- **[hono](https://hono.dev/)** — HTTP routing
- **@hono/node-server** — Node.js adapter
- **Node.js >= 18** — Built-ins only (child_process, fs, crypto, http)

## License

[FSL-1.1-Apache-2.0](./LICENSE.md) — source-available, converts to Apache 2.0
two years after each release.
