// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AccountInfo } from '@core/serpapi/budget';
import type { ScanJob } from '@core/scan/types';
import type { AppState, PanelReport, Reply, Request } from '../../lib/messages';
import { UNREACHABLE, type WorkerApi } from '../../lib/pageClient';
import { App } from './App';
import { Notice } from './Notice';
import { progressText } from './ProgressRow';

vi.mock('./Notice', () => ({ Notice: vi.fn(() => null) }));
// The shell tests need only to know the report arrived; the list has its own tests in DealsTab.test.ts.
vi.mock('./DealsTab', async () => {
  const { createElement: h } = await import('react');
  return {
    DealsTab: ({ report, onPaidEnd }: { report: PanelReport | null; onPaidEnd?: () => void }) =>
      h('div', null, h('p', null, report ? `${report.bundles.length} bundles` : 'No scan has finished yet.'), h('button', { type: 'button', onClick: onPaidEnd }, 'A Look up ends')),
  };
});

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

const REPORT = { bundles: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], review: [{ id: 'r1', kind: 'split', brand: 'DEWALT', model: 'DCK1', title: null, reason: 'why', candidates: [], choices: [], openedAt: 1 }], packaging: {} } as unknown as PanelReport;
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

const stopped = (stopReason: string, finishedAt: number) =>
  ({ ...JOB, status: 'stopped', stopReason, finishedAt, queue: [] }) as unknown as ScanJob;

const noticeError = () => vi.mocked(Notice).mock.calls.at(-1)![0].error;

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
    expect(await screen.findByText('1 of 1')).toBeInTheDocument();
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
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Scanning · page 4 of 5 · 12 searches used');
    expect([...status.querySelectorAll('.figure')].map((e) => e.textContent)).toEqual(['4', '5', '12']);
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
    expect(footer).toHaveTextContent('No scan scheduled');
    expect(within(footer).getByRole('img', { name: '212 of 250 searches left' })).toBeInTheDocument();
    expect(footer).toHaveTextContent('212 searches left');
    await emit(state({ nextRunAt: new Date(2026, 10, 10, 14, 12, 0).getTime() }));
    expect(footer).toHaveTextContent('Next scan in 12 min');
  });

  it('footer: a next scan time in the past reads due now', async () => {
    setup(state({ nextRunAt: new Date(2026, 10, 10, 13, 0, 0).getTime() }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('Next scan due now');
  });

  it('footer after a limit stop: Scanned <when>', async () => {
    const now = new Date(2026, 10, 10, 14, 0, 0).getTime();
    setup(state({ lastJob: stopped('run_cap', now - 5 * 60_000) }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('Scanned 5 min ago');
  });

  it('footer right after a limit stop: Scanned just now', async () => {
    const now = new Date(2026, 10, 10, 14, 0, 0).getTime();
    setup(state({ lastJob: stopped('run_cap', now - 10_000) }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('Scanned just now');
  });

  it('Scan now in the last minute of an hourly limit says Try again now, never "after now"', async () => {
    const now = new Date(2026, 10, 10, 14, 0, 0).getTime();
    setup(state({ lastJob: stopped('hourly_limit', now - 60 * 60_000 + 20_000) }));
    const button = await screen.findByRole('button', { name: 'Scan now' });
    expect(button).toHaveAttribute('title', 'The hourly search limit is reached. Try again now.');
  });

  it('footer after a user stop still shows the schedule', async () => {
    const now = new Date(2026, 10, 10, 14, 0, 0).getTime();
    setup(state({ lastJob: stopped('user', now - 5 * 60_000) }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('No scan scheduled');
  });

  it('Scan now is disabled within the hour of an hourly limit, keeping its label and a title', async () => {
    const now = new Date(2026, 10, 10, 14, 0, 0).getTime();
    setup(state({ lastJob: stopped('hourly_limit', now - 20 * 60_000) }));
    const button = await screen.findByRole('button', { name: 'Scan now' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'The hourly search limit is reached. Try again after 40 min.');
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('Scan now is enabled an hour after an hourly limit, and after run_cap or reserve', async () => {
    const now = new Date(2026, 10, 10, 14, 0, 0).getTime();
    setup(state({ lastJob: stopped('hourly_limit', now - 61 * 60_000) }));
    expect(await screen.findByRole('button', { name: 'Scan now' })).toBeEnabled();
    cleanup();
    setup(state({ lastJob: stopped('run_cap', now - 60_000) }));
    expect(await screen.findByRole('button', { name: 'Scan now' })).toBeEnabled();
    cleanup();
    setup(state({ lastJob: stopped('reserve', now - 60_000) }));
    expect(await screen.findByRole('button', { name: 'Scan now' })).toBeEnabled();
  });

  it('footer says so when the account has not been checked', async () => {
    setup(state({ account: null }));
    expect(await screen.findByRole('contentinfo')).toHaveTextContent('Searches left unknown');
  });

  it('no key: the first-run body, Scan now disabled, no tabs or footer', async () => {
    setup(state({ hasKey: false, account: null }));
    expect(await screen.findByText(/Add your SerpApi key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan now' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Scan now' })).toHaveAttribute('title', 'Add your SerpApi key first.');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });

  it('the settings button opens the settings page', async () => {
    const user = userEvent.setup();
    const { openSettings } = setup(state());
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('Notice gets the sentence of a refused scanNow, and loses it on the next success', async () => {
    const user = userEvent.setup();
    const { send } = setup(state());
    await user.click(await screen.findByRole('button', { name: 'Scan now' }));
    expect(noticeError()).toBeNull();
    send.mockImplementationOnce(async () => ({ ok: false, error: 'No searches left to spend.' }));
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(noticeError()).toBe('No searches left to spend.'));
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(noticeError()).toBeNull());
  });

  it('a refused scanNow sentence survives a successful report refresh', async () => {
    const user = userEvent.setup();
    const { send, emit } = setup(state());
    await user.click(await screen.findByRole('button', { name: 'Scan now' }));
    send.mockImplementationOnce(async () => ({ ok: false, error: 'No searches left to spend.' }));
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(noticeError()).toBe('No searches left to spend.'));
    send.mockImplementation(async (r) => (r.type === 'getReport' ? { ok: true, data: REPORT } : { ok: true, data: null }));
    await emit(state({ nextRunAt: 5 }));
    await waitFor(() => expect(send.mock.calls.filter((c) => c[0].type === 'getReport').length).toBeGreaterThan(1));
    expect(noticeError()).toBe('No searches left to spend.');
  });

  it('a refused scanNow sentence goes when a scan starts or ends', async () => {
    const user = userEvent.setup();
    const { send, emit } = setup(state());
    await screen.findByText('3 bundles');
    send.mockImplementationOnce(async () => ({ ok: false, error: 'A Look up or Verify is running.' }));
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(noticeError()).toBe('A Look up or Verify is running.'));
    await emit(state({ scanRunning: true, lastJob: JOB }));
    expect(noticeError()).toBeNull();

    send.mockImplementationOnce(async () => ({ ok: false, error: 'Could not stop.' }));
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(noticeError()).toBe('Could not stop.'));
    await emit(state({ scanRunning: false, lastJob: { ...JOB, status: 'stopped' } as ScanJob }));
    expect(noticeError()).toBeNull();
  });

  it('a refused scanNow sentence goes when a Look up or Verify on the panel ends', async () => {
    const user = userEvent.setup();
    const { send } = setup(state());
    await screen.findByText('3 bundles');
    send.mockImplementationOnce(async () => ({ ok: false, error: 'A Look up or Verify is running.' }));
    await user.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(noticeError()).toBe('A Look up or Verify is running.'));
    await user.click(screen.getByRole('button', { name: 'A Look up ends' }));
    expect(noticeError()).toBeNull();
  });

  it('Notice gets the unreachable sentence when stopScan rejects', async () => {
    const user = userEvent.setup();
    const { send } = setup(state({ scanRunning: true, lastJob: JOB }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    send.mockImplementationOnce(async () => {
      throw new Error('gone');
    });
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(noticeError()).toBe(UNREACHABLE));
  });

  it('the screens get the api; FirstRun gets openSettings', async () => {
    const { openSettings } = setup(state({ hasKey: false, account: null }));
    await screen.findByText(/Add your SerpApi key/);
    expect(openSettings).not.toHaveBeenCalled();
  });
});

describe('progress row', () => {
  const job = (pagesFetched: number, queue: unknown[]) => ({ ...JOB, counts: { pagesFetched }, queue, searchesUsed: 0 }) as unknown as ScanJob;
  const listing = { kind: 'listing', q: 'a', page: 1, filterTokens: null, bundlesOnly: true };
  const catalog = { kind: 'catalog', brand: 'DEWALT', page: 1 };
  const lookup = { kind: 'lookup', brand: 'DEWALT', model: 'X' };

  it('start of scan: the page being fetched is page 1', () => {
    expect(progressText(job(0, [listing, catalog]))).toBe('Scanning · page 1 of 2 · 0 searches used');
  });
  it('after the pages: the count stops at the pages fetched', () => {
    expect(progressText(job(2, [lookup]))).toBe('Scanning · page 2 of 2 · 0 searches used');
  });
});
