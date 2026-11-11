import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

const DIR = 'test-results/panel/';
const WIDTHS = [360, 480];

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(150);
    await panel.screenshot({ path: `${DIR}${name}-${width}.png` });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

test('side panel, first run with no key', async ({ context, extensionId, seen, server }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('heading', { name: 'Find bundles worth splitting' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeDisabled();
  await expect(panel.getByRole('link', { name: 'Get a free key' })).toHaveAttribute('href', 'https://serpapi.com/users/sign_up');
  await shoot(panel, 'firstrun');
  expect(server.counts['/search.json'] ?? 0).toBe(0);
  expect(seen.console).toEqual([]);
});

test('side panel, a failed scan shows its sentence and Retry with its cost', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.failSearches();
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(options)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const notice = panel.getByRole('region', { name: 'Problem' });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('alert')).toHaveText('SerpApi answered with an error (HTTP 500). Try again later.');
  await expect(notice.getByRole('button', { name: 'Retry up to 5 searches' })).toBeEnabled();
  await shoot(panel, 'error');
});
