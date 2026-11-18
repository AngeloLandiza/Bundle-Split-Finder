import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

/** End-to-end build only: the replay server's port, fixed because the base URL is baked in at build time. */
export const E2E_PORT = Number(process.env.SPLIT_FINDER_E2E_PORT ?? 47831);
const e2e = process.env.SPLIT_FINDER_E2E === '1';

export default defineConfig({
  srcDir: 'extension',
  alias: { '@core': resolve('core/src') },
  modules: ['@wxt-dev/module-react'],
  // Each switch builds into its own folder, so .output/chrome-mv3 (the one loaded in Chrome) is written only by ext:build and ext:dev.
  ...(e2e ? { outDir: '.output-e2e' } : process.env.SPLIT_FINDER_PROD_CHECK === '1' ? { outDir: '.output-prod-check' } : {}),
  vite: () => ({
    // Undefined in the normal build, so the worker keeps its default https://serpapi.com.
    define: {
      __SPLIT_FINDER_BASE_URL__: e2e ? JSON.stringify(`http://localhost:${E2E_PORT}`) : 'undefined',
      // Where the background tab reads bundle pages: Home Depot, or the replay server in the end-to-end build.
      __SPLIT_FINDER_HD_ORIGIN__: JSON.stringify(e2e ? `http://localhost:${E2E_PORT}` : 'https://www.homedepot.com'),
      // True only with SPLIT_FINDER_DEBUG=1: exposes the page reader on the worker's global for a manual check.
      __SPLIT_FINDER_DEBUG__: process.env.SPLIT_FINDER_DEBUG === '1' ? 'true' : 'false',
    },
  }),
  manifest: {
    name: 'Split Finder',
    permissions: ['storage', 'alarms', 'sidePanel', 'notifications', 'scripting'],
    host_permissions: ['https://serpapi.com/*', 'https://www.homedepot.com/*', ...(e2e ? ['http://localhost/*'] : [])],
    // The chip's fonts are declared in the Home Depot page's own document (a shadow root cannot load @font-face),
    // so only Home Depot pages may fetch them. The content script's stylesheet is added by WXT.
    web_accessible_resources: [{ resources: ['fonts/*.woff2'], matches: ['https://www.homedepot.com/*', ...(e2e ? ['http://localhost/*'] : [])] }],
  },
});
