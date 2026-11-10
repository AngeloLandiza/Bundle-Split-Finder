import { defineConfig } from 'vitest/config';

// Opt-in suite that spends real SerpApi searches. See docs/search-budget.md.
export default defineConfig({
  test: { include: ['core/test-live/**/*.live.test.ts'], testTimeout: 60_000, fileParallelism: false },
});
