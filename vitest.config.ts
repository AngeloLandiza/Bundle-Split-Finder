import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import { stable } from './vitest.shared';

// Default suite: no network, ever. Live tests have their own config.
export default defineConfig({
  // desktop-ui imports the agent's contract as @core (its vite.config.ts and tsconfig say the same).
  resolve: { alias: { '@core': resolve(import.meta.dirname, 'core/src') } },
  test: {
    ...stable,
    include: ['core/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'desktop/*.test.ts', 'desktop-ui/src/**/*.test.ts'],
    // The agent's writes skip the flush to disk in tests (agent/fsync.ts); agent/test/fsync.test.ts runs the real one.
    setupFiles: [resolve(import.meta.dirname, 'agent/test/setup.ts')],
  },
});
