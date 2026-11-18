import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

// Screenshots only when SPLIT_FINDER_SHOTS is set: 1 writes to qa-shots/, any other value is the folder. Never in a normal run.
const SHOTS = process.env.SPLIT_FINDER_SHOTS;
const DIR = SHOTS ? `${SHOTS === '1' ? 'qa-shots' : SHOTS}/` : null;
const WIDTHS = [360, 480];

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.waitForTimeout(150);
    if (DIR) await panel.screenshot({ path: `${DIR}accept-all-${name}-${width}.png` });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

type ReviewRow = { id: string; kind: string; choices: string[][] };
const reviewRows = async (page: Page): Promise<ReviewRow[]> =>
  (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getReport' }))).data.review;
const oneReading = (rows: ReviewRow[]): ReviewRow[] => rows.filter((r) => r.kind === 'split' && r.choices.length === 1);

async function scanAndWait(page: Page): Promise<void> {
  const was = (await getState(page)).data.lastJob?.id ?? null;
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect
    .poll(async () => {
      const { scanRunning, lastJob } = (await getState(page)).data;
      return !scanRunning && lastJob?.id !== undefined && lastJob.id !== was;
    }, { timeout: 60_000, intervals: [100] })
    .toBe(true);
}

test('review tab, Accept all answers the split questions that offer one reading, and the others stay', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  const current = (await getState(options)).data as unknown as { settings: Record<string, unknown> };
  const settings = { ...current.settings, searchesPerScan: 10 };
  expect(await options.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings)).toMatchObject({ ok: true });
  server.refuse('*');
  await scanAndWait(options);
  const before = await reviewRows(options);
  const suggested = oneReading(before);
  // The replay opens several bundles whose model number gives one reading: the block needs at least two.
  expect(suggested.length).toBeGreaterThanOrEqual(2);
  const others = before.filter((r) => !suggested.includes(r));

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  await expect(panel.getByRole('heading', { name: `${suggested.length} bundles have one suggested answer` })).toBeVisible();
  await expect(panel.getByText(`1 of ${before.length}`)).toBeVisible();
  await expect(panel.getByText('Each bundle gets the parts shown. Questions with more than one answer stay below.')).toBeVisible();
  await expect(panel.locator('.accept-row')).toHaveCount(suggested.length);
  await shoot(panel, 'block');

  await panel.getByRole('button', { name: `Accept all ${suggested.length}` }).click();
  const result = panel.getByText(`Accepted ${suggested.length} of ${suggested.length}.`);
  await expect(result).toBeVisible();
  await expect(result).toBeFocused();
  await expect(panel.getByRole('button', { name: /^Accept/ })).toHaveCount(0);
  await shoot(panel, 'done');

  // The accepted bundles have left Review; the questions with another number of readings are still open.
  const after = await reviewRows(options);
  for (const r of suggested) expect(after.map((x) => x.id)).not.toContain(r.id);
  expect(after.map((x) => x.id).sort()).toEqual(others.map((x) => x.id).sort());
  if (others.length > 0) await expect(panel.getByText(`1 of ${others.length}`)).toBeVisible();
});
