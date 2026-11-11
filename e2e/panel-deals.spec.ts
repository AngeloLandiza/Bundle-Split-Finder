import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

const DIR = 'test-results/panel/';
const WIDTHS = [360, 480];

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(150);
    await panel.screenshot({ path: `${DIR}deals-${name}-${width}.png` });
    // Nothing may run past the panel's width.
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

async function configure(page: Page, patch: Record<string, unknown>): Promise<void> {
  const settings = { ...((await getState(page)).data as unknown as { settings: Record<string, unknown> }).settings, ...patch };
  const reply = await page.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings);
  expect(reply).toMatchObject({ ok: true });
}

async function scanAndWait(page: Page): Promise<void> {
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(page)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
}

test('deals tab, the ranked list', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 10 });
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByText(/ bundles? · scanned /)).toBeVisible();
  await expect(panel.locator('.deal-row').first()).toBeVisible();
  await expect(panel.getByText('Estimated profit')).toHaveCount(1);
  await shoot(panel, 'list');
});

test('deals tab, stopped at the per-scan limit', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 1 });
  server.refuse('*');
  await scanAndWait(options);
  expect((await getState(options)).data.lastJob?.status).toBe('stopped');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByText('Scan stopped at your search limit')).toBeVisible();
  await expect(panel.getByText(/^It used the 1 search allowed per scan\./)).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Change the limit' })).toHaveAttribute('target', '_blank');
  // Until the worker answers quotes, a Look up shows its refusal; that is fine for now.
  await shoot(panel, 'limit');
});

test('deals tab, no scan yet', async ({ context, extensionId, options, server: _server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByText("No scan yet. Scan now looks at Home Depot's DEWALT and RYOBI bundles.")).toBeVisible();
  await shoot(panel, 'empty');
});

test('deals tab, bundles waiting for a lookup', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  // Exactly the two listing pages (a fifth of 2 is no brand page): bundles resolve and every part lookup waits.
  // With more, the scan would look up parts that have no recording and stop on the replay's 404.
  await configure(options, { searchesPerScan: 2 });
  await scanAndWait(options);
  expect(server.misses).toEqual([]);
  expect((await getState(options)).data.lastJob?.status).toBe('stopped');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('button', { name: /^Look up/ }).first()).toBeVisible();
  await expect(panel.getByText('Scan stopped at your search limit')).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Problem' })).toHaveCount(0);
  // The worker quotes each Look up: the label shows the quoted count.
  await expect(panel.getByRole('button', { name: /^Look up \d+ search(es)?$/ }).first()).toBeEnabled();
  await expect(panel.locator('.deal-refusal')).toHaveCount(0);
  await shoot(panel, 'waiting');
});

test('deals tab, keyboard focus on the first row', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 10 });
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const first = panel.locator('.deal-link').first();
  await expect(first).toBeVisible();
  // Tab from the page start to the first row link.
  for (let i = 0; i < 20 && !(await first.evaluate((el) => el === document.activeElement)); i++) await panel.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await shoot(panel, 'focus');
});
