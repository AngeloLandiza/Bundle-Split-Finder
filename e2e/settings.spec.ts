import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_PORT } from '../wxt.config';
import { EXTENSION_DIR, expect, saveKey, test } from './fixtures';

test('first run: no key, first-run text, no request', async ({ options, server, seen }) => {
  await expect(options.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(options.getByText('through your own SerpApi account')).toBeVisible();
  await expect(options.getByTestId('key-result')).toHaveText('');
  await expect(options.getByRole('button', { name: 'Check key' })).toBeDisabled();
  await options.waitForTimeout(1500);
  expect(server.counts).toEqual({});
  expect(seen.console).toEqual([]);
});

test('a refused key shows the sentence and saves nothing', async ({ options, server }) => {
  await saveKey(options, 'WRONG');
  await expect(options.getByTestId('key-result')).toHaveText('SerpApi did not accept this key.');
  expect(server.counts['/account.json']).toBe(1);
  await options.reload();
  await expect(options.getByPlaceholder('Key saved')).toHaveCount(0);
});

test('a working key shows the plan line and survives a reload', async ({ options, server }) => {
  await saveKey(options, 'TEST');
  const result = options.getByTestId('key-result');
  await expect(result).toContainText('Key works.');
  await expect(result).toContainText('Free Plan');
  await expect(result).toContainText('250 of 250 searches left this month');
  await expect(result).toContainText('50 an hour');
  expect(server.counts).toEqual({ '/account.json': 1 });
  await options.reload();
  await expect(options.getByPlaceholder('Key saved')).toBeVisible();
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
});

test('Every 6 hours with 5 per scan does not fit and says what does; with 1 per scan it fits and survives a reload', async ({ options }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await options.getByLabel('Every 6 hours').check();
  const perScan = options.getByLabel('Searches per scan, at most');
  // 120 scans a month x 5 = 600, and the plan has 250 less the 100 reserve.
  await expect(options.getByTestId('forecast')).toContainText('This needs 600 searches a month and your plan has 150 to spend. Use 1 per scan');
  await perScan.fill('1');
  await perScan.blur();
  await expect(options.getByTestId('forecast')).toContainText('This fits your plan');
  await expect(options.getByTestId('save-status')).toHaveText('Changes save as you make them');
  await options.waitForTimeout(500);
  await options.reload();
  await expect(options.getByLabel('Every 6 hours')).toBeChecked();
  await expect(options.getByLabel('Searches per scan, at most')).toHaveValue('1');
  await expect(options.getByTestId('forecast')).toContainText('This fits your plan');
});

test('worker facts: key access level, tick alarm, no console errors', async ({ worker, options, seen }) => {
  const facts = await worker.evaluate(async () => {
    const area = chrome.storage.local as unknown as { setAccessLevel?: unknown };
    const alarm = await chrome.alarms.get('tick');
    return { hasSetAccessLevel: typeof area.setAccessLevel === 'function', tick: alarm ? alarm.periodInMinutes : null };
  });
  console.log('worker facts', JSON.stringify(facts));
  expect(facts.tick).toBe(1);
  expect(facts.hasSetAccessLevel).toBe(true);
  await expect(options.getByRole('heading', { name: 'Settings' })).toBeVisible();
  expect(seen.console).toEqual([]);
});

test('the built bundle talks only to the local replay server', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toEqual(['https://serpapi.com/*', 'https://www.homedepot.com/*', 'http://localhost/*']);
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const background = readFileSync(join(EXTENSION_DIR, 'background.js'), 'utf8');
  expect(background).toContain(`http://localhost:${E2E_PORT}`);
  // The page reader's origin is the replay server here, and its debug handle is not in the build.
  expect(manifest.permissions).toContain('scripting');
  expect(background).not.toContain('splitFinderReadPages');
  expect(files(EXTENSION_DIR).length).toBeGreaterThan(0);
});
