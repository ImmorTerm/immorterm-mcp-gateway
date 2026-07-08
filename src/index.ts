#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger, GatewayState, StdioServerConfig } from './types';
import { initClassification } from './classification';
import { initNpxResolver } from './npx-resolver';
import { initChildPool, killAll, startIdleReaper } from './child-pool';
import {
  initConfigRewriter,
  recoverFromCrash,
  recoverOrphanedServers,
  rewriteConfig,
  restoreConfig,
  restoreAllProjectConfigs,
  writeState,
  readState,
  deleteState,
  startWatching,
  stopWatching,
} from './config-rewriter';
import { createApp, addServer, removeServer, startServer, stopServer } from './server';
import { initOptOut, isOptedOut } from './opt-out';
import {
  initClients,
  detectInstalledTools,
  registerClient,
  restoreAllClients,
  startWatchingClient,
  stopAllWatchers,
  getRegisteredClients,
  recoverClient,
} from './clients';

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_PORT = 9100;
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.immorterm', 'mcp-gateway');
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

// ── Logger ─────────────────────────────────────────────────────────────

let logFile: fs.WriteStream | null = null;

function createLogger(stateDir: string, foreground: boolean): Logger {
  const logPath = path.join(stateDir, 'gateway.log');

  // Rotate log if > 5 MB
  if (fs.existsSync(logPath)) {
    const stats = fs.statSync(logPath);
    if (stats.size > 5 * 1024 * 1024) {
      const rotated = logPath + '.old';
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(logPath, rotated);
    }
  }

  logFile = fs.createWriteStream(logPath, { flags: 'a' });

  function formatMsg(level: string, msg: string): string {
    const ts = new Date().toISOString();
    return `${ts} [${level}] ${msg}`;
  }

  return {
    info: (msg: string) => {
      const formatted = formatMsg('INFO', msg);
      logFile?.write(formatted + '\n');
      if (foreground) console.log(formatted);
    },
    warn: (msg: string) => {
      const formatted = formatMsg('WARN', msg);
      logFile?.write(formatted + '\n');
      if (foreground) console.warn(formatted);
    },
    error: (msg: string) => {
      const formatted = formatMsg('ERROR', msg);
      logFile?.write(formatted + '\n');
      if (foreground) console.error(formatted);
    },
    debug: (msg: string) => {
      const formatted = formatMsg('DEBUG', msg);
      logFile?.write(formatted + '\n');
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function parseArgs(): { port: number; config: string; foreground: boolean } {
  let port = DEFAULT_PORT;
  let config = DEFAULT_CONFIG_PATH;
  let foreground = false;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
      case '-p':
        port = parseInt(args[++i], 10);
        break;
      case '--config':
      case '-c':
        config = args[++i];
        break;
      case '--foreground':
      case '-f':
        foreground = true;
        break;
    }
  }

  return { port, config, foreground };
}

// ── PID Lock ──────────────────────────────────────────────────────────

function lockPath(): string {
  return path.join(DEFAULT_STATE_DIR, 'gateway.lock');
}

/**
 * Acquire a singleton lock. Returns true if lock was acquired.
 * If another instance is alive, returns false.
 * Stale locks (dead PID) are automatically cleaned up.
 */
function acquireLock(): boolean {
  const lock = lockPath();
  if (fs.existsSync(lock)) {
    try {
      const existingPid = parseInt(fs.readFileSync(lock, 'utf-8').trim(), 10);
      if (existingPid && !isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0); // signal 0 = check if alive
          return false; // PID is alive — another instance is running
        } catch {
          // PID is dead — stale lock, safe to overwrite
        }
      }
    } catch {
      // Corrupt lock file — safe to overwrite
    }
  }
  fs.writeFileSync(lock, String(process.pid));
  return true;
}

/** Release the singleton lock (only if we own it). */
function releaseLock(): void {
  const lock = lockPath();
  try {
    if (fs.existsSync(lock)) {
      const pid = parseInt(fs.readFileSync(lock, 'utf-8').trim(), 10);
      if (pid === process.pid) {
        fs.unlinkSync(lock);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

async function cmdStart(): Promise<void> {
  const opts = parseArgs();
  const stateDir = DEFAULT_STATE_DIR;

  // Ensure state directory exists
  fs.mkdirSync(stateDir, { recursive: true });

  // Singleton enforcement — only one gateway instance allowed
  if (!acquireLock()) {
    const lock = lockPath();
    const existingPid = fs.readFileSync(lock, 'utf-8').trim();
    console.error(`Another gateway instance is already running (PID ${existingPid}).`);
    console.error(`If this is stale, remove ${lock} and retry.`);
    process.exit(1);
  }

  const logger = createLogger(stateDir, opts.foreground);
  logger.info('─────────────────────────────────────────────');
  logger.info(`immorterm-mcp-gateway starting (port=${opts.port}, pid=${process.pid})`);

  // Initialize all modules
  initClassification(stateDir, logger);
  initNpxResolver(stateDir, logger);
  initChildPool(logger);
  initConfigRewriter({ stateDir, configPath: opts.config, port: opts.port }, logger);
  initClients({ stateDir, port: opts.port }, logger);
  initOptOut(stateDir);

  // Check for stale state from a crashed previous instance
  recoverFromCrash();

  // Rewrite Claude config (primary, backward-compatible path)
  let rewritten = rewriteConfig();

  // Self-healing: if rewriteConfig found 0 stdio servers, check for the
  // "all-HTTP-pointing-at-self" corrupted state and try to recover from npx-cache
  if (rewritten.length === 0) {
    const recovered = recoverOrphanedServers();
    if (recovered.length > 0) {
      logger.info(`[startup] Self-healing: recovered ${recovered.length} orphaned servers, re-rewriting...`);
      // Re-run rewriteConfig now that original stdio entries are restored
      rewritten = rewriteConfig();
    }
  }

  // Register all rewritten servers with the child pool (skip opted-out ones)
  for (const { name, config } of rewritten) {
    if (isOptedOut(name)) {
      logger.info(`[startup] Skipping opted-out server: ${name}`);
      continue;
    }
    addServer(name, config);
  }

  // Auto-detect and register other installed AI tools
  const detected = detectInstalledTools();
  const allServerNames = new Set(rewritten.map(r => r.name));

  for (const { tool, configPath } of detected) {
    // Skip Claude — already handled by the primary rewriteConfig() above
    if (tool === 'claude') continue;

    // Check for crash recovery first
    recoverClient(tool, configPath);

    const clientServers = registerClient(tool, configPath);
    for (const { name, config } of clientServers) {
      if (!allServerNames.has(name)) {
        addServer(name, config);
        allServerNames.add(name);
      }
    }

    logger.info(`[startup] Auto-registered ${tool}: ${clientServers.length} servers`);
  }

  // Create and start the HTTP server
  const app = createApp(logger);
  await startServer(app, opts.port);

  // Write state file (PID, port, clients, etc.)
  writeState({
    pid: process.pid,
    port: opts.port,
    startedAt: Date.now(),
    servers: Array.from(allServerNames),
    clients: getRegisteredClients(),
  });

  // Start idle reaper — kills stateful children with no activity for 5 min
  startIdleReaper();

  // Hot-reload callbacks (shared by all clients)
  const onNewServer = (name: string, config: StdioServerConfig) => {
    addServer(name, config);
    logger.info(`[hot-reload] Wrapped new server: ${name}`);
  };
  const onRemovedServer = (name: string) => {
    removeServer(name);
    logger.info(`[hot-reload] Unwrapped removed server: ${name}`);
  };

  // Start watching Claude config for hot reload (primary)
  startWatching(onNewServer, onRemovedServer);

  // Start watching other AI tool configs for hot reload
  for (const { tool } of detected) {
    if (tool === 'claude') continue;
    startWatchingClient(tool, onNewServer, onRemovedServer);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info(`[shutdown] Received ${signal}, shutting down...`);

    stopWatching();
    stopAllWatchers();
    killAll();
    restoreConfig();
    restoreAllClients();
    restoreAllProjectConfigs();
    deleteState();
    releaseLock();
    await stopServer();

    logger.info('[shutdown] Goodbye.');
    logFile?.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // SIGPIPE: default action is instant termination with no handler.
  // This killed the gateway when VS Code reloaded (pipe FDs closed).
  // Even with file-backed stdio, SIGPIPE can still arrive from other
  // broken pipes (e.g., HTTP responses to dead clients). Handle it.
  process.on('SIGPIPE', () => {
    logger.warn('[signal] Received SIGPIPE — ignoring (broken pipe to dead client)');
  });

  // Crash resilience — log the error and attempt graceful shutdown
  // instead of silently dying
  process.on('uncaughtException', (err) => {
    logger.error(`[FATAL] Uncaught exception: ${err.message}\n${err.stack}`);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`[FATAL] Unhandled rejection: ${reason}`);
    // Don't shutdown for rejections — they may be non-fatal
  });

  // If running as detached, disconnect from parent
  if (!opts.foreground && process.send) {
    process.send({ type: 'started', port: opts.port, pid: process.pid });
    process.disconnect();
  }
}

function cmdStop(): void {
  const stateDir = DEFAULT_STATE_DIR;
  const statePath = path.join(stateDir, 'state.json');

  if (!fs.existsSync(statePath)) {
    console.log('Gateway is not running (no state file found).');
    process.exit(0);
  }

  let state: GatewayState;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    console.error('Failed to read state file.');
    process.exit(1);
    return;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
    console.log(`Sent SIGTERM to gateway (PID ${state.pid}).`);
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      console.log(`Gateway (PID ${state.pid}) is already dead. Cleaning up...`);
      // Manual cleanup since the process didn't get to do its own
      const opts = parseArgs();
      initConfigRewriter({ stateDir, configPath: opts.config, port: state.port });
      initClients({ stateDir, port: state.port });
      restoreConfig();
      restoreAllClients();
      restoreAllProjectConfigs();
      fs.unlinkSync(statePath);
      // Clean up stale lock file
      const lock = lockPath();
      if (fs.existsSync(lock)) {
        try { fs.unlinkSync(lock); } catch {}
      }
    } else {
      throw err;
    }
  }
}

function cmdStatus(): void {
  const stateDir = DEFAULT_STATE_DIR;
  const statePath = path.join(stateDir, 'state.json');

  if (!fs.existsSync(statePath)) {
    console.log('Gateway is not running.');
    process.exit(0);
  }

  let state: GatewayState;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    console.error('Failed to read state file.');
    process.exit(1);
    return;
  }

  let alive = false;
  try {
    process.kill(state.pid, 0);
    alive = true;
  } catch {}

  const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
  const uptimeStr = uptime > 3600
    ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    : uptime > 60
      ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
      : `${uptime}s`;

  console.log(`Gateway: ${alive ? 'RUNNING' : 'DEAD (stale state)'}`);
  console.log(`  PID:     ${state.pid}`);
  console.log(`  Port:    ${state.port}`);
  console.log(`  Uptime:  ${uptimeStr}`);
  console.log(`  Servers: ${state.servers.join(', ')}`);

  if (state.clients && state.clients.length > 0) {
    console.log(`  Clients: ${state.clients.map(c => `${c.tool} (${c.serverCount} servers)`).join(', ')}`);
  }

  if (!alive) {
    console.log('\nRun "immorterm-mcp-gateway stop" to clean up stale state.');
  }
}

async function cmdDoctor(): Promise<void> {
  const stateDir = DEFAULT_STATE_DIR;
  const opts = parseArgs();
  let issues = 0;
  let ok = 0;

  console.log('immorterm-mcp-gateway doctor\n');

  // 0. Lock file
  const lock = lockPath();
  if (fs.existsSync(lock)) {
    try {
      const lockPid = parseInt(fs.readFileSync(lock, 'utf-8').trim(), 10);
      let lockAlive = false;
      try { process.kill(lockPid, 0); lockAlive = true; } catch {}
      if (lockAlive) {
        console.log(`  ✓ Lock file valid (PID ${lockPid} alive)`);
        ok++;
      } else {
        console.log(`  ✗ Stale lock file — PID ${lockPid} is dead. Run "stop" to clean up.`);
        issues++;
      }
    } catch {
      console.log('  ✗ Lock file exists but is corrupt');
      issues++;
    }
  } else {
    console.log('  ○ No lock file (gateway not running)');
  }

  // 1. State file
  const statePath = path.join(stateDir, 'state.json');
  if (fs.existsSync(statePath)) {
    let state: GatewayState;
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch {
      console.log('  ✗ State file exists but is corrupt');
      issues++;
      state = undefined as any;
    }

    if (state) {
      let alive = false;
      try { process.kill(state.pid, 0); alive = true; } catch {}

      if (alive) {
        console.log(`  ✓ Gateway running (PID ${state.pid}, port ${state.port})`);
        ok++;
      } else {
        console.log(`  ✗ Stale state.json — PID ${state.pid} is dead. Run "stop" to clean up.`);
        issues++;
      }
    }
  } else {
    console.log('  ○ Gateway not running (no state file)');
  }

  // 2. Health endpoint
  try {
    const health = await fetchHealth(opts.port);
    console.log(`  ✓ Health endpoint OK — ${health.servers.length} servers, ${health.totalChildren} children, ${health.memoryMB} MB`);
    ok++;

    // List servers
    for (const s of health.servers) {
      const childInfo = s.activeChildren > 0 ? `${s.activeChildren} child${s.activeChildren > 1 ? 'ren' : ''}` : 'idle';
      console.log(`    ${s.mode === 'stateful' ? '◆' : '○'} ${s.name} (${s.mode}, ${childInfo}, ${s.totalRequests} reqs)`);
    }
  } catch {
    console.log(`  ✗ Health endpoint unreachable at localhost:${opts.port}`);
    issues++;
  }

  // 3. Config backup
  const backupPath = path.join(stateDir, 'config-backup.json');
  if (fs.existsSync(backupPath)) {
    try {
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      const serverCount = Object.keys(backup.servers ?? {}).length;
      console.log(`  ✓ Config backup valid (${serverCount} servers backed up)`);
      ok++;
    } catch {
      console.log('  ✗ Config backup exists but is corrupt');
      issues++;
    }
  } else {
    console.log('  ○ No config backup (gateway hasn\'t rewritten config yet)');
  }

  // 4. Claude config state
  const configPath = opts.config;
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const servers = config.mcpServers ?? {};
      let gatewayed = 0;
      let stdio = 0;
      let other = 0;

      for (const [, serverConfig] of Object.entries(servers) as [string, any][]) {
        if (serverConfig.type === 'http' && serverConfig.url?.includes(`localhost:${opts.port}`)) {
          gatewayed++;
        } else if (serverConfig.type === 'stdio') {
          stdio++;
        } else {
          other++;
        }
      }

      console.log(`  ✓ Claude config: ${gatewayed} via gateway, ${stdio} stdio, ${other} other`);
      ok++;

      if (stdio > 0) {
        console.log(`    ⚠ ${stdio} stdio server(s) not routed through gateway`);
      }
    } catch {
      console.log(`  ✗ Could not read ${configPath}`);
      issues++;
    }
  } else {
    console.log(`  ○ No Claude config at ${configPath}`);
  }

  // 5. npx cache
  const npxCachePath = path.join(stateDir, 'npx-cache.json');
  if (fs.existsSync(npxCachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(npxCachePath, 'utf-8'));
      const entries = Object.keys(cache).length;
      console.log(`  ✓ npx cache: ${entries} resolved path(s)`);
      ok++;
    } catch {
      console.log('  ✗ npx cache is corrupt');
      issues++;
    }
  } else {
    console.log('  ○ No npx cache yet (will populate on first requests)');
  }

  // 6. Classification overrides
  const classificationPath = path.join(stateDir, 'classification.json');
  if (fs.existsSync(classificationPath)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(classificationPath, 'utf-8'));
      const count = Object.keys(overrides).length;
      console.log(`  ✓ Classification overrides: ${count} server(s)`);
      for (const [name, entry] of Object.entries(overrides) as [string, any][]) {
        console.log(`    ${entry.mode === 'stateful' ? '◆' : '○'} ${name} → ${entry.mode}`);
      }
      ok++;
    } catch {
      console.log('  ✗ Classification file is corrupt');
      issues++;
    }
  } else {
    console.log('  ○ No classification overrides (using defaults)');
  }

  // 7. Log file
  const logPath = path.join(stateDir, 'gateway.log');
  if (fs.existsSync(logPath)) {
    const stats = fs.statSync(logPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    console.log(`  ✓ Log file: ${sizeMB} MB`);
    ok++;
  }

  // 8. Multi-AI clients
  const detected = detectInstalledTools();
  if (detected.length > 0) {
    console.log(`  ✓ Detected AI tools: ${detected.map(d => d.tool).join(', ')}`);
    for (const { tool, configPath: cp } of detected) {
      const hasBackup = fs.existsSync(path.join(stateDir, `config-backup-${tool}.json`));
      console.log(`    ${hasBackup ? '◆' : '○'} ${tool}: ${cp}${hasBackup ? ' (backed up)' : ''}`);
    }
    ok++;
  } else {
    console.log('  ○ No additional AI tools detected (only Claude)');
  }

  // Summary
  console.log(`\n${ok} passed, ${issues} issue(s)`);

  // Helpful tips
  console.log('\nTips:');
  console.log('  Override server modes: edit ~/.immorterm/mcp-gateway/classification.json');
  console.log('  Example: { "my-server": { "mode": "stateful" } }');
  if (issues > 0) {
    process.exit(1);
  }
}

/** Fetch health from the gateway HTTP endpoint */
function fetchHealth(port: number): Promise<any> {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/health`, { timeout: 3000 }, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function printUsage(): void {
  console.log(`
immorterm-mcp-gateway — Singleton MCP gateway

Usage:
  immorterm-mcp-gateway start [options]   Start the gateway
  immorterm-mcp-gateway stop              Stop the gateway
  immorterm-mcp-gateway status            Show gateway status
  immorterm-mcp-gateway doctor            Diagnose gateway health

Options:
  --port, -p <port>         Port to listen on (default: ${DEFAULT_PORT})
  --config, -c <path>       Path to claude.json (default: ~/.claude.json)
  --foreground, -f          Run in foreground (don't detach)
  `.trim());
}

// ── Main ───────────────────────────────────────────────────────────────

switch (command) {
  case 'start':
    cmdStart().catch((err) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
    break;
  case 'stop':
    cmdStop();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'doctor':
    cmdDoctor().catch((err) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
    break;
  default:
    printUsage();
    process.exit(command ? 1 : 0);
}
