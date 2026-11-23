import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

/**
 * Nov 23: the helper's build, baked in at build time as the manifest's version_name ("0.1.0+3c92cc7"): the package
 * version and the commit it was built from (SPLIT_FINDER_BUILD_ID overrides; "dev" outside a git checkout). The helper
 * sends it in its heartbeats and the app reads the same field from the zip it ships, so an older helper is told apart.
 */
function buildId(): string {
  const set = process.env.SPLIT_FINDER_BUILD_ID?.trim();
  if (set && /^[0-9A-Za-z._-]{1,40}$/.test(set)) return set;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'dev';
  } catch {
    return 'dev';
  }
}
const PACKAGE_VERSION = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version;
export const HELPER_VERSION = `${PACKAGE_VERSION}+${buildId()}`;

/** End-to-end build only: the replay server's port, fixed because the base URL is baked in at build time. */
export const E2E_PORT = Number(process.env.SPLIT_FINDER_E2E_PORT ?? 47831);
const e2e = process.env.SPLIT_FINDER_E2E === '1';

export default defineConfig({
  srcDir: 'extension',
  alias: { '@core': resolve('core/src') },
  modules: ['@wxt-dev/module-react'],
  // Each switch builds into its own folder, so .output/chrome-mv3 (the one loaded in Chrome) is written only by ext:build and ext:dev.
  ...(e2e ? { outDir: '.output-e2e' } : process.env.SPLIT_FINDER_PROD_CHECK === '1' ? { outDir: '.output-prod-check' } : process.env.SPLIT_FINDER_PACKAGE === '1' ? { outDir: '.output-package' } : {}),
  vite: () => ({
    // Undefined in the normal build, so the worker keeps its default https://serpapi.com.
    define: {
      __SPLIT_FINDER_BASE_URL__: e2e ? JSON.stringify(`http://localhost:${E2E_PORT}`) : 'undefined',
      // Where the background tab reads bundle pages: Home Depot, or the replay server in the end-to-end build.
      __SPLIT_FINDER_HD_ORIGIN__: JSON.stringify(e2e ? `http://localhost:${E2E_PORT}` : 'https://www.homedepot.com'),
      // True only with SPLIT_FINDER_DEBUG=1: exposes the page reader on the worker's global for a manual check.
      __SPLIT_FINDER_DEBUG__: process.env.SPLIT_FINDER_DEBUG === '1' ? 'true' : 'false',
      __SPLIT_FINDER_HELPER__: process.env.SPLIT_FINDER_HELPER === '1' ? 'true' : 'false',
    },
  }),
  manifest: {
    version: PACKAGE_VERSION,
    version_name: HELPER_VERSION,
    name: process.env.SPLIT_FINDER_HELPER === '1' ? 'Split Finder Helper' : 'Split Finder',
    description:
      process.env.SPLIT_FINDER_HELPER === '1'
        ? 'Home Depot chip and page reads for Split Finder.'
        : 'Find discounted DEWALT and RYOBI bundles on Home Depot and estimate split profit.',
    permissions: ['storage', 'alarms', 'sidePanel', 'notifications', 'scripting'],
    // Step 10: eBay's API and the listing judge's model, each with the owner's own key. No other host ever gets either.
    host_permissions: [
      'https://serpapi.com/*',
      'https://www.homedepot.com/*',
      'https://api.ebay.com/*',
      'https://api.anthropic.com/*',
      'https://api.keepa.com/*',
      // Step 13: the paired Split Finder app, on this computer only. The owner's own agent (agent/server.ts) listens here and
      // nowhere else; every call to it carries the pairing token. See docs/decisions.md, "the extension is a paired worker".
      'http://127.0.0.1:8790/*',
      ...(e2e ? ['http://localhost/*', 'http://127.0.0.1/*'] : []),
    ],
    optional_host_permissions: e2e ? undefined : ['http://*/*', 'https://*/*'],
    // The chip's fonts are declared in the Home Depot page's own document (a shadow root cannot load @font-face),
    // so only Home Depot pages may fetch them. use_dynamic_url gives the files a per-session address, so a page cannot
    // probe for the extension by a fixed URL. The content script's stylesheet is added by WXT.
    web_accessible_resources: [{ resources: ['fonts/*.woff2'], use_dynamic_url: true, matches: ['https://www.homedepot.com/*', ...(e2e ? ['http://localhost/*'] : [])] }],
  },
});
