import { expect, test } from './fixtures';

test('Open settings with no key opens options.html as a tab where the key can be entered and saved', async ({ context, extensionId, server }) => {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const opened = context.waitForEvent('page');
  await panel.getByRole('button', { name: 'Open settings' }).click();
  const settings = await opened;
  await settings.waitForLoadState();
  expect(settings.url()).toBe(`chrome-extension://${extensionId}/options.html`);

  // A tab, not the embedded dialog: the key field is on screen and takes input.
  const field = settings.getByLabel('API key');
  await expect(field).toBeVisible();
  expect(await field.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
  await field.fill('TEST');
  await settings.getByRole('button', { name: 'Check key' }).click();
  await expect(settings.getByTestId('key-result')).toContainText('Key works.');
  await settings.reload();
  await expect(settings.getByPlaceholder('Key saved')).toBeVisible();
  expect(server.counts['/account.json']).toBe(1);
});
