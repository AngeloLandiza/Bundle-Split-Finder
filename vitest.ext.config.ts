import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Extension suite: no network. WxtVitest supplies the @core alias and fakeBrowser.
export default defineConfig({
  plugins: [WxtVitest()],
  test: { include: ['extension/**/*.test.ts'] },
});
