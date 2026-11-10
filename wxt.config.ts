import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'extension',
  alias: { '@core': resolve('core/src') },
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Split Finder',
    permissions: ['storage', 'alarms', 'sidePanel', 'notifications'],
    host_permissions: ['https://serpapi.com/*', 'https://www.homedepot.com/*'],
  },
});
