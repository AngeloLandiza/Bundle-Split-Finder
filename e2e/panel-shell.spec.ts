import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

const DIR = 'test-results/panel/';
const WIDTHS = [360, 480];

async function shoot(panel: Page, state: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(150);
    await panel.screenshot({ path: `${DIR}shell-${state}-${width}.png` });
    // Nothing may run past the panel's width.
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

test('side panel shell, idle', async ({ context, extensionId, options, seen }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeEnabled();
  await expect(panel.getByRole('button', { name: /^Deals/ })).toBeVisible();
  await expect(panel.getByRole('contentinfo')).toContainText('searches left');
  await expect(panel.getByText(/^Scanning/)).toHaveCount(0);
  await shoot(panel, 'idle');
  expect(seen.console).toEqual([]);
});

test('side panel shell, scanning', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  // Each search waits, so the scan is still running when the panel is photographed.
  server.delaySearches(20_000);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(options)).data.scanRunning, { intervals: [100] }).toBe(true);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(panel.locator('.progress-now')).toHaveText(/^(Scanning$|Fetching deals pages)/);
  await expect(panel.getByRole('progressbar', { name: 'Scan progress' })).toBeVisible();
  await shoot(panel, 'scanning');

  await panel.getByRole('button', { name: 'Stop' }).click();
  server.delaySearches(0);
});

type Settings = Record<string, unknown>;

async function configure(page: Page, patch: Settings): Promise<void> {
  const settings = { ...((await getState(page)).data as unknown as { settings: Settings }).settings, ...patch };
  const reply = await page.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings);
  expect(reply).toMatchObject({ ok: true });
}

async function scanAndWait(page: Page): Promise<void> {
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(page)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
}

test('side panel shell, review tab count and a scheduled footer', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { schedule: { mode: 'daily', at: '07:00' }, searchesPerScan: 5 });
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('contentinfo')).toContainText('Next scan');
  const review = panel.getByRole('button', { name: /^Review/ }).locator('.count');
  await expect(review).not.toHaveText('0');
  await expect(review).toHaveAttribute('data-tag', 'attention');
  await panel.getByRole('button', { name: /^Review/ }).click();
  await shoot(panel, 'review');
});

test('side panel shell, stopped at the per-scan limit', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 1 });
  server.refuse('*');
  await scanAndWait(options);
  expect((await getState(options)).data.lastJob?.status).toBe('stopped');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('contentinfo')).toContainText('Scanned');
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeEnabled();
  await shoot(panel, 'limit');
});

test('side panel shell, no key', async ({ context, extensionId, server: _server }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeDisabled();
  await shoot(panel, 'nokey');
});
