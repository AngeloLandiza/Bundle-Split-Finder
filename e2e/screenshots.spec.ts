import type { Page } from '@playwright/test';
import { expect, saveKey, test } from './fixtures';

const DIR = '/private/tmp/claude-501/-Users-angelolandiza-Developer-GitHub-Bundle-Split-Finder/746879c5-93f9-4d1e-8b5d-377e14737cb3/scratchpad/settings-shots/';
const WIDTHS = [1280, 600];

async function shoot(page: Page, state: string): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${DIR}${state}-${width}.png`, fullPage: true });
  }
}

const commit = async (page: Page, label: string, value: string) => {
  const field = page.getByLabel(label);
  await field.fill(value);
  await field.blur();
};

test('settings page screenshots', async ({ options }) => {
  await expect(options.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await shoot(options, 'no-key');

  await saveKey(options, 'WRONG');
  await expect(options.getByTestId('key-result')).toHaveText('SerpApi did not accept this key.');
  await shoot(options, 'key-refused');

  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');
  await shoot(options, 'key-works');

  await options.getByLabel('Every 6 hours').check();
  await commit(options, 'Searches per scan, at most', '1');
  await expect(options.getByTestId('forecast')).toContainText('This fits your plan');
  await shoot(options, 'schedule-fits');

  await options.getByLabel('Hours between scans').fill('1');
  await commit(options, 'Searches per scan, at most', '50');
  await expect(options.getByTestId('forecast')).toContainText('This needs');
  await shoot(options, 'schedule-too-big');

  await commit(options, 'Searches per scan, at most', '');
  await expect(options.getByTestId('save-status')).toContainText('Not saved');
  await shoot(options, 'invalid-field');

  await commit(options, 'Searches per scan, at most', '1');
  await options.getByRole('button', { name: 'Clear saved searches' }).click();
  await expect(options.getByRole('button', { name: 'Yes, clear' })).toBeVisible();
  await shoot(options, 'clear-confirm');
});
