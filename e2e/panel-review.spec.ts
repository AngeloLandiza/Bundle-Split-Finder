import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

const DIR = 'test-results/panel/';
const WIDTHS = [360, 480];

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(150);
    await panel.screenshot({ path: `${DIR}review-${name}-${width}.png` });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

async function scanAndWait(page: Page): Promise<void> {
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(page)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
}

test('review tab, empty before any scan', async ({ context, extensionId, options }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  await expect(panel.getByText('Nothing needs your answer.')).toBeVisible();
  await shoot(panel, 'empty');
});

test('review tab, a split question after a replayed scan, answered', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  const current = (await getState(options)).data as unknown as { settings: Record<string, unknown> };
  const settings = { ...current.settings, searchesPerScan: 5 };
  expect(await options.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings)).toMatchObject({ ok: true });
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  await expect(panel.getByText(/^1 of \d+$/)).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Which parts come in this bundle?' })).toBeVisible();
  await shoot(panel, 'split');

  const count = Number((await panel.getByText(/^1 of \d+$/).textContent())!.replace('1 of ', ''));
  await panel.getByRole('radio', { name: 'None of these' }).check();
  await panel.getByRole('button', { name: 'Save answer' }).click();
  await expect(panel.getByText(`2 of ${count}`)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toBeDisabled();

  // This replay leaves no match question, so there is no review-match screenshot.
  expect(await panel.getByRole('group', { name: /Which Amazon listing/ }).count()).toBe(0);
});
