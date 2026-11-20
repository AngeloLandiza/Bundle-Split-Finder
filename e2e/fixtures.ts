import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { E2E_PORT } from '../wxt.config';
import { startReplayServer, type ReplayServer } from './replay-server';

export const EXTENSION_DIR = resolve('.output-e2e/chrome-mv3');

export interface Seen {
  console: string[];
}

export const test = base.extend<
  { context: BrowserContext; extensionId: string; worker: Worker; seen: Seen; options: Page; server: ReplayServer },
  { replayServer: ReplayServer }
>({
  replayServer: [
    async ({}, use) => {
      const server = await startReplayServer(E2E_PORT);
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],
  server: async ({ replayServer }, use) => {
    replayServer.reset();
    await use(replayServer);
  },
  // A fresh profile per test, with the built extension loaded (Playwright's documented way).
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(worker.url().split('/')[2]!);
  },
  seen: async ({ context }, use) => {
    const seen: Seen = { console: [] };
    const watch = (p: Page) => {
      p.on('console', (m) => m.type() === 'error' && seen.console.push(`page: ${m.text()}`));
      p.on('pageerror', (e) => seen.console.push(`page: ${e.message}`));
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    context.on('serviceworker', (w) => w.on('console', (m) => m.type() === 'error' && seen.console.push(`worker: ${m.text()}`)));
    await use(seen);
  },
  options: async ({ context, extensionId, server: _server, seen: _seen }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await use(page);
  },
});

export { expect };

type AppState = {
  hasKey: boolean;
  scanRunning: boolean;
  lastJob: { id?: string; status?: string } | null;
  problem: string | null;
  /** Step 12: Ask AI about all, while it runs; how the last one ended; and whether a scan is followed by it. */
  askAll?: { done: number; total: number; costUsd: number; estimateUsd: number | null; stopping?: boolean } | null;
  askAllResult?: { total: number; asked: number; suggested: number; verified: number; costUsd: number; stopped: boolean; problem: string | null; overspent: boolean } | null;
  askAfterScan?: boolean;
};

export const getState = (page: Page): Promise<{ ok: boolean; data: AppState }> =>
  page.evaluate(() => chrome.runtime.sendMessage({ type: 'getState' }));

/** Saves the key through the page's own UI. */
export async function saveKey(page: Page, key: string): Promise<void> {
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Check key' }).click();
}
