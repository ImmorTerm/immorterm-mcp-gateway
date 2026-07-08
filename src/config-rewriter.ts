import * as fs from 'fs';
import * as path from 'path';
import {
  ConfigBackup,
  StdioServerConfig,
  GatewayState,
  ServerConfig,
  Logger,
} from './types';

let stateDir = '';
let configPath = '';
let port = 9100;
let logger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

/** Tracks our own writes to ignore self-triggered fs.watch events */
let lastWriteTs = 0;
const SELF_WRITE_WINDOW_MS = 500;

/** fs.watch handle */
let watcher: fs.FSWatcher | null = null;

/** Debounce timer for config change handling */
let changeTimer: NodeJS.Timeout | null = null;
const CHANGE_DEBOUNCE_MS = 500;

/**
 * Initialize the config rewriter.
 */
export function initConfigRewriter(
  opts: { stateDir: string; configPath: string; port: number },
  log?: Logger,
): void {
  stateDir = opts.stateDir;
  configPath = opts.configPath;
  port = opts.port;
  if (log) logger = log;
}

// ── Paths ──────────────────────────────────────────────────────────────

function backupPath(): string {
  return path.join(stateDir, 'config-backup.json');
}

/** Shadow backup — redundant copy that survives accidental overwrites */
function shadowBackupPath(): string {
  return path.join(stateDir, 'config-backup.shadow.json');
}

function statePath(): string {
  return path.join(stateDir, 'state.json');
}

function gatewayUrl(serverName: string): string {
  return `http://localhost:${port}/${serverName}/mcp`;
}

// ── Read/Write helpers ─────────────────────────────────────────────────

function readClaudeConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeClaudeConfig(config: Record<string, unknown>): void {
  lastWriteTs = Date.now();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function readBackup(): ConfigBackup | null {
  // Try primary backup first
  const primary = backupPath();
  if (fs.existsSync(primary)) {
    try {
      const backup = JSON.parse(fs.readFileSync(primary, 'utf-8')) as ConfigBackup;
      if (backup.servers && Object.keys(backup.servers).length > 0) {
        return backup;
      }
      // Primary exists but is empty — fall through to shadow
      logger.warn('[config] Primary backup is empty, trying shadow backup...');
    } catch {
      logger.warn('[config] Primary backup corrupt, trying shadow backup...');
    }
  }

  // Fall back to shadow backup
  const shadow = shadowBackupPath();
  if (fs.existsSync(shadow)) {
    try {
      const backup = JSON.parse(fs.readFileSync(shadow, 'utf-8')) as ConfigBackup;
      if (backup.servers && Object.keys(backup.servers).length > 0) {
        // Restore primary from shadow
        logger.info(`[config] Recovered ${Object.keys(backup.servers).length} servers from shadow backup`);
        fs.writeFileSync(primary, JSON.stringify(backup, null, 2));
        return backup;
      }
    } catch {}
  }

  return null;
}

function writeBackup(backup: ConfigBackup): void {
  // Only write if backup has actual servers — never write an empty backup
  if (!backup.servers || Object.keys(backup.servers).length === 0) {
    logger.warn('[config] Refusing to write empty backup — this would destroy recovery data');
    return;
  }
  const data = JSON.stringify(backup, null, 2);
  fs.writeFileSync(backupPath(), data);
  // Shadow copy — redundant backup that survives accidental overwrites
  fs.writeFileSync(shadowBackupPath(), data);
}

export function readState(): GatewayState | null {
  const p = statePath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeState(state: GatewayState): void {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function deleteState(): void {
  const p = statePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── Core: Backup → Rewrite → Restore ──────────────────────────────────

/**
 * Check for stale state from a crashed gateway and restore config if needed.
 *
 * Two recovery paths:
 * 1. state.json exists + PID is dead → restore from backup
 * 2. No state.json but backup exists + config has gateway URLs → restore from backup
 *    (handles the case where process died without writing state, or state was lost)
 *
 * Returns true if recovery was performed.
 */
export function recoverFromCrash(): boolean {
  const existingState = readState();

  if (existingState) {
    // Check if the PID is still alive
    try {
      process.kill(existingState.pid, 0);
      // Process exists — another gateway is running
      logger.error(
        `[config] Another gateway is running (PID ${existingState.pid} on port ${existingState.port}). ` +
        `Kill it first or use a different port.`
      );
      throw new Error(`Gateway already running at PID ${existingState.pid}`);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        // Process dead — stale state, restore config
        logger.warn('[config] Found stale state.json (gateway crashed). Restoring config backup...');
        restoreConfig();
        deleteState();
        return true;
      }
      // Re-throw if it's our "already running" error
      if (err.message?.includes('already running')) throw err;
    }
    return false;
  }

  // Path 2: No state.json — check if backup exists AND config has orphaned gateway URLs.
  // This catches the case where the process died without state.json being written,
  // or state.json was manually deleted during debugging.
  const backup = readBackup();
  if (backup && Object.keys(backup.servers).length > 0) {
    const config = readClaudeConfig();
    const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;

    const hasOrphanedGatewayUrls = Object.values(servers).some(
      (s) => 'url' in s && typeof s.url === 'string' && s.url.includes(`localhost:${port}`)
    );

    if (hasOrphanedGatewayUrls) {
      logger.warn('[config] No state.json but found orphaned gateway URLs in config. Restoring from backup...');
      restoreConfig();
      return true;
    }
  }

  return false;
}

/**
 * Detect and recover from the "all-HTTP-pointing-at-self" corrupted state.
 *
 * This happens when:
 * 1. The gateway crashed without restoring configs
 * 2. The backup was lost or emptied
 * 3. On restart, all servers in ~/.claude.json point to the gateway's own HTTP URLs
 * 4. rewriteConfig() finds 0 stdio servers → gateway runs with zero servers
 *
 * Recovery strategy: reconstruct original stdio configs from the npx-cache.json
 * file, which maps npx commands to their resolved local paths. This is the
 * same cache the child-pool uses for spawning, so it's always accurate.
 *
 * Returns the recovered configs, or empty array if nothing to recover.
 */
export function recoverOrphanedServers(): { name: string; config: StdioServerConfig }[] {
  const config = readClaudeConfig();
  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;

  // Find servers pointing at our own gateway URLs
  const orphanedNames: string[] = [];
  for (const [name, serverConfig] of Object.entries(servers)) {
    if (
      'url' in serverConfig &&
      typeof serverConfig.url === 'string' &&
      serverConfig.url.includes(`localhost:${port}`)
    ) {
      orphanedNames.push(name);
    }
  }

  if (orphanedNames.length === 0) return [];

  // Try to reconstruct from npx-cache.json
  const npxCachePath = path.join(stateDir, 'npx-cache.json');
  let npxCache: Record<string, { originalCommand: string; originalArgs: string[] }> = {};
  try {
    npxCache = JSON.parse(fs.readFileSync(npxCachePath, 'utf-8'));
  } catch {}

  // Build a lookup: server name → npx cache entry
  // npx-cache keys look like "npx:-y @upstash/context7-mcp" and the server name
  // appears in the URL path: http://localhost:9100/context7/mcp → "context7"
  const nameToNpxKey = new Map<string, string>();
  for (const key of Object.keys(npxCache)) {
    // Extract package hint from key (last segment of package name)
    const parts = key.split(/\s+/);
    for (const part of parts) {
      if (part.startsWith('-')) continue;
      // @scope/package-name → package-name, or just package-name
      const pkgName = part.includes('/') ? part.split('/').pop()! : part;
      // Match against known server names by checking if the package name
      // contains the server name or vice versa
      for (const serverName of orphanedNames) {
        if (
          pkgName.toLowerCase().includes(serverName.toLowerCase()) ||
          serverName.toLowerCase().includes(pkgName.replace(/-mcp$|^mcp-/, '').toLowerCase())
        ) {
          nameToNpxKey.set(serverName, key);
        }
      }
    }
  }

  const recovered: { name: string; config: StdioServerConfig }[] = [];
  const backupServers: Record<string, StdioServerConfig> = {};

  for (const name of orphanedNames) {
    const cacheKey = nameToNpxKey.get(name);
    if (!cacheKey) {
      logger.warn(`[config] Cannot recover server "${name}" — not found in npx-cache`);
      continue;
    }

    const entry = npxCache[cacheKey] as any;
    const config: StdioServerConfig = {
      type: 'stdio',
      command: entry.originalCommand,
      args: entry.originalArgs,
    };

    // Check if the original had env vars by reading from any remaining config context
    // (env vars aren't in npx-cache, but most MCP servers get them from process.env)

    backupServers[name] = config;
    recovered.push({ name, config });
    logger.info(`[config] Recovered server "${name}" from npx-cache: ${config.command} ${(config.args ?? []).join(' ')}`);
  }

  if (recovered.length > 0) {
    // Rebuild the backup from recovered configs
    writeBackup({ backedAt: Date.now(), servers: backupServers });
    logger.info(`[config] Reconstructed backup with ${recovered.length} servers from npx-cache`);

    // Restore the original stdio configs in claude.json so rewriteConfig() can
    // find them on the next call and do a proper backup → rewrite cycle
    for (const { name, config: stdioConfig } of recovered) {
      (servers as any)[name] = stdioConfig;
    }
    config.mcpServers = servers;
    writeClaudeConfig(config);
    logger.info(`[config] Restored ${recovered.length} stdio entries in config for re-rewriting`);
  } else if (orphanedNames.length > 0) {
    logger.error(
      `[config] CRITICAL: ${orphanedNames.length} orphaned server(s) pointing at gateway ` +
      `but cannot recover from npx-cache: ${orphanedNames.join(', ')}. ` +
      `Manual intervention needed: restore ~/.claude.json with original stdio configs.`
    );
  }

  return recovered;
}

/**
 * Scan claude config for stdio servers, backup originals, and rewrite to HTTP.
 *
 * Returns the list of server names that were rewritten.
 */
export function rewriteConfig(): { name: string; config: StdioServerConfig }[] {
  const config = readClaudeConfig();
  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;

  const rewritten: { name: string; config: StdioServerConfig }[] = [];
  const backupServers: Record<string, StdioServerConfig> = {};

  // Load existing backup to preserve servers from previous runs
  const existingBackup = readBackup();
  if (existingBackup) {
    Object.assign(backupServers, existingBackup.servers);
  }

  for (const [name, serverConfig] of Object.entries(servers)) {
    // Only rewrite stdio servers
    if (serverConfig.type !== 'stdio') continue;

    // Skip if already pointing to our gateway
    if ('url' in serverConfig && typeof serverConfig.url === 'string' && serverConfig.url.includes(`localhost:${port}`)) {
      continue;
    }

    // Backup the original
    backupServers[name] = serverConfig as StdioServerConfig;

    // Rewrite to HTTP
    (servers as any)[name] = {
      type: 'http',
      url: gatewayUrl(name),
    };

    rewritten.push({ name, config: serverConfig as StdioServerConfig });
  }

  // Save backup — but NEVER shrink it. The backup is append-only:
  // new servers get added, but we never lose servers that were previously backed up.
  // This protects against the scenario where all configs are already HTTP (post-crash)
  // and rewriteConfig() finds 0 stdio servers — without this guard it would save an
  // empty backup, permanently losing the original configs.
  if (Object.keys(backupServers).length > 0) {
    writeBackup({
      backedAt: Date.now(),
      servers: backupServers,
    });
  }

  // Write rewritten config + reconnect timestamp
  // Claude Code watches this file — _reconnect_ts forces it to re-init MCP connections
  config.mcpServers = servers;
  (config as Record<string, unknown>)._mcp_gateway_ts = Date.now();
  writeClaudeConfig(config);

  logger.info(`[config] Rewrote ${rewritten.length} stdio servers → HTTP gateway`);
  return rewritten;
}

/**
 * Restore original stdio configs from backup.
 */
export function restoreConfig(): boolean {
  const backup = readBackup();
  if (!backup || Object.keys(backup.servers).length === 0) {
    logger.info('[config] No backup to restore');
    return false;
  }

  const config = readClaudeConfig();
  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;

  let restored = 0;
  for (const [name, originalConfig] of Object.entries(backup.servers)) {
    const current = servers[name];

    // Only restore if current entry points to our gateway
    if (
      current &&
      'url' in current &&
      typeof current.url === 'string' &&
      current.url.includes(`localhost:${port}`)
    ) {
      (servers as any)[name] = originalConfig;
      restored++;
    }
  }

  if (restored > 0) {
    config.mcpServers = servers;
    writeClaudeConfig(config);
    logger.info(`[config] Restored ${restored} servers from backup`);
  }

  // Backup is intentionally KEPT after restore — it's an append-only ledger.
  // If the process dies before restoreConfig() runs, the backup is the only
  // record of original configs. Deleting it creates an unrecoverable state.

  return restored > 0;
}

// ── Hot Reload: fs.watch on config file ────────────────────────────────

/**
 * Start watching the config file for external changes (e.g., `claude mcp add`).
 *
 * @param onNewServer Callback when a new stdio server is detected
 * @param onRemovedServer Callback when a server is removed
 */
export function startWatching(
  onNewServer: (name: string, config: StdioServerConfig) => void,
  onRemovedServer: (name: string) => void,
): void {
  if (watcher) return;

  try {
    watcher = fs.watch(configPath, () => {
      // Ignore self-triggered events
      if (Date.now() - lastWriteTs < SELF_WRITE_WINDOW_MS) return;

      // Debounce — Claude may write multiple times in quick succession
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => handleConfigChange(onNewServer, onRemovedServer), CHANGE_DEBOUNCE_MS);
    });

    logger.info(`[config] Watching ${configPath} for changes`);
  } catch (err) {
    logger.warn(`[config] Failed to watch config: ${err}`);
  }
}

/**
 * Stop watching the config file.
 */
export function stopWatching(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (changeTimer) {
    clearTimeout(changeTimer);
    changeTimer = null;
  }
}

/**
 * Handle an external config change.
 */
function handleConfigChange(
  onNewServer: (name: string, config: StdioServerConfig) => void,
  onRemovedServer: (name: string) => void,
): void {
  const config = readClaudeConfig();
  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;
  const backup = readBackup();
  const knownServers = new Set(backup ? Object.keys(backup.servers) : []);

  let hasChanges = false;

  for (const [name, serverConfig] of Object.entries(servers)) {
    if (serverConfig.type === 'stdio') {
      // New stdio entry — either brand new or someone reverted a gateway entry
      logger.info(`[config] Detected new stdio server: ${name}`);

      // Add to backup
      if (backup) {
        backup.servers[name] = serverConfig as StdioServerConfig;
        writeBackup(backup);
      }

      // Rewrite to HTTP
      (servers as any)[name] = {
        type: 'http',
        url: gatewayUrl(name),
      };

      hasChanges = true;
      onNewServer(name, serverConfig as StdioServerConfig);
    }
  }

  // Check for removed servers.
  // IMPORTANT: We only remove a server from the backup if it was explicitly
  // removed from the config (user ran `claude mcp remove`). We detect this by
  // checking that the config still has OTHER servers — if the entire mcpServers
  // section is empty/missing, this is likely a transient write (config truncation,
  // editor save race) and we must NOT touch the backup.
  if (backup) {
    const configServerCount = Object.keys(servers).length;
    for (const name of Object.keys(backup.servers)) {
      if (!(name in servers)) {
        // Safety: if ALL backed-up servers are "missing" from config, this is
        // almost certainly a transient/corrupted config write — do NOT purge.
        if (configServerCount === 0) {
          logger.warn(`[config] Config appears empty/truncated — refusing to remove ${name} from backup`);
          continue;
        }
        // At least some servers still exist — this was a targeted removal
        logger.info(`[config] Detected removed server: ${name}`);
        delete backup.servers[name];
        // Only persist if backup still has entries
        if (Object.keys(backup.servers).length > 0) {
          writeBackup(backup);
        } else {
          logger.warn('[config] Would empty backup — skipping write (keeping last server in backup)');
        }
        onRemovedServer(name);
      }
    }
  }

  if (hasChanges) {
    config.mcpServers = servers;
    writeClaudeConfig(config);
  }
}

// ── Project config rewriting (for .mcp.json) ──────────────────────────

/**
 * Rewrite a project .mcp.json file, similar to global config.
 * Returns list of rewritten server names.
 */
export function rewriteProjectConfig(projectConfigPath: string): { name: string; config: StdioServerConfig }[] {
  if (!fs.existsSync(projectConfigPath)) return [];

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
  } catch {
    return [];
  }

  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;
  const rewritten: { name: string; config: StdioServerConfig }[] = [];

  // Project backups dir
  const projectBackupsDir = path.join(stateDir, 'project-backups');
  if (!fs.existsSync(projectBackupsDir)) {
    fs.mkdirSync(projectBackupsDir, { recursive: true });
  }

  const projectHash = hashString(projectConfigPath);
  const projectBackupPath = path.join(projectBackupsDir, `${projectHash}.json`);

  // Load existing project backup
  let backupServers: Record<string, StdioServerConfig> = {};
  if (fs.existsSync(projectBackupPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(projectBackupPath, 'utf-8'));
      backupServers = existing.servers ?? {};
    } catch {}
  }

  for (const [name, serverConfig] of Object.entries(servers)) {
    if (serverConfig.type !== 'stdio') continue;
    if ('url' in serverConfig && typeof serverConfig.url === 'string' && serverConfig.url.includes(`localhost:${port}`)) continue;

    backupServers[name] = serverConfig as StdioServerConfig;

    (servers as any)[name] = {
      type: 'http',
      url: gatewayUrl(name),
    };

    rewritten.push({ name, config: serverConfig as StdioServerConfig });
  }

  if (rewritten.length > 0) {
    // Save project backup
    fs.writeFileSync(projectBackupPath, JSON.stringify({
      configPath: projectConfigPath,
      projectHash,
      backedAt: Date.now(),
      servers: backupServers,
    }, null, 2));

    // Write rewritten project config
    config.mcpServers = servers;
    fs.writeFileSync(projectConfigPath, JSON.stringify(config, null, 2) + '\n');
    logger.info(`[config] Rewrote ${rewritten.length} servers in ${projectConfigPath}`);
  }

  return rewritten;
}

/**
 * Restore a project .mcp.json from backup.
 */
export function restoreProjectConfig(projectConfigPath: string): boolean {
  const projectHash = hashString(projectConfigPath);
  const projectBackupPath = path.join(stateDir, 'project-backups', `${projectHash}.json`);

  if (!fs.existsSync(projectBackupPath)) return false;

  let backup: { servers: Record<string, StdioServerConfig> };
  try {
    backup = JSON.parse(fs.readFileSync(projectBackupPath, 'utf-8'));
  } catch {
    return false;
  }

  if (!fs.existsSync(projectConfigPath)) return false;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
  } catch {
    return false;
  }

  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;
  let restored = 0;

  for (const [name, originalConfig] of Object.entries(backup.servers)) {
    const current = servers[name];
    if (
      current &&
      'url' in current &&
      typeof current.url === 'string' &&
      current.url.includes(`localhost:${port}`)
    ) {
      (servers as any)[name] = originalConfig;
      restored++;
    }
  }

  if (restored > 0) {
    config.mcpServers = servers;
    fs.writeFileSync(projectConfigPath, JSON.stringify(config, null, 2) + '\n');
    logger.info(`[config] Restored ${restored} servers in ${projectConfigPath}`);
  }

  // Backup kept intentionally — same rationale as global config

  return restored > 0;
}

/**
 * Restore all project configs from backups.
 */
export function restoreAllProjectConfigs(): void {
  const projectBackupsDir = path.join(stateDir, 'project-backups');
  if (!fs.existsSync(projectBackupsDir)) return;

  for (const file of fs.readdirSync(projectBackupsDir)) {
    if (!file.endsWith('.json')) continue;
    const backupPath = path.join(projectBackupsDir, file);
    try {
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      if (backup.configPath) {
        restoreProjectConfig(backup.configPath);
      }
    } catch (err) {
      logger.warn(`[config] Failed to restore project backup ${file}: ${err}`);
    }
  }
}

/**
 * Get the backed-up server configs (original stdio entries before gateway rewrite).
 * Used by management endpoints to look up original commands for opted-out servers.
 */
export function getBackupServers(): Record<string, StdioServerConfig> {
  const backup = readBackup();
  return backup?.servers ?? {};
}

/**
 * Restore a single server's config back to its original stdio entry
 * across all registered config files (claude.json + AI tool configs).
 * Used when opting-out a server from gateway proxying.
 */
export function restoreServerInConfigs(serverName: string): boolean {
  const backup = readBackup();
  if (!backup?.servers[serverName]) return false;

  const originalConfig = backup.servers[serverName];
  const claudeConfigPath = configPath;

  // Restore in Claude's config
  try {
    const raw = fs.readFileSync(claudeConfigPath, 'utf-8');
    const config = JSON.parse(raw);
    if (config.mcpServers?.[serverName]) {
      config.mcpServers[serverName] = originalConfig;
      lastWriteTs = Date.now();
      fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
    }
  } catch (err) {
    logger.warn(`[config] Failed to restore ${serverName} in ${claudeConfigPath}: ${err}`);
  }

  return true;
}

/**
 * Rewrite a single server entry to route through the gateway
 * across all registered config files.
 * Used when opting-in a server back to gateway proxying.
 */
export function rewriteServerInConfigs(serverName: string): void {
  const claudeConfigPath = configPath;
  const url = gatewayUrl(serverName);

  try {
    const raw = fs.readFileSync(claudeConfigPath, 'utf-8');
    const config = JSON.parse(raw);
    if (config.mcpServers) {
      config.mcpServers[serverName] = { type: 'http', url };
      lastWriteTs = Date.now();
      fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
    }
  } catch (err) {
    logger.warn(`[config] Failed to rewrite ${serverName} in ${claudeConfigPath}: ${err}`);
  }
}

/** Simple string hash for project path → filename */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
