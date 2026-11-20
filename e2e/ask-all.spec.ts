import { mkdirSync } from 'node:fs';
import type { Page, Worker } from '@playwright/test';
import { ANTHROPIC_KEY, type ReplayServer } from './replay-server';
import { expect, getState, saveKey, test } from './fixtures';

// Step 12, R3: Ask AI about all, the "AI suggestions" section and Approve all, end to end. The built extension scans against the
// replay server, whose fake model answers the review assistant as the test says (server.setAssistReply). Nothing leaves the machine
// and no real model is called.
//
// The questions are the recorded scan's: twelve open split questions. Four bundles are served the recorded page that says "Includes
// DCK200D1P1 and DCF921B." (as in ask-ai.spec), and their questions are given that reading after the scan, so the fake model can quote
// the page for them. Three it answers verifiably (the first, the second and the sixth question); the third it quotes wrongly, so the
// code finds the quote missing (unverified). Every other question it cannot tell. The queue asks them in the store's order, so a Stop
// after the fourth leaves the sixth for a second pass.

const SHOTS = process.env.SPLIT_FINDER_SHOTS === '1';
const DIR = 'qa-shots/';
const T1 = '320243741';
const T2 = '324903619';
/** Quoted wrongly: the AI's answer is unverified. */
const T3 = '324904496';
/** The sixth question in the order they are asked. */
const T4 = '341644756';
const TARGETS = [T1, T2, T3, T4];
const READING = ['DCK200D1P1', 'DCF921B'];

async function shoot(page: Page, name: string, width: number, target?: () => Promise<void>): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await target?.();
  await page.waitForTimeout(200);
  // Nothing may run past the width, shot or not.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (SHOTS) {
    mkdirSync(DIR, { recursive: true });
    await page.screenshot({ path: `${DIR}${name}-${width}.png` });
  }
}

const send = (page: Page, request: Record<string, unknown>) => page.evaluate((r) => chrome.runtime.sendMessage(r), request);
interface Item { id: string; answer: string | null }
const audit = async (page: Page) => JSON.parse((await send(page, { type: 'exportAudit' })).data as string);
const idOf = (id: string) => id.replace('split:homedepot:', '');
const answered = async (page: Page): Promise<Record<string, string>> =>
  Object.fromEntries(((await audit(page)).answers as Item[]).filter((q) => q.answer !== null).map((q) => [idOf(q.id), q.answer!]));

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

/** Scans until the four bundles' pages have been read, then gives their questions the reading the served page names. */
async function seedAndScan(options: Page, worker: Worker, server: ReplayServer): Promise<void> {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  for (const id of TARGETS) server.servePageAs(id, '337440459');
  for (let i = 0; i < 8 && !TARGETS.every((id) => server.pageRequests.includes(id)); i++) await scanAndWait(options);
  for (const id of TARGETS) expect(server.pageRequests).toContain(id);
  // Written after the last scan, which would write the readings back.
  await worker.evaluate(
    (args) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('split-finder');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('review', 'readwrite');
          const store = tx.objectStore('review');
          for (const id of args.ids) {
            const get = store.get(`split:homedepot:${id}`);
            get.onsuccess = () => store.put({ ...get.result, choices: [args.reading] });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    { ids: TARGETS, reading: READING },
  );
}

const INCLUDES = 'Includes DCK200D1P1 and DCF921B.';
/** The third question's bundle model, as the prompt gives it (the recorded scan's). */
const T3_MODEL = 'Bundle model number: PCL1201K2-PCL430B';
/** What the fake model says: the page's own sentence for three questions; a sentence the page does not have for the third; nothing for the rest. */
const says = (user: string): unknown => {
  const reading = /<reading index="(\d+)">DCK200D1P1, DCF921B<\/reading>/.exec(user);
  if (reading && user.includes(INCLUDES)) {
    const quote = user.includes(T3_MODEL) ? 'Includes DCK200D1P1 and a battery the page never mentions.' : INCLUDES;
    return { evidence: [{ quote, source: 'bundle' }], reason: 'The page says it includes both.', decision: 'choose', choiceIndex: Number(reading[1]), asin: null };
  }
  return { evidence: [], reason: 'The page does not say which parts are in the kit.', decision: 'cannot_tell', choiceIndex: null, asin: null };
};

const askAllButton = (panel: Page) => panel.getByRole('button', { name: /^Ask AI about all/ });
const countIn = async (panel: Page, name: RegExp): Promise<number> => Number(/(\d+)/.exec(await panel.getByRole('button', { name }).innerText())![1]);

test('Ask AI about all: the queue, Stop, the section of verified suggestions, Approve all with its question, and Accept all for the rest', async ({ context, extensionId, options, server, worker, seen }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();

  // No Anthropic key: no Ask AI about all, not even a disabled one. Accept all is there, for the single readings.
  await expect(panel.getByRole('button', { name: /^Accept all/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Ask AI/ })).toHaveCount(0);
  const acceptAll = await countIn(panel, /^Accept all/);
  expect(acceptAll).toBeGreaterThanOrEqual(TARGETS.length);

  // With the key, beside Accept all, saying how many and about what it costs. Twelve split questions, Haiku.
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  await expect(askAllButton(panel)).toHaveAccessibleName(/^Ask AI about all \d+ · about \$0\.\d\d$/);
  // Every open question of the recorded scan is a split question that can be asked: the number is how many there are.
  const TOTAL = await countIn(panel, /^Ask AI about all/);
  expect(TOTAL).toBeGreaterThanOrEqual(8);
  expect((await send(options, { type: 'getReport' })).data.review).toHaveLength(TOTAL);
  await expect(panel.locator('.accept-actions').filter({ has: panel.getByRole('button', { name: /^Accept all/ }) }).getByRole('button', { name: /^Ask AI about all/ })).toBeVisible();
  expect(server.assistCalls).toEqual([]);

  // Ask about all of them, slowly enough to see the row and to stop it.
  server.setAssistReply(says);
  server.delayAssist(700);
  await askAllButton(panel).click();
  const row = panel.locator('.progress');
  await expect(row).toContainText(new RegExp(`Asking AI · \\d+ of ${TOTAL}`));
  await expect(row).toContainText(/about \d+ min|under a minute/);
  await expect(panel.getByRole('progressbar', { name: 'Asking AI progress' })).toBeVisible();
  await shoot(panel, 'progress-asking-ai', 360);
  // Details: one line, the cost so far, from the tokens of the answers.
  await row.getByRole('button', { name: 'Details' }).click();
  await expect(row.getByRole('list', { name: 'Asking AI steps' })).toContainText(/Asking AInow\$0\.\d\d so far/);
  await row.getByRole('button', { name: 'Details' }).click();
  // The panel is usable, and a scan waits: Scan now is Stop, and a scan asked for is refused.
  await expect(panel.getByRole('button', { name: 'Scan now' })).toHaveCount(0);
  expect(await send(options, { type: 'scanNow' })).toMatchObject({ ok: false, error: 'Asking AI is running. Stop it first, or wait for it to finish.' });

  // Stop, once four questions are done: the fifth is out.
  await expect.poll(async () => (await getState(options)).data.askAll?.done ?? 0, { timeout: 60_000, intervals: [100] }).toBeGreaterThanOrEqual(4);
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(async () => (await getState(options)).data.askAll ?? null, { timeout: 30_000, intervals: [100] }).toBeNull();
  const result = (await getState(options)).data.askAllResult!;
  // The one with no reading has nothing to ask with the evidence alone, so it is passed over, not asked.
  expect(result).toMatchObject({ stopped: true, total: TOTAL, verified: 2 });
  expect(result.asked).toBeGreaterThanOrEqual(3);
  expect(result.asked).toBeLessThan(TOTAL - 1);
  await expect(panel.getByRole('status').filter({ hasText: 'Stopped after' })).toContainText(`Stopped after ${result.asked} of ${TOTAL}: 2 verified.`);
  await expect(panel.getByRole('button', { name: 'Scan now' })).toBeVisible();
  // No half-written suggestion: one record for each question that was answered, none for the call that was cancelled.
  server.delayAssist(0);
  let a = await audit(options);
  expect(a.aiSuggestions).toHaveLength(result.asked);
  expect(server.assistCalls.length).toBeGreaterThanOrEqual(result.asked);
  expect(server.assistCalls.length).toBeLessThanOrEqual(result.asked + 1);
  expect(await answered(options)).toEqual({});

  // The section lists the verified ones only; the unverified and the cannot-tell stay in the list below with their block.
  const section = panel.getByRole('region', { name: /AI suggestions/ });
  await expect(section.getByRole('heading', { name: 'AI suggestions · 2' })).toBeVisible();
  await expect(section.getByRole('listitem')).toHaveCount(2);
  await expect(section.getByText(INCLUDES)).toHaveCount(2);
  await expect(section.getByRole('link', { name: 'Home Depot page' }).first()).toHaveAttribute('target', '_blank');
  // One line each: a name longer than the panel is cut, not wrapped.
  expect(await section.locator('.ai-row-name').evaluateAll((els) => els.every((el) => el.scrollHeight <= el.clientHeight + 1))).toBe(true);
  await expect(panel.getByRole('button', { name: 'Approve all 2 verified' })).toBeVisible();
  for (const width of [360, 480]) await shoot(panel, 'review-ai-section', width, () => panel.evaluate(() => window.scrollTo(0, 0)));

  // Ask about the rest: a question with a suggestion is not asked twice.
  const before = server.assistCalls.length;
  const left = await countIn(panel, /^Ask AI about all/);
  expect(left).toBe(TOTAL - result.asked);
  await askAllButton(panel).click();
  await expect.poll(async () => (await getState(options)).data.askAllResult?.stopped, { timeout: 60_000, intervals: [100] }).toBe(false);
  // Every question but the one with no reading was asked, once.
  expect(server.assistCalls.length - before).toBe(left - 1);
  a = await audit(options);
  expect(a.aiSuggestions).toHaveLength(TOTAL - 1);
  const verifiedIds = a.aiSuggestions.filter((r: { suggestion: { status: string } }) => r.suggestion.status === 'verified').map((r: { questionId: string }) => idOf(r.questionId));
  expect(verifiedIds.sort()).toEqual([T1, T2, T4].sort());
  await expect(section.getByRole('heading', { name: 'AI suggestions · 3' })).toBeVisible();
  // Accept all has nothing left to answer: every other question the AI has spoken on.
  await expect(panel.getByRole('button', { name: /^Accept all/ })).toHaveCount(0);

  // Approve all asks first. Nothing is saved by the first press.
  await panel.getByRole('button', { name: 'Approve all 3 verified' }).click();
  await expect(section.getByText('Approve 3 AI answers?')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Approve', exact: true })).toBeFocused();
  expect(await answered(options)).toEqual({});
  await shoot(panel, 'review-ai-approve-all-confirm', 360, () => panel.evaluate(() => window.scrollTo(0, 0)));
  // Cancel changes nothing.
  await section.getByRole('button', { name: 'Cancel' }).click();
  expect(await answered(options)).toEqual({});
  await panel.getByRole('button', { name: 'Approve all 3 verified' }).click();
  await section.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(panel.getByText('Approved 3 of 3.')).toBeVisible();

  // Exactly the verified ones are answered, with the parts the page named, and each is recorded as an AI approval.
  expect(await answered(options)).toEqual({ [T1]: READING.join(','), [T2]: READING.join(','), [T4]: READING.join(',') });
  a = await audit(options);
  const outcomes = a.aiSuggestions
    .filter((r: { agreed: boolean | null }) => r.agreed !== null)
    .map((r: { questionId: string; agreed: boolean }) => [idOf(r.questionId), r.agreed]);
  expect(outcomes.sort()).toEqual([[T1, true], [T2, true], [T4, true]].sort());
  await expect(panel.getByRole('region', { name: /AI suggestions/ })).toHaveCount(0);
  // The third question, whose quote the code could not find, was not approved: it is still open, with its block and nothing preselected.
  const open = (await send(options, { type: 'getReport' })).data.review as Item[];
  expect(open.map((q) => idOf(q.id))).toContain(T3);
  expect(open).toHaveLength(TOTAL - 3);
  expect(seen.console.filter((c) => !c.includes('status of 403') && !c.includes('status of 404'))).toEqual([]);
  expect(JSON.stringify(a)).not.toContain(ANTHROPIC_KEY);
});

test('Accept all still answers the questions the AI has not been asked about', async ({ context, extensionId, options, server, worker }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  const all = await countIn(panel, /^Accept all/);
  server.setAssistReply(says);
  // Ask about two questions on their own: they have suggestions, so Accept all leaves them be.
  expect(await send(options, { type: 'askAi', questionId: `split:homedepot:${T1}` })).toMatchObject({ ok: true });
  expect(await send(options, { type: 'askAi', questionId: `split:homedepot:${T3}` })).toMatchObject({ ok: true });
  await expect(panel.getByRole('button', { name: `Accept all ${all - 2}` })).toBeVisible();
  await panel.getByRole('button', { name: `Accept all ${all - 2}` }).click();
  await expect(panel.getByText(new RegExp(`^Accepted ${all - 2} of ${all - 2}\\.`))).toBeVisible();
  const done = await answered(options);
  expect(Object.keys(done)).toHaveLength(all - 2);
  expect(Object.keys(done)).not.toContain(T1);
  expect(Object.keys(done)).not.toContain(T3);
  // No AI approval is recorded for them: Accept all never says a suggestion was on screen.
  expect(((await audit(options)).aiSuggestions as { agreed: boolean | null }[]).every((r) => r.agreed === null)).toBe(true);
});

test('Settings: Ask AI after each scan is off until turned on, then the queue follows a scan', async ({ options, server, worker }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  server.setAssistReply(says);
  await options.reload();
  const box = options.getByRole('checkbox', { name: /Ask AI after each scan/ });
  await expect(box).not.toBeChecked();
  await shoot(options, 'settings-ask-after-scan', 360, () => box.scrollIntoViewIfNeeded());
  // A scan with it off asks nothing.
  const before = server.assistCalls.length;
  await scanAndWait(options);
  expect(server.assistCalls.length).toBe(before);
  expect((await getState(options)).data.askAllResult ?? null).toBeNull();
  // Turned on, it is saved at once and kept.
  await box.check();
  await expect.poll(async () => (await getState(options)).data.askAfterScan).toBe(true);
  await options.reload();
  await expect(options.getByRole('checkbox', { name: /Ask AI after each scan/ })).toBeChecked();
  // The scan runs to its end and the queue starts after it; nothing is answered.
  await scanAndWait(options);
  await expect.poll(async () => (await getState(options)).data.askAllResult?.stopped, { timeout: 60_000, intervals: [200] }).toBe(false);
  const result = (await getState(options)).data.askAllResult!;
  expect(result.total).toBeGreaterThan(0);
  expect(server.assistCalls.length).toBeGreaterThan(before);
  expect(server.assistCalls.length - before).toBeLessThanOrEqual(result.total);
  // Nothing was answered by the AI: the only answers are the scan's own closing of a question its page now settles.
  expect(Object.values(await answered(options)).every((a) => a === 'resolved by a later scan')).toBe(true);
});
