import * as fs from 'fs';
import * as path from 'path';
import { ServerMode, ClassificationEntry, Logger } from './types';

/**
 * Known stateful servers — these maintain per-session state and need
 * a dedicated child process per MCP session.
 *
 * Stateless servers share a single child across all sessions,
 * multiplexed via JSON-RPC request IDs.
 */
const KNOWN_STATEFUL: Set<string> = new Set([
  'sequential-thinking',
  'serena',
  'playwright',
  'chrome-devtools',
  'puppeteer',
]);

/** Default classification for unknown servers */
const DEFAULT_MODE: ServerMode = 'stateless';

/** User overrides loaded from classification.json */
let userOverrides: Record<string, ClassificationEntry> = {};

let logger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

/**
 * Initialize classification with optional user overrides.
 */
export function initClassification(stateDir: string, log?: Logger): void {
  if (log) logger = log;

  const overridePath = path.join(stateDir, 'classification.json');
  if (fs.existsSync(overridePath)) {
    try {
      userOverrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      logger.info(`[classification] Loaded ${Object.keys(userOverrides).length} user overrides`);
    } catch (err) {
      logger.warn(`[classification] Failed to parse ${overridePath}: ${err}`);
    }
  }
}

/**
 * Get the mode for a server by name.
 */
export function getServerMode(serverName: string): ServerMode {
  // User override takes priority
  if (userOverrides[serverName]) {
    return userOverrides[serverName].mode;
  }

  // Known stateful servers
  if (KNOWN_STATEFUL.has(serverName)) {
    return 'stateful';
  }

  return DEFAULT_MODE;
}

/**
 * Get full classification for a server.
 */
export function getClassification(serverName: string): ClassificationEntry {
  if (userOverrides[serverName]) {
    return { ...userOverrides[serverName], mode: getServerMode(serverName) };
  }

  return {
    mode: getServerMode(serverName),
    requestTimeout: 120_000,
  };
}

/**
 * Check if a server is stateful (needs per-session children).
 */
export function isStateful(serverName: string): boolean {
  return getServerMode(serverName) === 'stateful';
}
