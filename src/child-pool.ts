import { spawn, ChildProcess } from 'child_process';
import {
  ManagedChild,
  StdioServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  ResolvedCommand,
  Logger,
} from './types';
import { isStateful, getClassification } from './classification';
import { resolveCommand } from './npx-resolver';

/** Pool of stateless (shared) children: serverName → ManagedChild */
const sharedPool = new Map<string, ManagedChild>();

/** Pool of stateful (per-session) children: `${serverName}:${sessionId}` → ManagedChild */
const sessionPool = new Map<string, ManagedChild>();

/**
 * Session-level activity tracking.
 * Updated on every request/notification from a session (regardless of which
 * server it targets). The reaper uses this to decide when a session is dead —
 * if ANY server in the session is active, ALL servers stay alive.
 * This prevents killing Chrome DevTools just because the user is actively
 * using Serena instead.
 */
const sessionLastActivity = new Map<string, number>();

/**
 * Maps gateway session ID → owning client PID.
 * Extracted from clientInfo.pid in the MCP initialize request, or from the
 * X-Client-Pid HTTP header. Used by the reaper to detect dead clients —
 * if the PID no longer exists, the session is orphaned and all its
 * children can be killed immediately instead of waiting for idle timeout.
 */
const sessionClientPid = new Map<string, number>();

/**
 * Spawn lock: prevents duplicate spawns for the same pool key.
 * When multiple concurrent requests arrive for the same server (before the
 * first spawn completes), all callers await the same Promise instead of
 * each spawning their own child.
 */
const pendingSpawns = new Map<string, Promise<ManagedChild>>();

/** Concurrency limiter for child spawning — prevents fork bomb under load */
const MAX_CONCURRENT_SPAWNS = 5;
let activeSpawns = 0;
const spawnQueue: Array<{ resolve: (child: ManagedChild) => void; reject: (err: Error) => void; fn: () => Promise<ManagedChild> }> = [];

async function throttledSpawn(fn: () => Promise<ManagedChild>): Promise<ManagedChild> {
  if (activeSpawns >= MAX_CONCURRENT_SPAWNS) {
    // Queue and wait for a slot
    return new Promise((resolve, reject) => {
      spawnQueue.push({ resolve, reject, fn });
    });
  }
  activeSpawns++;
  try {
    return await fn();
  } finally {
    activeSpawns--;
    // Drain queue
    if (spawnQueue.length > 0) {
      const next = spawnQueue.shift()!;
      throttledSpawn(next.fn).then(next.resolve, next.reject);
    }
  }
}

/** Original server configs for respawning */
const serverConfigs = new Map<string, StdioServerConfig>();

/** Request ID counter for internal tracking */
let nextInternalId = 1;

let logger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

/**
 * Initialize the child pool.
 */
export function initChildPool(log?: Logger): void {
  if (log) logger = log;
}

/**
 * Register a server config so the pool knows how to spawn it.
 */
export function registerServer(name: string, config: StdioServerConfig): void {
  serverConfigs.set(name, config);
}

/**
 * Associate a gateway session with the client PID that owns it.
 * Called when processing MCP `initialize` requests.
 */
export function setSessionClientPid(sessionId: string, pid: number): void {
  sessionClientPid.set(sessionId, pid);
  logger.debug(`[child-pool] Session ${sessionId.slice(0, 8)} owned by PID ${pid}`);
}

/**
 * Send a JSON-RPC request to a server and get the response.
 *
 * For stateless servers: routes to the shared child (spawning if needed).
 * For stateful servers: routes to the session-specific child (spawning if needed).
 */
export async function sendRequest(
  serverName: string,
  sessionId: string,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  sessionLastActivity.set(sessionId, Date.now());
  const child = await getOrSpawnChild(serverName, sessionId);
  return sendToChild(child, request);
}

/**
 * Send a notification (no response expected) to a server.
 * Spawns the child if it doesn't exist yet (notifications can arrive
 * right after initialize, before the child is in the pool).
 */
export async function sendNotificationToChild(
  serverName: string,
  sessionId: string,
  notification: JsonRpcRequest,
): Promise<void> {
  sessionLastActivity.set(sessionId, Date.now());
  const child = await getOrSpawnChild(serverName, sessionId);
  child.lastActivityAt = Date.now();
  writeToStdin(child, notification);

  // After forwarding notifications/initialized, give the child server time
  // to process it before allowing tool calls through. Without this, requests
  // arriving immediately after init race the server's internal setup.
  if (notification.method === 'notifications/initialized') {
    setTimeout(() => child.resolveInitGate(), 200);
  }
}

/**
 * @deprecated Use sendNotificationToChild instead
 */
export function sendNotification(
  serverName: string,
  sessionId: string,
  notification: JsonRpcRequest,
): void {
  const child = getExistingChild(serverName, sessionId);
  if (child) {
    writeToStdin(child, notification);
  }
}

/**
 * Get an existing child or spawn a new one.
 *
 * Uses a spawn lock (pendingSpawns) to prevent duplicate spawns when
 * concurrent requests arrive for the same server before the first
 * spawn completes. Without this, N concurrent requests would each
 * see an empty pool and spawn N children — only one gets registered,
 * the rest become orphaned OS processes consuming memory.
 */
async function getOrSpawnChild(serverName: string, sessionId: string): Promise<ManagedChild> {
  const stateful = isStateful(serverName);
  const poolKey = stateful ? `${serverName}:${sessionId}` : serverName;
  const pool = stateful ? sessionPool : sharedPool;

  // Fast path: child already exists and is alive
  let child = pool.get(poolKey);
  if (child && isChildAlive(child)) {
    return child;
  }

  // Child is dead — clean up
  if (child) {
    logger.warn(`[child-pool] ${stateful ? 'Stateful' : 'Shared'} child ${poolKey} died, removing`);
    pool.delete(poolKey);
  }

  // Check if another caller is already spawning this exact key
  const pending = pendingSpawns.get(poolKey);
  if (pending) {
    logger.debug(`[child-pool] Waiting on pending spawn for ${poolKey}`);
    return pending;
  }

  // We're the first caller — spawn and let others wait on our Promise
  const spawnPromise = throttledSpawn(() => spawnChild(serverName, stateful ? sessionId : null))
    .then((newChild) => {
      pool.set(poolKey, newChild);
      return newChild;
    })
    .finally(() => {
      pendingSpawns.delete(poolKey);
    });

  pendingSpawns.set(poolKey, spawnPromise);
  return spawnPromise;
}

/**
 * Get an existing child without spawning.
 */
function getExistingChild(serverName: string, sessionId: string): ManagedChild | undefined {
  if (isStateful(serverName)) {
    return sessionPool.get(`${serverName}:${sessionId}`);
  }
  return sharedPool.get(serverName);
}

/**
 * Spawn a child process for a server.
 */
async function spawnChild(serverName: string, sessionId: string | null): Promise<ManagedChild> {
  const config = serverConfigs.get(serverName);
  if (!config) {
    throw new Error(`No config registered for server: ${serverName}`);
  }

  const resolved: ResolvedCommand = resolveCommand(config);

  logger.info(
    `[child-pool] Spawning ${isStateful(serverName) ? 'stateful' : 'shared'} child: ${serverName}` +
    (sessionId ? ` (session: ${sessionId.slice(0, 8)})` : '') +
    ` → ${resolved.command} ${resolved.args.join(' ')}`
  );

  const child = spawn(resolved.command, resolved.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...resolved.env },
    // Don't detach — children should die with the gateway
  });

  let resolveInitGate: () => void;
  const initGate = new Promise<void>((resolve) => {
    resolveInitGate = resolve;
    // Safety: if notifications/initialized never arrives, unblock after 10s
    setTimeout(resolve, 10_000);
  });

  const managed: ManagedChild = {
    name: serverName,
    process: child,
    sessionId,
    ready: false,
    pending: new Map(),
    stdoutBuffer: '',
    spawnedAt: Date.now(),
    requestCount: 0,
    lastActivityAt: Date.now(),
    initGate,
    resolveInitGate: resolveInitGate!,
  };

  // Handle stdout — line-delimited JSON-RPC responses
  child.stdout!.on('data', (data: Buffer) => {
    handleStdout(managed, data);
  });

  // Handle stderr — log but don't fail
  child.stderr!.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      logger.debug(`[child-pool] ${serverName} stderr: ${text.slice(0, 500)}`);
    }
  });

  // Handle exit
  child.on('exit', (code, signal) => {
    logger.info(
      `[child-pool] ${serverName} exited: code=${code} signal=${signal}`
    );
    // Reject all pending requests
    for (const [id, pending] of managed.pending) {
      pending.reject(new Error(`Child process ${serverName} exited (code=${code})`));
      clearTimeout(pending.timer);
    }
    managed.pending.clear();
  });

  child.on('error', (err) => {
    logger.error(`[child-pool] ${serverName} error: ${err.message}`);
  });

  // Wait for the child to be ready (first stdout message, or short timeout)
  await waitForReady(managed);

  return managed;
}

/**
 * Wait for the child process to be ready.
 * MCP servers typically send an initialization message on stdout.
 */
function waitForReady(child: ManagedChild): Promise<void> {
  return new Promise((resolve) => {
    // If we get any stdout within 5s, consider ready
    const timeout = setTimeout(() => {
      child.ready = true;
      resolve();
    }, 5000);

    const onData = () => {
      child.ready = true;
      clearTimeout(timeout);
      child.process.stdout!.removeListener('data', onData);
      resolve();
    };

    child.process.stdout!.once('data', onData);

    // Also resolve immediately if the process dies
    child.process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Handle stdout data from a child process.
 * Parses line-delimited JSON-RPC messages and routes responses.
 */
function handleStdout(child: ManagedChild, data: Buffer): void {
  child.stdoutBuffer += data.toString();
  child.ready = true;

  // Process complete lines
  let newlineIdx: number;
  while ((newlineIdx = child.stdoutBuffer.indexOf('\n')) !== -1) {
    const line = child.stdoutBuffer.slice(0, newlineIdx).trim();
    child.stdoutBuffer = child.stdoutBuffer.slice(newlineIdx + 1);

    if (!line) continue;

    try {
      const msg = JSON.parse(line);

      // Check if this is a response (has id) or notification
      if (msg.id !== undefined && msg.id !== null) {
        const pending = child.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          child.pending.delete(msg.id);
          pending.resolve(msg as JsonRpcResponse);
        } else {
          logger.debug(`[child-pool] ${child.name}: orphan response id=${msg.id}`);
        }
      }
      // Notifications (no id) are ignored for now
      // Future: could forward to SSE stream for server-initiated messages
    } catch {
      logger.debug(`[child-pool] ${child.name}: non-JSON stdout: ${line.slice(0, 200)}`);
    }
  }
}

/**
 * Send a JSON-RPC request to a child and wait for the response.
 */
async function sendToChild(child: ManagedChild, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  // Wait for MCP initialization to complete before sending requests.
  // This prevents the race where a tool call arrives before the server
  // has finished processing notifications/initialized.
  if (request.method !== 'initialize') {
    await child.initGate;
  }

  return new Promise((resolve, reject) => {
    if (!isChildAlive(child)) {
      reject(new Error(`Child ${child.name} is not alive`));
      return;
    }

    // Ensure request has an ID
    const id = request.id ?? nextInternalId++;
    const outgoing = { ...request, id };

    const classification = getClassification(child.name);
    const timeout = classification.requestTimeout ?? 120_000;

    const timer = setTimeout(() => {
      child.pending.delete(id);
      reject(new Error(`Request to ${child.name} timed out after ${timeout}ms (method: ${request.method})`));
    }, timeout);

    child.pending.set(id, {
      resolve,
      reject,
      timer,
      method: request.method,
      sentAt: Date.now(),
    });

    child.requestCount++;
    child.lastActivityAt = Date.now();
    writeToStdin(child, outgoing);
  });
}

/**
 * Write a JSON-RPC message to a child's stdin.
 */
function writeToStdin(child: ManagedChild, message: object): void {
  try {
    child.process.stdin!.write(JSON.stringify(message) + '\n');
  } catch (err) {
    logger.error(`[child-pool] Failed to write to ${child.name} stdin: ${err}`);
  }
}

/**
 * Check if a child process is still alive.
 */
function isChildAlive(child: ManagedChild): boolean {
  return child.process.exitCode === null && !child.process.killed;
}

/**
 * Kill a specific session's stateful child.
 */
export function killSessionChild(serverName: string, sessionId: string): void {
  const key = `${serverName}:${sessionId}`;
  const child = sessionPool.get(key);
  if (child) {
    logger.info(`[child-pool] Killing stateful child: ${key}`);
    child.process.kill('SIGTERM');
    sessionPool.delete(key);
  }
}

/**
 * Kill all children for a server.
 */
export function killServer(serverName: string): void {
  // Kill shared child
  const shared = sharedPool.get(serverName);
  if (shared) {
    shared.process.kill('SIGTERM');
    sharedPool.delete(serverName);
  }

  // Kill all session-specific children
  for (const [key, child] of sessionPool) {
    if (key.startsWith(`${serverName}:`)) {
      child.process.kill('SIGTERM');
      sessionPool.delete(key);
    }
  }

  serverConfigs.delete(serverName);
}

// ── Session Cleanup ──────────────────────────────────────────────────

/**
 * Kill all stateful children belonging to a session.
 * Called when a Claude session explicitly disconnects (DELETE /sessions/:id)
 * or when the reaper determines a session is abandoned.
 */
export function killSession(sessionId: string): number {
  let killed = 0;
  for (const [key, child] of sessionPool) {
    if (child.sessionId === sessionId) {
      if (isChildAlive(child)) {
        child.process.kill('SIGTERM');
        killed++;
      }
      sessionPool.delete(key);
    }
  }
  sessionLastActivity.delete(sessionId);
  sessionClientPid.delete(sessionId);
  if (killed > 0) {
    logger.info(`[child-pool] Killed ${killed} children for session ${sessionId.slice(0, 8)}`);
  }
  return killed;
}

/**
 * Kill all sessions owned by a specific client PID.
 * Called by the extension when it knows a Claude process is dying
 * (terminal close grace period, stale session reaper).
 */
export function killSessionsByPid(pid: number): { killed: number; sessions: number } {
  const sessionsForPid: string[] = [];
  for (const [sessionId, ownerPid] of sessionClientPid) {
    if (ownerPid === pid) {
      sessionsForPid.push(sessionId);
    }
  }

  let totalKilled = 0;
  for (const sessionId of sessionsForPid) {
    totalKilled += killSession(sessionId);
  }

  if (sessionsForPid.length > 0) {
    logger.info(
      `[child-pool] Cleaned up PID ${pid}: killed ${totalKilled} children across ${sessionsForPid.length} session(s)`
    );
  }

  return { killed: totalKilled, sessions: sessionsForPid.length };
}

// ── Idle Reaper ───────────────────────────────────────────────────────

/**
 * How long a session can be idle before ALL its stateful children are reaped.
 * Tracked at the SESSION level (not per-child), so if Claude is actively
 * using Serena, its Chrome DevTools child stays alive too.
 * 30 minutes is a safety net for truly abandoned sessions — users who
 * close their terminal without clean shutdown.
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Reaper interval (check every 60 seconds) */
const REAPER_INTERVAL_MS = 60 * 1000;

let reaperTimer: NodeJS.Timeout | null = null;

/**
 * Start the idle reaper. Periodically checks for abandoned sessions
 * and kills all their stateful children.
 *
 * Uses session-level activity tracking: if a session hasn't sent ANY
 * request to ANY server in SESSION_IDLE_TIMEOUT_MS, the entire session
 * is considered dead and all its children are killed at once.
 *
 * Also cleans up dead children (process exited but still in the pool).
 */
export function startIdleReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();

    // Phase 1: Clean up dead children (process exited but still in pool)
    for (const [key, child] of sessionPool) {
      if (!isChildAlive(child)) {
        sessionPool.delete(key);
      }
    }

    // Phase 2: Check for dead client processes (immediate cleanup).
    // If we know the client PID and it's no longer running, the session
    // is definitely orphaned — kill immediately, don't wait for idle timeout.
    // This handles: user closes terminal (grace period expires → Claude killed),
    // stale session reaper (48h idle → Claude SIGTERMed), or Claude crashes.
    const deadClientSessions: string[] = [];
    for (const [sessionId, pid] of sessionClientPid) {
      try {
        process.kill(pid, 0); // Signal 0 = check if alive
      } catch {
        // ESRCH: process doesn't exist → client is dead
        deadClientSessions.push(sessionId);
      }
    }

    let totalReaped = 0;
    for (const sessionId of deadClientSessions) {
      const pid = sessionClientPid.get(sessionId);
      logger.info(`[reaper] Client PID ${pid} is dead — killing session ${sessionId.slice(0, 8)}`);
      totalReaped += killSession(sessionId);
      sessionClientPid.delete(sessionId);
    }

    // Phase 3: Idle timeout fallback for sessions without a known PID.
    // If we don't know the client PID (older clients, missing header),
    // fall back to the 30-minute idle timeout.
    for (const [sessionId, lastActivity] of sessionLastActivity) {
      if (sessionClientPid.has(sessionId)) continue; // Phase 2 handles these
      const idleMs = now - lastActivity;
      if (idleMs > SESSION_IDLE_TIMEOUT_MS) {
        let sessionChildren = 0;
        for (const [, child] of sessionPool) {
          if (child.sessionId === sessionId && isChildAlive(child)) {
            sessionChildren++;
          }
        }

        if (sessionChildren > 0) {
          logger.info(
            `[reaper] Session ${sessionId.slice(0, 8)} abandoned ` +
            `(idle ${Math.round(idleMs / 60000)}m, no PID tracked) ` +
            `— killing ${sessionChildren} stateful children`
          );
          totalReaped += killSession(sessionId);
        } else {
          sessionLastActivity.delete(sessionId);
        }
      }
    }

    if (totalReaped > 0) {
      logger.info(`[reaper] Reaped ${totalReaped} total. Pool: ${sessionPool.size} stateful, ${sharedPool.size} shared`);
    }
  }, REAPER_INTERVAL_MS);
}

/**
 * Stop the idle reaper.
 */
export function stopIdleReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

/**
 * Kill all children and clean up.
 */
export function killAll(): void {
  stopIdleReaper();
  logger.info('[child-pool] Killing all children...');

  for (const [name, child] of sharedPool) {
    child.process.kill('SIGTERM');
  }
  sharedPool.clear();

  for (const [key, child] of sessionPool) {
    child.process.kill('SIGTERM');
  }
  sessionPool.clear();

  serverConfigs.clear();
}

/**
 * Get diagnostics about the child pool.
 */
export function getPoolStats(): {
  servers: Array<{
    name: string;
    mode: 'stateless' | 'stateful';
    activeChildren: number;
    totalRequests: number;
  }>;
  totalChildren: number;
} {
  const serverStats = new Map<string, { mode: 'stateless' | 'stateful'; children: number; requests: number }>();

  // Count shared children
  for (const [name, child] of sharedPool) {
    serverStats.set(name, {
      mode: 'stateless',
      children: isChildAlive(child) ? 1 : 0,
      requests: child.requestCount,
    });
  }

  // Count session children
  for (const [key, child] of sessionPool) {
    const name = key.split(':')[0];
    const existing = serverStats.get(name) ?? { mode: 'stateful' as const, children: 0, requests: 0 };
    if (isChildAlive(child)) existing.children++;
    existing.requests += child.requestCount;
    serverStats.set(name, existing);
  }

  // Include registered but not-yet-spawned servers
  for (const name of serverConfigs.keys()) {
    if (!serverStats.has(name)) {
      serverStats.set(name, {
        mode: isStateful(name) ? 'stateful' : 'stateless',
        children: 0,
        requests: 0,
      });
    }
  }

  const servers = Array.from(serverStats.entries()).map(([name, stats]) => ({
    name,
    mode: stats.mode,
    activeChildren: stats.children,
    totalRequests: stats.requests,
  }));

  return {
    servers,
    totalChildren: servers.reduce((sum, s) => sum + s.activeChildren, 0),
  };
}

/**
 * Get active session info for the dashboard.
 * Iterates sessionPool, sessionLastActivity, and sessionClientPid
 * to build per-session summaries.
 */
export function getSessionInfo(): Array<{
  sessionId: string;
  clientPid: number | null;
  servers: string[];
  lastActivityAt: number;
  childCount: number;
}> {
  // Collect unique sessions from the session pool
  const sessions = new Map<string, { servers: Set<string>; childCount: number }>();

  for (const [key, child] of sessionPool) {
    const parts = key.split(':');
    const serverName = parts[0];
    const sessionId = parts.slice(1).join(':');
    if (!sessionId) continue;

    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { servers: new Set(), childCount: 0 };
      sessions.set(sessionId, entry);
    }
    entry.servers.add(serverName);
    if (isChildAlive(child)) entry.childCount++;
  }

  return Array.from(sessions.entries()).map(([sessionId, entry]) => ({
    sessionId,
    clientPid: sessionClientPid.get(sessionId) ?? null,
    servers: Array.from(entry.servers),
    lastActivityAt: sessionLastActivity.get(sessionId) ?? 0,
    childCount: entry.childCount,
  }));
}

/**
 * Expose server configs for management endpoints.
 */
export function getServerConfigs(): Map<string, StdioServerConfig> {
  return serverConfigs;
}
