import { expect, saveKey, test } from './fixtures';

/** Lane D P5: when the app is primary, the helper panel defers scan to the app. */
test('side panel shows Open app when appPrimaryUi is on', async ({ context, extensionId, options }) => {
  await saveKey(options, 'TEST');
  await expect(options.getByTestId('key-result')).toContainText('Key works.');

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ appPrimaryUi: true });
  });
  await panel.reload();
  await expect(panel.getByRole('button', { name: 'Open app' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Scan now' })).toHaveCount(0);
});