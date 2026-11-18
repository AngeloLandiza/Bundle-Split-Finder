// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AppState, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { getShowChip } from '../../lib/prefs';
import { AlertsSection } from './OtherSections';
import { SettingsPage } from './SettingsPage';

beforeEach(() => fakeBrowser.reset());
afterEach(cleanup);

const LABEL = 'Show the chip on Home Depot pages';

const state: AppState = {
  hasKey: false, account: null, accountCheckedAt: null, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null,
};
const api: WorkerApi = {
  send: (async (r: Request): Promise<Reply> => (r.type === 'getState' ? { ok: true, data: state } : { ok: true, data: null })) as WorkerApi['send'],
  onStateChanged: () => () => {},
  download: vi.fn(),
};

describe('Show the chip on Home Depot pages', () => {
  it('is a checkbox in Alerts, on by default, and saves on change with no Save button', async () => {
    const user = userEvent.setup();
    render(createElement(SettingsPage, { api }));
    const alerts = (await screen.findByRole('heading', { name: 'Alerts' })).closest('section')!;
    const box = await screen.findByLabelText(LABEL);
    expect(alerts).toContainElement(box);
    expect(box).toBeChecked();
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();

    await user.click(box);
    expect(box).not.toBeChecked();
    await waitFor(async () => expect(await getShowChip()).toBe(false));
    // storage.sync, where the content script can read it; the key's storage.local is not touched.
    expect(await fakeBrowser.storage.local.get('showChip')).toEqual({});

    await user.click(box);
    await waitFor(async () => expect(await getShowChip()).toBe(true));
  });

  it('shows a stored off', async () => {
    await fakeBrowser.storage.sync.set({ showChip: false });
    render(createElement(SettingsPage, { api }));
    await waitFor(async () => expect(await screen.findByLabelText(LABEL)).not.toBeChecked());
  });

  it('puts the box back and says so when the save fails', async () => {
    const user = userEvent.setup();
    const chip = { get: async () => true, set: () => Promise.reject(new Error('quota')) };
    render(createElement(AlertsSection, { draft: DEFAULT_SETTINGS, problems: {}, onChange: () => {}, onCommit: () => {}, chip }));
    const box = await screen.findByLabelText(LABEL);
    await user.click(box);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not saved. Try again.'));
    expect(box).toBeChecked();
  });
});
