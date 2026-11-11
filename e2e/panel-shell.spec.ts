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
  await expect(panel.getByRole('status')).toContainText('Scanning · page');
  await shoot(panel, 'scanning');

  await panel.getByRole('button', { name: 'Stop' }).click();
  server.delaySearches(0);
});
