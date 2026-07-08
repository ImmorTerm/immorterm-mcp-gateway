import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child-pool before importing health module
vi.mock('../child-pool', () => ({
  getPoolStats: () => ({
    servers: [
      { name: 'context7', mode: 'stateless', activeChildren: 1, totalRequests: 42 },
      { name: 'tavily', mode: 'stateless', activeChildren: 1, totalRequests: 10 },
    ],
    totalChildren: 2,
  }),
}));

// Mock fs.readFileSync to return a fake package.json
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual as object,
    readFileSync: (filePath: string, encoding?: string) => {
      if (typeof filePath === 'string' && filePath.endsWith('package.json')) {
        return JSON.stringify({ version: '0.1.0' });
      }
      return (actual as { readFileSync: Function }).readFileSync(filePath, encoding);
    },
  };
});

describe('health endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes version from package.json in health response', async () => {
    // Re-import to pick up mocks
    vi.resetModules();
    vi.doMock('../child-pool', () => ({
      getPoolStats: () => ({
        servers: [],
        totalChildren: 0,
      }),
    }));

    const { getHealthInfo, initHealth } = await import('../health');
    initHealth(9100);

    const health = getHealthInfo();
    expect(health.version).toBe('0.1.0');
  });

  it('returns all expected fields', async () => {
    vi.resetModules();
    vi.doMock('../child-pool', () => ({
      getPoolStats: () => ({
        servers: [
          { name: 'context7', mode: 'stateless', activeChildren: 1, totalRequests: 42 },
        ],
        totalChildren: 1,
      }),
    }));

    const { getHealthInfo, initHealth } = await import('../health');
    initHealth(9100);

    const health = getHealthInfo();

    expect(health.status).toBe('ok');
    expect(health.version).toBeDefined();
    expect(health.port).toBe(9100);
    expect(health.uptime).toBeGreaterThanOrEqual(0);
    expect(health.servers).toHaveLength(1);
    expect(health.totalChildren).toBe(1);
    expect(health.memoryMB).toBeGreaterThan(0);
  });

  it('version is a non-empty string', async () => {
    vi.resetModules();
    vi.doMock('../child-pool', () => ({
      getPoolStats: () => ({ servers: [], totalChildren: 0 }),
    }));

    const { getHealthInfo, initHealth } = await import('../health');
    initHealth(9100);

    const health = getHealthInfo();
    expect(typeof health.version).toBe('string');
    expect(health.version.length).toBeGreaterThan(0);
    // Should be valid semver-ish (x.y.z or "unknown")
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$|^unknown$/);
  });
});
