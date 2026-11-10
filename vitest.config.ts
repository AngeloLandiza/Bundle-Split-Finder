import { defineConfig } from 'vitest/config';

// Default suite: no network, ever. Live tests have their own config.
export default defineConfig({
  test: { include: ['core/test/**/*.test.ts'] },
});
