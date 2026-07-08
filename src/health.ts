import { readFileSync } from 'fs';
import { join } from 'path';
import { HealthInfo, Logger } from './types';
import { getPoolStats } from './child-pool';
import { getRegisteredClients } from './clients';

let startedAt = 0;
let port = 0;

// Read version once at import time
const pkgVersion: string = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')).version;
  } catch {
    return 'unknown';
  }
})();

export function initHealth(serverPort: number): void {
  startedAt = Date.now();
  port = serverPort;
}

/**
 * Build health response.
 *
 * Status values:
 * - "ok": Gateway is running and has servers registered
 * - "degraded": Gateway is running but has ZERO servers — MCPs are dead.
 *   This typically means the config backup was lost and the gateway couldn't
 *   recover original stdio configs on restart. Clients should treat this as
 *   unhealthy and trigger recovery (stop + start).
 * - "starting": Gateway just started (< 15s uptime), may still be registering servers
 */
export function getHealthInfo(): HealthInfo {
  const stats = getPoolStats();
  const mem = process.memoryUsage();
  const clients = getRegisteredClients();
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  // Determine health status:
  // - If no servers are registered and we've been running long enough for
  //   startup to complete, the gateway is degraded (alive but useless).
  // - Grace period of 15 seconds covers npx resolution + config rewriting.
  const hasServers = stats.servers.length > 0;
  const pastStartupGrace = uptimeSeconds > 15;
  let status: 'ok' | 'degraded' | 'starting';
  if (hasServers) {
    status = 'ok';
  } else if (pastStartupGrace) {
    status = 'degraded';
  } else {
    status = 'starting';
  }

  return {
    status,
    version: pkgVersion,
    uptime: uptimeSeconds,
    port,
    servers: stats.servers,
    totalChildren: stats.totalChildren,
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    clients: clients.length > 0 ? clients : undefined,
  };
}
