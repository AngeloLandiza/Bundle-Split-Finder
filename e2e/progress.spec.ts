import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

// Step 11, P2: the scan progress row (docs/design.md, "Scan progress") in the built extension, on a replayed scan. The
// Amazon lookups after the first are held at the replay server, so the scan waits at a mid point: the pages fetched and
// read, eBay and the listing check skipped (no keys), the first lookup answered and the next under way. Nothing leaves the machine.

// Screenshots only when SPLIT_FINDER_SHOTS is set: 1 writes to qa-shots/, any other value is the folder. Never in a normal run.
const SHOTS = process.env.SPLIT_FINDER_SHOTS;
const DIR = SHOTS ? `${SHOTS === '1' ? 'qa-shots' : SHOTS}/` : null;
const WIDTHS = [360, 480];

/** An Amazon part lookup: engine=amazon with a k and no rh (a brand's catalog page has rh=p_123:…). */
const isLookup = (search: string): boolean => search.includes('engine=amazon') && !search.includes('rh=');

const ESTIMATE = /^(about \d+ min|under a minute|at least \d+ min|estimating)$/;

async function fits(panel: Page): Promise<void> {
  // Nothing runs past the panel, and no figure or state word in the step list is cut or wrapped.
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const cut = await panel.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.progress-step-state, .progress-step-figure, .progress-count, .progress-estimate, .progress-toggle')]
      .filter((e) => e.offsetParent !== null)
      .filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getClientRects().length > 1 || e.getBoundingClientRect().height > 24)
      .map((e) => e.textContent),
  );
  expect(cut).toEqual([]);
}

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(450);
    await fits(panel);
    if (DIR) {
      mkdirSync(DIR, { recursive: true });
      await panel.screenshot({ path: `${DIR}${name}-${width}.png` });
    }
  }
}

test('the progress row: a step and an estimate, Details lists the steps and is remembered, gone when the scan ends', async ({ context, extensionId, options, server, seen }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  // The first lookup goes through, so the job is saved with the lookups started; the second waits.
  let lookups = 0;
  server.holdSearches((search) => isLookup(search) && ++lookups > 1);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 480, height: 820 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeEnabled();
  await expect(panel.getByRole('progressbar')).toHaveCount(0);

  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  const bar = panel.getByRole('progressbar', { name: 'Scan progress' });
  const row = panel.locator('.progress');
  await expect(bar).toBeVisible();
  // While it runs the row names a step, and the estimate is always one of its labelled forms.
  await expect(row.locator('.progress-now')).toHaveText(/^(Scanning|Fetching Home Depot deals pages|Reading bundle pages|Reading Home Depot part prices|Looking up parts on Amazon)/);
  await expect(row.locator('.progress-estimate')).toHaveText(ESTIMATE);

  // Held at the lookups: the mid point.
  await expect(row.locator('.progress-now')).toHaveText(/^Looking up parts on Amazon · \d+ of \d+$/, { timeout: 60_000 });
  await expect(row.locator('.progress-estimate')).toHaveText(ESTIMATE);
  await expect(bar).toHaveAttribute('aria-valuetext', /^Step 7 of 8, looking up parts on Amazon, /);
  const now = Number(await bar.getAttribute('aria-valuenow'));
  expect(now).toBeGreaterThan(0);
  expect(now).toBeLessThan(100);
  await expect(panel.getByRole('status').filter({ hasText: /^Step \d of 8, / })).toHaveCount(1);
  const details = panel.getByRole('button', { name: 'Details' });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByRole('list', { name: 'Scan steps' })).toBeHidden();
  // The collapsed row is no taller than the row it replaced (37px) by more than the bar's extra pixel.
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(38);
  await shoot(panel, 'progress-collapsed');

  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  const list = panel.getByRole('list', { name: 'Scan steps' });
  await expect(list).toBeVisible();
  const items = list.getByRole('listitem');
  await expect(items).toHaveCount(8);
  await expect(items.nth(0)).toHaveText(/^Home Depot deals pagesdone\d+ searches?$/);
  await expect(items.nth(4)).toHaveText('eBay listingsskippedno eBay keys');
  await expect(items.nth(6)).toHaveText(/^Amazon lookupsnow\d+ of \d+$/);
  await expect(items.nth(7)).toHaveText('Finishnext');
  await shoot(panel, 'progress-expanded');

  // Remembered: the panel opened again shows the list without a press.
  await panel.reload();
  await expect(panel.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByRole('list', { name: 'Scan steps' })).toBeVisible();

  server.releaseSearches();
  await expect.poll(async () => (await getState(options)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await expect(panel.locator('.progress')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeVisible();
  // The lookups name parts the replay has no recording of: it answers them 404, and the scan goes on.
  expect(seen.console.filter((c) => !c.includes('404'))).toEqual([]);
});
