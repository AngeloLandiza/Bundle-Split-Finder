import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

const DIR = 'test-results/panel/';
const WIDTHS = [360, 480];

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(150);
    await panel.screenshot({ path: `${DIR}detail-${name}-${width}.png` });
    // Nothing may run past the panel's width.
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await panel.evaluate(() => document.querySelector('.detail-body')!.scrollWidth <= document.querySelector('.detail-body')!.clientWidth)).toBe(true);
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

test('detail, priced parts, the packaging question and the answer', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 10 });
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('.deal-link').first().click();
  await expect(panel.getByRole('heading', { level: 2, name: /^PARTS · / })).toBeVisible();
  await expect(panel.getByText('Do these arrive individually boxed?')).toBeVisible();
  await expect(panel.getByText(/^Estimate from your fee settings/)).toBeVisible();
  await expect(panel.getByRole('link', { name: / on Amazon$/ }).first()).toHaveAttribute('href', /^https:\/\/www\.amazon\.com\/dp\/B0/);
  await shoot(panel, 'priced');

  await panel.getByRole('button', { name: 'No, loose' }).click();
  await expect(panel.locator('.detail-tag')).toHaveText('Loose');
  await expect(panel.getByText(/Loose parts cannot/)).toHaveCount(0);
  await shoot(panel, 'loose');

  // The same bundle once it is answered as boxed.
  await panel.getByRole('button', { name: 'Change' }).last().click();
  await panel.getByRole('button', { name: 'Yes, boxed' }).click();
  await expect(panel.locator('.detail-packaging-answer')).toHaveText('Boxed');
  await expect(panel.locator('.detail-tag')).toHaveCount(0);
  await shoot(panel, 'boxed');

  // Escape goes back to the list.
  await panel.keyboard.press('Escape');
  await expect(panel.locator('.deal-row').first()).toBeVisible();
});

test('detail, a bundle whose parts wait for a lookup', async ({ context, extensionId, options, server: _server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 4 });
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('.deal-row', { has: panel.getByRole('button', { name: /^Look up/ }) }).first().locator('.deal-link').click();
  await expect(panel.getByText(/^No estimate yet: \d+ parts? still needs? an Amazon lookup\.$/)).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Look up/ })).toBeVisible();
  await expect(panel.getByRole('link', { name: /^Search Amazon for / }).first()).toHaveAttribute('href', /^https:\/\/www\.amazon\.com\/s\?k=/);
  await shoot(panel, 'waiting');
});

test('detail, while a scan runs', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 4 });
  await scanAndWait(options);
  // The next scan's searches wait, so it is still running when the panel is photographed.
  server.delaySearches(20_000);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(options)).data.scanRunning, { intervals: [100] }).toBe(true);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('.deal-row', { has: panel.getByRole('button', { name: /^Look up/ }) }).first().locator('.deal-link').click();
  await expect(panel.getByRole('heading', { level: 2, name: /^PARTS · / })).toBeVisible();
  await expect(panel.locator('.progress-now')).toHaveText(/^(Scanning$|Fetching Home Depot deals pages|Reading bundle pages|Reading Home Depot part prices|Looking up parts on Amazon)/);
  await shoot(panel, 'scanning');

  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'stopScan' }));
  server.delaySearches(0);
});
