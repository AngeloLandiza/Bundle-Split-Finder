import { E2E_PORT } from '../wxt.config';
import { expect, test } from './fixtures';

// Step 7, acceptance 4: on the founder's example page (item 328814689) the chip appears under the price with
// no search used. The replay server serves the recorded page at /p/328814689 with a price block, the element the
// chip anchors under. These need the worker's pageSeen and openThisPage handlers (Task 3); they are written
// against the contract in .superpowers/sdd/2026-11-17-step-7-chip/contract.md. fixme: they need the worker side
// (step 7 Task 3), so they are skipped here; the controller turns them on after the merge by changing test.fixme to test.

const PAGE = `http://localhost:${E2E_PORT}/p/328814689`;

test.fixme('the chip sits directly under the price on the founder\'s page, and no search is used', async ({ context, server }) => {
  const page = await context.newPage();
  await page.goto(PAGE);
  const chip = page.locator('split-finder-chip').getByRole('button');
  // Nothing is stored yet, so both parts wait for a lookup: the chip says how many searches that would take.
  await expect(chip).toHaveText(/Splits into 2 parts · Look up prices · 2 searches/);
  const sibling = await page.evaluate(() => document.querySelector('[data-component^="price:Price"]')?.nextElementSibling?.localName);
  expect(sibling).toBe('split-finder-chip');
  expect(server.counts['/search.json'] ?? 0).toBe(0);
  expect(server.searches).toEqual([]);
});

test.fixme('clicking the chip asks the worker to open the panel', async ({ context, server: _server }) => {
  const page = await context.newPage();
  await page.goto(PAGE);
  const chip = page.locator('split-finder-chip').getByRole('button');
  await expect(chip).toBeVisible();
  await chip.click();
  // Either the worker opened the panel (the sentence stays empty) or it said it could not, and the chip says so in words.
  await expect(page.locator('split-finder-chip').getByRole('status')).toHaveText(/^(Open Split Finder from the toolbar to see this bundle\.)?$/);
});

test.fixme('turning "Show the chip on Home Depot pages" off removes the chip, on brings it back, and it stays off on the next page load', async ({ context, options, server }) => {
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

test.fixme('the chip is drawn in the design\'s fonts, loaded from the extension', async ({ context }) => {
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
