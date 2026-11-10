import type { Page } from '@playwright/test';
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
  expect(seen.console).toEqual([]);
});
