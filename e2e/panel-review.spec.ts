import type { Page } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

const DIR = 'test-results/panel/';
const WIDTHS = [360, 480];

async function shoot(panel: Page, name: string): Promise<void> {
  for (const width of WIDTHS) {
    await panel.setViewportSize({ width, height: 820 });
    await panel.waitForTimeout(150);
    await panel.screenshot({ path: `${DIR}review-${name}-${width}.png` });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
}

const lastJobId = async (page: Page): Promise<string | null> => (await getState(page)).data.lastJob?.id ?? null;

/** Waits for a scan that is over and is a new one: the last job's id has changed, so a scan that never started cannot pass. */
async function scanDone(page: Page, was: string | null): Promise<void> {
  await expect
    .poll(async () => {
      const { scanRunning, lastJob } = (await getState(page)).data;
      return !scanRunning && lastJob?.id !== undefined && lastJob.id !== was;
    }, { timeout: 60_000, intervals: [100] })
    .toBe(true);
}

async function scanAndWait(page: Page): Promise<void> {
  const was = await lastJobId(page);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await scanDone(page, was);
}

test('review tab, empty before any scan', async ({ context, extensionId, options }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  await expect(panel.getByText('Nothing needs your answer.')).toBeVisible();
  await shoot(panel, 'empty');
});

test('review tab, a split question after a replayed scan, answered', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  const current = (await getState(options)).data as unknown as { settings: Record<string, unknown> };
  const settings = { ...current.settings, searchesPerScan: 5 };
  expect(await options.evaluate((s) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: s }), settings)).toMatchObject({ ok: true });
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  await expect(panel.getByText(/^1 of \d+$/)).toBeVisible();
  await expect(panel.locator('legend', { hasText: 'Which parts come in this bundle?' })).toBeVisible();
  await shoot(panel, 'split');

  const count = Number((await panel.getByText(/^1 of \d+$/).textContent())!.replace('1 of ', ''));
  await panel.getByRole('radio', { name: 'None of these' }).check();
  await panel.getByRole('button', { name: 'Save answer' }).click();
  await expect(panel.getByText(`2 of ${count}`)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toBeDisabled();

  // This replay leaves no match question, so there is no review-match screenshot.
  expect(await panel.getByRole('group', { name: /Which Amazon listing/ }).count()).toBe(0);
});

type ReviewRow = { id: string; kind: string; choices: string[][] };
const reviewRows = async (page: Page): Promise<ReviewRow[]> =>
  (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'getReport' }))).data.review;

test('review tab, an answered question does not come back after the next scan', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.refuse('*');
  await scanAndWait(options);
  const before = await reviewRows(options);
  expect(before.length).toBeGreaterThan(1);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  await expect(panel.getByText(`1 of ${before.length}`)).toBeVisible();
  await panel.getByRole('radio', { name: 'None of these' }).check();
  await panel.getByRole('button', { name: 'Save answer' }).click();
  await expect(panel.getByText(`2 of ${before.length}`)).toBeVisible();

  const was = await lastJobId(options);
  await panel.getByRole('button', { name: 'Scan now' }).click();
  await scanDone(options, was);
  const after = await reviewRows(options);
  expect(after.map((r) => r.id)).not.toContain(before[0]!.id);
  // The scan may also close questions of its own, so the count drops by at least the one answered.
  expect(after.length).toBeLessThanOrEqual(before.length - 1);
  expect(after.length).toBeGreaterThan(0);

  await panel.reload();
  await panel.getByRole('button', { name: /^Review/ }).click();
  await expect(panel.getByText(`1 of ${after.length}`)).toBeVisible();
});

test('review tab, a split question with two real choices', async ({ context, extensionId, options, server, worker }) => {
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
          tx.objectStore('catalog').put({
            key: 'DEWALT:DCB606', brand: 'DEWALT', model: 'DCB606', title: 'DCB606 (seeded for this test)', kinds: ['battery'], isKit: false, upc: null, seenAt: Date.now(),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  // 337440461 (DCK200D1P1WB606) reads as DCB606 from its model number; its page, here the recorded page of 337440459, says DCF921B.
  server.servePageAs('337440461', '337440459');
  // A scan reads only a few pages; scan again until the page of 337440461 has been read.
  for (let i = 0; i < 6 && !server.pageRequests.includes('337440461'); i++) await scanAndWait(options);
  expect(server.pageRequests).toContain('337440461');
  const wanted = (await reviewRows(options)).find((r) => r.id === 'split:homedepot:337440461');
  expect(wanted?.choices.map((c) => c.join(' + '))).toEqual(['DCK200D1P1 + DCB606', 'DCK200D1P1 + DCF921B']);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  // Older questions come first; answer them until this one is shown.
  for (let i = 0; i < 20 && (await panel.getByText('DCK200D1P1 + DCF921B').count()) === 0; i++) {
    await panel.getByRole('radio', { name: 'None of these' }).check();
    await panel.getByRole('button', { name: 'Save answer' }).click();
    // Wait for the next question before looking again.
    await expect(panel.getByText(new RegExp(`^${i + 2} of `))).toBeVisible();
  }
  await expect(panel.getByRole('radio', { name: 'DCK200D1P1 + DCB606' })).toBeVisible();
  await panel.getByRole('radio', { name: 'DCK200D1P1 + DCF921B' }).check();
  await shoot(panel, 'choices');
});

test('review tab, a scan is running: Save answer is disabled and says why', async ({ context, extensionId, options, server }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.refuse('*');
  await scanAndWait(options);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole('button', { name: /^Review/ }).click();
  await panel.getByRole('radio', { name: 'None of these' }).check();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toBeEnabled();

  // Each search waits, so the scan is still running when the panel is photographed.
  server.delaySearches(20_000);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
  await expect(panel.getByText('A scan is running. Answer when it has finished.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save answer' })).toBeDisabled();
  await shoot(panel, 'scanning');

  const was = await lastJobId(options);
  await panel.getByRole('button', { name: 'Stop' }).click();
  server.delaySearches(0);
  // The scan that was running has ended (stopped), and is the one the state now reports.
  await expect.poll(async () => (await getState(options)).data.scanRunning, { timeout: 60_000, intervals: [100] }).toBe(false);
  expect(await lastJobId(options)).toBe(was);
});
