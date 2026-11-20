import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { ANTHROPIC_KEY } from './replay-server';
import { expect, getState, saveKey, test } from './fixtures';

// Step 11, A2: Ask AI on a Review question, end to end. The built extension scans against the replay server, whose fake model
// answers the review assistant as the test says (server.setAssistReply). Nothing leaves the machine and no real model is called.
//
// The question is the recorded one of panel-review.spec: bundle 337440461 (DCK200D1P1DCB606) reads as DCB606 from its model
// number; its page, here the recorded page of 337440459, says "Includes DCK200D1P1 and DCF921B." So it offers two readings and the
// page names the second one's parts.

const SHOTS = process.env.SPLIT_FINDER_SHOTS === '1';
const DIR = 'qa-shots/';
const ID = 'split:homedepot:337440461';
const READING_0 = 'DCK200D1P1 + DCB606';
const READING_1 = 'DCK200D1P1 + DCF921B';

async function shoot(page: Page, name: string, widths: number[]): Promise<void> {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.review-question').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(150);
    // Nothing may run past the width, shot or not.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (SHOTS) {
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: `${DIR}${name}-${width}.png` });
    }
  }
}

const send = (page: Page, request: Record<string, unknown>) => page.evaluate((r) => chrome.runtime.sendMessage(r), request);
interface Item { id: string; answer: string | null; title: string | null; choices: string[][] }
interface Report { review: Item[] }
const report = async (page: Page): Promise<Report> => (await send(page, { type: 'getReport' })).data;
const question = async (page: Page): Promise<Item> => (await report(page)).review.find((q) => q.id === ID)!;
/** The answer the owner has saved to the question (the report lists open questions only), or null. */
const saved = async (page: Page): Promise<string | null> => ((await audit(page)).answers as Item[]).find((q) => q.id === ID)?.answer ?? null;
const audit = async (page: Page) => JSON.parse((await send(page, { type: 'exportAudit' })).data as string);

async function scanAndWait(page: Page): Promise<void> {
  const was = (await getState(page)).data.lastJob?.id ?? null;
  await send(page, { type: 'scanNow' });
  await expect
    .poll(async () => {
      const { scanRunning, lastJob } = (await getState(page)).data;
      return !scanRunning && lastJob?.id !== undefined && lastJob.id !== was;
    }, { timeout: 60_000, intervals: [100] })
    .toBe(true);
}

/** The Review tab with this question in front: the older ones are put off, which sends nothing. */
async function showQuestion(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: /^Review/ }).click();
  const mine = panel.getByRole('radio', { name: READING_1, exact: true });
  for (let i = 0; i < 40 && !(await mine.isVisible()); i++) await panel.getByRole('button', { name: 'Skip for now' }).click();
  await expect(mine).toBeVisible();
}

/** What the fake model says to a question: an answer in the assistant's schema, quoting the page's own sentence. */
const INCLUDES = /Includes DCK200D1P1 and DCF921B\./;
const quoted = (user: string): string => {
  const found = INCLUDES.exec(user);
  if (!found) throw new Error('the question reached the model without the page that names both parts');
  return found[0];
};
const says = {
  verified: (user: string) => ({ evidence: [{ quote: quoted(user), source: 'bundle' }], reason: 'The page says it includes both.', decision: 'choose', choiceIndex: 1, asin: null }),
  unverified: () => ({ evidence: [{ quote: 'Includes DCK200D1P1 and a battery the page never mentions.', source: 'bundle' }], reason: 'It does.', decision: 'choose', choiceIndex: 1, asin: null }),
  cannotTell: () => ({ evidence: [], reason: 'The page does not say which impact wrench is in the kit.', decision: 'cannot_tell', choiceIndex: null, asin: null }),
  none: (user: string) => ({ evidence: [{ quote: quoted(user), source: 'bundle' }], reason: 'The page names a different set of parts.', decision: 'none', choiceIndex: null, asin: null }),
};

async function seedAndScan(options: Page, worker: import('@playwright/test').Worker, server: import('./replay-server').ReplayServer): Promise<void> {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  // As in core/test/review-answers.test.ts: the catalog knows DCB606, so the model number gives a reading of its own.
  await worker.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('split-finder');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('catalog', 'readwrite');
          tx.objectStore('catalog').put({ key: 'DEWALT:DCB606', brand: 'DEWALT', model: 'DCB606', title: 'DCB606 (seeded for this test)', kinds: ['battery'], isKit: false, upc: null, seenAt: Date.now() });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  server.servePageAs('337440461', '337440459');
  // A scan reads only a few pages; scan again until the page of 337440461 has been read.
  for (let i = 0; i < 6 && !server.pageRequests.includes('337440461'); i++) await scanAndWait(options);
  expect(server.pageRequests).toContain('337440461');
  expect((await question(options))?.choices.map((c) => c.join(' + '))).toEqual([READING_0, READING_1]);
}

test('Ask AI: nothing is saved until Approve; verified, unverified, cannot tell and none each show their block', async ({ context, extensionId, options, server, worker, seen }) => {
  test.setTimeout(240_000);
  await seedAndScan(options, worker, server);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  // No Anthropic key: no Ask AI, not even a disabled one.
  await showQuestion(panel);
  await expect(panel.getByRole('button', { name: /Ask AI/ })).toHaveCount(0);

  // The key is saved, and the button says its price: Settings' model is Haiku.
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  await expect(panel.getByRole('button', { name: 'Ask AI · about $0.01' })).toBeVisible();
  expect(server.assistCalls).toEqual([]);
  await shoot(panel, 'ask-ai-button', [360, 480]);

  // (b) Unverified: the model's quote is not on the page. The block says so, nothing is preselected, the owner chooses.
  server.setAssistReply(says.unverified);
  await panel.getByRole('button', { name: /^Ask AI/ }).click();
  const block = panel.getByRole('group', { name: 'AI suggestion' });
  await expect(block.getByText('AI suggestion, unverified')).toBeVisible();
  await expect(block.getByText(READING_1)).toBeVisible();
  expect(server.assistCalls).toHaveLength(1);
  expect(server.modelBadKeys).toBe(0);
  for (const r of await panel.getByRole('radio').all()) await expect(r).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await shoot(panel, 'ask-ai-unverified', [360]);
  // Nothing was saved by the suggestion.
  expect(await saved(options)).toBeNull();
  // The owner chooses the other reading: a disagreement.
  await panel.getByRole('radio', { name: READING_0, exact: true }).check();
  await panel.getByRole('button', { name: 'Save answer' }).click();
  await expect.poll(() => saved(options)).toBe('DCK200D1P1,DCB606');
  let a = await audit(options);
  expect(a.aiSuggestions).toEqual([expect.objectContaining({ questionId: ID, source: 'ai', agreed: false, answer: 'DCK200D1P1,DCB606', suggestion: expect.objectContaining({ status: 'unverified' }) })]);

  // Cannot tell: the question is opened again, and the owner asks again.
  expect(await send(options, { type: 'reopenReview', id: ID })).toMatchObject({ ok: true });
  expect(await saved(options)).toBeNull();
  await panel.reload();
  await showQuestion(panel);
  server.setAssistReply(says.cannotTell);
  await panel.getByRole('button', { name: /^Ask AI/ }).click();
  await expect(block.getByText('AI could not tell from the page')).toBeVisible();
  await expect(block.getByText('The page does not say which impact wrench is in the kit.')).toBeVisible();
  for (const r of await panel.getByRole('radio').all()) await expect(r).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toBeDisabled();
  await shoot(panel, 'ask-ai-cannot-tell', [360]);

  // None of these fits: the AI's view, never verified; nothing preselected and the button stays Save answer.
  server.setAssistReply(says.none);
  expect(await send(options, { type: 'askAi', questionId: ID })).toMatchObject({ ok: true });
  await panel.reload();
  await showQuestion(panel);
  await expect(block.getByText('AI suggests none of these fits')).toBeVisible();
  await expect(block.getByText('The page names a different set of parts.')).toBeVisible();
  await expect(block.getByRole('link', { name: 'Home Depot page' })).toHaveAttribute('href', /homedepot\.com/);
  for (const r of await panel.getByRole('radio').all()) await expect(r).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await shoot(panel, 'ask-ai-none', [360]);
  expect(await saved(options)).toBeNull();

  // (a) Verified: the page's own sentence names both parts. The reading is preselected; nothing is saved until Approve.
  server.setAssistReply(says.verified);
  expect(await send(options, { type: 'askAi', questionId: ID })).toMatchObject({ ok: true });
  await panel.reload();
  await showQuestion(panel);
  await expect(block.getByText('AI suggestion', { exact: true })).toBeVisible();
  await expect(block.getByText(READING_1)).toBeVisible();
  await expect(block.getByText('Includes DCK200D1P1 and DCF921B.')).toBeVisible();
  await expect(block.getByRole('link', { name: 'Home Depot page' })).toHaveAttribute('target', '_blank');
  await expect(panel.getByRole('radio', { name: READING_1, exact: true })).toBeChecked();
  await expect(panel.getByRole('button', { name: 'Approve' })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toHaveCount(0);
  await shoot(panel, 'ask-ai-verified', [360, 480]);
  expect(await saved(options)).toBeNull();
  expect(server.assistCalls).toHaveLength(4);

  await panel.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => saved(options)).toBe('DCK200D1P1,DCF921B');
  a = await audit(options);
  expect(a.aiSuggestions).toHaveLength(4);
  expect(a.aiSuggestions.at(-1)).toMatchObject({ questionId: ID, source: 'ai', agreed: true, answer: 'DCK200D1P1,DCF921B', suggestion: { status: 'verified' }, tokens: { inputTokens: 1800, outputTokens: 300 } });
  // Neither key nor secrets in the audit.
  expect(JSON.stringify(a)).not.toContain(ANTHROPIC_KEY);
  expect(seen.console.filter((c) => !c.includes('status of 403') && !c.includes('status of 404'))).toEqual([]);
});

test('Ask AI: a call the model refuses is said in one line and the button comes back', async ({ context, extensionId, options, server, worker }) => {
  test.setTimeout(240_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: 'sk-ant-not-the-replay-key' })).toMatchObject({ ok: true });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await showQuestion(panel);
  await panel.getByRole('button', { name: /^Ask AI/ }).click();
  // The replay refuses the key: the model's refusal is a failed call, not a suggestion.
  await expect(panel.getByText(/Claude refused the API key/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Ask AI · about $0.01' })).toBeVisible();
  await expect(panel.getByRole('group', { name: 'AI suggestion' })).toHaveCount(0);
  expect(server.modelBadKeys).toBe(1);
  expect(await saved(options)).toBeNull();
});
