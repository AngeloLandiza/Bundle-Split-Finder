import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import { stable } from './vitest.shared';

// Default suite: no network, ever. Live tests have their own config.
export default defineConfig({
  // desktop-ui imports the agent's contract as @core (its vite.config.ts and tsconfig say the same).
  resolve: { alias: { '@core': resolve(import.meta.dirname, 'core/src') } },
  test: { ...stable, include: ['core/test/**/*.test.ts', 'agent/test/**/*.test.ts', 'desktop/*.test.ts', 'desktop-ui/src/**/*.test.ts'] },
});
