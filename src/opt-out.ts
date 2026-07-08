/**
 * Server opt-out persistence.
 *
 * Manages the list of servers that are excluded from gateway proxying.
 * Persisted to ~/.immorterm/mcp-gateway/opt-out.json.
 */

import * as fs from 'fs';
import * as path from 'path';

let stateDir = '';
const optedOut = new Set<string>();

function optOutPath(): string {
  return path.join(stateDir, 'opt-out.json');
}

function persist(): void {
  try {
    fs.writeFileSync(optOutPath(), JSON.stringify(Array.from(optedOut)), 'utf-8');
  } catch {
    // Best-effort persistence
  }
}

/** Initialize opt-out from disk */
export function initOptOut(dir: string): void {
  stateDir = dir;
  try {
    const data = fs.readFileSync(optOutPath(), 'utf-8');
    const names = JSON.parse(data);
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === 'string') optedOut.add(name);
      }
    }
  } catch {
    // No file or invalid — start empty
  }
}

/** Check if a server is opted out */
export function isOptedOut(name: string): boolean {
  return optedOut.has(name);
}

/** Opt out a server */
export function optOut(name: string): void {
  optedOut.add(name);
  persist();
}

/** Opt in a server (remove from opt-out list) */
export function optIn(name: string): void {
  optedOut.delete(name);
  persist();
}

/** Get list of opted-out server names */
export function getOptedOut(): string[] {
  return Array.from(optedOut);
}
