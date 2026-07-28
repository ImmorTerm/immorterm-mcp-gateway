/**
 * Vendor-agnostic MCP gateway test \u2014 pins the per-vendor MCP config
 * path. If a vendor moves its config file (the way it's happened to
 * gemini-cli already), this test surfaces the breakage immediately.
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import * as path from 'path';
import { getDefaultConfigPath, usesJsonConfig } from '../clients';

const HOME = homedir();

describe('getDefaultConfigPath \u2014 vendor MCP config paths', () => {
  it.each([
    ['claude',   path.join(HOME, '.claude.json')],
    ['cursor',   path.join(HOME, '.cursor', 'mcp.json')],
    ['windsurf', path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json')],
    ['copilot',  path.join(HOME, '.copilot', 'mcp-config.json')],
    ['codex',    path.join(HOME, '.codex', 'config.toml')],
    ['gemini',   path.join(HOME, '.gemini', 'settings.json')],
    ['opencode', path.join(HOME, '.config', 'opencode', 'opencode.json')],
  ])('returns the documented MCP config path for %s', (tool, expected) => {
    expect(getDefaultConfigPath(tool as Parameters<typeof getDefaultConfigPath>[0])).toBe(expected);
  });

  it('returns null for tools without a single global path', () => {
    // Aider has no MCP support; custom requires explicit registration.
    expect(getDefaultConfigPath('aider')).toBeNull();
    expect(getDefaultConfigPath('custom')).toBeNull();
  });

  it('cline returns a VS Code globalStorage path', () => {
    const result = getDefaultConfigPath('cline');
    expect(result).toContain('saoudrizwan.claude-dev');
    expect(result).toMatch(/cline_mcp_settings\.json$/);
  });
});

describe('usesJsonConfig \u2014 which client configs the gateway may rewrite', () => {
  it('excludes Codex, whose config is TOML', () => {
    // readConfig() swallows a parse failure and returns {}. Treating Codex's
    // TOML as JSON therefore yields an empty config, and any path that then
    // writes would replace the user's whole ~/.codex/config.toml \u2014 trust
    // levels, hook trust hashes and MCP servers \u2014 with `{}`.
    expect(usesJsonConfig('codex')).toBe(false);
  });

  it.each(['claude', 'cursor', 'windsurf', 'cline', 'copilot', 'gemini', 'opencode'])(
    'treats %s as a JSON-config client',
    (tool) => {
      expect(usesJsonConfig(tool as Parameters<typeof usesJsonConfig>[0])).toBe(true);
    }
  );
});
