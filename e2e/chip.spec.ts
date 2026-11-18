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

test.fixme('with "Show the chip on Home Depot pages" off there is no chip', async ({ context, options, server }) => {
  await options.getByLabel('Show the chip on Home Depot pages').uncheck();
  const page = await context.newPage();
  await page.goto(PAGE);
  await page.waitForTimeout(1000);
  await expect(page.locator('split-finder-chip')).toHaveCount(0);
  expect(server.counts['/search.json'] ?? 0).toBe(0);
});
