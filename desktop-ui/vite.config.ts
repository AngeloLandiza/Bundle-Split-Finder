import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  resolve: {
    alias: { '@core': resolve(import.meta.dirname, '../core/src') },
  },
  build: {
    outDir: resolve(import.meta.dirname, '../desktop/dist/ui'),
    emptyOutDir: true,
  },
  base: '/ui/',
});