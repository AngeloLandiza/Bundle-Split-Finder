import type { Page, Worker } from '@playwright/test';
import type { BundleRow } from '../core/src/scan/types';
import { expect, getState, saveKey, test } from './fixtures';

// Step 9, Task 3: the ROI range in Deals and each part's prices in Detail, in the built extension. A real scan of the
// replay's recorded pages: bundle 343992133 (DEWALT DCK540D1 + DCS334B, $499) is priced by Amazon's recorded search rows
// (the featured price and the struck-through list price), and the scan reads each part's Home Depot price through the
// part price reader from the replay server's /s/<model> pages (SYNTHETIC prices: part-search-2026-11-18.json says so).
// What no recording holds is a Buy Box, which only Verify reads from a listing's page: the test saves one on each
// listing, as Verify does, so the range has two different ends. The seller names are invented.
//
// Screenshots only when SPLIT_FINDER_SHOTS is set: 1 writes to qa-shots/, any other value is the folder. Never in a normal run.
const SHOTS = process.env.SPLIT_FINDER_SHOTS;
const DIR = SHOTS ? `${SHOTS === '1' ? 'qa-shots' : SHOTS}/` : null;
const WIDTHS = [360, 480];
const BUNDLE = 'homedepot:343992133';

async function shoot(panel: Page, name: string, height = 820, scrollToParts = false): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height });
    // A resize puts the scroll back at the top: bring the parts to the top of the screen again.
    if (scrollToParts) await panel.getByRole('heading', { name: /^PARTS/ }).evaluate((h) => h.scrollIntoView({ block: 'start' }));
    await panel.waitForTimeout(150);
    if (DIR) await panel.screenshot({ path: `${DIR}${name}-${width}.png` });
    // Nothing may run past the panel's width.
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

async function configure(page: Page, patch: Record<string, unknown>): Promise<void> {
  const settings = { ...((await getState(page)).data as unknown as { settings: Record<string, unknown> }).settings, ...patch };
  expect(await page.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings)).toMatchObject({ ok: true });
}

async function scanAndWait(page: Page): Promise<void> {
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(page)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
}

const reportRow = async (page: Page): Promise<BundleRow> => {
  const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getReport' }));
  return (reply as { data: { bundles: BundleRow[] } }).data.bundles.find((b) => b.key === BUNDLE)!;
};

/** What Verify saves on a listing: its Buy Box. The page's own reading is not recorded for these listings. */
function saveBuyBox(worker: Worker, asin: string, box: { price: number; soldBy: string; shipsFrom: string }): Promise<void> {
  return worker.evaluate(
    ([key, b]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('split-finder');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const store = open.result.transaction('listings', 'readwrite').objectStore('listings');
          const get = store.get(key);
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            const put = store.put({ ...get.result, buyBox: { ...b, seenAt: Date.now() } });
            put.onerror = () => reject(put.error);
            put.onsuccess = () => resolve();
          };
        };
      }),
    [asin, box] as const,
  );
}

test('Deals shows the ROI range under the Amazon New figures, and Detail lists each part\'s prices, labelled', async ({ context, extensionId, options, server, worker }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await configure(options, { searchesPerScan: 10 });
  server.reset();
  await scanAndWait(options);
  expect(server.searchPageRequests.map((m) => m.toUpperCase())).toEqual(expect.arrayContaining(['DCK540D1', 'DCS334B']));

  let row = await reportRow(options);
  expect(row.estimate).not.toBeNull();
  const [kit, saw] = row.parts;
  expect(kit!.model).toBe('DCK540D1');
  expect(saw!.model).toBe('DCS334B');
  // Before any Buy Box: Amazon's featured and list prices and Home Depot's, the last two for reference; one figure, no range.
  expect(kit!.prices.map((o) => o.kind)).toEqual(['amazon_list', 'homedepot', 'amazon_new']);
  expect(saw!.prices.map((o) => o.kind)).toEqual(['amazon_list', 'homedepot', 'amazon_new']);
  expect(row.range.lowest!.roi).toBeCloseTo(row.range.highest!.roi, 6);

  // A Buy Box under the kit's featured price and one over the saw's: the range now has two ends.
  await saveBuyBox(worker, kit!.asin!, { price: kit!.price! - 20, soldBy: 'Northline Tools', shipsFrom: 'Amazon' });
  await saveBuyBox(worker, saw!.asin!, { price: saw!.price! + 16, soldBy: 'Amazon.com', shipsFrom: 'Amazon' });
  row = await reportRow(options);
  expect(row.range.lowest!.roi).toBeLessThan(row.estimate!.roi);
  expect(row.range.highest!.roi).toBeGreaterThan(row.estimate!.roi);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const deal = panel.locator('.deal-link', { hasText: 'DCK540D1WCS334B' });
  await expect(deal).toBeVisible();
  // The headline is the Amazon New figure, as before; the range is under it, in words an estimate can be read from.
  await expect(deal.locator('.deal-roi')).toHaveText(/^ROI /);
  await expect(deal.locator('.deal-roi-range')).toHaveText(/^ROI [−+]?\d+% to \+?\d+%$/);
  await expect(panel.getByText('Estimated profit · ROI')).toHaveCount(1);
  // Sort has the two range sorts.
  await expect(panel.getByLabel('Sort by').locator('option')).toHaveText(['Sort: Profit', 'Sort: ROI', 'Sort: Lowest ROI', 'Sort: Highest ROI', 'Sort: Discount']);
  await panel.getByLabel('Sort by').selectOption('roiLowest');
  await expect(deal).toBeVisible();
  await panel.getByLabel('Sort by').selectOption('profit');
  await shoot(panel, 'deals-range');

  await deal.click();
  await expect(panel.getByRole('heading', { level: 1 })).toContainText('Combo Kit (5-Tool)');
  await expect(panel.getByText(/^Estimated range: ROI /)).toBeVisible();
  const prices = panel.getByRole('group', { name: 'Prices for DCS334B' });
  await expect(prices.getByText('Amazon · New', { exact: true })).toBeVisible();
  await expect(prices.getByText('Amazon · New · Buy Box · sold by Amazon.com, ships from Amazon')).toBeVisible();
  await expect(prices.getByText('Amazon list price · reference')).toBeVisible();
  await expect(prices.getByText('Home Depot · sold alone · reference')).toBeVisible();
  await expect(prices.getByText('not counted')).toHaveCount(2);
  // A price with a link opens its own page: Home Depot's is the one the reader found.
  await expect(prices.getByRole('link', { name: 'Home Depot · sold alone · reference' })).toHaveAttribute('href', /\/p\/DEWALT-.*-DCS334B\/399000010$/);
  await expect(prices.getByRole('link', { name: 'Amazon · New', exact: true })).toHaveAttribute('href', /^https:\/\/www\.amazon\.com\/dp\/B/);
  await expect(panel.getByText(/renewed|refurbished/i)).toHaveCount(0);
  // Tall enough for both parts' price lists, as Chrome's side panel is.
  await shoot(panel, 'detail-prices', 1100, true);

  // The CSV the panel saves carries the range and the Home Depot total of the parts.
  const csv = await panel.evaluate(async (key) => {
    const reply = (await chrome.runtime.sendMessage({ type: 'exportDeals' })) as { ok: boolean; data: string };
    return { key, text: reply.data };
  }, BUNDLE);
  const [header, ...lines] = csv.text.trim().split('\n');
  expect(header).toMatch(/,roi_lowest,roi_amazon_new,roi_highest,hd_price_total$/);
  const mine = lines.find((l) => l.includes('343992133'))!;
  expect(mine).toMatch(/,-?[\d.]+,-?[\d.]+,-?[\d.]+,648$/);
});
