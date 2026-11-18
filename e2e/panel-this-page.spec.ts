import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { parseProductPage, type ProductPage } from '../core/src/hdPage';
import { expect, saveKey, test } from './fixtures';

// The This page tab without the content script (Task 2's chip): the page the chip would send is sent through the worker's real
// message path, from a script the extension injects into a tab of the replay server (scripting.executeScript, isolated world,
// which Chrome treats as the extension's content script: it carries the tab and the page's address). The panel is a tab here,
// not Chrome's side panel, so it follows the tab that is active; the test activates the replay tab and reads the panel behind it.
//
// Screenshots only when SPLIT_FINDER_SHOTS is set: 1 writes to qa-shots/, any other value is the folder. Never in a normal run.
const SHOTS = process.env.SPLIT_FINDER_SHOTS;
const DIR = SHOTS ? `${SHOTS === '1' ? 'qa-shots' : SHOTS}/` : null;
const WIDTHS = [360, 480];

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(150);
    if (DIR) await panel.screenshot({ path: `${DIR}this-page-${name}-${width}.png` });
    // Nothing may run past the panel's width.
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

const pages = (JSON.parse(readFileSync('fixtures/homedepot-pages/pages-2026-11-10.json', 'utf8')) as { pages: { itemId: string; text: string }[] }).pages;
const textOf = (id: string) => pages.find((p) => p.itemId === id)!.text;

/** 328814689 as the owner sees it: the recorded page priced in the shape captured on Nov 17 ($189, was $338). */
function founderPage(): ProductPage {
  const mark = '"base-catalog-328814689":{';
  const entry = '"pricing({\\"isBrandPricingPolicyCompliant\\":false,\\"storeId\\":\\"8119\\"})":{"value":189,"original":338},';
  return parseProductPage(textOf('328814689').replace(mark, mark + entry), '328814689')!;
}
/** PCL500525SB has no split rule and no Includes list: its split is a question that offers no reading. */
const askedPage = (): ProductPage => parseProductPage(textOf('328690510'), '328690510')!;

type Reply = { ok: boolean; data?: { kind: string; parts?: number; lookupParts?: number }; error?: string };

/** What the chip's content script does: sends the page from inside the tab, as that tab. */
async function pageSeen(extension: Page, tabUrl: string, page: ProductPage): Promise<Reply> {
  return extension.evaluate(
    async ([url, seen]) => {
      const c = chrome as unknown as {
        tabs: { query(q: object): Promise<{ id: number }[]> };
        scripting: { executeScript(o: object): Promise<{ result: unknown }[]> };
      };
      const [tab] = await c.tabs.query({ url });
      const results = await c.scripting.executeScript({
        target: { tabId: tab!.id },
        world: 'ISOLATED',
        func: (p: unknown) => (chrome as unknown as { runtime: { sendMessage(m: unknown): Promise<unknown> } }).runtime.sendMessage({ type: 'pageSeen', page: p }),
        args: [seen],
      });
      return results[0]!.result;
    },
    [tabUrl, page] as const,
  ) as Promise<Reply>;
}

async function setUp(context: import('@playwright/test').BrowserContext, extensionId: string, options: Page) {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: 'This page' }).click();
  return panel;
}

test('this page: the founder\'s bundle from the page, with no search used', async ({ context, extensionId, options, server }) => {
  const panel = await setUp(context, extensionId, options);
  // Nothing open in the active tab yet that the chip reads.
  const hd = await context.newPage();
  await hd.goto(`${server.url}/p/328814689`);
  await hd.bringToFront();
  await expect(panel.getByText('Open a Home Depot bundle page to see it here.')).toBeVisible();

  const reply = await pageSeen(options, `${server.url}/p/328814689`, founderPage());
  expect(reply).toMatchObject({ ok: true, data: { kind: 'bundle', parts: 2, lookupParts: 2 } });

  await expect(panel.getByText('read from this page · no search used')).toBeVisible();
  const head = panel.getByRole('region', { name: 'Estimate' });
  await expect(head).toContainText('PBLRC2501SB');
  // Acceptance criterion 4: the parts PBLRC25B and PBLRC01B; nothing is priced because nothing was looked up.
  const parts = panel.locator('.detail-parts .detail-part');
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toContainText('PBLRC25B');
  await expect(parts.nth(1)).toContainText('PBLRC01B');
  await expect(panel.getByText(/^No estimate yet: 2 parts still need an Amazon lookup\./)).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Verify|^Look up/ })).toHaveCount(0);
  await shoot(panel, 'founder');

  // The visit stored the bundle, so Detail opens; Back says where it came from.
  await expect(panel.getByRole('button', { name: 'Open full detail' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Open full detail' }).click();
  await expect(panel.getByRole('heading', { level: 1 })).toContainText('Extended Reach Ratchets');
  await panel.getByRole('button', { name: 'This page' }).click();
  await expect(panel.getByText('read from this page · no search used')).toBeVisible();

  // No SerpApi search and no page request was made for it.
  expect(server.searches).toEqual([]);
  expect(server.counts['/search.json'] ?? 0).toBe(0);
});

test('this page: a bundle that needs an answer, the answer, and a tab that moves on', async ({ context, extensionId, options, server }) => {
  const panel = await setUp(context, extensionId, options);
  const hd = await context.newPage();
  await hd.goto(`${server.url}/p/328690510`);
  await hd.bringToFront();

  const reply = await pageSeen(options, `${server.url}/p/328690510`, askedPage());
  expect(reply).toMatchObject({ ok: true, data: { kind: 'bundle', parts: 0 } });
  await expect(panel.getByRole('group', { name: /Which parts come in this bundle\?/ })).toBeVisible();
  await expect(panel.getByText('Est. profit')).toHaveCount(0);
  await shoot(panel, 'question');

  await panel.getByRole('radio', { name: 'Enter the parts' }).check();
  await panel.getByLabel('Model numbers, separated by commas').fill('PCL500B, PBP005');
  await panel.getByRole('button', { name: 'Save answer' }).click();
  const parts = panel.locator('.detail-parts .detail-part');
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toContainText('PCL500B');
  await expect(panel.getByRole('group', { name: /Which parts come in this bundle\?/ })).toHaveCount(0);
  await shoot(panel, 'answered');

  // The tab goes on to another address the chip did not send: the panel does not keep showing the last page.
  await hd.goto(`${server.url}/p/328814689`);
  await expect(panel.getByText('Open a Home Depot bundle page to see it here.')).toBeVisible();
  expect(server.searches).toEqual([]);
});
