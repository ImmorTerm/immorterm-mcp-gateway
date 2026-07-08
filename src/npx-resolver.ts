import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { NpxCacheEntry, ResolvedCommand, StdioServerConfig, Logger } from './types';

let cache: Record<string, NpxCacheEntry> = {};
let cachePath: string = '';
let logger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

/** Max cache age before re-resolving (7 days) */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Initialize the resolver, loading any cached paths.
 */
export function initNpxResolver(stateDir: string, log?: Logger): void {
  if (log) logger = log;
  cachePath = path.join(stateDir, 'npx-cache.json');

  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const count = Object.keys(cache).length;
      if (count > 0) {
        logger.info(`[npx-resolver] Loaded ${count} cached paths`);
      }
    } catch {
      logger.warn('[npx-resolver] Failed to parse cache, starting fresh');
      cache = {};
    }
  }
}

/**
 * Build a cache key from command + args.
 */
function cacheKey(command: string, args: string[]): string {
  return `${command}:${args.join(' ')}`;
}

/**
 * Resolve an npx/uvx command to a direct executable path.
 *
 * For npx: runs `npx -y <package>` once to install, then finds the
 * actual binary in the npm cache.
 *
 * For uvx: resolves the tool path via uvx.
 *
 * For node/python/etc: returns as-is (already direct).
 */
export function resolveCommand(config: StdioServerConfig): ResolvedCommand {
  const key = cacheKey(config.command, config.args ?? []);

  // Check cache (if not expired)
  const cached = cache[key];
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    if (fs.existsSync(cached.resolvedPath)) {
      return {
        command: cached.resolvedPath,
        args: cached.resolvedArgs,
        env: config.env ?? {},
      };
    }
    // Cache entry stale (file gone), re-resolve
    logger.debug(`[npx-resolver] Cached path gone for ${key}, re-resolving`);
  }

  if (config.command === 'npx') {
    return resolveNpx(config, key);
  }

  if (config.command === 'uvx') {
    return resolveUvx(config, key);
  }

  // Direct command (node, python, etc.) — use as-is
  return {
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
  };
}

/**
 * Resolve npx command to direct node path.
 *
 * Strategy:
 * 1. Run `npx -y <package> --help` to ensure installed (or just resolve path)
 * 2. Use `npm exec --which <package>` or scan _npx cache for the binary
 */
function resolveNpx(config: StdioServerConfig, key: string): ResolvedCommand {
  const args = config.args ?? [];

  // Find the package name (skip -y and other flags)
  let packageArg = '';
  const extraArgs: string[] = [];
  let pastFlags = false;

  for (const arg of args) {
    if (!pastFlags && (arg === '-y' || arg === '--yes' || arg === '-q' || arg === '--quiet')) {
      continue;
    }
    if (!pastFlags && !packageArg) {
      packageArg = arg;
      pastFlags = true;
    } else {
      extraArgs.push(arg);
    }
  }

  if (!packageArg) {
    logger.warn(`[npx-resolver] No package found in args: ${args.join(' ')}`);
    return { command: config.command, args: config.args ?? [], env: config.env ?? {} };
  }

  // Strip version specifiers for resolution (e.g., "@latest")
  const cleanPackage = packageArg.replace(/@latest$/, '');

  try {
    // Use npx to resolve the path — runs `which` inside the npx environment
    const resolvedPath = execFileSync('npx', ['-y', packageArg, '--version'], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // That gave us the version, not the path. Try `which` approach.
    const whichResult = execFileSync('npx', ['which', cleanPackage], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (whichResult && fs.existsSync(whichResult)) {
      saveCache(key, config, whichResult, extraArgs);
      return { command: whichResult, args: extraArgs, env: config.env ?? {} };
    }
  } catch {
    // `npx which` may not exist on all npm versions
  }

  // Fallback: search npm _npx cache for the binary
  const npmCacheDir = getNpmCacheDir();
  if (npmCacheDir) {
    const binPath = findBinaryInNpxCache(npmCacheDir, cleanPackage);
    if (binPath) {
      saveCache(key, config, binPath, extraArgs);
      return { command: binPath, args: extraArgs, env: config.env ?? {} };
    }
  }

  // Last resort: ensure installed then use full npx (still saves on subsequent calls)
  try {
    execFileSync('npx', ['-y', packageArg, '--help'], {
      timeout: 60_000,
      env: { ...process.env, ...config.env },
      stdio: 'pipe',
    });
  } catch {
    // --help may exit with non-zero, that's fine — package is installed
  }

  // Try scanning again after install
  if (npmCacheDir) {
    const binPath = findBinaryInNpxCache(npmCacheDir, cleanPackage);
    if (binPath) {
      saveCache(key, config, binPath, extraArgs);
      return { command: binPath, args: extraArgs, env: config.env ?? {} };
    }
  }

  logger.warn(`[npx-resolver] Could not resolve direct path for ${packageArg}, using npx fallback`);
  return { command: config.command, args: config.args ?? [], env: config.env ?? {} };
}

/**
 * Resolve uvx command to direct path.
 */
function resolveUvx(config: StdioServerConfig, key: string): ResolvedCommand {
  // uvx commands are python tools — harder to resolve directly.
  // For now, use uvx as-is. The child pool will spawn uvx directly.
  // This still saves over npx since uvx caches are persistent.
  return {
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
  };
}

/**
 * Get the npm global cache directory.
 */
function getNpmCacheDir(): string | null {
  try {
    const cacheDir = execFileSync('npm', ['config', 'get', 'cache'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const npxDir = path.join(cacheDir, '_npx');
    return fs.existsSync(npxDir) ? npxDir : null;
  } catch {
    // Fallback to default location
    const defaultDir = path.join(process.env.HOME ?? '~', '.npm', '_npx');
    return fs.existsSync(defaultDir) ? defaultDir : null;
  }
}

/**
 * Search npm _npx cache for a binary matching the package name.
 *
 * Uses two strategies:
 * 1. Check the package's package.json "bin" field for the actual binary name
 * 2. Fall back to guessing from the package name (scoped: @scope/name → name)
 *
 * Strategy 1 handles cases like @modelcontextprotocol/server-sequential-thinking
 * where the package name is "server-sequential-thinking" but the bin is
 * "mcp-server-sequential-thinking".
 */
function findBinaryInNpxCache(npxDir: string, packageName: string): string | null {
  // Package name may be scoped: @upstash/context7-mcp → context7-mcp
  const guessedBinName = packageName.includes('/') ? packageName.split('/').pop()! : packageName;

  try {
    const hashDirs = fs.readdirSync(npxDir);
    for (const hashDir of hashDirs) {
      const nodeModulesDir = path.join(npxDir, hashDir, 'node_modules');
      const binDir = path.join(nodeModulesDir, '.bin');
      if (!fs.existsSync(binDir)) continue;

      // Strategy 1: Read the package's package.json to find the real bin name
      const pkgJsonPath = path.join(nodeModulesDir, packageName, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          const binEntry = pkgJson.bin;
          if (binEntry) {
            // bin can be a string (single binary) or object (multiple)
            const binNames = typeof binEntry === 'string'
              ? [pkgJson.name?.split('/').pop() ?? guessedBinName]
              : Object.keys(binEntry);
            for (const bn of binNames) {
              const binPath = path.join(binDir, bn);
              if (fs.existsSync(binPath)) {
                const realPath = fs.realpathSync(binPath);
                if (fs.existsSync(realPath)) {
                  return binPath;
                }
              }
            }
          }
        } catch {
          // Ignore JSON parse errors, fall through to guessed name
        }
      }

      // Strategy 2: Guess from the package name
      const binPath = path.join(binDir, guessedBinName);
      if (fs.existsSync(binPath)) {
        const realPath = fs.realpathSync(binPath);
        if (fs.existsSync(realPath)) {
          return binPath;
        }
      }
    }
  } catch (err) {
    logger.debug(`[npx-resolver] Error scanning _npx cache: ${err}`);
  }

  return null;
}

/**
 * Save a resolved path to the cache.
 */
function saveCache(
  key: string,
  config: StdioServerConfig,
  resolvedPath: string,
  resolvedArgs: string[]
): void {
  cache[key] = {
    originalCommand: config.command,
    originalArgs: config.args ?? [],
    resolvedPath,
    resolvedArgs,
    resolvedAt: Date.now(),
  };

  if (cachePath) {
    try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    } catch (err) {
      logger.warn(`[npx-resolver] Failed to write cache: ${err}`);
    }
  }
}

/**
 * Clear the entire cache.
 */
export function clearCache(): void {
  cache = {};
  if (cachePath && fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }
}
