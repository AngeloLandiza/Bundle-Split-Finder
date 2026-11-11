// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AccountInfo } from '@core/serpapi/budget';
import type { ScanJob } from '@core/scan/types';
import type { AppState, PanelReport, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { App } from './App';

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

const JOB = {
  id: '1',
  startedAt: 1,
  finishedAt: null,
  status: 'running',
  stopReason: null,
  stopMessage: null,
  phase: 'listing',
  queue: [
    { kind: 'listing', q: 'a', page: 2, filterTokens: null, bundlesOnly: true },
    { kind: 'catalog', brand: 'DEWALT', page: 1 },
    { kind: 'lookup', brand: 'DEWALT', model: 'DCD791' },
  ],
  deferred: [],
  searchesUsed: 12,
  counts: { pagesFetched: 3 },
} as unknown as ScanJob;

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true,
  account: ACCOUNT,
  accountCheckedAt: 1,
  problem: null,
  settings: DEFAULT_SETTINGS,
  scanRunning: false,
  lastJob: null,
  nextRunAt: null,
  ...over,
});

const REPORT = { bundles: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], review: [{ id: 'r1' }], packaging: {} } as unknown as PanelReport;
const EMPTY = { bundles: [], review: [], packaging: {} } as unknown as PanelReport;

function setup(initial: AppState, report: PanelReport = REPORT) {
  let listener: (s: AppState) => void = () => {};
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    if (r.type === 'getState') return { ok: true, data: initial };
    if (r.type === 'getReport') return { ok: true, data: report };
    return { ok: true, data: null };
  });
  const api: WorkerApi = {
    send: send as WorkerApi['send'],
    onStateChanged: (l) => {
      listener = l;
      return () => {};
    },
    download: vi.fn(),
  };
  const openSettings = vi.fn();
  render(createElement(App, { api, openSettings, now: () => new Date(2026, 10, 10, 14, 0, 0).getTime() }));
  return { send, openSettings, emit: (s: AppState) => act(async () => listener(s)) };
}

const tab = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('side panel shell', () => {
  it('shows the Deals count and an amber Review count', async () => {
    setup(state());
    await screen.findByText('3 bundles');
    expect(within(tab('Deals')).getByText('3')).toBeInTheDocument();
    const review = within(tab('Review')).getByText('1');
    expect(review).toHaveAttribute('data-tag', 'attention');
    expect(screen.queryByRole('button', { name: /This page/ })).toBeNull();
  });

  it('a Review count of zero is plain text, not a tag', async () => {
    setup(state(), EMPTY);
    await screen.findByText('0 bundles');
    expect(within(tab('Review')).getByText('0')).not.toHaveAttribute('data-tag');
  });

  it('switches between Deals and Review', async () => {
    const user = userEvent.setup();
    setup(state());
    await screen.findByText('3 bundles');
    await user.click(tab('Review'));
    expect(await screen.findByText('1 to review')).toBeInTheDocument();
    expect(tab('Review')).toHaveAttribute('aria-current', 'true');
  });

  it('Scan now sends scanNow, then becomes Stop with the progress row on a state change', async () => {
    const user = userEvent.setup();
    const { send, emit } = setup(state());
    await user.click(await screen.findByRole('button', { name: 'Scan now' }));
    expect(send).toHaveBeenCalledWith({ type: 'scanNow' });
    expect(screen.queryByText(/^Scanning/)).toBeNull();

    await emit(state({ scanRunning: true, lastJob: JOB }));
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(screen.queryByRole('button', { name: 'Scan now' })).toBeNull();
    expect(screen.getByText('Scanning · page 3 of 5 · 12 searches used')).toBeInTheDocument();
    await user.click(stop);
    expect(send).toHaveBeenCalledWith({ type: 'stopScan' });

    await emit(state({ scanRunning: false, lastJob: { ...JOB, status: 'stopped' } }));
    expect(screen.getByRole('button', { name: 'Scan now' })).toBeInTheDocument();
    expect(screen.queryByText(/^Scanning/)).toBeNull();
  });

  it('fetches the report again after a state change and keeps the last one meanwhile', async () => {
    const { send, emit } = setup(state());
    await screen.findByText('3 bundles');
    const before = send.mock.calls.filter((c) => c[0].type === 'getReport').length;
    send.mockImplementation(() => new Promise(() => {}));
    await emit(state({ scanRunning: true, lastJob: JOB }));
    expect(send.mock.calls.filter((c) => c[0].type === 'getReport').length).toBe(before + 1);
    expect(screen.getByText('3 bundles')).toBeInTheDocument();
  });

  it('footer: next scan time, or the manual sentence, and the searches left', async () => {
    const { emit } = setup(state());
    const footer = await screen.findByRole('contentinfo');
    expect(footer).toHaveTextContent('Scans when you click Scan now');
    expect(within(footer).getByRole('img', { name: '212 of 250 searches left' })).toBeInTheDocument();
    expect(footer).toHaveTextContent('212 searches left');
    await emit(state({ nextRunAt: new Date(2026, 10, 10, 14, 12, 0).getTime() }));
    expect(footer).toHaveTextContent('Next scan in 12 min');
  });

  it('footer says so when the account has not been checked', async () => {
    setup(state({ account: null }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('Searches left unknown');
  });

  it('no key: the first-run body, Scan now disabled, no tabs or footer', async () => {
    setup(state({ hasKey: false, account: null }));
    expect(await screen.findByText(/Add your SerpApi key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan now' })).toBeDisabled();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });

  it('the settings button opens the settings page', async () => {
    const user = userEvent.setup();
    const { openSettings } = setup(state());
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
