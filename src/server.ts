import fs from 'fs';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import {
  JsonRpcRequest,
  JsonRpcResponse,
  StdioServerConfig,
  Logger,
  ToolStats,
  GatewayStats,
  ServerDetail,
  AiToolId,
} from './types';
import { sendRequest, sendNotificationToChild, registerServer, getPoolStats, killSession, killSessionsByPid, killSessionChild, killServer, setSessionClientPid, getSessionInfo, getServerConfigs } from './child-pool';
import { getHealthInfo, initHealth } from './health';
import { isStateful } from './classification';
import { rewriteProjectConfig, readState, writeState, getBackupServers, restoreServerInConfigs, rewriteServerInConfigs, restoreConfig, rewriteConfig } from './config-rewriter';
import { registerClient, getRegisteredClients, detectInstalledTools } from './clients';
import { recordTimelineEvent, getTimeline } from './timeline';
import { isOptedOut, optOut, optIn, getOptedOut } from './opt-out';
import { getDashboardHtml } from './dashboard';
import { randomUUID } from 'crypto';

/** Active server names the gateway is proxying */
const managedServers = new Set<string>();

/** Tracks where each server was registered from: global config vs project .mcp.json */
const serverSource = new Map<string, { source: 'global' | 'project'; configPath: string }>();

/** HTTP/SSE servers from project configs — not proxied, but tracked for dashboard visibility */
const passthroughServers = new Map<string, { name: string; url: string; configPath: string }>();

/** Cached initialize responses for stateless shared servers */
const initializeCache = new Map<string, JsonRpcResponse>();

/** Whether the gateway is soft-disabled (proxy returns 503, but dashboard still works) */
let gatewayDisabled = false;

// ── Per-tool stats (in-memory, resets on restart) ──────────────────────

/** Per-tool call counters: toolName → stats */
const toolStatsMap = new Map<string, ToolStats>();

/** Maps tool names to the MCP server that provides them */
const toolServerMap = new Map<string, string>();

/** Per-tool recent latency samples for p99 computation */
const latencySamples = new Map<string, number[]>();
const MAX_LATENCY_SAMPLES = 100;

/** Total requests through the MCP proxy (excluding health/admin endpoints) */
let totalMcpRequests = 0;
let totalMcpErrors = 0;

/**
 * Extract the effective tool/method name from a JSON-RPC request.
 * For `tools/call`, returns the actual tool name (e.g., "search_memory").
 * For other methods, returns the method itself (e.g., "tools/list", "initialize").
 */
function extractToolName(body: JsonRpcRequest): string {
  if (body.method === 'tools/call') {
    const params = body.params as Record<string, unknown> | undefined;
    if (params?.name && typeof params.name === 'string') {
      return params.name;
    }
  }
  return body.method;
}

/** Compute p99 from a sorted array of samples */
function computeP99(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1);
  return Math.round(sorted[idx]);
}

/** Record a completed tool call with timing and success/error status. */
function recordToolCall(toolName: string, elapsedMs: number, isError: boolean, serverName?: string): void {
  if (serverName) toolServerMap.set(toolName, serverName);
  totalMcpRequests++;
  if (isError) totalMcpErrors++;

  let stats = toolStatsMap.get(toolName);
  if (!stats) {
    stats = { calls: 0, errors: 0, totalMs: 0, avgMs: 0, p99Ms: 0, errorRate: 0, lastCalledAt: 0 };
    toolStatsMap.set(toolName, stats);
  }

  if (isError) {
    stats.errors++;
  } else {
    stats.calls++;
  }
  stats.totalMs += elapsedMs;
  const total = stats.calls + stats.errors;
  stats.avgMs = Math.round(stats.totalMs / total);
  stats.errorRate = total > 0 ? stats.errors / total : 0;
  stats.lastCalledAt = Date.now();

  // Track latency samples for p99
  let samples = latencySamples.get(toolName);
  if (!samples) {
    samples = [];
    latencySamples.set(toolName, samples);
  }
  samples.push(elapsedMs);
  if (samples.length > MAX_LATENCY_SAMPLES) samples.shift();
  stats.p99Ms = computeP99(samples);

  // Record in timeline ring buffer
  recordTimelineEvent(toolName, elapsedMs, isError);
}

let logger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

let httpServer: ServerType | null = null;

/**
 * Create and configure the Hono app.
 */
export function createApp(log?: Logger): Hono {
  if (log) logger = log;

  const app = new Hono();

  // CORS — allow the ImmorTerm web dashboard to call gateway APIs
  const corsMiddleware = async (c: any, next: any) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    await next();
  };
  app.use('/health', corsMiddleware);
  app.use('/api/*', corsMiddleware);

  // Health endpoint
  app.get('/health', (c) => {
    return c.json(getHealthInfo());
  });

  // Stats endpoint — per-tool call counts, errors, and latency
  app.get('/api/health/stats', async (c) => {
    const healthInfo = getHealthInfo();

    // Check memory service health (best-effort, 2s timeout)
    let memoryServiceHealthy = false;
    try {
      const http = await import('http');
      memoryServiceHealthy = await new Promise<boolean>((resolve) => {
        const req = http.get('http://localhost:8765/health', { timeout: 2000 }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
    } catch {
      memoryServiceHealthy = false;
    }

    // Build sorted tool stats (most-called first), with server attribution
    const sortedTools: Record<string, ToolStats> = {};
    const entries = Array.from(toolStatsMap.entries())
      .sort((a, b) => (b[1].calls + b[1].errors) - (a[1].calls + a[1].errors));
    for (const [name, stats] of entries) {
      sortedTools[name] = { ...stats, server: toolServerMap.get(name) };
    }

    // Build server details — proxied servers from the child pool
    const poolStats = getPoolStats();
    const backupServers = getBackupServers();
    const serverConfigs = getServerConfigs();
    const servers: ServerDetail[] = poolStats.servers.map(s => {
      const config = serverConfigs.get(s.name);
      const backup = backupServers[s.name];
      const src = serverSource.get(s.name);
      return {
        name: s.name,
        mode: s.mode,
        activeChildren: s.activeChildren,
        totalRequests: s.totalRequests,
        status: s.activeChildren > 0 ? 'running' as const : 'idle' as const,
        enabled: !isOptedOut(s.name),
        command: backup ? `${backup.command} ${(backup.args ?? []).join(' ')}`.trim() : (config ? `${config.command} ${(config.args ?? []).join(' ')}`.trim() : 'unknown'),
        lastActivityAt: 0, // Not tracked per-server yet
        source: src?.source ?? 'global',
        configPath: src?.configPath ?? '',
      };
    });

    // Add passthrough HTTP/SSE servers (not proxied, but visible in dashboard)
    for (const [name, pt] of passthroughServers) {
      // Skip if already in the pool (shouldn't happen, but defensive)
      if (servers.some(s => s.name === name)) continue;
      servers.push({
        name,
        mode: 'stateless',
        activeChildren: 0,
        totalRequests: 0,
        status: 'running',  // HTTP servers are always "running" (externally managed)
        enabled: true,
        command: pt.url,     // Show the URL instead of command for HTTP servers
        lastActivityAt: 0,
        source: 'project',
        configPath: pt.configPath,
      });
    }

    const response: GatewayStats = {
      uptimeSeconds: healthInfo.uptime,
      totalRequests: totalMcpRequests,
      totalErrors: totalMcpErrors,
      toolStats: sortedTools,
      activeConnections: healthInfo.totalChildren,
      memoryServiceHealthy,
      servers,
      sessions: getSessionInfo(),
      clients: healthInfo.clients ?? [],
      timeline: getTimeline(60),
      gatewayEnabled: !gatewayDisabled,
      memoryMB: healthInfo.memoryMB,
    };

    return c.json(response);
  });

  // ── Dashboard ──────────────────────────────────────────────────────
  app.get('/dashboard', (c) => {
    return c.html(getDashboardHtml());
  });

  // ── Server Management APIs ─────────────────────────────────────────

  // Reconnect a server: kill all children, force respawn on next request
  app.post('/api/servers/:name/reconnect', (c) => {
    const name = c.req.param('name');
    if (!managedServers.has(name)) {
      return c.json({ error: `Unknown server: ${name}` }, 404);
    }

    killServer(name);
    initializeCache.delete(name);
    logger.info(`[server] Reconnected server: ${name}`);
    return c.json({ ok: true, server: name });
  });

  // Disable a server: opt it out of gateway proxying
  app.post('/api/servers/:name/disable', (c) => {
    const name = c.req.param('name');
    optOut(name);
    removeServer(name);
    restoreServerInConfigs(name);
    logger.info(`[server] Disabled server: ${name}`);
    return c.json({ ok: true, server: name, enabled: false });
  });

  // Enable a previously disabled server
  app.post('/api/servers/:name/enable', (c) => {
    const name = c.req.param('name');
    optIn(name);

    // Look up original config from backup
    const backup = getBackupServers();
    const config = backup[name];
    if (config) {
      addServer(name, config);
      rewriteServerInConfigs(name);
      logger.info(`[server] Enabled server: ${name}`);
      return c.json({ ok: true, server: name, enabled: true });
    }

    return c.json({ error: `No backup config found for server: ${name}` }, 404);
  });

  // Install a new MCP server
  app.post('/api/servers/install', async (c) => {
    const body = await c.req.json<{
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }>();

    if (!body.name || !body.command) {
      return c.json({ error: 'name and command are required' }, 400);
    }

    const config: StdioServerConfig = {
      type: 'stdio',
      command: body.command,
      args: body.args,
      env: body.env,
    };

    addServer(body.name, config);
    rewriteServerInConfigs(body.name);

    // Update state.json
    const current = readState();
    if (current) {
      const serverSet = new Set(current.servers);
      serverSet.add(body.name);
      writeState({ ...current, servers: Array.from(serverSet) });
    }

    logger.info(`[server] Installed new server: ${body.name} (${body.command})`);
    return c.json({ ok: true, server: body.name, installed: true });
  });

  // ── Gateway Control APIs ───────────────────────────────────────────

  // Soft-disable: stop proxying but keep dashboard alive
  app.post('/api/gateway/disable', (c) => {
    gatewayDisabled = true;
    restoreConfig();
    logger.info('[server] Gateway disabled — MCP traffic restored to direct stdio');
    return c.json({ ok: true, status: 'disabled' });
  });

  // Re-enable gateway
  app.post('/api/gateway/enable', (c) => {
    gatewayDisabled = false;
    const rewritten = rewriteConfig();
    for (const { name, config } of rewritten) {
      addServer(name, config);
    }
    logger.info('[server] Gateway enabled — MCP traffic proxied');
    return c.json({ ok: true, status: 'enabled' });
  });

  // Gateway configuration
  app.get('/api/gateway/config', (c) => {
    return c.json({
      port: getHealthInfo().port,
      optedOut: getOptedOut(),
      disabled: gatewayDisabled,
      managedServers: Array.from(managedServers),
    });
  });

  // ── Session Management APIs ──────────────────────────────────────

  // Kill a single session
  app.post('/api/sessions/:sessionId/kill', (c) => {
    const sessionId = c.req.param('sessionId');
    // getSessionInfo returns 8-char truncated IDs, but killSession needs the full ID.
    // Look up the full session ID from the pool.
    const sessions = getSessionInfo();
    const match = sessions.find(s => s.sessionId === sessionId);
    if (!match) {
      return c.json({ error: `Session not found: ${sessionId}` }, 404);
    }
    const killed = killSession(sessionId);
    logger.info(`[server] Killed session ${sessionId}: ${killed} children`);
    return c.json({ ok: true, sessionId, killed });
  });

  // Kill all sessions
  app.post('/api/sessions/kill-all', (c) => {
    const sessions = getSessionInfo();
    let totalKilled = 0;
    for (const s of sessions) {
      totalKilled += killSession(s.sessionId);
    }
    logger.info(`[server] Killed all sessions: ${totalKilled} children across ${sessions.length} sessions`);
    return c.json({ ok: true, sessions: sessions.length, killed: totalKilled });
  });

  // ── MCP Proxy ──────────────────────────────────────────────────────

  // MCP proxy: POST /:serverName/mcp
  app.post('/:serverName/mcp', async (c) => {
    const serverName = c.req.param('serverName');

    // Gateway disabled guard
    if (gatewayDisabled) {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Gateway is disabled' } },
        503,
      );
    }

    if (!managedServers.has(serverName)) {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32601, message: `Unknown server: ${serverName}` } },
        404,
      );
    }

    // Parse JSON-RPC request
    let body: JsonRpcRequest;
    try {
      body = await c.req.json<JsonRpcRequest>();
    } catch {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        400,
      );
    }

    // Session management via Mcp-Session-Id header
    let sessionId = c.req.header('mcp-session-id') ?? '';
    if (!sessionId) {
      sessionId = randomUUID();
    }

    // Track client PID for dead-process detection in the reaper.
    // Claude Code sends X-Client-Pid header (set by our gateway config rewriter),
    // or we extract it from clientInfo.pid in the initialize request.
    if (body.method === 'initialize') {
      const headerPid = c.req.header('x-client-pid');
      const clientInfoPid = (body.params as any)?.clientInfo?.pid;
      const pid = headerPid ? parseInt(headerPid, 10) : clientInfoPid;
      if (pid && !isNaN(pid)) {
        setSessionClientPid(sessionId, pid);
      }
    }

    // JSON-RPC notifications have no `id` field — fire-and-forget, no response expected.
    // MCP sends `notifications/initialized`, `notifications/cancelled`, etc.
    const isNotification = body.id === undefined || body.id === null;

    if (isNotification) {
      try {
        await sendNotificationToChild(serverName, sessionId, body);
      } catch (err) {
        // Non-fatal — notification delivery is best-effort
        logger.debug(`[server] Notification ${body.method} to ${serverName} failed: ${err}`);
      }
      c.header('Mcp-Session-Id', sessionId);
      return c.json({ jsonrpc: '2.0' }, 202);
    }

    const toolName = extractToolName(body);
    const startTime = Date.now();

    try {
      // For stateless servers, cache the initialize response
      if (!isStateful(serverName) && body.method === 'initialize') {
        const cached = initializeCache.get(serverName);
        if (cached && body.id !== undefined) {
          // Return cached response with the caller's request ID
          const response = { ...cached, id: body.id };
          recordToolCall(toolName, Date.now() - startTime, false, serverName);
          c.header('Mcp-Session-Id', sessionId);
          return c.json(response);
        }
      }

      const response = await sendRequest(serverName, sessionId, body);

      // Cache initialize response for stateless servers
      if (!isStateful(serverName) && body.method === 'initialize' && response.result) {
        initializeCache.set(serverName, response);
      }

      const isError = !!response.error;
      recordToolCall(toolName, Date.now() - startTime, isError, serverName);

      c.header('Mcp-Session-Id', sessionId);
      return c.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[server] Error proxying to ${serverName}: ${message}`);

      recordToolCall(toolName, Date.now() - startTime, true, serverName);

      return c.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: `Gateway error: ${message}` },
      }, 502);
    }
  });

  // DELETE /sessions/by-pid/:pid — kill ALL stateful children owned by a client PID.
  // Called by the extension when a Claude process is dying (terminal close
  // grace period, stale session reaper). This is the primary cleanup path.
  app.delete('/sessions/by-pid/:pid', (c) => {
    const pid = parseInt(c.req.param('pid'), 10);
    if (isNaN(pid)) {
      return c.json({ error: 'Invalid PID' }, 400);
    }
    const result = killSessionsByPid(pid);
    logger.info(`[server] Cleanup by PID ${pid}: killed ${result.killed} children, ${result.sessions} sessions`);
    return c.json({ ok: true, ...result });
  });

  // DELETE /sessions/:sessionId — kill ALL stateful children for a session.
  // Called when a Claude session ends (clean shutdown) to immediately free
  // resources instead of waiting for the 30-minute idle reaper.
  app.delete('/sessions/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    const killed = killSession(sessionId);
    logger.info(`[server] Session ${sessionId.slice(0, 8)} closed — killed ${killed} children`);
    return c.json({ ok: true, killed });
  });

  // DELETE /:serverName/mcp — per-server session cleanup (MCP Streamable HTTP spec)
  app.delete('/:serverName/mcp', (c) => {
    const serverName = c.req.param('serverName');
    const sessionId = c.req.header('mcp-session-id');

    if (sessionId && isStateful(serverName)) {
      killSessionChild(serverName, sessionId);
    }

    return c.json({ ok: true });
  });

  // Register project-level MCP servers with the gateway.
  // Called by the extension's triggerMcpReconnect() to bridge project .mcp.json
  // servers into the gateway's child pool (backup → rewrite → register).
  // Also tracks HTTP/SSE servers as passthrough entries for dashboard visibility.
  app.post('/projects/register', async (c) => {
    const { configPath } = await c.req.json<{ configPath: string }>();
    if (!configPath) {
      return c.json({ error: 'configPath is required' }, 400);
    }

    // Read the project config to discover ALL servers (including HTTP/SSE)
    let allProjectServers: Record<string, any> = {};
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      allProjectServers = parsed.mcpServers ?? {};
    } catch {}

    // Track HTTP/SSE servers as passthrough (not proxied, but visible in dashboard)
    for (const [name, serverConfig] of Object.entries(allProjectServers)) {
      const cfg = serverConfig as Record<string, unknown>;
      if (cfg.type === 'http' || cfg.type === 'sse') {
        // Skip if this is a gateway-rewritten URL (already proxied)
        const url = cfg.url as string;
        if (url && !url.includes('localhost:9100')) {
          passthroughServers.set(name, { name, url, configPath });
        }
      }
    }

    const rewritten = rewriteProjectConfig(configPath);
    for (const { name, config } of rewritten) {
      addServer(name, config, { source: 'project', configPath });
    }

    // Update state.json so the extension sees the full server list
    if (rewritten.length > 0) {
      const current = readState();
      if (current) {
        const serverSet = new Set(current.servers);
        for (const { name } of rewritten) serverSet.add(name);
        writeState({ ...current, servers: Array.from(serverSet) });
      }
    }

    const passthroughCount = Object.entries(allProjectServers).filter(([, cfg]) => {
      const c = cfg as Record<string, unknown>;
      return (c.type === 'http' || c.type === 'sse') && !(c.url as string)?.includes('localhost:9100');
    }).length;

    logger.info(`[server] Registered ${rewritten.length} proxied + ${passthroughCount} passthrough servers from ${configPath}`);
    return c.json({ registered: rewritten.map(r => r.name), passthrough: passthroughCount });
  });

  // ── Multi-AI Client Registration ──────────────────────────────────
  //
  // AI tools (Claude, Cursor, Windsurf, Cline, etc.) can register with
  // the gateway to have their MCP traffic proxied through it. Each tool
  // keeps its own config file; the gateway rewrites all of them.

  // Register an AI client. Rewrites its config to route through the gateway.
  app.post('/clients/register', async (c) => {
    const body = await c.req.json<{ tool: string; configPath?: string }>();
    const tool = body.tool as AiToolId;

    if (!tool) {
      return c.json({ error: 'tool is required (claude, cursor, windsurf, cline, copilot, custom)' }, 400);
    }

    if (tool === 'custom' && !body.configPath) {
      return c.json({ error: 'configPath is required for custom AI tools' }, 400);
    }

    const rewritten = registerClient(tool, body.configPath);

    // Register new servers with the child pool
    for (const { name, config } of rewritten) {
      addServer(name, config);
    }

    // Update state.json
    const current = readState();
    if (current) {
      const serverSet = new Set(current.servers);
      for (const { name } of rewritten) serverSet.add(name);
      current.servers = Array.from(serverSet);
      current.clients = getRegisteredClients();
      writeState(current);
    }

    logger.info(`[server] Registered AI client: ${tool} (${rewritten.length} servers)`);
    return c.json({
      tool,
      registered: rewritten.map(r => r.name),
      configPath: body.configPath,
    });
  });

  // List registered AI clients.
  app.get('/clients', (c) => {
    return c.json({ clients: getRegisteredClients() });
  });

  // Auto-detect installed AI tools and return their config paths.
  app.get('/clients/detect', (c) => {
    const detected = detectInstalledTools();
    return c.json({ detected });
  });

  // Catch-all for unknown routes
  app.all('*', (c) => {
    return c.json({ error: 'Not found' }, 404);
  });

  return app;
}

/**
 * Register a server to be proxied by the gateway.
 * @param source Where this server was registered from (defaults to 'global')
 */
export function addServer(name: string, config: StdioServerConfig, source?: { source: 'global' | 'project'; configPath: string }): void {
  managedServers.add(name);
  registerServer(name, config);
  if (source) {
    serverSource.set(name, source);
  } else if (!serverSource.has(name)) {
    serverSource.set(name, { source: 'global', configPath: '' });
  }
  logger.info(`[server] Registered server: ${name} (${isStateful(name) ? 'stateful' : 'stateless'}, ${source?.source ?? 'global'})`);
}

/**
 * Remove a server from the gateway.
 */
export function removeServer(name: string): void {
  managedServers.delete(name);
  initializeCache.delete(name);
  killServer(name);
  logger.info(`[server] Removed server: ${name}`);
}

/**
 * Get list of managed server names.
 */
export function getManagedServers(): string[] {
  return Array.from(managedServers);
}

/**
 * Start the HTTP server.
 */
export function startServer(app: Hono, port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    initHealth(port);

    const server = serve({
      fetch: app.fetch,
      port,
    }, (info) => {
      logger.info(`[server] Gateway listening on http://localhost:${info.port}`);
      httpServer = server;
      resolve(server);
    });
  });
}

/**
 * Stop the HTTP server.
 */
export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (httpServer) {
      httpServer.close(() => {
        httpServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
