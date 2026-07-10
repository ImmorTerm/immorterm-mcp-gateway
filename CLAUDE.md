# immorterm-mcp-gateway

HTTP-to-stdio MCP proxy — runs one long-lived gateway so all AI coding sessions share a single set of MCP server processes instead of each spawning their own.

## Build & Test

```bash
npm ci           # install deps
npm run build    # tsc → dist/
npm test         # vitest run
```

Typecheck only (no emit): `npm run typecheck`.

## State Directory

```
~/.immorterm/mcp-gateway/
  state.json              # PID + port while running (gate on existence to check if alive)
  config-backup.json      # Original ~/.claude.json stdio entries (restored on stop/crash)
  config-backup-<tool>.json  # Per-client backups (Cursor, Windsurf, etc.)
  npx-cache.json          # Resolved binary paths (7-day TTL)
  classification.json     # Optional user overrides (stateless/stateful)
  gateway.log             # Auto-rotated at 5 MB
  project-backups/        # Per-project .mcp.json backups
```

PID-file locking prevents duplicate instances. The process is detached — it survives editor restarts.

## Restart ritual

**Never** `lsof -ti:9100 | xargs kill` — that kills every process with a connection on port 9100, including MCP clients that are connected AS consumers. To restart:

```bash
# 1. Kill only the listening gateway process
kill $(jq -r .pid ~/.immorterm/mcp-gateway/state.json)

# 2. Start again
immorterm-mcp-gateway start
# or from source:
node dist/index.js start
```

Port is 9100 (default). Verify: `curl -s http://localhost:9100/health | jq .`

## Publish

Publishing goes through the **Publish to npm** GitHub Actions workflow (`.github/workflows/publish.yml`), triggered via `workflow_dispatch`. It bumps the patch version, runs tests, builds, and publishes via npm Trusted Publishing (OIDC — no `NODE_AUTH_TOKEN` required).

Note: the Trusted Publisher on npmjs.com must point at `ImmorTerm/immorterm-mcp-gateway` + workflow `publish.yml`. See `WORKFLOW-NOTES.md` for the re-pointing instructions needed after the monorepo extraction.

## Detailed internals

`.claude/docs/mcp-gateway.md` — module map, session lifecycle, orphan problem, cleanup layers, multi-client support, and gotchas.
