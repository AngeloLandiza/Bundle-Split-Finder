import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Reads wxt.config.ts for both modes; builds nothing.
async function configFor(e2e: boolean) {
  vi.resetModules();
  if (e2e) vi.stubEnv('SPLIT_FINDER_E2E', '1');
  else vi.stubEnv('SPLIT_FINDER_E2E', '');
  const mod = await import('../wxt.config');
  return mod.default as unknown as {
    manifest: { host_permissions: string[]; permissions: string[]; web_accessible_resources: { resources: string[]; matches: string[]; use_dynamic_url?: boolean }[] };
    outDir?: string;
    vite: () => { define: Record<string, string> };
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('wxt.config', () => {
  it('the production manifest has exactly the two host permissions and no localhost', async () => {
    const c = await configFor(false);
    expect(c.manifest.host_permissions).toEqual(['https://serpapi.com/*', 'https://www.homedepot.com/*']);
    // The chip's fonts are fetchable by Home Depot pages only.
    expect(c.manifest.web_accessible_resources).toEqual([{ resources: ['fonts/*.woff2'], use_dynamic_url: true, matches: ['https://www.homedepot.com/*'] }]);
    expect(c.manifest.permissions).toEqual(['storage', 'alarms', 'sidePanel', 'notifications', 'scripting']);
    expect(c.outDir).toBeUndefined();
    expect(c.vite().define.__SPLIT_FINDER_BASE_URL__).toBe('undefined');
    expect(c.vite().define.__SPLIT_FINDER_HD_ORIGIN__).toBe('"https://www.homedepot.com"');
    expect(c.vite().define.__SPLIT_FINDER_DEBUG__).toBe('false');
    expect(JSON.stringify(c)).not.toContain('localhost');
  }, 30_000);

  it('the end-to-end build adds only http://localhost/* and a localhost base URL', async () => {
    const c = await configFor(true);
    expect(c.manifest.host_permissions).toEqual(['https://serpapi.com/*', 'https://www.homedepot.com/*', 'http://localhost/*']);
    expect(c.manifest.web_accessible_resources).toEqual([{ resources: ['fonts/*.woff2'], use_dynamic_url: true, matches: ['https://www.homedepot.com/*', 'http://localhost/*'] }]);
    expect(c.outDir).toBe('.output-e2e');
    expect(c.vite().define.__SPLIT_FINDER_BASE_URL__).toMatch(/^"http:\/\/localhost:\d+"$/);
    expect(c.vite().define.__SPLIT_FINDER_HD_ORIGIN__).toMatch(/^"http:\/\/localhost:\d+"$/);
    expect(c.manifest.permissions).toContain('scripting');
  }, 30_000);

  it('debug is on only with SPLIT_FINDER_DEBUG=1', async () => {
    vi.stubEnv('SPLIT_FINDER_DEBUG', '1');
    expect((await configFor(false)).vite().define.__SPLIT_FINDER_DEBUG__).toBe('true');
  }, 30_000);
});

describe('the production build', () => {
  it('has the scripting permission, Home Depot as the reader origin, no localhost and no debug handle', async () => {
    // The real command into its own folder, with the end-to-end and debug switches off. It must leave
    // .output/chrome-mv3, which the owner loads in Chrome, as it was.
    const loaded = join('.output', 'chrome-mv3', 'manifest.json');
    const before = existsSync(loaded) ? statSync(loaded).mtimeMs : null;
    execFileSync('npx', ['wxt', 'build'], {
      env: { ...process.env, SPLIT_FINDER_E2E: '', SPLIT_FINDER_DEBUG: '', SPLIT_FINDER_PROD_CHECK: '1' },
      stdio: 'ignore',
    });
    expect(existsSync(loaded) ? statSync(loaded).mtimeMs : null).toBe(before);
    {
      const dir = join('.output-prod-check', 'chrome-mv3');
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { permissions: string[]; host_permissions: string[] };
      expect(manifest.permissions).toEqual(['storage', 'alarms', 'sidePanel', 'notifications', 'scripting']);
      expect(manifest.host_permissions).toEqual(['https://serpapi.com/*', 'https://www.homedepot.com/*']);
      // Settings are a full tab; Chrome's embedded options dialog cut the key field off.
      expect((manifest as unknown as { options_ui: { open_in_tab: boolean } }).options_ui.open_in_tab).toBe(true);
      // Home Depot pages may fetch the fonts and the chip's stylesheet, and nothing else of the extension's.
      const war = (manifest as unknown as { web_accessible_resources: { resources: string[]; matches: string[]; use_dynamic_url?: boolean }[] }).web_accessible_resources;
      expect(war.flatMap((w) => w.resources).sort()).toEqual(['content-scripts/homedepot.css', 'fonts/*.woff2']);
      for (const w of war) {
        expect(w.matches).toEqual(['https://www.homedepot.com/*']);
        // A per-session address, so a page cannot probe for the extension by a fixed URL.
        expect(w.use_dynamic_url, w.resources.join()).toBe(true);
      }
      // The chip's shadow root is closed in the production script (the end-to-end build opens it for Playwright).
      const chipScript = readFileSync(join(dir, 'content-scripts', 'homedepot.js'), 'utf8');
      // mountChip.tsx's MODE constant folded to 'closed' (it sits just before HOST_NAME in the source), not to an 'open' ternary.
      expect(chipScript).toMatch(/[\w$]+=`closed`,[\w$]+=`split-finder-chip`/);
      const files = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
      const code = files(dir).filter((f) => f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.json'));
      expect(code.length).toBeGreaterThan(0);
      for (const f of code) {
        const text = readFileSync(f, 'utf8');
        expect(text, f).not.toContain('splitFinderReadPages');
        expect(text, f).not.toContain('splitFinderReadPartPrices');
        expect(text, f).not.toContain('http://localhost');
      }
      expect(readFileSync(join(dir, 'background.js'), 'utf8')).toContain('https://www.homedepot.com');
    }
  }, 180_000);
});
