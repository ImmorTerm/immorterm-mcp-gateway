import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { findNpx, childPath } from '../npx-resolver';

/**
 * Regression guard for a gateway-wide outage.
 *
 * Every npx-based MCP server (context7, tavily, playwright, puppeteer, magic,
 * stitch, morph-fast-tools, sequential-thinking) failed to spawn with
 * "Child <name> is not alive" — surfacing to clients as HTTP 502 — because the
 * resolver called bare `execFileSync('npx', …)` and the gateway's PATH had no
 * npx. A GUI-launched process does not inherit a login shell's PATH, and
 * version managers routinely shim `node` without shimming `npx`.
 *
 * The fix must not depend on PATH being populated.
 */
describe('npx resolution without a usable PATH', () => {
  let originalPath: string | undefined;

  beforeEach(() => { originalPath = process.env.PATH; });
  afterEach(() => { process.env.PATH = originalPath; });

  it('finds npx even when PATH is empty', () => {
    process.env.PATH = '';
    // findNpx caches, so this asserts the cached value is a real absolute path
    // rather than the literal string "npx" the old code fell back to.
    const found = findNpx();
    if (found !== null) {
      expect(path.isAbsolute(found)).toBe(true);
      expect(found).not.toBe('npx');
    }
  });

  it('childPath always includes the directory of the running node', () => {
    process.env.PATH = '';
    const nodeDir = path.dirname(process.execPath);
    expect(childPath().split(path.delimiter)).toContain(nodeDir);
  });

  it('childPath preserves existing PATH entries', () => {
    process.env.PATH = ['/some/dir', '/other/dir'].join(path.delimiter);
    const parts = childPath().split(path.delimiter);
    expect(parts).toContain('/some/dir');
    expect(parts).toContain('/other/dir');
  });
});
