import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

// Screenshots only when SPLIT_FINDER_SHOTS is set: 1 writes to qa-shots/, any other value is the folder. Never in a normal run.
const SHOTS = process.env.SPLIT_FINDER_SHOTS;
const DIR = SHOTS ? `${SHOTS === '1' ? 'qa-shots' : SHOTS}/` : null;
const WIDTHS = [360, 480];

async function scanAndWait(page: Page): Promise<void> {
  const settings = { ...((await getState(page)).data as unknown as { settings: Record<string, unknown> }).settings, searchesPerScan: 10 };
  expect(await page.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings)).toMatchObject({ ok: true });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(page)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
}

test('Download CSV saves every bundle of the Deals list', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByText(/ bundles? · scanned /)).toBeVisible();
  const rows = await panel.locator('.deal-row').count();

  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.waitForTimeout(150);
    if (DIR) await panel.screenshot({ path: `${DIR}download-all-${width}.png` });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The summary row's controls stay inside the panel.
    const inside = await panel.evaluate(() => {
      const w = window.innerWidth;
      return ['.deals-download', '#deals-sort'].every((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return r.left >= 0 && r.right <= w;
      });
    });
    expect(inside).toBe(true);
  }

  const [download] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Download CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^split-finder-deals-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text.trimEnd().split('\n').length).toBe(1 + rows);
});
