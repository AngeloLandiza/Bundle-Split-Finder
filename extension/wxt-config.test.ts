import { afterEach, describe, expect, it, vi } from 'vitest';

// Reads wxt.config.ts for both modes; builds nothing.
async function configFor(e2e: boolean) {
  vi.resetModules();
  if (e2e) vi.stubEnv('SPLIT_FINDER_E2E', '1');
  else vi.stubEnv('SPLIT_FINDER_E2E', '');
  const mod = await import('../wxt.config');
  return mod.default as unknown as {
    manifest: { host_permissions: string[]; permissions: string[] };
    outDir?: string;
    vite: () => { define: Record<string, string> };
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('wxt.config', () => {
  it('the production manifest has exactly the two host permissions and no localhost', async () => {
    const c = await configFor(false);
    expect(c.manifest.host_permissions).toEqual(['https://serpapi.com/*', 'https://www.homedepot.com/*']);
    expect(c.manifest.permissions).toEqual(['storage', 'alarms', 'sidePanel', 'notifications']);
    expect(c.outDir).toBeUndefined();
    expect(c.vite().define.__SPLIT_FINDER_BASE_URL__).toBe('undefined');
    expect(JSON.stringify(c)).not.toContain('localhost');
  });

  it('the end-to-end build adds only http://localhost/* and a localhost base URL', async () => {
    const c = await configFor(true);
    expect(c.manifest.host_permissions).toEqual(['https://serpapi.com/*', 'https://www.homedepot.com/*', 'http://localhost/*']);
    expect(c.outDir).toBe('.output-e2e');
    expect(c.vite().define.__SPLIT_FINDER_BASE_URL__).toMatch(/^"http:\/\/localhost:\d+"$/);
  });
});
