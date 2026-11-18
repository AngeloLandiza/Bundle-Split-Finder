import type { Page } from '@playwright/test';
import { E2E_PORT } from '../wxt.config';
import { expect, saveKey, test } from './fixtures';

// Step 7, acceptance 4: on the founder's example page (item 328814689) the chip appears under the price with
// no search used. The replay server serves the recorded page at /p/328814689 with a price block, the element the
// chip anchors under. They run against the real worker (pageSeen, openThisPage and the chipSetting push).

const PAGE = `http://localhost:${E2E_PORT}/p/328814689`;

test('the chip sits directly under the price on the founder\'s page, and no search is used', async ({ context, server }) => {
  const page = await context.newPage();
  await page.goto(PAGE);
  const chip = page.locator('split-finder-chip').getByRole('button');
  // Nothing is stored yet, so both parts wait for a lookup: the chip says how many searches that would take.
  await expect(chip).toHaveText(/Splits into 2 parts · Look up prices · 2 searches/);
  const sibling = await page.evaluate(() => document.querySelector('[data-component^="price:Price"]')?.nextElementSibling?.localName);
  expect(sibling).toBe('split-finder-chip');
  // The control is 40px tall and the page moves by no more than that. (The end-to-end build opens the shadow root, which is closed in production, so Playwright can see inside it.)
  expect((await chip.boundingBox())!.height).toBe(40);
  expect(server.counts['/search.json'] ?? 0).toBe(0);
  expect(server.searches).toEqual([]);
});

test('clicking the chip asks the worker to open the panel', async ({ context, server: _server }) => {
  const page = await context.newPage();
  await page.goto(PAGE);
  const chip = page.locator('split-finder-chip').getByRole('button');
  await expect(chip).toBeVisible();
  await chip.click();
  // Either the worker opened the panel (the sentence stays empty) or it said it could not, and the chip says so in words.
  await expect(page.locator('split-finder-chip').getByRole('status')).toHaveText(/^(Open Split Finder from the toolbar to see this bundle\.)?$/);
});

test('turning "Show the chip on Home Depot pages" off removes the chip, on brings it back, and it stays off on the next page load', async ({ context, options, server }) => {
  // The worker answers pageSeen with { kind: 'off' } while the setting is off and sends open Home Depot tabs { type: 'chipSetting', show }.
  const page = await context.newPage();
  await page.goto(PAGE);
  const chip = page.locator('split-finder-chip');
  await expect(chip.getByRole('button')).toBeVisible();

  await options.getByLabel('Show the chip on Home Depot pages').uncheck();
  await expect(chip).toHaveCount(0);

  await page.reload();
  await page.waitForTimeout(1000);
  await expect(chip).toHaveCount(0);

  await options.getByLabel('Show the chip on Home Depot pages').check();
  await expect(chip.getByRole('button')).toBeVisible();
  expect(server.counts['/search.json'] ?? 0).toBe(0);
});

test('the chip is drawn in the design\'s fonts, loaded from the extension', async ({ context, server: _server }) => {
  const page = await context.newPage();
  await page.goto(PAGE);
  await expect(page.locator('split-finder-chip').getByRole('button')).toBeVisible();
  const loaded = await page.evaluate(async () => {
    await document.fonts.load("600 14px 'Split Finder JetBrains Mono'");
    await document.fonts.load("500 14px 'Split Finder Barlow'");
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', ''));
  });
  expect(loaded).toEqual(expect.arrayContaining(['Split Finder Barlow', 'Split Finder JetBrains Mono']));
});

// Screenshots only when SPLIT_FINDER_SHOTS is set: 1 writes to qa-shots/, any other value is the folder. Never in a normal run.
const SHOTS = process.env.SPLIT_FINDER_SHOTS;
const DIR = SHOTS ? `${SHOTS === '1' ? 'qa-shots' : SHOTS}/` : null;
const WIDTHS = [360, 480];

async function shoot(page: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(150);
    if (DIR) await page.screenshot({ path: `${DIR}${name}-${width}.png` });
    // Nothing may run past the page's width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

test('clicking the chip opens the panel on This page with the founder\'s parts, and no search is used', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  // The panel is a tab here, not Chrome's side panel: it follows the tab that is active, so the Home Depot tab is brought to the front.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const page = await context.newPage();
  await page.goto(PAGE);
  await page.bringToFront();
  const chip = page.locator('split-finder-chip').getByRole('button');
  await expect(chip).toHaveText(/Splits into 2 parts · Look up prices · 2 searches/);
  await shoot(page, 'chip-in-extension-lookup');

  await chip.click();
  await expect(page.locator('split-finder-chip').getByRole('status')).toHaveText('');
  await expect(panel.getByRole('button', { name: 'This page' })).toHaveAttribute('aria-current', 'true');
  await expect(panel.getByText('read from this page · no search used')).toBeVisible();
  const parts = panel.locator('.detail-parts .detail-part');
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toContainText('PBLRC25B');
  await expect(parts.nth(1)).toContainText('PBLRC01B');
  await shoot(panel, 'this-page-after-chip');
  expect(server.searches).toEqual([]);
});
