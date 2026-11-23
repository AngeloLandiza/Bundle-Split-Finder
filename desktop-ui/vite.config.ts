import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The agent's address (agent/server.ts). `npm run ui:dev` serves the UI with hot reload and sends /api to it.
const AGENT = `http://127.0.0.1:${process.env.AGENT_PORT ?? '8790'}`;

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  resolve: {
    // The agent's contract and core's pure types: the UI imports them from the source, nothing is copied.
    alias: { '@core': resolve(import.meta.dirname, '../core/src') },
  },
  build: {
    outDir: resolve(import.meta.dirname, '../desktop/dist/ui'),
    emptyOutDir: true,
  },
  base: '/ui/',
  server: {
    // Development in a plain browser: http://localhost:5173/ui/?token=<the app token> (the token is the agent's
    // <data dir>/agent-token; the page keeps it for the tab and removes it from the address). The agent allows only
    // its own Host and Origin, so the proxy presents both as the agent's.
    proxy: {
      '/api': {
        target: AGENT,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin')) req.setHeader('origin', AGENT);
          });
        },
      },
    },
  },
});
