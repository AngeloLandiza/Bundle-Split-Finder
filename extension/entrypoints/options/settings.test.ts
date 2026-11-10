// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@core/settings';
import type { AccountInfo } from '@core/serpapi/budget';
import type { AppState, Reply, Request } from '../../lib/messages';
import { SettingsPage } from './SettingsPage';
import type { WorkerApi } from './worker';

afterEach(cleanup);

const ACCOUNT: AccountInfo = {
  planName: 'Free Plan',
  status: 'Active',
  searchesPerMonth: 250,
  totalSearchesLeft: 212,
  thisMonthUsage: 38,
  thisHourSearches: 0,
  rateLimitPerHour: 50,
  renewalDate: null,
};

function stateWith(over: Partial<AppState> = {}, settings: Partial<ExtensionSettings> = {}): AppState {
  return {
    hasKey: false,
    account: null,
    accountCheckedAt: null,
    problem: null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    scanRunning: false,
    lastJob: null,
    nextRunAt: null,
    ...over,
  };
}

type Handler = (r: Request) => Promise<Reply> | Reply;

function fakeWorker(state: AppState, handlers: Partial<Record<Request['type'], Handler>> = {}) {
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    if (r.type === 'getState') return { ok: true, data: state };
    return (await handlers[r.type]?.(r)) ?? { ok: true, data: null };
  });
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  const saved = () => send.mock.calls.map((c) => c[0]).filter((r) => r.type === 'saveSettings');
  return { api, send, saved };
}

async function open(state: AppState, handlers: Partial<Record<Request['type'], Handler>> = {}) {
  const w = fakeWorker(state, handlers);
  const user = userEvent.setup();
  render(createElement(SettingsPage, { api: w.api }));
  await screen.findByRole('heading', { name: 'SerpApi key' });
  return { ...w, user };
}

const keyField = () => screen.getByLabelText('API key') as HTMLInputElement;
const keyLine = () => screen.getByTestId('key-result');
const forecast = () => screen.getByTestId('forecast');

describe('SerpApi key', () => {
  it('no key: empty field, Check key waits for a key, no Remove key', async () => {
    await open(stateWith());
    expect(keyField().value).toBe('');
    expect(keyField().type).toBe('password');
    expect(screen.getByRole('button', { name: 'Check key' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull();
  });

  it('while checking: the button is disabled and reads Checking', async () => {
    let release!: (r: Reply) => void;
    const { user } = await open(stateWith(), { checkKey: () => new Promise<Reply>((res) => (release = res)) });
    await user.type(keyField(), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    const busy = await screen.findByRole('button', { name: 'Checking' });
    expect(busy).toBeDisabled();
    release({ ok: true, data: ACCOUNT });
    await screen.findByRole('button', { name: 'Check key' });
  });

  it('key works: plan, searches left and the hourly limit', async () => {
    const { user, send } = await open(stateWith(), { checkKey: () => ({ ok: true, data: ACCOUNT }) });
    await user.type(keyField(), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    await waitFor(() => expect(keyLine().textContent).toContain('Key works.'));
    expect(keyLine().textContent).toBe('Key works. Free Plan · 212 of 250 searches left this month · 50 an hour');
    expect(send).toHaveBeenCalledWith({ type: 'checkKey', apiKey: 'abc123' });
    expect(keyField().value).toBe('');
    expect(document.body.textContent).not.toContain('abc123');
  });

  it('key refused: shows the sentence the worker gave', async () => {
    const { user } = await open(stateWith(), {
      checkKey: () => ({ ok: false, error: 'SerpApi did not accept this key.' }),
    });
    await user.type(keyField(), 'nope');
    await user.click(screen.getByRole('button', { name: 'Check key' }));
    await waitFor(() => expect(keyLine().textContent).toBe('SerpApi did not accept this key.'));
  });

  it('a saved key is never shown back; Remove key asks once', async () => {
    const { user, send } = await open(stateWith({ hasKey: true, account: ACCOUNT }));
    expect(keyField().value).toBe('');
    expect(keyField().placeholder).toBe('Key saved');
    await user.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(send).not.toHaveBeenCalledWith({ type: 'forgetKey' });
    await user.click(screen.getByRole('button', { name: 'Yes, remove key' }));
    expect(send).toHaveBeenCalledWith({ type: 'forgetKey' });
  });
});

describe('Scanning', () => {
  it('schedule fits: says so with exact numbers', async () => {
    await open(stateWith({ account: ACCOUNT, hasKey: true }, { schedule: { mode: 'daily', at: '07:00' } }));
    expect(forecast().textContent).toContain('This fits your plan');
    expect(forecast().textContent).toContain('150 of 150 usable a month');
    expect(forecast().textContent).toContain('30 scans a month × 5 searches');
    expect(forecast()).not.toHaveAttribute('data-attention');
  });

  it('schedule does not fit: attention colors and the fix, live before saving', async () => {
    const { user } = await open(
      stateWith({ account: ACCOUNT, hasKey: true }, { schedule: { mode: 'interval', hours: 6 } }),
    );
    expect(forecast()).toHaveAttribute('data-attention', 'true');
    expect(forecast().textContent).toContain(
      'This needs 600 searches a month and your plan has 150 to spend. Use 1 per scan, or scan less often.',
    );
    await user.click(screen.getByRole('radio', { name: 'Once a day at' }));
    expect(forecast()).not.toHaveAttribute('data-attention');
    const perScan = screen.getByLabelText('Searches per scan, at most');
    await user.clear(perScan);
    await user.type(perScan, '10');
    expect(forecast().textContent).toContain(
      'This needs 300 searches a month and your plan has 150 to spend. Use 5 per scan, or scan less often.',
    );
  });

  it('manual mode: nothing is spent automatically', async () => {
    await open(stateWith({ account: ACCOUNT, hasKey: true }));
    expect(forecast().textContent).toContain('Scans run only when you click Scan now');
    expect(forecast().textContent).toContain('Nothing is spent automatically');
  });

  it('every 6 hours and another interval pick the right radio', async () => {
    await open(stateWith({}, { schedule: { mode: 'interval', hours: 6 } }));
    expect(screen.getByRole('radio', { name: 'Every 6 hours' })).toBeChecked();
    cleanup();
    await open(stateWith({}, { schedule: { mode: 'interval', hours: 24 } }));
    expect(screen.getByRole('radio', { name: 'Every' })).toBeChecked();
    expect(screen.getByLabelText('Hours between scans')).toHaveValue(24);
  });

  it('an invalid field: message under it, linked, and nothing is saved', async () => {
    const { user, saved } = await open(stateWith());
    const perScan = screen.getByLabelText('Searches per scan, at most');
    await user.clear(perScan);
    expect(perScan).toHaveAttribute('aria-invalid', 'true');
    const message = within(document.getElementById(perScan.getAttribute('aria-describedby')!)!);
    expect(message.getByText('Use a whole number from 1 to 250.')).toBeTruthy();
    expect(saved()).toHaveLength(0);
    expect(screen.getByTestId('save-status').textContent).toContain('Not saved');
    await user.type(perScan, '7');
    expect(perScan).not.toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect((saved()[0] as { settings: ExtensionSettings }).settings.searchesPerScan).toBe(7);
  });
});

describe('Your data', () => {
  it('exports download the reply text', async () => {
    const { user, api } = await open(stateWith(), { exportDeals: () => ({ ok: true, data: 'a,b\n1,2' }) });
    await user.click(screen.getByRole('button', { name: 'Export deals as CSV' }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith('split-finder-deals.csv', 'a,b\n1,2', 'text/csv'));
  });

  it('clearing saved searches asks once', async () => {
    const { user, send } = await open(stateWith());
    await user.click(screen.getByRole('button', { name: 'Clear saved searches' }));
    expect(send).not.toHaveBeenCalledWith({ type: 'clearSavedSearches' });
    await user.click(screen.getByRole('button', { name: 'Yes, clear' }));
    expect(send).toHaveBeenCalledWith({ type: 'clearSavedSearches' });
  });
});
