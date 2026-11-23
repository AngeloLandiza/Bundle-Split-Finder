import { defineConfig } from 'vitest/config';

import { stable } from './vitest.shared';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Extension suite: no network. WxtVitest supplies the @core alias and fakeBrowser.
export default defineConfig({
  plugins: [WxtVitest()],
  test: { ...stable, include: ['extension/**/*.test.ts'] },
});
