import { mkdirSync } from 'node:fs';
import type { Page, Worker } from '@playwright/test';
import { ANTHROPIC_KEY, type ReplayServer } from './replay-server';
import { expect, getState, saveKey, test } from './fixtures';

// Step 12, R3: Ask AI about all, the "AI suggestions" section and Approve all, end to end. The built extension scans against the
// replay server. Its fake model answers the research agent as the test says (server.setResearchReply), and its Home Depot routes answer
// the research tools' page reads and searches from fixtures/homedepot-pages/research-2026-11-20.json. Nothing leaves the machine and no
// real model is called.
//
// The questions are the recorded scan's: open split questions, which the worker researches. Four bundles are served the recorded page that
// says "Includes DCK200D1P1 and DCF921B." (as in ask-ai.spec), and their questions are given that reading after the scan, so the fake model
// can quote the page for them: three it answers verifiably (the first, the second and the sixth question); the third it quotes wrongly, so
// the code finds the quote missing (unverified). RYOBI PCL500525SB (offers no reading) it researches: it reads the page and two searches and
// answers PCL500B + PCL525B, the answer key's. Every other question it cannot tell. The queue asks them in the store's order, so a Stop
// after the fourth leaves the sixth for a second pass.

const SHOTS = process.env.SPLIT_FINDER_SHOTS === '1';
const DIR = 'qa-shots/';
const T1 = '320243741';
const T2 = '324903619';
/** Quoted wrongly: the AI's answer is unverified. */
const T3 = '324904496';
/** The sixth question in the order they are asked. */
const T4 = '341644756';
/** RYOBI PCL500525SB: no reading to choose from; research finds its parts. */
const PCL = '328690510';
const TARGETS = [T1, T2, T3, T4];
const READING = ['DCK200D1P1', 'DCF921B'];
const PCL_ANSWER = 'PCL500B,PCL525B';

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

const INCLUDES = 'Includes DCK200D1P1 and DCF921B.';
/** The third question's bundle model, as the prompt gives it (the recorded scan's). */
const T3_MODEL = 'Bundle model number: PCL1201K2-PCL430B';
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const turn = (...content: unknown[]) => ({ stopReason: 'tool_use' as const, content });
const submit = (input: unknown) => turn(use('toolu_submit', 'submit_answer', input));
/** The research answer for PCL500525SB as a model might give it: each part named by a Home Depot search row and by the bundle's own words. */
const PCL_PARTS = {
  quotes: [], decision: 'parts', choiceIndex: null, reason: 'The two tools, as Home Depot sells them alone.',
  parts: [
    { model: 'PCL500B', qty: 1, quotes: [
      { quote: 'RYOBI PCL500B (item 317987588): ONE+ 18V Cordless 5 1/2 in. Circular Saw (Tool Only)', sourceId: 'hd-search:ryobi-pcl500' },
      { quote: '18V 5-1/2" Circular Saw', sourceId: 'hd-page:328690510' }, { quote: '18T Carbide Tipped Blade', sourceId: 'hd-page:328690510' },
      { quote: '(2) Hex Wrenches', sourceId: 'bundle' },
    ] },
    { model: 'PCL525B', qty: 1, quotes: [
      { quote: 'RYOBI PCL525B (item 318898528): ONE+ 18V Cordless Jig Saw (Tool Only)', sourceId: 'hd-search:ryobi-jig-saw-tool-only' },
      { quote: '18V Jig Saw', sourceId: 'hd-page:328690510' }, { quote: 'Non-Marring Shoe', sourceId: 'hd-page:328690510' },
      { quote: 'T-Shank Wood Cutting Blade', sourceId: 'hd-page:328690510' },
    ] },
  ],
};
/**
 * What the fake research model does, a turn at a time (the turn is how many times it has spoken): for PCL500525SB it reads the page and two
 * Home Depot searches and then submits the parts; for three questions with the served page it quotes the page's own sentence; for the
 * third it quotes a sentence the page does not have; for the rest it cannot tell.
 */
const researchSays = (body: { messages: { role: string; content: unknown }[] }) => {
  const user = String(body.messages[0]!.content);
  const spoken = body.messages.filter((m) => m.role === 'assistant').length;
  if (user.includes(`Bundle Home Depot item id: ${PCL}`)) {
    return [
      turn(use('t1', 'read_homedepot_page', { itemId: PCL, url: null })),
      turn(use('t2', 'search_homedepot', { query: 'ryobi pcl500' }), use('t3', 'search_homedepot', { query: 'ryobi jig saw tool only' })),
      submit(PCL_PARTS),
    ][spoken];
  }
  const reading = /<reading index="(\d+)">DCK200D1P1, DCF921B<\/reading>/.exec(user);
  if (reading && user.includes(INCLUDES)) {
    const quote = user.includes(T3_MODEL) ? 'Includes DCK200D1P1 and a battery the page never mentions.' : INCLUDES;
    return submit({ quotes: [{ quote, sourceId: 'bundle' }], parts: [], reason: 'The page says it includes both.', decision: 'choose', choiceIndex: Number(reading[1]) });
  }
  return submit({ quotes: [], parts: [], reason: 'The page does not say which parts are in the kit.', decision: 'cannot_tell', choiceIndex: null });
};

/** Scans until the four bundles' pages have been read, gives their questions the reading the served page names, then turns on the research routes and the model. */
async function seedAndScan(options: Page, worker: Worker, server: ReplayServer): Promise<void> {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  for (const id of TARGETS) server.servePageAs(id, '337440459');
  for (let i = 0; i < 8 && ![...TARGETS, PCL].every((id) => server.pageRequests.includes(id)); i++) await scanAndWait(options);
  for (const id of [...TARGETS, PCL]) expect(server.pageRequests).toContain(id);
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
  // From here on Home Depot's pages and searches are the research recordings, and the model is the script above.
  server.serveResearchPages(true);
  server.setResearchReply(researchSays);
}

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

  // With the key, in its own row above Accept all, saying how many and about what it costs. Every open question is a split question that research can answer.
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  await expect(askAllButton(panel)).toHaveAccessibleName(/^Ask AI about all \d+ · about \$\d+(\.\d\d)?$/);
  const TOTAL = await countIn(panel, /^Ask AI about all/);
  expect(TOTAL).toBeGreaterThanOrEqual(8);
  expect((await send(options, { type: 'getReport' })).data.review).toHaveLength(TOTAL);
  // The words are in the word face and only the price is a figure.
  await expect(askAllButton(panel).locator('.figure')).toHaveText(/^\$\d+(\.\d\d)?$/);
  expect(await askAllButton(panel).evaluate((el) => el.textContent)).toMatch(/^Ask AI about all \d+ · about \$/);
  // The Ask AI row comes first: above Accept all.
  const askAt = (await askAllButton(panel).boundingBox())!;
  const acceptAt = (await panel.getByRole('button', { name: /^Accept all/ }).boundingBox())!;
  expect(askAt.y).toBeLessThan(acceptAt.y);
  expect(server.assistCalls).toEqual([]);

  // Ask about all of them, slowly enough to see the row and to stop it.
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

  // Stop, once four questions are done (the fourth is the researched one): the fifth is out.
  await expect.poll(async () => (await getState(options)).data.askAll?.done ?? 0, { timeout: 60_000, intervals: [100] }).toBeGreaterThanOrEqual(4);
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(async () => (await getState(options)).data.askAll ?? null, { timeout: 30_000, intervals: [100] }).toBeNull();
  const result = (await getState(options)).data.askAllResult!;
  // Verified so far: the first two and the researched parts.
  expect(result).toMatchObject({ stopped: true, total: TOTAL, verified: 3 });
  expect(result.asked).toBeGreaterThanOrEqual(4);
  expect(result.asked).toBeLessThan(TOTAL - 1);
  // The sentence belongs to the Ask AI row and goes once the section shows the results: it is not left between sections.
  await expect(panel.getByRole('status').filter({ hasText: 'Stopped after' })).toHaveCount(0);
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
  await expect(section.getByRole('heading', { name: 'AI suggestions · 3' })).toBeVisible();
  await expect(section.getByRole('listitem')).toHaveCount(3);
  await expect(section.getByText(INCLUDES)).toHaveCount(2);
  // The researched one proposes parts no reading offered, with the Home Depot search row that names each as its quote.
  await expect(section.getByText('PCL500B + PCL525B')).toBeVisible();
  await expect(section.getByRole('link', { name: 'Home Depot page' }).first()).toHaveAttribute('target', '_blank');
  // One line each: a name longer than the panel is cut, not wrapped.
  expect(await section.locator('.ai-row-name').evaluateAll((els) => els.every((el) => el.scrollHeight <= el.clientHeight + 1))).toBe(true);
  await expect(panel.getByRole('button', { name: 'Approve all 3 verified' })).toBeVisible();
  // Review reads in order: the Ask AI row, the suggestions, the Accept all block, then the questions.
  const at = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y;
  const askY = await at(askAllButton(panel));
  const sectionY = await at(section.getByRole('heading'));
  const approveY = await at(panel.getByRole('button', { name: 'Approve all 3 verified' }));
  // In the section's own header, on the title's line.
  expect(Math.abs(approveY - sectionY)).toBeLessThan(16);
  expect(askY).toBeLessThan(sectionY);
  const acceptBlock = panel.getByRole('heading', { name: /bundles have one suggested answer/ });
  if (await acceptBlock.count()) expect(await at(acceptBlock)).toBeGreaterThan(sectionY);
  expect(await at(panel.getByText(/^\d+ of \d+$/))).toBeGreaterThan(sectionY);
  for (const width of [360, 480]) await shoot(panel, 'review-ai-section', width, () => panel.evaluate(() => window.scrollTo(0, 0)));

  // Ask about the rest: a question with a suggestion is not asked twice.
  const before = server.assistCalls.length;
  const left = await countIn(panel, /^Ask AI about all/);
  expect(left).toBe(TOTAL - result.asked);
  await askAllButton(panel).click();
  await expect.poll(async () => (await getState(options)).data.askAllResult?.stopped, { timeout: 60_000, intervals: [100] }).toBe(false);
  expect(server.assistCalls.length - before).toBe(left);
  a = await audit(options);
  expect(a.aiSuggestions).toHaveLength(TOTAL);
  const verifiedIds = a.aiSuggestions.filter((r: { suggestion: { status: string } }) => r.suggestion.status === 'verified').map((r: { questionId: string }) => idOf(r.questionId));
  expect(verifiedIds.sort()).toEqual([T1, T2, T4, PCL].sort());
  await expect(section.getByRole('heading', { name: 'AI suggestions · 4' })).toBeVisible();
  // Accept all has nothing left to answer: every other question the AI has spoken on.
  await expect(panel.getByRole('button', { name: /^Accept all/ })).toHaveCount(0);
  // Nothing about the key anywhere in what was kept (the trace holds each source's name and link only).
  expect(JSON.stringify(a)).not.toContain(ANTHROPIC_KEY);

  // The researched suggestion open: its parts, the search rows and the bundle's words as quotes, each with its source.
  await section.getByRole('button', { name: /PCL500B \+ PCL525B/ }).click();
  const block = section.getByRole('group', { name: 'AI suggestion' });
  await expect(block.getByText('PCL500B + PCL525B')).toBeVisible();
  await expect(section.getByRole('radio', { name: 'Enter the parts' })).toBeChecked();
  await expect(section.getByRole('textbox')).toHaveValue('PCL500B, PCL525B');
  await expect(section.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await shoot(panel, 'research-parts', 360, () => block.scrollIntoViewIfNeeded());
  await section.getByRole('button', { name: /PCL500B \+ PCL525B/ }).first().click();

  // Approve all asks first. Nothing is saved by the first press.
  await panel.getByRole('button', { name: 'Approve all 4 verified' }).click();
  await expect(section.locator('.ai-confirm-q')).toHaveText('Approve 4 AI answers?');
  await expect(section.getByRole('button', { name: 'Approve', exact: true })).toBeFocused();
  expect(await answered(options)).toEqual({});
  await shoot(panel, 'review-ai-approve-all-confirm', 360, () => panel.evaluate(() => window.scrollTo(0, 0)));
  // Cancel changes nothing.
  await section.getByRole('button', { name: 'Cancel' }).click();
  expect(await answered(options)).toEqual({});
  await panel.getByRole('button', { name: 'Approve all 4 verified' }).click();
  await section.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(panel.getByText('Approved 4 of 4.')).toBeVisible();

  // Exactly the verified ones are answered, with the parts the page named or the research found, and each is recorded as an AI approval.
  expect(await answered(options)).toEqual({ [T1]: READING.join(','), [T2]: READING.join(','), [T4]: READING.join(','), [PCL]: PCL_ANSWER });
  a = await audit(options);
  const outcomes = a.aiSuggestions
    .filter((r: { agreed: boolean | null }) => r.agreed !== null)
    .map((r: { questionId: string; agreed: boolean }) => [idOf(r.questionId), r.agreed]);
  expect(outcomes.sort()).toEqual([[T1, true], [T2, true], [T4, true], [PCL, true]].sort());
  await expect(panel.getByRole('region', { name: /AI suggestions/ })).toHaveCount(0);
  // The third question, whose quote the code could not find, was not approved: it is still open, with its block and nothing preselected.
  const open = (await send(options, { type: 'getReport' })).data.review as Item[];
  expect(open.map((q) => idOf(q.id))).toContain(T3);
  expect(open).toHaveLength(TOTAL - 4);
  expect(seen.console.filter((c) => !c.includes('status of 403') && !c.includes('status of 404'))).toEqual([]);
  expect(JSON.stringify(a)).not.toContain(ANTHROPIC_KEY);
});

test('Ask AI about all stops after three researches in a row that ran past their limits, and says so in its row', async ({ context, extensionId, options, server, worker }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  // A model that only ever pauses: each question runs to its request limit, which is no provider error.
  server.setResearchReply(() => ({ stopReason: 'pause_turn', content: [] }));
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  const TOTAL = await countIn(panel, /^Ask AI about all/);
  await askAllButton(panel).click();
  await expect.poll(async () => (await getState(options)).data.askAllResult?.problem ?? null, { timeout: 120_000, intervals: [200] }).toMatch(/limit/);
  const result = (await getState(options)).data.askAllResult!;
  expect(result.stopped).toBe(false);
  // Three questions of twelve requests each, and no fourth.
  expect(server.researchRequests).toHaveLength(3);
  expect(TOTAL).toBeGreaterThan(3);
  const line = panel.getByRole('status').filter({ hasText: 'Asking stopped' });
  await expect(line).toContainText(`Asking stopped after ${result.asked} of ${TOTAL}: The research ran past its limits on three questions in a row.`);
  // The sentence is in the Ask AI row, under its button.
  expect(await line.evaluate((el, id) => el.previousElementSibling === document.querySelector(id), '.ask-all')).toBe(true);
  expect(await answered(options)).toEqual({});
  await shoot(panel, 'review-ask-all-limits', 360, () => panel.evaluate(() => window.scrollTo(0, 0)));
});

test('Ask AI about all stops when it has cost more than twice its estimate, and nothing is applied', async ({ context, extensionId, options, server, worker }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  // Each answer reports three million tokens in: a few dollars, against an estimate of cents.
  server.setResearchUsage({ input_tokens: 3_000_000, output_tokens: 1000 });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  const TOTAL = await countIn(panel, /^Ask AI about all/);
  await askAllButton(panel).click();
  await expect.poll(async () => (await getState(options)).data.askAllResult?.overspent ?? null, { timeout: 60_000, intervals: [200] }).toBe(true);
  const result = (await getState(options)).data.askAllResult!;
  expect(result.asked).toBeLessThan(TOTAL);
  expect(server.researchRequests.length).toBeLessThan(TOTAL);
  await expect(panel.getByRole('status').filter({ hasText: 'Stopped: asking cost more than expected' })).toHaveText(`Stopped: asking cost more than expected ($${result.costUsd.toFixed(2)}). Nothing was applied.`);
  expect(await answered(options)).toEqual({});
  await shoot(panel, 'review-ask-all-over-cost', 360, () => panel.evaluate(() => window.scrollTo(0, 0)));
});

test('Approve all applies the rows it asked about: one that became verified while the question was open is left', async ({ context, extensionId, options, server, worker }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  // Two questions the fake model verifies, asked on their own; the panel lists them as rows.
  for (const id of [T1, T2]) expect(await send(options, { type: 'askAi', questionId: `split:homedepot:${id}` })).toMatchObject({ ok: true });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  const section = panel.getByRole('region', { name: /AI suggestions/ });
  await expect(section.getByRole('heading', { name: 'AI suggestions · 2' })).toBeVisible();
  await panel.getByRole('button', { name: 'Approve all 2 verified' }).click();
  await expect(section.locator('.ai-confirm-q')).toHaveText('Approve 2 AI answers?');
  // While the question is open a third question comes back verified.
  expect(await send(options, { type: 'askAi', questionId: `split:homedepot:${T4}` })).toMatchObject({ ok: true });
  await expect(section.getByRole('heading', { name: 'AI suggestions · 3' })).toBeVisible();
  await expect(section.locator('.ai-confirm-q')).toHaveText('Approve 2 AI answers?');
  await section.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(panel.getByText('Approved 2 of 2.')).toBeVisible();
  expect(await answered(options)).toEqual({ [T1]: READING.join(','), [T2]: READING.join(',') });
  // The late one is still a row, waiting for its own press.
  await expect(section.getByRole('button', { name: 'Approve all 1 verified' })).toBeVisible();
});

test('Research reads Home Depot only while no scan runs, and its tools never reach SerpApi or Amazon', async ({ options, server, worker }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  const searchesBefore = server.searches.length;
  const pagesBefore = server.pageRequests.length;
  server.delayAssist(600);
  const asking = send(options, { type: 'askAi', questionId: `split:homedepot:${PCL}` });
  // While the one question is being researched, a scan is refused: the doorway tab is not shared.
  await expect.poll(() => server.researchRequests.length, { timeout: 30_000, intervals: [50] }).toBeGreaterThan(0);
  expect(await send(options, { type: 'scanNow' })).toMatchObject({ ok: false, error: 'Asking AI is running. Stop it first, or wait for it to finish.' });
  expect(await asking).toMatchObject({ ok: true });
  // It read the bundle's page and two searches in the owner's browser, and nothing went to SerpApi.
  // (the doorway tab loads the page, then the tool fetches it from inside the tab: two requests for the one read)
  expect([...new Set(server.pageRequests.slice(pagesBefore))]).toEqual([PCL]);
  expect(server.searches.length).toBe(searchesBefore);
  const [record] = (await audit(options)).aiSuggestions.filter((r: { questionId: string }) => idOf(r.questionId) === PCL);
  expect(record.suggestion.reasons ?? []).toEqual([]);
  expect(record.suggestion).toMatchObject({ status: 'verified', answer: { decision: 'parts', parts: ['PCL500B', 'PCL525B'] }, research: { toolCalls: 3 } });
  // What is kept of the trace is each source's name and link, not the pages' text.
  expect(record.suggestion.research.ledger.every((e: { lines: unknown[] }) => e.lines.length === 0)).toBe(true);
  expect(await answered(options)).toEqual({});
});

test('Accept all still answers the questions the AI has not been asked about', async ({ context, extensionId, options, server, worker }) => {
  test.setTimeout(300_000);
  await seedAndScan(options, worker, server);
  expect(await send(options, { type: 'saveAnthropicKey', apiKey: ANTHROPIC_KEY })).toMatchObject({ ok: true });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  const all = await countIn(panel, /^Accept all/);
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
  // The scan runs and the queue starts after it; nothing is answered by the AI.
  await scanAndWait(options);
  await expect.poll(async () => (await getState(options)).data.askAllResult?.stopped, { timeout: 120_000, intervals: [200] }).toBe(false);
  const result = (await getState(options)).data.askAllResult!;
  expect(result.total).toBeGreaterThan(0);
  expect(server.assistCalls.length).toBeGreaterThan(before);
  expect(server.assistCalls.length - before).toBeLessThanOrEqual(result.total);
  // The only answers are the scan's own closing of a question its page now settles.
  expect(Object.values(await answered(options)).every((a) => a === 'resolved by a later scan')).toBe(true);
});
