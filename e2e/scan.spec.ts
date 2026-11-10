import type { Page, Worker } from '@playwright/test';
import { expect, getState, saveKey, test } from './fixtures';

async function scanAndWait(page: Page): Promise<unknown> {
  const started = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'scanNow' }));
  await expect
    .poll(async () => (await getState(page)).data.scanRunning, { timeout: 60_000, intervals: [250] })
    .toBe(false);
  return started;
}

// Default settings: 5 searches a scan, and one Amazon catalog page a scan (DEFAULT_SCAN_SETTINGS).
// So the recorded run of `npm run scan -- --fixtures` (which asks for two catalog pages) takes two scans here.
// A third scan would ask for the next catalog page, which is not recorded; this spec stops before it.
test('the first scan sends the listing pages, the second what the first left, and every request is recorded', async ({
  options,
  server,
  seen,
}) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.reset();
  // This spec is about the listing and catalog pages. With every bundle page refused the splits come from the
  // titles alone, as before; the page reads have their own specs below.
  server.refuse('*');

  expect(await scanAndWait(options)).toMatchObject({ ok: true });
  const state1 = (await getState(options)).data;
  console.log('scan 1', JSON.stringify({ counts: server.counts, searches: server.searches, status: state1.lastJob?.status }));
  expect(state1.problem).toBeNull();
  expect(state1.lastJob?.status).toBe('done');
  expect([...server.searches].sort()).toEqual([
    'amazon_domain=amazon.com&engine=amazon&k=DEWALT&rh=p_123:195991',
    'engine=home_depot&page=1&q=dewalt 20v combo kit',
    'engine=home_depot&page=1&q=ryobi 18v combo kit',
  ]);
  expect(server.misses).toEqual([]);
  expect(server.counts['/search.json']).toBe(3);

  server.reset();
  server.refuse('*');
  expect(await scanAndWait(options)).toMatchObject({ ok: true });
  const state2 = (await getState(options)).data;
  console.log('scan 2', JSON.stringify({ counts: server.counts, searches: server.searches, status: state2.lastJob?.status }));
  expect(state2.problem).toBeNull();
  expect(state2.lastJob?.status).toBe('done');
  expect([...server.searches].sort()).toEqual([
    'amazon_domain=amazon.com&engine=amazon&k=RYOBI PCL1201K2',
    'amazon_domain=amazon.com&engine=amazon&k=RYOBI&rh=p_123:252605',
  ]);
  expect(server.misses).toEqual([]);

  // None of the five listing or catalog pages is asked for twice: the saved responses answer them.
  // Chrome logs each refused fetch in the tab; that is the refusal this run asked for.
  expect(seen.console.filter((c) => !c.includes('status of 403'))).toEqual([]);
});

// Bundle 337440459 (DEWALT DCK200D1P1W921B) is on the recorded page 1 of the default DEWALT query. Its page is
// in fixtures/homedepot-pages. The reader opens one background tab on the replay server's /p/<id>, so this also
// proves the function run in the tab survives the production bundler.
interface Stored {
  page: unknown;
  split: { components: string[]; status: string } | null;
}
const BUNDLE = '337440459';

function storedBundle(worker: Worker, itemId: string): Promise<Stored | undefined> {
  return worker.evaluate(
    (key) =>
      new Promise<Stored | undefined>((resolve, reject) => {
        const open = indexedDB.open('split-finder');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const get = open.result.transaction('bundles').objectStore('bundles').get(key);
          get.onerror = () => reject(get.error);
          get.onsuccess = () => resolve(get.result as Stored | undefined);
        };
      }),
    `homedepot:${itemId}`,
  );
}

/** Tabs and windows that are not the extension's own pages. */
function strayTabs(worker: Worker): Promise<string[]> {
  return worker.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.url || t.pendingUrl || '(blank)').filter((u) => !u.startsWith('chrome-extension://')));
}

test('a scan reads a bundle page through a background tab, stores its split and leaves no tab open', async ({ options, server, seen, worker }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.reset();
  const before = await strayTabs(worker);

  await scanAndWait(options);
  expect(server.pageRequests).toContain(BUNDLE);
  const stored = await storedBundle(worker, BUNDLE);
  expect(stored?.page).toBeTruthy();
  expect(stored?.split?.status).toBe('resolved');
  expect([...(stored?.split?.components ?? [])].sort()).toEqual(['DCF921B', 'DCK200D1P1']);
  expect(await strayTabs(worker)).toEqual(before);
  // The split names two parts that have no recorded Amazon search, so the replay answers their lookups with its 404.
  expect(server.misses.length).toBeGreaterThan(0);
  expect(seen.console).toEqual([]);
});

test('a refused page does not stop the scan, and its bundle is left unread', async ({ options, server, worker }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  server.reset();
  server.refuse(BUNDLE);
  const before = await strayTabs(worker);

  await scanAndWait(options);
  const state = (await getState(options)).data;
  expect(state.lastJob?.status).toBe('done');
  expect(server.pageRequests).toContain(BUNDLE);
  const stored = await storedBundle(worker, BUNDLE);
  expect(stored).toBeDefined();
  expect(stored?.page ?? null).toBeNull();
  expect(await strayTabs(worker)).toEqual(before);
});
