import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { parseBundlePage } from '../core/src/hdPage';
import { reviewSignature } from '../core/src/scan/answers';
import type { BundleRecord, ReviewItem } from '../core/src/scan/types';
import { expect, getState, saveKey, test } from './fixtures';

// Screenshots only when SPLIT_FINDER_SHOTS is set: 1 writes to qa-shots/, any other value is the folder. Never in a normal run.
const SHOTS = process.env.SPLIT_FINDER_SHOTS;
const DIR = SHOTS ? `${SHOTS === '1' ? 'qa-shots' : SHOTS}/` : null;
const WIDTHS = [360, 480];
const P553 = 'homedepot:320243741';

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.waitForTimeout(150);
    if (DIR) await panel.screenshot({ path: `${DIR}options-${name}-${width}.png` });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await panel.evaluate(() => (document.querySelector('.detail-body') ? document.querySelector('.detail-body')!.scrollWidth <= document.querySelector('.detail-body')!.clientWidth : true))).toBe(true);
  }
}

async function setPerScan(page: Page, searchesPerScan: number): Promise<void> {
  const settings = { ...((await getState(page)).data as unknown as { settings: Record<string, unknown> }).settings, searchesPerScan };
  expect(await page.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings)).toMatchObject({ ok: true });
}

async function scanAndWait(page: Page): Promise<void> {
  await setPerScan(page, 10);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect.poll(async () => (await getState(page)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
}

/**
 * The kit PCL1600K2 (317987591) stored as a bundle with its recorded Home Depot page read, as a scan with a
 * bundles-only listing query leaves it. The panel's own scan has no such query, so the record is put into the
 * extension's database by hand; the page is the recorded one.
 */
async function storeKitPage(page: Page): Promise<void> {
  const pages = (JSON.parse(readFileSync('fixtures/homedepot-pages/pages-2026-11-10.json', 'utf8')) as { pages: { itemId: string; text: string }[] }).pages;
  const content = parseBundlePage(pages.find((p) => p.itemId === '317987591')!.text, '317987591')!;
  // The database name and the store are the extension's own (extension/lib/db.ts: 'split-finder', 'bundles').
  const record: BundleRecord = {
    key: 'homedepot:317987591', retailer: 'homedepot', itemId: '317987591', title: 'RYOBI ONE+ 18V Cordless 11-Tool Combo Kit', brand: 'RYOBI', model: 'PCL1600K2',
    upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: Date.now(), split: null, page: { ...content, readAt: Date.now() },
  };
  await page.evaluate(
    (r) =>
      new Promise<void>((ok, fail) => {
        const open = indexedDB.open('split-finder');
        open.onerror = () => fail(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('bundles', 'readwrite');
          tx.objectStore('bundles').put(r);
          tx.oncomplete = () => ok();
          tx.onerror = () => fail(tx.error);
        };
      }),
    record,
  );
}

/** The owner's answer to PCL1600K2-P553's split question: its one choice, PCL1600K2 + P553. */
async function ownerChoosesKit(page: Page): Promise<void> {
  const review = (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getReport' }))).data.review as ReviewItem[];
  const question = review.find((r) => r.id === `split:${P553}`)!;
  const reply = await page.evaluate((a) => chrome.runtime.sendMessage({ type: 'answerReview', id: a.id, answer: a.answer }), {
    id: question.id, answer: { choice: 0, seen: reviewSignature(question) },
  });
  expect(reply).toMatchObject({ ok: true });
}

test('deals and detail, a bundle with a kit that can be sold whole or split', async ({ context, extensionId, options }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await scanAndWait(options);
  await storeKitPage(options);
  await ownerChoosesKit(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const row = panel.locator('.deal-row', { has: panel.locator(`[data-key="${P553}"]`) });
  await expect(row.getByText('2 ways to sell')).toBeVisible();
  await shoot(panel, 'deals-row');

  await row.locator('.deal-link').click();
  const region = panel.getByRole('region', { name: 'Ways to sell' });
  await expect(region.getByRole('heading', { name: 'Ways to sell' })).toBeVisible();
  await expect(region.getByText('PCL1600K2 sold whole')).toBeVisible();
  await expect(region.getByText('PCL1600K2 split into its parts')).toBeVisible();
  await expect(region.getByText('Shown above')).toHaveCount(1);
  await expect(region.getByText('Leaves nothing')).toBeVisible();
  await expect(region.getByText('Parts from a kit have no retail box of their own.')).toBeVisible();
  await expect(region.getByText(/^Estimated profit and ROI/)).toBeVisible();
  const whole = region.getByRole('button', { name: 'Look up 2 parts · 2 searches' });
  await expect(whole).toBeVisible();
  await expect(whole).not.toHaveAttribute('aria-disabled', 'true');
  await expect(region.getByRole('button', { name: /^Look up 9 parts · / })).toBeVisible();
  await shoot(panel, 'before-lookup');

  await whole.click();
  await expect(region.getByRole('button', { name: /^Look up 2 parts/ })).toHaveCount(0);
  await expect(region.locator('.detail-way').first().locator('.detail-way-profit')).toHaveText(/^[+−]\$/);
  await shoot(panel, 'after-lookup');
});

/**
 * Here PBP005 has no saved listing and its search is not recorded (the unit replay saves it from a brand page), so
 * its lookup fails and ends the press, as any failed lookup does: the press spends at most 5, and fewer parts wait.
 */
test('ways to sell at the default 5 searches per scan: the split looks up what fits, and is quoted again for the rest (Ruling 72)', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await scanAndWait(options);
  await storeKitPage(options);
  await ownerChoosesKit(options);
  await setPerScan(options, 5);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('.deal-row', { has: panel.locator(`[data-key="${P553}"]`) }).locator('.deal-link').click();
  const region = panel.getByRole('region', { name: 'Ways to sell' });
  const split = region.locator('.detail-way', { hasText: 'split into its parts' });
  const first = split.getByRole('button', { name: 'Look up 5 of 9 parts · 5 searches' });
  await expect(first).toBeVisible();
  await expect(first).not.toHaveAttribute('aria-disabled', 'true');
  // The whole way's two parts fit: unchanged.
  await expect(region.getByRole('button', { name: 'Look up 2 parts · 2 searches' })).toBeVisible();
  await shoot(panel, 'split-capped');

  const sent = server.searches.length;
  await first.click();
  // Quoted again for the parts still waiting, fewer than the 9; above the limit it still says how many of them.
  const rest = split.getByRole('button', { name: /^Look up (\d+ of )?[1-8] parts? · / });
  await expect(rest).toBeVisible();
  await expect(rest).not.toHaveAttribute('aria-disabled', 'true');
  expect(server.searches.slice(sent).length).toBeLessThanOrEqual(5);
  // The press made progress and then failed at PBP005: the owner is told so under the button quoted again.
  const failed = split.getByText('SerpApi answered with an error (HTTP 404). Try again later.');
  await expect(failed).toBeVisible();
  expect((await failed.boundingBox())!.y).toBeGreaterThanOrEqual((await rest.boundingBox())!.y);
  await shoot(panel, 'split-rest');

  // A refusal in a way to sell is its own full-width line under the button (QA, 360px). A scan held running refuses
  // every Look up with one.
  server.delaySearches(2_000);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  const refusal = split.getByText('A scan is running.');
  await expect(refusal).toBeVisible();
  const button = split.getByRole('button', { name: /^Look up/ });
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 900 });
    const b = (await button.boundingBox())!;
    const r = (await refusal.boundingBox())!;
    expect(r.y).toBeGreaterThanOrEqual(b.y + b.height);
    expect(r.width).toBeGreaterThan(b.width);
  }
  await shoot(panel, 'refusal-stacked');
  await expect.poll(async () => (await getState(options)).data.scanRunning, { timeout: 60_000, intervals: [250] }).toBe(false);
});

test('deals row at 360px: a Look up that names how many of the parts leaves the left column its room (Ruling 72 review)', async ({ context, extensionId, options }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await scanAndWait(options);
  await storeKitPage(options);
  await ownerChoosesKit(options);
  await setPerScan(options, 1);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const row = panel.locator('.deal-row', { has: panel.locator(`[data-key="${P553}"]`) });
  const button = row.getByRole('button', { name: 'Look up 1 of 2 parts · 1 search, for PCL1600K2-P553' });
  await expect(button).toBeVisible();
  await expect(button).toHaveClass(/deal-lookup-btn-long/);
  // Hand-made: the longest label a kit split gives at the default limit, written into this real row's button.
  await button.evaluate((b) => {
    const cost = b.querySelector('.deal-lookup-cost')!;
    for (const node of Array.from(b.childNodes)) if (node !== cost) node.remove();
    b.insertBefore(document.createTextNode('Look up 5 of 8 parts '), cost);
    cost.textContent = '· 5 searches';
  });
  await expect(button).toHaveText('Look up 5 of 8 parts · 5 searches');
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 900 });
    await panel.waitForTimeout(150);
    const b = (await button.boundingBox())!;
    const subs = (await row.locator('.deal-subs').boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(width - 16 + 1);
    expect(b.width).toBeLessThanOrEqual(160);
    expect(subs.width).toBeGreaterThanOrEqual(width === 360 ? 170 : 290);
    expect(subs.x + subs.width).toBeLessThanOrEqual(b.x + 1);
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (DIR) await panel.screenshot({ path: `${DIR}options-deals-row-long-${width}.png` });
  }
});

test('detail, a kit whose Home Depot page has not been read', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.refuse('*');
  await scanAndWait(options);
  await ownerChoosesKit(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('.deal-row', { has: panel.locator(`[data-key="${P553}"]`) }).locator('.deal-link').click();
  await expect(panel.getByText("PCL1600K2's contents are not known yet: its Home Depot page has not been read.")).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Ways to sell' })).toHaveCount(0);
  await shoot(panel, 'not-read');
});
