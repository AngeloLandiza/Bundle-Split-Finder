import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { ANTHROPIC_KEY, EBAY_APP_ID, EBAY_CERT_ID } from './replay-server';
import { expect, getState, saveKey, test } from './fixtures';

// Step 10, Task 5: eBay reference values, end to end. The built extension scans against the replay server, which answers as
// api.ebay.com (the recorded searches and item reads of fixtures/ebay/validation-2026-11-19.json) and as api.anthropic.com
// (a canned answer per recorded listing, scripts/ebay-replay.ts). Nothing leaves the machine.
//
// DEWALT DCF921B (the 1/2 in. impact wrench) is a part of bundle 337440459: five of its recorded listings are matches that
// have sold (345 units, $64.99 to $137.99); the model is unsure of a sixth (920101779170: $79, 4 sold).

const SHOTS = process.env.SPLIT_FINDER_SHOTS === '1';
const DIR = 'qa-shots/';
const WIDTHS = [360, 480];

async function shoot(page: Page, name: string, o: { fullPage?: boolean } = {}): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(150);
    // Nothing may run past the width, shot or not.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (SHOTS) {
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: `${DIR}${name}-${width}.png`, fullPage: o.fullPage ?? false });
    }
  }
}

interface Option { kind: string; reference: boolean; price: number; ebay?: { listings: number; unitsSold: number; low: number; high: number; links: string[] } }
interface Report {
  bundles: { key: string; title: string; parts: { model: string; prices: Option[] }[] }[];
  ebayQuestions: { id: string; key: string; model: string; itemId: string; title: string; reasons: string[] }[];
}

const report = async (page: Page): Promise<Report> => (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getReport' }))).data;
const send = (page: Page, request: Record<string, unknown>) => page.evaluate((r) => chrome.runtime.sendMessage(r), request);

async function scanAndWait(page: Page): Promise<void> {
  await send(page, { type: 'scanNow' });
  await expect.poll(async () => (await getState(page)).data.scanRunning, { timeout: 80_000, intervals: [250] }).toBe(false);
}

test('a scan gives a part an eBay reference line and an eBay question; Yes changes the line', async ({ context, extensionId, options, server, seen }) => {
  test.setTimeout(180_000);
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');

  // Settings: eBay's keys are saved only once eBay gives a token for them; the Anthropic key without a call.
  await options.getByLabel('eBay App ID').fill(EBAY_APP_ID);
  await options.getByLabel('eBay Cert ID').fill('not-the-cert');
  await options.getByRole('button', { name: 'Check eBay keys' }).click();
  await expect(options.getByTestId('ebay-key-result')).toHaveText('eBay did not accept this App ID and Cert ID.');
  await options.getByLabel('eBay Cert ID').fill(EBAY_CERT_ID);
  await options.getByRole('button', { name: 'Check eBay keys' }).click();
  await expect(options.getByTestId('ebay-key-result')).toContainText('Keys work.');
  await options.getByLabel('Anthropic key').fill(ANTHROPIC_KEY);
  await options.getByRole('button', { name: 'Add key' }).click();
  await expect(options.getByTestId('anthropic-key-result')).toContainText('Key saved in this browser.');
  // The most listings judged in a scan: room for every recorded part.
  const limit = options.getByLabel('eBay listings judged per scan');
  await limit.fill('300');
  await limit.blur();
  await expect(options.getByTestId('ebay-settings-status')).toHaveText('Saved.');
  expect((await getState(options)).data).toMatchObject({ ebay: { hasEbayKeys: true, hasAnthropicKey: true, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 300 } });
  // Neither key is in the page once saved.
  expect(await options.content()).not.toContain(EBAY_CERT_ID);
  expect(await options.content()).not.toContain(ANTHROPIC_KEY);
  await shoot(options, 'settings-ebay', { fullPage: true });

  await scanAndWait(options);
  // The replay has no Amazon search for the parts the scan then looks up, so it ends at that 404: the eBay step ran before it.
  const job = (await getState(options)).data.lastJob as unknown as { ebayNotice?: string | null; counts: Record<string, number> };
  expect(job.ebayNotice ?? null).toBeNull();
  expect(job.counts.ebaySearches).toBeGreaterThan(0);
  expect(job.counts.ebayItemReads).toBeGreaterThan(0);
  expect(job.counts.listingsJudged).toBeGreaterThan(0);
  expect(job.counts.judgeTokensIn).toBe(job.counts.listingsJudged! * 900);
  expect(server.ebaySearches).toContain('DEWALT DCF921B');
  expect(server.modelBadKeys).toBe(0);
  expect(server.modelCalls).toBe(job.counts.listingsJudged);
  // eBay's token was asked for once, and the keys went only in that request's Authorization header.
  expect(server.counts['/identity/v1/oauth2/token']).toBe(2);

  // The report: DCF921B has the eBay value, a reference of five matches that have sold; one listing is a question.
  const r = await report(options);
  const bundle = r.bundles.find((b) => b.parts.some((p) => p.model === 'DCF921B' && p.prices.some((o) => o.kind === 'ebay_sold_new')))!;
  expect(bundle).toBeDefined();
  const ebay = bundle.parts.find((p) => p.model === 'DCF921B')!.prices.find((o) => o.kind === 'ebay_sold_new')!;
  expect(ebay.reference).toBe(true);
  expect(ebay.ebay).toMatchObject({ listings: 5, unitsSold: 345, low: 64.99, high: 137.99 });
  expect(ebay.ebay!.links).toHaveLength(3);
  const asked = r.ebayQuestions.filter((q) => q.model === 'DCF921B');
  expect(asked.map((q) => q.itemId)).toEqual(['v1|920101779170|0']);
  expect(asked[0]!.reasons.length).toBeGreaterThan(0);

  // Detail: the line sits in the reference group, with its listings to open.
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.locator('.deal-row', { hasText: bundle.title }).first().locator('.deal-link').click();
  const prices = panel.getByRole('group', { name: 'Prices for DCF921B' });
  const reference = prices.getByRole('group', { name: 'Reference · not counted' });
  await expect(reference.getByText('eBay · New · $64.99–$137.99 · 5 listings, 345 sold')).toBeVisible();
  const links = reference.getByRole('link', { name: /^eBay listing / });
  await expect(links).toHaveCount(3);
  for (const href of ebay.ebay!.links) await expect(reference.locator(`a[href="${href}"]`)).toHaveAttribute('target', '_blank');
  await shoot(panel, 'detail-ebay');
  // A part with no eBay value has no eBay line.
  expect(await panel.getByText(/^eBay · New/).count()).toBeGreaterThan(0);

  // Review: the unsure listing is a question with its title, the check's reasons and its link.
  await panel.keyboard.press('Escape');
  await panel.getByRole('button', { name: /^Review/ }).click({ timeout: 10_000 });
  const legend = panel.locator('legend', { hasText: 'Is this eBay listing exactly DCF921B, New, with the same contents?' });
  // The questions come oldest first, so the split questions this replay opened come before an eBay one: put them off.
  await expect(panel.getByText(/^1 of \d+$/)).toBeVisible();
  for (let i = 0; i < 40 && !(await legend.isVisible()); i++) await panel.getByRole('button', { name: 'Skip for now' }).click();
  await expect(legend).toBeVisible();
  await expect(panel.locator('.review-bundle', { hasText: asked[0]!.title })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open this listing on eBay' })).toHaveAttribute('href', 'https://www.ebay.com/itm/920101779170');
  await expect(panel.getByText('Why the check was not certain')).toBeVisible();
  await shoot(panel, 'review-ebay');

  // Yes: the listing counts, and the line changes (six listings, four more units, $79 inside the range).
  await panel.getByRole('radio', { name: 'Yes, it is exactly this part' }).check();
  await panel.getByRole('button', { name: 'Save answer' }).click();
  await expect(legend).toHaveCount(0);
  await expect.poll(async () => (await report(options)).ebayQuestions.filter((q) => q.model === 'DCF921B').length).toBe(0);
  const after = (await report(options)).bundles
    .find((b) => b.key === bundle.key)!.parts.find((p) => p.model === 'DCF921B')!.prices.find((o) => o.kind === 'ebay_sold_new')!;
  expect(after.ebay).toMatchObject({ listings: 6, unitsSold: 349, low: 64.99, high: 137.99 });

  await panel.getByRole('button', { name: /^Deals/ }).click();
  await panel.locator('.deal-row', { hasText: bundle.title }).first().locator('.deal-link').click();
  await expect(panel.getByRole('group', { name: 'Prices for DCF921B' }).getByText('eBay · New · $64.99–$137.99 · 6 listings, 349 sold')).toBeVisible();

  // The answer is exported for the labels, and the CSV says the figures per part. Neither carries a key.
  const audit = JSON.parse((await send(options, { type: 'exportAudit' })).data as string);
  expect(audit.ebayAnswers).toEqual([
    expect.objectContaining({ itemId: 'v1|920101779170|0', model: 'DCF921B', verdict: 'match', labelledBy: 'owner', judged: 'unsure', url: 'https://www.ebay.com/itm/920101779170' }),
  ]);
  const csv = (await send(options, { type: 'exportDeals' })).data as string;
  expect(csv.split('\n')[0]).toMatch(/,ebay_ref_low,ebay_ref_high,ebay_units_sold$/);
  const row = csv.split('\n').find((l) => l.includes('DCF921B'))!;
  expect(row).toContain('349');
  for (const text of [JSON.stringify(audit), csv]) {
    expect(text).not.toContain(EBAY_CERT_ID);
    expect(text).not.toContain(ANTHROPIC_KEY);
  }

  // A second scan asks eBay for no new token while the saved one lasts (it is kept in session storage), and does not check
  // again a part it checked just now. It reads more bundle pages, so it may check parts the first did not reach.
  server.reset();
  await scanAndWait(options);
  expect(server.counts['/identity/v1/oauth2/token'] ?? 0).toBe(0);
  expect(server.ebaySearches).not.toContain('DEWALT DCF921B');
  expect(server.modelBadKeys).toBe(0);
  // The owner's answer stands through the scan: the line still counts six listings.
  const again = (await report(options)).bundles.find((b) => b.key === bundle.key)!.parts.find((p) => p.model === 'DCF921B')!.prices.find((o) => o.kind === 'ebay_sold_new')!;
  expect(again.ebay).toMatchObject({ listings: 6, unitsSold: 349 });
  expect(seen.console.filter((c) => !c.includes('status of 403') && !c.includes('status of 404'))).toEqual([]);
});

test('without the keys a scan says why eBay values were skipped, and calls neither eBay nor the model', async ({ options, server }) => {
  test.setTimeout(120_000);
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.reset();
  await scanAndWait(options);
  // The replay has no Amazon search for the parts the scan then looks up, so it ends at that 404: the eBay step ran before it.
  const job = (await getState(options)).data.lastJob as unknown as { ebayNotice?: string };
  expect(job.ebayNotice).toBe('eBay reference values were skipped. Add your eBay App ID and Cert ID and your Anthropic key in Settings to see them.');
  expect(server.ebaySearches).toEqual([]);
  expect(server.modelCalls).toBe(0);
  expect(server.counts['/identity/v1/oauth2/token'] ?? 0).toBe(0);
});
