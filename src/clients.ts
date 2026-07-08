/**
 * Multi-AI client registration and config management.
 *
 * Each AI tool (Claude, Cursor, Windsurf, etc.) uses the same mcpServers
 * JSON format but stores it at a different path. This module manages
 * registration, backup/rewrite/restore for all of them through the
 * shared gateway.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AiToolId,
  AiClientEntry,
  StdioServerConfig,
  ServerConfig,
  ConfigBackup,
  Logger,
} from './types';

let stateDir = '';
let port = 9100;
let logger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

/** Registered AI clients: tool → AiClientEntry */
const registeredClients = new Map<string, AiClientEntry>();

/** Per-client fs.watch handles */
const clientWatchers = new Map<string, fs.FSWatcher>();

/** Per-client self-write timestamps (to ignore self-triggered watch events) */
const clientLastWriteTs = new Map<string, number>();

const SELF_WRITE_WINDOW_MS = 500;
const CHANGE_DEBOUNCE_MS = 500;
const clientChangeTimers = new Map<string, NodeJS.Timeout>();

// ── Known config paths ────────────────────────────────────────────────

/**
 * Default config file paths for known AI tools.
 * Returns null if the path cannot be determined or the file doesn't exist.
 */
export function getDefaultConfigPath(tool: AiToolId): string | null {
  const home = os.homedir();

  switch (tool) {
    case 'claude':
      return path.join(home, '.claude.json');

    case 'cursor':
      // Global: ~/.cursor/mcp.json
      return path.join(home, '.cursor', 'mcp.json');

    case 'windsurf':
      // Global: ~/.codeium/windsurf/mcp_config.json
      return path.join(home, '.codeium', 'windsurf', 'mcp_config.json');

    case 'cline': {
      // Cline stores in VS Code global storage — platform-specific
      const vsCodeDir = process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
        : process.platform === 'win32'
          ? path.join(process.env.APPDATA ?? '', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
          : path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
      return path.join(vsCodeDir, 'settings', 'cline_mcp_settings.json');
    }

    case 'copilot':
      // Standalone Copilot CLI (GA Feb 2026) reads ~/.copilot/mcp-config.json
      // per docs.github.com/en/copilot/.../add-mcp-servers. Project-scoped
      // configs at .mcp.json or .github/mcp.json are also supported but
      // we use the user-global path here for simplicity.
      return path.join(home, '.copilot', 'mcp-config.json');

    case 'codex':
      // Codex CLI uses TOML (~/.codex/config.toml) for the [mcp_servers]
      // table. Per per-vendor format-adapter rule \u2014 the gateway's TOML
      // rewriter wraps the JSON->TOML transformation; we still return the
      // canonical path so registration + watch logic can find it.
      return path.join(home, '.codex', 'config.toml');

    case 'gemini':
      // Gemini CLI uses JSON-standard format at ~/.gemini/settings.json
      // with an `mcpServers` key (same shape as Claude/Cursor).
      return path.join(home, '.gemini', 'settings.json');

    case 'opencode':
      // opencode uses its own schema with array `command` field and the
      // `mcp` key (NOT `mcpServers`). Per-project config takes priority,
      // but we also write to the user-global location for convenience.
      return path.join(home, '.config', 'opencode', 'opencode.json');

    case 'aider':
      // Aider has no MCP support today. Return null so registration is
      // a no-op; the wizard surface still lists Aider for hook capture.
      return null;

    case 'custom':
      return null;
  }
}

/**
 * Auto-detect which AI tools are installed by checking for config files.
 */
export function detectInstalledTools(): { tool: AiToolId; configPath: string }[] {
  const detected: { tool: AiToolId; configPath: string }[] = [];
  // Walk every known vendor with a global MCP config path. Aider is
  // intentionally omitted — it has no MCP support. Copilot/Codex/Gemini/
  // opencode are detected when their MCP config files are present.
  const tools: AiToolId[] = [
    'claude', 'cursor', 'windsurf', 'cline',
    'copilot', 'codex', 'gemini', 'opencode',
  ];

  for (const tool of tools) {
    const configPath = getDefaultConfigPath(tool);
    if (configPath && fs.existsSync(configPath)) {
      detected.push({ tool, configPath });
    }
  }

  return detected;
}

// ── Initialization ────────────────────────────────────────────────────

export function initClients(
  opts: { stateDir: string; port: number },
  log?: Logger,
): void {
  stateDir = opts.stateDir;
  port = opts.port;
  if (log) logger = log;
}

// ── Config read/write (per-client) ────────────────────────────────────

function gatewayUrl(serverName: string): string {
  return `http://localhost:${port}/${serverName}/mcp`;
}

function readConfig(configPath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(configPath: string, config: Record<string, unknown>): void {
  clientLastWriteTs.set(configPath, Date.now());
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function clientBackupPath(tool: string): string {
  return path.join(stateDir, `config-backup-${tool}.json`);
}

function readClientBackup(tool: string): ConfigBackup | null {
  const p = clientBackupPath(tool);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeClientBackup(tool: string, backup: ConfigBackup): void {
  fs.writeFileSync(clientBackupPath(tool), JSON.stringify(backup, null, 2));
}

// ── Registration ──────────────────────────────────────────────────────

/**
 * Register an AI client with the gateway.
 * Rewrites its config to route MCP traffic through the gateway.
 *
 * Returns the list of servers that were rewritten.
 */
export function registerClient(
  tool: AiToolId,
  configPath?: string,
): { name: string; config: StdioServerConfig }[] {
  const resolvedPath = configPath ?? getDefaultConfigPath(tool);
  if (!resolvedPath) {
    logger.warn(`[clients] Cannot register ${tool}: no config path provided and no default known`);
    return [];
  }

  if (!fs.existsSync(resolvedPath)) {
    logger.info(`[clients] Config file not found for ${tool}: ${resolvedPath}`);
    return [];
  }

  const rewritten = rewriteClientConfig(tool, resolvedPath);

  registeredClients.set(tool, {
    tool,
    configPath: resolvedPath,
    registeredAt: Date.now(),
    serverCount: rewritten.length,
  });

  logger.info(`[clients] Registered ${tool} (${resolvedPath}): ${rewritten.length} servers rewritten`);
  return rewritten;
}

/**
 * Rewrite a client's config file: backup originals, replace stdio with HTTP gateway URLs.
 */
function rewriteClientConfig(
  tool: string,
  configPath: string,
): { name: string; config: StdioServerConfig }[] {
  const config = readConfig(configPath);
  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;

  const rewritten: { name: string; config: StdioServerConfig }[] = [];
  const backupServers: Record<string, StdioServerConfig> = {};

  // Load existing backup to preserve servers from previous runs
  const existingBackup = readClientBackup(tool);
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

  // Save backup (append-only — never shrink)
  if (Object.keys(backupServers).length > 0) {
    writeClientBackup(tool, {
      backedAt: Date.now(),
      servers: backupServers,
    });
  }

  // Write rewritten config
  if (rewritten.length > 0) {
    config.mcpServers = servers;
    (config as Record<string, unknown>)._mcp_gateway_ts = Date.now();
    writeConfig(configPath, config);
  }

  return rewritten;
}

/**
 * Restore a client's original config from backup.
 */
export function restoreClient(tool: string): boolean {
  const client = registeredClients.get(tool);
  const backup = readClientBackup(tool);

  if (!backup || Object.keys(backup.servers).length === 0) {
    logger.debug(`[clients] No backup to restore for ${tool}`);
    return false;
  }

  const configPath = client?.configPath ?? getDefaultConfigPath(tool as AiToolId);
  if (!configPath || !fs.existsSync(configPath)) return false;

  const config = readConfig(configPath);
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
    writeConfig(configPath, config);
    logger.info(`[clients] Restored ${restored} servers for ${tool}`);
  }

  return restored > 0;
}

/**
 * Restore all registered clients' configs.
 */
export function restoreAllClients(): void {
  // Restore from registered clients
  for (const [tool] of registeredClients) {
    restoreClient(tool);
  }

  // Also try to restore from backup files on disk (for crash recovery)
  try {
    for (const file of fs.readdirSync(stateDir)) {
      const match = file.match(/^config-backup-(.+)\.json$/);
      if (match) {
        const tool = match[1];
        if (!registeredClients.has(tool)) {
          restoreClient(tool);
        }
      }
    }
  } catch {
    // stateDir may not exist
  }
}

/**
 * Unregister a client — stop watching and restore its config.
 */
export function unregisterClient(tool: string): boolean {
  stopWatchingClient(tool);
  const restored = restoreClient(tool);
  registeredClients.delete(tool);
  return restored;
}

// ── Hot Reload (per-client) ───────────────────────────────────────────

/**
 * Start watching a client's config file for external changes.
 */
export function startWatchingClient(
  tool: string,
  onNewServer: (name: string, config: StdioServerConfig) => void,
  onRemovedServer: (name: string) => void,
): void {
  const client = registeredClients.get(tool);
  if (!client) return;
  if (clientWatchers.has(tool)) return;

  try {
    const watcher = fs.watch(client.configPath, () => {
      const lastWrite = clientLastWriteTs.get(client.configPath) ?? 0;
      if (Date.now() - lastWrite < SELF_WRITE_WINDOW_MS) return;

      const existing = clientChangeTimers.get(tool);
      if (existing) clearTimeout(existing);
      clientChangeTimers.set(
        tool,
        setTimeout(
          () => handleClientConfigChange(tool, client.configPath, onNewServer, onRemovedServer),
          CHANGE_DEBOUNCE_MS,
        ),
      );
    });

    clientWatchers.set(tool, watcher);
    logger.info(`[clients] Watching ${tool} config: ${client.configPath}`);
  } catch (err) {
    logger.warn(`[clients] Failed to watch ${tool} config: ${err}`);
  }
}

/**
 * Stop watching a client's config file.
 */
function stopWatchingClient(tool: string): void {
  const watcher = clientWatchers.get(tool);
  if (watcher) {
    watcher.close();
    clientWatchers.delete(tool);
  }
  const timer = clientChangeTimers.get(tool);
  if (timer) {
    clearTimeout(timer);
    clientChangeTimers.delete(tool);
  }
}

/**
 * Stop watching all client config files.
 */
export function stopAllWatchers(): void {
  for (const tool of clientWatchers.keys()) {
    stopWatchingClient(tool);
  }
}

/**
 * Handle an external config change for a specific client.
 */
function handleClientConfigChange(
  tool: string,
  configPath: string,
  onNewServer: (name: string, config: StdioServerConfig) => void,
  onRemovedServer: (name: string) => void,
): void {
  const config = readConfig(configPath);
  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;
  const backup = readClientBackup(tool);

  let hasChanges = false;

  for (const [name, serverConfig] of Object.entries(servers)) {
    if (serverConfig.type === 'stdio') {
      logger.info(`[clients] ${tool}: detected new stdio server: ${name}`);

      // Add to backup
      if (backup) {
        backup.servers[name] = serverConfig as StdioServerConfig;
        writeClientBackup(tool, backup);
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

  // Check for removed servers
  if (backup) {
    for (const name of Object.keys(backup.servers)) {
      if (!(name in servers)) {
        logger.info(`[clients] ${tool}: detected removed server: ${name}`);
        delete backup.servers[name];
        writeClientBackup(tool, backup);
        onRemovedServer(name);
      }
    }
  }

  if (hasChanges) {
    config.mcpServers = servers;
    writeConfig(configPath, config);
  }
}

// ── Recovery ──────────────────────────────────────────────────────────

/**
 * Check a client's config for orphaned gateway URLs (crash recovery).
 */
export function recoverClient(tool: AiToolId, configPath?: string): boolean {
  const resolvedPath = configPath ?? getDefaultConfigPath(tool);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) return false;

  const backup = readClientBackup(tool);
  if (!backup || Object.keys(backup.servers).length === 0) return false;

  const config = readConfig(resolvedPath);
  const servers = (config.mcpServers ?? {}) as Record<string, ServerConfig>;

  const hasOrphanedGatewayUrls = Object.values(servers).some(
    (s) => 'url' in s && typeof s.url === 'string' && s.url.includes(`localhost:${port}`)
  );

  if (hasOrphanedGatewayUrls) {
    logger.warn(`[clients] ${tool}: found orphaned gateway URLs — restoring from backup`);
    restoreClient(tool);
    return true;
  }

  return false;
}

// ── Query ─────────────────────────────────────────────────────────────

/**
 * Get all registered clients.
 */
export function getRegisteredClients(): AiClientEntry[] {
  return Array.from(registeredClients.values());
}

/**
 * Get a specific registered client.
 */
export function getClient(tool: string): AiClientEntry | undefined {
  return registeredClients.get(tool);
}
