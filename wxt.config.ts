import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

/** End-to-end build only: the replay server's port, fixed because the base URL is baked in at build time. */
export const E2E_PORT = Number(process.env.SPLIT_FINDER_E2E_PORT ?? 47831);
const e2e = process.env.SPLIT_FINDER_E2E === '1';

export default defineConfig({
  srcDir: 'extension',
  alias: { '@core': resolve('core/src') },
  modules: ['@wxt-dev/module-react'],
  ...(e2e ? { outDir: '.output-e2e' } : {}),
  vite: () => ({
    // Undefined in the normal build, so the worker keeps its default https://serpapi.com.
    define: { __SPLIT_FINDER_BASE_URL__: e2e ? JSON.stringify(`http://localhost:${E2E_PORT}`) : 'undefined' },
  }),
  manifest: {
    name: 'Split Finder',
    permissions: ['storage', 'alarms', 'sidePanel', 'notifications'],
    host_permissions: ['https://serpapi.com/*', 'https://www.homedepot.com/*', ...(e2e ? ['http://localhost/*'] : [])],
  },
});
