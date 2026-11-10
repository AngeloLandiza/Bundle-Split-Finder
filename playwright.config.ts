import { defineConfig } from '@playwright/test';

// One worker: the replay server has a fixed port and the extension a single profile at a time.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  reporter: 'list',
});
