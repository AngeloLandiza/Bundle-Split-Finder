// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { BundleRow, PartRow, ReviewItem, ScanJob, ScanStep } from '@core/scan/types';
import type { AppState, PanelReport, Quote, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { DealsTab } from './DealsTab';
import { matchState, sortRows } from './dealsModel';
import type { SortKey } from './sort';

afterEach(cleanup);

const NOW = new Date(2026, 10, 10, 14, 0, 0).getTime();
const DAY = 86_400_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const part = (model: string, over: Partial<PartRow> = {}): PartRow => ({
  model,
  qty: 1,
  status: 'matched',
  availability: 'active',
  asin: 'B0TESTASIN',
  grade: 'exact',
  price: 199,
  priceSeenAt: NOW - DAY,
  image: null,
  ...over,
});

const row = (key: string, over: Partial<BundleRow> = {}): BundleRow => ({
  key,
  itemId: key,
  brand: 'DEWALT',
  model: key.toUpperCase(),
  title: `Title of ${key}`,
  link: null,
  price: 749,
  regularPrice: 1270,
  percentOff: 41,
  status: 'complete',
  section: 'confirmed',
  parts: [part('DCD791B'), part('DCF891B')],
  estimate: { cost: 800, netRevenue: 1137.3, profit: 337.3, roi: 0.4216 },
  uncovered: [],
  ...over,
});

const est = (profitValue: number, roiValue: number) => ({ cost: 800, netRevenue: 800 + profitValue, profit: profitValue, roi: roiValue });

const lookup = (model: string): ScanStep => ({ kind: 'lookup', brand: 'DEWALT', model });

const job = (over: Partial<ScanJob> = {}): ScanJob =>
  ({
    id: '1',
    startedAt: NOW - 3_600_000,
    finishedAt: NOW - 1_800_000,
    status: 'done',
    stopReason: null,
    stopMessage: null,
    phase: 'finish',
    queue: [],
    deferred: [],
    searchesUsed: 5,
    counts: {},
    ...over,
  }) as unknown as ScanJob;

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true,
  account: null,
  accountCheckedAt: 1,
  problem: null,
  settings: { ...DEFAULT_SETTINGS, searchesPerScan: 40 },
  scanRunning: false,
  lastJob: job(),
  nextRunAt: null,
  ...over,
});

const report = (bundles: BundleRow[], review: ReviewItem[] = []): PanelReport => ({ bundles, review, packaging: {} });

function fakeApi(quote: Quote | ((r: Request) => Reply)) {
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    if (typeof quote === 'function') return quote(r);
    if (r.type === 'quote') return { ok: true, data: quote };
    return { ok: true, data: null };
  });
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
  return { api, send };
}

function show(r: PanelReport | null, s: AppState = state(), extra: { sort?: SortKey; api?: WorkerApi; onOpen?: (k: string) => void; onSort?: (k: SortKey) => void } = {}) {
  const onOpen = extra.onOpen ?? vi.fn();
  const onSort = extra.onSort ?? vi.fn();
  const api = extra.api ?? fakeApi({ searches: 1, refusal: null }).api;
  const view = render(createElement(DealsTab, { api, report: r, state: s, sort: extra.sort ?? 'profit', onSort, onOpen }));
  return { onOpen, onSort, api, view };
}

const labels = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
const titles = () => [...document.querySelectorAll('.deal-title')].map((e) => e.textContent);

describe('sections', () => {
  const bundles = [
    row('s1', { section: 'split', parts: [], estimate: null }),
    row('m1', { section: 'missing_listing', parts: [part('X1', { status: 'none', availability: 'missing', grade: null })] }),
    row('c1'),
    row('c2'),
    row('i1', { section: 'inactive_listing', parts: [part('Y1', { availability: 'inactive' })] }),
  ];

  it('shows the sections in order with their counts, and the line under the tabs', () => {
    show(report(bundles));
    expect(labels().filter((l) => /·/.test(l ?? '') && !/^Scan/.test(l ?? ''))).toEqual([
      'CONFIRMED · 2Estimated profit',
      'REVIEW: INACTIVE LISTING · 1',
      'REVIEW: MISSING LISTING · 1',
      'CONTENTS NOT KNOWN · 1',
    ]);
    expect(screen.getByText(/^5 bundles · scanned /)).toBeInTheDocument();
    expect(screen.getAllByText('Estimated profit')).toHaveLength(1);
  });

  it('hides empty sections', () => {
    show(report([row('c1')]));
    expect(screen.queryByText(/REVIEW/)).toBeNull();
    expect(screen.queryByText(/CONTENTS NOT KNOWN/)).toBeNull();
    expect(screen.getByText(/^1 bundle · scanned 30 min ago$/)).toBeInTheDocument();
  });
});

describe('sorting', () => {
  const rows = [
    row('none', { estimate: null, percentOff: null }),
    row('low', { estimate: est(30.3, 0.06), percentOff: 20 }),
    row('high', { estimate: est(337.3, 0.45), percentOff: 41 }),
    row('loss', { estimate: est(-22.7, -0.06), percentOff: 10 }),
    row('mid', { estimate: est(98.3, 0.52), percentOff: 44 }),
  ];
  const order = (k: SortKey) => sortRows(rows, k).map((r) => r.key);

  it('puts the highest first and rows with no figure last', () => {
    expect(order('profit')).toEqual(['high', 'mid', 'low', 'loss', 'none']);
    expect(order('roi')).toEqual(['mid', 'high', 'low', 'loss', 'none']);
    expect(order('discount')).toEqual(['mid', 'high', 'low', 'loss', 'none']);
  });

  it('applies within each section on screen', () => {
    show(report(rows), state(), { sort: 'roi' });
    expect(titles()).toEqual(['mid', 'high', 'low', 'loss', 'none'].map((k) => `Title of ${k}`));
  });

  it('is a labelled select that reports the choice', async () => {
    const user = userEvent.setup();
    const { onSort } = show(report(rows));
    const select = screen.getByLabelText('Sort by');
    expect(select).toHaveValue('profit');
    await user.selectOptions(select, 'roi');
    expect(onSort).toHaveBeenCalledWith('roi');
  });
});

describe('match state', () => {
  const m = (over: Partial<PartRow> = {}) => part('A', over);
  it('says matched when every part is exact or strong', () => {
    expect(matchState([m(), m({ grade: 'strong' })])).toBe('2 parts matched');
    expect(matchState([m()])).toBe('1 parts matched'.replace('1 parts', '1 part'));
  });
  it('counts probable parts to verify', () => {
    expect(matchState([m(), m({ grade: 'probable' })])).toBe('1 part to verify');
    expect(matchState([m({ grade: 'probable' }), m({ grade: 'probable' })])).toBe('2 parts to verify');
  });
  it('counts waiting and unmatched parts unknown', () => {
    expect(matchState([m({ status: 'waiting', grade: null }), m({ status: 'unmatched', grade: null })])).toBe('2 parts unknown');
    expect(matchState([m({ status: 'waiting', grade: null })])).toBe('1 part unknown');
  });
  it('counts parts with no listing', () => {
    expect(matchState([m(), m({ status: 'none', grade: null, availability: 'missing' })])).toBe('1 part with no listing');
    expect(matchState([m({ status: 'none', grade: null, availability: 'missing' }), m({ status: 'none', grade: null, availability: 'missing' })])).toBe(
      '2 parts with no listing',
    );
  });
  it('shows the first that applies: to verify, then unknown, then no listing', () => {
    const verify = m({ grade: 'probable' });
    const unknown = m({ status: 'waiting', grade: null, availability: 'missing' });
    const none = m({ status: 'none', grade: null, availability: 'missing' });
    expect(matchState([none, unknown, verify])).toBe('1 part to verify');
    expect(matchState([none, unknown])).toBe('1 part unknown');
  });
  it('has nothing to say about a bundle with no parts', () => {
    expect(matchState([])).toBeNull();
  });
});

describe('rows', () => {
  it('shows price, discount and match state, and opens with a click or Enter', async () => {
    const user = userEvent.setup();
    const { onOpen } = show(report([row('c1', { title: 'A very long title '.repeat(10) })]));
    const link = screen.getByRole('link', { name: /A very long title/ });
    expect(within(link).getByText('$749.00')).toBeInTheDocument();
    expect(within(link).getByText('41% off')).toBeInTheDocument();
    expect(within(link).getByText('2 parts matched')).toBeInTheDocument();
    expect(link.querySelector('.deal-title')).toHaveAttribute('title', 'A very long title '.repeat(10));
    await user.click(link);
    expect(onOpen).toHaveBeenCalledWith('c1');
    link.focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('writes a gain with a plus and a loss with the real minus, in the loss color class', () => {
    show(report([row('gain'), row('loss', { estimate: est(-22.7, -0.0613) })]));
    expect(screen.getByText('+$337.30')).toBeInTheDocument();
    const loss = screen.getByText('−$22.70');
    expect(loss.parentElement).toHaveAttribute('data-loss', 'true');
    expect(screen.getByText('ROI −6%')).toBeInTheDocument();
    expect(screen.getByText('+$337.30').parentElement).not.toHaveAttribute('data-loss');
  });

  it('says No estimate when a row has none', () => {
    show(report([row('x', { estimate: null })]));
    expect(screen.getByText('No estimate')).toBeInTheDocument();
  });

  it('shows the amber tag for a split with an open question, else Contents not known', () => {
    const open = { id: 'split:s1', kind: 'split', subject: 's1' } as unknown as ReviewItem;
    show(report([row('s1', { section: 'split', parts: [], estimate: null }), row('s2', { section: 'split', parts: [], estimate: null })], [open]));
    const asked = screen.getByText('Needs your answer');
    expect(asked.closest('a')).toHaveTextContent('Title of s1');
    const other = screen.getByRole('link', { name: /Title of s2/ });
    expect(within(other).getByText('Contents not known')).toBeInTheDocument();
    expect(within(other).queryByText('Needs your answer')).toBeNull();
  });
});

describe('limit notice', () => {
  const stopped = (reason: string, deferred: ScanStep[] = []) => state({ lastJob: job({ status: 'stopped', stopReason: reason as ScanJob['stopReason'], deferred }) });
  const deferred = [lookup('A'), lookup('A'), lookup('B'), { kind: 'refresh', brand: 'DEWALT', model: 'C', asin: 'B0' } as ScanStep];

  it('run_cap names the per-scan limit and the parts waiting', () => {
    show(report([row('c1')]), stopped('run_cap', deferred));
    expect(screen.getByText('Scan stopped at your search limit')).toBeInTheDocument();
    expect(screen.getByText('It used the 40 searches allowed per scan. 2 parts still need an Amazon lookup and go first next time.')).toBeInTheDocument();
  });

  it('reserve keeps the rest of the month for the owner', () => {
    show(report([row('c1')]), stopped('reserve', deferred));
    expect(screen.getByText('Scan stopped at your reserve')).toBeInTheDocument();
    expect(screen.getByText("The rest of this month's searches are kept for scans you start yourself. 2 parts still need an Amazon lookup.")).toBeInTheDocument();
  });

  it('hourly_limit gives the limit and the time to try again, or only the time when the limit is unknown', () => {
    const account = { rateLimitPerHour: 50 } as AppState['account'];
    const s = stopped('hourly_limit');
    show(report([row('c1')]), { ...s, account });
    expect(screen.getByText('Scan stopped at the hourly limit')).toBeInTheDocument();
    expect(screen.getByText(/^SerpApi allows 50 searches an hour\. Try again after 30 min\.$/)).toBeInTheDocument();
    cleanup();
    show(report([row('c1')]), s);
    expect(screen.getByText(/^Try again after 30 min\.$/)).toBeInTheDocument();
  });

  it('shows the next scan and a real link to the options page', () => {
    show(report([row('c1')]), { ...stopped('run_cap'), nextRunAt: NOW + DAY });
    expect(screen.getByText(/^Next scan tomorrow /)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Change the limit' });
    expect(link.getAttribute('href')).toMatch(/\/options\.html$/);
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('is absent when the scan finished or the owner stopped it', () => {
    show(report([row('c1')]));
    expect(screen.queryByText(/^Scan stopped/)).toBeNull();
    cleanup();
    show(report([row('c1')]), stopped('user'));
    expect(screen.queryByText(/^Scan stopped/)).toBeNull();
  });
});

describe('Look up', () => {
  const waiting = row('w1', {
    price: 449,
    percentOff: 34,
    estimate: null,
    section: 'missing_listing',
    parts: [part('DCB1', { status: 'waiting', grade: null, availability: 'missing', asin: null }), part('DCB2', { status: 'waiting', grade: null, availability: 'missing', asin: null })],
  });

  it('asks for the price of the waiting parts, shows it on the button, and sends runPaid on click', async () => {
    const user = userEvent.setup();
    const { api, send } = fakeApi({ searches: 2, refusal: null });
    show(report([waiting, row('c1')]), state(), { api });
    const button = await screen.findByRole('button', { name: 'Look up · 2 searches' });
    const action = { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'DCB1' }, { brand: 'DEWALT', model: 'DCB2' }] };
    expect(send).toHaveBeenCalledWith({ type: 'quote', action });
    expect(screen.getAllByRole('button', { name: /^Look up/ })).toHaveLength(1);
    await user.click(button);
    expect(send).toHaveBeenCalledWith({ type: 'runPaid', action });
  });

  it('says 1 search in the singular', async () => {
    show(report([waiting]), state(), { api: fakeApi({ searches: 1, refusal: null }).api });
    expect(await screen.findByRole('button', { name: 'Look up · 1 search' })).toBeEnabled();
  });

  it('disables the button and shows the refusal beneath', async () => {
    const sentence = 'The hourly search limit is reached. Try again after 15:00.';
    show(report([waiting]), state(), { api: fakeApi({ searches: 2, refusal: sentence }).api });
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Look up/ })).toBeDisabled();
  });

  it('sends one request at a time', async () => {
    const user = userEvent.setup();
    let release: (r: Reply) => void = () => {};
    const send = vi.fn((r: Request): Promise<Reply> => {
      if (r.type === 'quote') return Promise.resolve({ ok: true, data: { searches: 2, refusal: null } });
      return new Promise((ok) => (release = ok));
    });
    const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([waiting]), state(), { api });
    const button = await screen.findByRole('button', { name: 'Look up · 2 searches' });
    await user.click(button);
    expect(button).toBeDisabled();
    await user.click(button);
    expect(send.mock.calls.filter((c) => c[0].type === 'runPaid')).toHaveLength(1);
    release({ ok: false, error: 'Not available yet.' });
    expect(await screen.findByText('Not available yet.')).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('has no Look up when no part waits', () => {
    show(report([row('c1')]));
    expect(screen.queryByRole('button', { name: /Look up/ })).toBeNull();
  });
});

describe('empty states', () => {
  it('says nothing before the first report', () => {
    const { view } = show(null);
    expect(view.container).toBeEmptyDOMElement();
  });
  it('says there is no scan yet when none finished', () => {
    show(report([]), state({ lastJob: null }));
    expect(screen.getByText("No scan yet. Scan now looks at Home Depot's DEWALT and RYOBI bundles.")).toBeInTheDocument();
  });
  it('says the last scan found no bundles when one finished', () => {
    show(report([]));
    expect(screen.getByText('The last scan found no bundles.')).toBeInTheDocument();
  });
});

describe('stale prices', () => {
  const aged = (days: number) => row('c1', { parts: [part('A'), part('B', { priceSeenAt: NOW - days * DAY - 3_600_000 })] });
  it('names the age of the oldest shown price when it is past the freshness period', () => {
    show(report([aged(4)]));
    expect(screen.getByText('Prices seen 4 days ago')).toBeInTheDocument();
  });
  it('is absent when prices are fresh', () => {
    show(report([aged(2)]));
    expect(screen.queryByText(/^Prices seen/)).toBeNull();
  });
});
