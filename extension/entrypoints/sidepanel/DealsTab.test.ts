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
import { bundlesCsv } from '@core/scan/csv';
import { DealsTab } from './DealsTab';
import { matchState as matchStateOf, sortRows } from './dealsModel';
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
  title: null,
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
  seenAt: NOW - DAY,
  status: 'complete',
  section: 'confirmed',
  parts: [part('DCD791B'), part('DCF891B')],
  estimate: { cost: 800, netRevenue: 1137.3, profit: 337.3, roi: 0.4216 },
  uncovered: [],
  answer: null,
  options: [],
  kitsNotRead: [],
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
      'CONFIRMED · 2',
      'REVIEW: INACTIVE LISTING · 1',
      'REVIEW: MISSING LISTING · 1',
      'CONTENTS NOT KNOWN · 1',
    ]);
    expect(screen.getByText(/^5 bundles · scanned /)).toBeInTheDocument();
    expect(screen.getAllByText('Estimated profit · ROI')).toHaveLength(1);
    expect(screen.getByText('Estimated profit · ROI').closest('h2')).toBeNull();
    // The caption is above the first section that has figures.
    const caption = screen.getByText('Estimated profit · ROI');
    expect(caption.nextElementSibling).toHaveTextContent('CONFIRMED · 2');
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
  const matchState = (parts: PartRow[], over: Partial<BundleRow> = {}) => matchStateOf(row('x', { parts, ...over }));
  it('says matched when every part is exact or strong', () => {
    expect(matchState([m(), m({ grade: 'strong' })])).toBe('2 parts matched');
    expect(matchState([m()])).toBe('1 part matched');
  });
  it('confirmed: counts the title matches (probable parts), the owner decides on Detail', () => {
    expect(matchState([m(), m({ grade: 'probable' })])).toBe('1 title match');
    expect(matchState([m({ grade: 'probable' }), m({ grade: 'probable' })])).toBe('2 title matches');
  });
  it('waiting: counts the parts to look up, waiting or unmatched', () => {
    const waiting = { section: 'waiting' } as const;
    expect(matchState([m({ status: 'waiting', grade: null }), m({ status: 'unmatched', grade: null })], waiting)).toBe('2 parts to look up');
    expect(matchState([m({ status: 'waiting', grade: null }), m()], waiting)).toBe('1 part to look up');
  });
  it('missing listing: counts the parts with no listing, then the parts to verify', () => {
    const missing = { section: 'missing_listing' } as const;
    const none = m({ status: 'none', grade: null, availability: 'missing' });
    expect(matchState([m(), none], missing)).toBe('1 part with no listing');
    expect(matchState([none, { ...none, model: 'B' }], missing)).toBe('2 parts with no listing');
    expect(matchState([none, m({ grade: 'probable' })], missing)).toBe('1 part with no listing · 1 to verify');
    // The QA case: PCL1201K2-PCL515B after a Look up that found no listing for the saw.
    const saw = part('PCL515B', { status: 'matched', grade: 'exact' });
    const lookedUp = part('PCL1201K2', { status: 'none', grade: null, availability: 'missing', asin: null, price: null });
    expect(matchState([lookedUp, saw], { ...missing, key: 'PCL1201K2-PCL515B', brand: 'RYOBI' })).toBe('1 part with no listing');
  });
  it('outside a section with its own reason, falls back to to verify, unknown, then no listing', () => {
    const verify = m({ grade: 'probable' });
    const unknown = m({ status: 'waiting', grade: null, availability: 'missing' });
    const none = m({ status: 'none', grade: null, availability: 'missing' });
    expect(matchState([none, unknown, verify], { section: 'split' })).toBe('1 part to verify');
    expect(matchState([none, unknown], { section: 'split' })).toBe('1 part unknown');
  });
  it('says why a row is in the inactive section, before the other wordings', () => {
    const inactive = (n: number) => Array.from({ length: n }, (_, i) => m({ availability: 'inactive', model: `I${i}` }));
    expect(matchState(inactive(1), { section: 'inactive_listing' })).toBe('1 listing inactive');
    expect(matchState([...inactive(2), m({ grade: 'probable' })], { section: 'inactive_listing' })).toBe('2 listings inactive');
    expect(matchState(inactive(1), { section: 'inactive_listing', price: null })).toBe('No bundle price');
    // Elsewhere the ordinary wording stays.
    expect(matchState(inactive(2))).toBe('2 parts matched');
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

  it('leaves the figure column empty when a part waits, and says No estimate for other rows without one', () => {
    const waitingPart = part('W', { status: 'waiting', grade: null, availability: 'missing', asin: null });
    show(report([row('w', { estimate: null, parts: [waitingPart] }), row('u', { estimate: null, parts: [part('U', { status: 'unmatched', grade: null })] })]));
    expect(screen.queryByText('No estimate')).toBeNull();
    cleanup();
    show(report([row('n', { estimate: null, price: null, section: 'inactive_listing' })]));
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

describe('a failure set aside (N4)', () => {
  const SET_ASIDE = 'Set aside for the next scan. SerpApi answered with an error (HTTP 404). Try again later.';
  const failed = (over: Partial<ScanJob>) => state({ lastJob: job({ stopMessage: 'SerpApi returned HTTP 404.', ...over }) });

  it('joins the limit notice when the scan stopped at a limit', () => {
    show(report([row('c1')]), failed({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 1 }));
    const band = screen.getByRole('region', { name: /^(Scan stopped|You stopped)/ });
    expect(within(band).getByText('Scan stopped at your search limit')).toBeInTheDocument();
    expect(within(band).getByText(SET_ASIDE)).toBeInTheDocument();
  });

  it('joins the notice after a user stop', () => {
    show(report([row('c1')]), failed({ status: 'stopped', stopReason: 'user' }));
    expect(within(screen.getByRole('region', { name: /^(Scan stopped|You stopped)/ })).getByText(SET_ASIDE)).toBeInTheDocument();
  });

  it('stands alone when the job is done and there is no band', () => {
    show(report([row('c1')]), failed({ status: 'done' }));
    expect(screen.queryByRole('region', { name: /^(Scan stopped|You stopped)/ })).toBeNull();
    expect(screen.getByText(SET_ASIDE)).toBeInTheDocument();
  });

  it('sits under the empty state when there are no bundles', () => {
    show(report([]), failed({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 1 }));
    expect(screen.getByText(SET_ASIDE)).toBeInTheDocument();
    cleanup();
    show(report([]), failed({ status: 'done' }));
    expect(screen.getByText('The last scan found no bundles.')).toBeInTheDocument();
    expect(screen.getByText(SET_ASIDE)).toBeInTheDocument();
  });

  it('says an unread page the same way', () => {
    show(report([row('c1')]), failed({ status: 'done', stopMessage: 'A Home Depot page could not be read.' }));
    expect(screen.getByText('Set aside for the next scan. A Home Depot page could not be read.')).toBeInTheDocument();
  });

  // The runner's refusal note already says what happens next (core/src/scan/runner.ts; core/test/scan-kit-pages.test.ts has its three forms).
  it('says a page refusal as its own sentence, without "Set aside for the next scan."', () => {
    for (const said of [
      'Home Depot refused a page (HTTP 403); the rest are read next scan.',
      'Home Depot refused a page (no answer); the rest are read next scan.',
      'Home Depot refused a page; the rest are read next scan.',
    ]) {
      show(report([row('c1')]), failed({ status: 'done', stopMessage: said }));
      expect(screen.getByText(said)).toBeInTheDocument();
      expect(screen.queryByText(/Set aside for the next scan/)).toBeNull();
      cleanup();
    }
  });

  it('keeps the prefix for what follows a refusal: its lookup failure', () => {
    show(
      report([row('c1', { estimate: null, parts: [part('PCL526B', { status: 'waiting', grade: null, availability: 'missing', asin: null })] })]),
      failed({
        status: 'done',
        stopMessage: 'Home Depot refused a page (HTTP 403); the rest are read next scan. The lookup of PCL526B failed: SerpApi returned HTTP 404.',
      }),
    );
    expect(
      screen.getByText(
        'Home Depot refused a page (HTTP 403); the rest are read next scan. Set aside for the next scan. The lookup of PCL526B failed: SerpApi answered with an error (HTTP 404).',
      ),
    ).toBeInTheDocument();
  });

  it('says a joined lookup failure as sentences with SerpApi\'s text mapped', () => {
    show(
      report([row('c1', { estimate: null, parts: [part('PCL526B', { status: 'waiting', grade: null, availability: 'missing', asin: null })] })]),
      failed({ status: 'done', stopMessage: 'A Home Depot page could not be read. The lookup of PCL526B failed: SerpApi returned HTTP 404.' }),
    );
    expect(
      screen.getByText(
        'Set aside for the next scan. A Home Depot page could not be read. The lookup of PCL526B failed: SerpApi answered with an error (HTTP 404).',
      ),
    ).toBeInTheDocument();
  });

  it('is not repeated for an error or rate limit, which the Notice above the tabs shows, and absent without a message', () => {
    show(report([row('c1')]), failed({ status: 'stopped', stopReason: 'error' }));
    expect(screen.queryByText(/^Set aside for the next scan/)).toBeNull();
    cleanup();
    show(report([row('c1')]), state({ lastJob: job({ status: 'stopped', stopReason: 'run_cap' }) }));
    expect(screen.queryByText(/^Set aside for the next scan/)).toBeNull();
  });
});

describe('limit notice', () => {
  const stopped = (reason: string, deferred: ScanStep[] = []) => state({ lastJob: job({ status: 'stopped', stopReason: reason as ScanJob['stopReason'], deferred }) });
  const deferred = [lookup('A'), lookup('A'), lookup('B'), { kind: 'refresh', brand: 'DEWALT', model: 'C', asin: 'B0' } as ScanStep];
  // The report's rows say which of those still wait: A and B do.
  const waits = (...models: string[]) =>
    row('w', { estimate: null, section: 'waiting', parts: models.map((m) => part(m, { status: 'waiting', grade: null, availability: 'missing', asin: null, price: null })) });

  it('run_cap names the per-scan limit and the parts waiting', () => {
    show(report([waits('A', 'B')]), stopped('run_cap', deferred));
    expect(screen.getByText('Scan stopped at your search limit')).toBeInTheDocument();
    expect(screen.getByText('It used 5 of the 40 searches allowed per scan. 2 parts still need an Amazon lookup.')).toBeInTheDocument();
  });

  it('reserve keeps the rest of the month for the owner', () => {
    show(report([waits('A', 'B')]), stopped('reserve', deferred));
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

  it('a stop by the owner is said on the rows too, with the waiting parts and the next scan, and the failure that was set aside', () => {
    const s = state({
      lastJob: job({ status: 'stopped', stopReason: 'user', stopMessage: 'SerpApi returned HTTP 404.', deferred }),
      nextRunAt: NOW + 3_600_000,
    });
    show(report([waits('A', 'B')]), s);
    expect(screen.getByText('You stopped the last scan')).toBeInTheDocument();
    expect(screen.getByText('Scan now picks up where it left off. 2 parts still need an Amazon lookup.')).toBeInTheDocument();
    expect(screen.queryByText('Change the limit')).toBeNull();
    expect(screen.getByText(/^Next scan /)).toBeInTheDocument();
    // N4: the failure kept on the job is said, not hidden.
    expect(screen.getByText('Set aside for the next scan. SerpApi answered with an error (HTTP 404). Try again later.')).toBeInTheDocument();
  });

  it('run_cap says how many searches the scan used against the limit (QA m7)', () => {
    const at = (used: number, limit: number) => ({ ...state({ lastJob: job({ status: 'stopped', stopReason: 'run_cap', searchesUsed: used }) }), settings: { ...DEFAULT_SETTINGS, searchesPerScan: limit } });
    show(report([row('c1')]), at(3, 3));
    expect(screen.getByText('It used the 3 searches allowed per scan.')).toBeInTheDocument();
    cleanup();
    show(report([row('c1')]), at(2, 3));
    expect(screen.getByText('It used 2 of the 3 searches allowed per scan.')).toBeInTheDocument();
    cleanup();
    show(report([row('c1')]), at(0, 1));
    expect(screen.getByText('It used 0 of the 1 search allowed per scan.')).toBeInTheDocument();
    cleanup();
    show(report([row('c1')]), at(1, 1));
    expect(screen.getByText('It used the 1 search allowed per scan.')).toBeInTheDocument();
  });

  it('says 1 search, and leaves out the parts clause when none wait', () => {
    show(report([row('c1')]), { ...state({ lastJob: job({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 1 }) }), settings: { ...DEFAULT_SETTINGS, searchesPerScan: 1 } });
    expect(screen.getByText('It used the 1 search allowed per scan.')).toBeInTheDocument();
    cleanup();
    show(report([row('c1')]), stopped('reserve'));
    expect(screen.getByText("The rest of this month's searches are kept for scans you start yourself.")).toBeInTheDocument();
  });

  it('says Try again now when the hour has passed', () => {
    show(report([row('c1')]), state({ lastJob: job({ status: 'stopped', stopReason: 'hourly_limit', finishedAt: NOW - 2 * 3_600_000 }) }));
    expect(screen.getByText('Try again now.')).toBeInTheDocument();
  });

  it('says Try again now, never "after now", in the hour\'s last minute', () => {
    show(report([row('c1')]), state({ lastJob: job({ status: 'stopped', stopReason: 'hourly_limit', finishedAt: NOW - 3_600_000 + 20_000 }) }));
    expect(screen.getByText('Try again now.')).toBeInTheDocument();
    expect(screen.queryByText(/after now/)).toBeNull();
  });

  it('says the list was scanned just now, not "scanned now"', () => {
    show(report([row('c1')]), state({ lastJob: job({ finishedAt: NOW - 10_000 }) }));
    expect(screen.getByText('1 bundle · scanned just now')).toBeInTheDocument();
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

describe('Look up names what it looks up', () => {
  const none = { status: 'waiting' as const, grade: null, availability: 'missing' as const, asin: null };

  it('names the one part, and the bundle for several, with the cost as quoted', async () => {
    const one = row('o1', { model: 'PCL1201K2', estimate: null, section: 'waiting', parts: [part('PCL1201K2', none)] });
    const two = row('t1', { model: 'PCL1201K2-PCL515B', estimate: null, section: 'waiting', parts: [part('PCL1201K2', none), part('PCL515B', none)] });
    show(report([one, two]), state(), { api: fakeApi({ searches: 1, refusal: null }).api });
    expect(await screen.findByRole('button', { name: 'Look up 1 search, PCL1201K2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Look up 1 search, 2 parts of PCL1201K2-PCL515B' })).toBeInTheDocument();
    // The visible label is unchanged.
    expect(screen.getByRole('button', { name: 'Look up 1 search, PCL1201K2' })).toHaveTextContent('Look up 1 search');
  });

  it('says at most N searches before the quote returns, and no search when it is free', async () => {
    const two = row('t1', { model: 'PCL1201K2-PCL515B', estimate: null, section: 'waiting', parts: [part('PCL1201K2', none), part('PCL515B', none)] });
    const never: WorkerApi = { send: vi.fn(() => new Promise(() => {})) as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([two]), state(), { api: never });
    expect(screen.getByRole('button', { name: 'Look up at most 2 searches, 2 parts of PCL1201K2-PCL515B' })).toHaveAttribute('aria-disabled', 'true');
    cleanup();
    show(report([two]), state(), { api: fakeApi({ searches: 0, refusal: null }).api });
    expect(await screen.findByRole('button', { name: 'Look up · no search, 2 parts of PCL1201K2-PCL515B' })).toHaveTextContent('Look up · no search');
  });

  it('labels the limit notice by its own heading', () => {
    show(report([row('c1')]), state({ lastJob: job({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 1 }) }));
    const band = screen.getByRole('region', { name: 'Scan stopped at your search limit' });
    expect(band).toHaveAttribute('aria-labelledby', screen.getByRole('heading', { name: 'Scan stopped at your search limit' }).id);
    expect(screen.queryByRole('region', { name: 'Scan limit' })).toBeNull();
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

  it('lays a row with a button out in two rows so the title spans the full width (H4)', async () => {
    show(report([waiting, row('c1')]));
    const button = await screen.findByRole('button', { name: /^Look up/ });
    const li = button.closest('li')!;
    const link = li.querySelector('a.deal-link')!;
    expect(li).toHaveClass('deal-row-lookup');
    expect(button.parentElement).toBe(li);
    expect(link.contains(button)).toBe(false);
    // The title is its own line in the link; the lines beside the button are one block under it.
    const title = link.querySelector('.deal-title')!;
    const subs = link.querySelector('.deal-subs')!;
    expect(title.nextElementSibling).toBe(subs);
    expect(subs.querySelectorAll('.deal-sub')).toHaveLength(2);
    // A row without a button keeps its plain layout.
    const plain = document.querySelector('a.deal-link[data-key="c1"]')!.closest('li')!;
    expect(plain).not.toHaveClass('deal-row-lookup');
  });

  it('asks for the price of the waiting parts, shows it on the button, and sends runPaid on click', async () => {
    const user = userEvent.setup();
    const { api, send } = fakeApi({ searches: 2, refusal: null });
    show(report([waiting, row('c1')]), state(), { api });
    const button = await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ });
    const action = { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'DCB1' }, { brand: 'DEWALT', model: 'DCB2' }] };
    expect(send).toHaveBeenCalledWith({ type: 'quote', action });
    expect(screen.getAllByRole('button', { name: /^Look up/ })).toHaveLength(1);
    await user.click(button);
    expect(send).toHaveBeenCalledWith({ type: 'runPaid', action });
  });

  it('says Look up · no search when the quote is free, never 0 searches (N8)', async () => {
    show(report([waiting]), state(), { api: fakeApi({ searches: 0, refusal: null }).api });
    const button = await screen.findByRole('button', { name: /^Look up · no search, .+$/ });
    expect(button).toBeEnabled();
    expect(screen.queryByRole('button', { name: /0 searches/ })).toBeNull();
  });

  it('keeps the button in the row beside the link, never inside it', async () => {
    show(report([waiting]), state(), { api: fakeApi({ searches: 2, refusal: null }).api });
    const button = await screen.findByRole('button', { name: /^Look up/ });
    const li = button.closest('li')!;
    expect(button.closest('a')).toBeNull();
    expect(li.querySelector('a.deal-link')).not.toBeNull();
    expect(button.parentElement).toBe(li);
  });

  it('says at most N searches until a quote returns, and ties the refusal to the button', async () => {
    const send = vi.fn(() => new Promise<Reply>(() => {}));
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([waiting]), state(), { api });
    expect(screen.getByRole('button', { name: /^Look up at most 2 searches, .+$/ })).toHaveAttribute('aria-disabled', 'true');
    cleanup();
    const sentence = 'The hourly search limit is reached.';
    show(report([waiting]), state(), { api: fakeApi({ searches: 2, refusal: sentence }).api });
    const text = await screen.findByText(sentence);
    expect(screen.getByRole('button', { name: /^Look up/ })).toHaveAttribute('aria-describedby', text.id);
  });

  it('keeps the last quoted count on the label while it is quoted again after a run', async () => {
    const user = userEvent.setup();
    let release: (r: Reply) => void = () => {};
    let quotes = 0;
    const send = vi.fn((r: Request): Promise<Reply> => {
      if (r.type === 'quote') return quotes++ === 0 ? Promise.resolve({ ok: true, data: { searches: 2, refusal: null } }) : new Promise<Reply>((res) => (release = res));
      return Promise.resolve({ ok: true, data: null });
    });
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([waiting]), state(), { api });
    await user.click(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ }));
    const button = await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    release({ ok: true, data: { searches: 1, refusal: null } });
    expect(await screen.findByRole('button', { name: /^Look up 1 search, .+$/ })).not.toHaveAttribute('aria-disabled');
  });

  it('says 1 search in the singular', async () => {
    show(report([waiting]), state(), { api: fakeApi({ searches: 1, refusal: null }).api });
    expect(await screen.findByRole('button', { name: /^Look up 1 search, .+$/ })).not.toHaveAttribute('aria-disabled');
  });

  it('disables the button and shows the refusal beneath', async () => {
    const sentence = 'The hourly search limit is reached. Try again after 15:00.';
    show(report([waiting]), state(), { api: fakeApi({ searches: 2, refusal: sentence }).api });
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Look up/ })).toHaveAttribute('aria-disabled', 'true');
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
    const button = await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ });
    await user.click(button);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(send.mock.calls.filter((c) => c[0].type === 'runPaid')).toHaveLength(1);
    release({ ok: false, error: 'Not available yet.' });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('reads Looking up… while its request runs, and says a failure in words (QA m4)', async () => {
    const user = userEvent.setup();
    let release: (r: Reply) => void = () => {};
    const send = vi.fn((r: Request): Promise<Reply> => {
      if (r.type === 'quote') return Promise.resolve({ ok: true, data: { searches: 2, refusal: null } });
      return new Promise((ok) => (release = ok));
    });
    const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([waiting]), state(), { api });
    await user.click(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ }));
    expect(screen.getByRole('button', { name: 'Looking up…' })).toHaveAttribute('aria-disabled', 'true');
    release({ ok: false, error: 'SerpApi returned HTTP 404.' });
    expect(await screen.findByText('SerpApi answered with an error (HTTP 404). Try again later.')).toBeInTheDocument();
    expect(screen.queryByText(/returned HTTP/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Looking up…' })).toBeNull();
  });

  const waiting2 = { ...waiting, key: 'w2', title: 'Title of w2', parts: [part('DCB3', { status: 'waiting', grade: null, availability: 'missing', asin: null })] };
  const props = (api: WorkerApi, s: AppState) => ({ api, report: report([waiting]), state: s, sort: 'profit' as const, onSort: vi.fn(), onOpen: vi.fn() });

  it('keeps every Look up disabled while any one is in flight', async () => {
    const user = userEvent.setup();
    let release: (r: Reply) => void = () => {};
    const send = vi.fn((r: Request): Promise<Reply> => {
      if (r.type === 'quote') return Promise.resolve({ ok: true, data: { searches: 1, refusal: null } });
      return new Promise((ok) => (release = ok));
    });
    const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([waiting, waiting2]), state(), { api });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Look up .*\d.*, / })).toHaveLength(2));
    const [first, second] = screen.getAllByRole('button', { name: /^Look up/ });
    await user.click(first!);
    expect(first).toHaveAttribute('aria-disabled', 'true');
    expect(second).toHaveAttribute('aria-disabled', 'true');
    await user.click(second!);
    expect(send.mock.calls.filter((c) => c[0].type === 'runPaid')).toHaveLength(1);
    release({ ok: true, data: null });
    await waitFor(() => expect(second).toBeEnabled());
  });

  it('is disabled with a sentence while a scan runs, and asks again when it ends', async () => {
    const { api } = fakeApi({ searches: 2, refusal: null });
    const { view } = show(report([waiting]), state({ scanRunning: true }), { api });
    expect(screen.getByText('A scan is running.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Look up at most 2 searches, .+$/ })).toHaveAttribute('aria-disabled', 'true');
    view.rerender(createElement(DealsTab, props(api, state({ scanRunning: false }))));
    expect(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ })).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText('A scan is running.')).toBeNull();
  });

  it('a refusal is gone once a later quote succeeds', async () => {
    let refuse = true;
    const { api } = fakeApi((r) =>
      r.type === 'quote' ? { ok: true, data: { searches: 2, refusal: refuse ? 'A scan is already running.' : null } } : { ok: true, data: null },
    );
    const { view } = show(report([waiting]), state({ scanRunning: false }), { api });
    expect(await screen.findByText('A scan is already running.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Look up/ })).toHaveAttribute('aria-disabled', 'true');
    refuse = false;
    // A scan starts and ends: the price is asked for again.
    view.rerender(createElement(DealsTab, props(api, state({ scanRunning: true }))));
    view.rerender(createElement(DealsTab, props(api, state({ scanRunning: false }))));
    expect(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ })).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText('A scan is already running.')).toBeNull();
  });

  it('tells the panel when its Look up has ended, refused or not', async () => {
    const user = userEvent.setup();
    const onPaidEnd = vi.fn();
    const { api } = fakeApi((r) => (r.type === 'quote' ? { ok: true, data: { searches: 2, refusal: null } } : { ok: false, error: 'Not available yet.' }));
    render(createElement(DealsTab, { api, report: report([waiting]), state: state(), sort: 'profit', onSort: vi.fn(), onOpen: vi.fn(), onPaidEnd }));
    await user.click(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ }));
    await waitFor(() => expect(onPaidEnd).toHaveBeenCalledTimes(1));
  });

  it('asks for the price again after a run, before the button can be pressed again', async () => {
    const user = userEvent.setup();
    let searchesLeft = 2;
    const send = vi.fn(async (r: Request): Promise<Reply> => {
      if (r.type === 'quote') return { ok: true, data: { searches: searchesLeft, refusal: null } };
      searchesLeft = 1;
      return { ok: true, data: null };
    });
    const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([waiting]), state(), { api });
    await user.click(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ }));
    expect(await screen.findByRole('button', { name: /^Look up 1 search, .+$/ })).not.toHaveAttribute('aria-disabled');
    expect(send.mock.calls.filter((c) => c[0].type === 'quote')).toHaveLength(2);
  });

  it('keeps a failed run\'s sentence through the next successful quote, and clears it on the next click', async () => {
    const user = userEvent.setup();
    let fail = true;
    const send = vi.fn(async (r: Request): Promise<Reply> => {
      if (r.type === 'quote') return { ok: true, data: { searches: 2, refusal: null } };
      return fail ? { ok: false, error: 'Not available yet.' } : { ok: true, data: null };
    });
    const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(report([waiting]), state(), { api });
    await user.click(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ }));
    expect(await screen.findByText('Not available yet.')).toBeInTheDocument();
    // The re-quote after the run succeeded; the sentence is still there.
    await waitFor(() => expect(send.mock.calls.filter((c) => c[0].type === 'quote')).toHaveLength(2));
    expect(screen.getByText('Not available yet.')).toBeInTheDocument();
    fail = false;
    await user.click(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ }));
    await waitFor(() => expect(screen.queryByText('Not available yet.')).toBeNull());
  });

  it('does not ask again when only the api object changes', async () => {
    const { api, send } = fakeApi({ searches: 2, refusal: null });
    const r = report([waiting]);
    const s = state();
    const { view } = show(r, s, { api });
    await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ });
    view.rerender(createElement(DealsTab, { ...props({ ...api }, s), report: r }));
    expect(send.mock.calls.filter((c) => c[0].type === 'quote')).toHaveLength(1);
  });

  it('has no Look up when no part waits', () => {
    show(report([row('c1')]));
    expect(screen.queryByRole('button', { name: /Look up/ })).toBeNull();
  });

  /** Quotes answer only when told to, oldest first; anything else answers at once. */
  function heldQuotes() {
    const pending: ((r: Reply) => void)[] = [];
    const send = vi.fn((r: Request): Promise<Reply> => (r.type === 'quote' ? new Promise((ok) => pending.push(ok)) : Promise.resolve({ ok: true, data: null })));
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    const answer = async (searches: number) => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!({ ok: true, data: { searches, refusal: null } });
    };
    return { api, answer };
  }

  it('after a scan ends, stays disabled until the new quote comes, with the last count on its label', async () => {
    const { api, answer } = heldQuotes();
    const r = report([waiting]);
    const tab = (s: AppState) => createElement(DealsTab, { api, report: r, state: s, sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() });
    const view = render(tab(state()));
    await answer(2);
    expect(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ })).not.toHaveAttribute('aria-disabled');
    view.rerender(tab(state({ scanRunning: true })));
    view.rerender(tab(state({ scanRunning: false })));
    // The quote from before the scan is not this one's.
    expect(screen.getByRole('button', { name: /^Look up 2 searches, .+$/ })).toHaveAttribute('aria-disabled', 'true');
    await answer(1);
    expect(await screen.findByRole('button', { name: /^Look up 1 search, .+$/ })).not.toHaveAttribute('aria-disabled');
  });

  it('after its parts change, stays disabled until their quote comes', async () => {
    const { api, answer } = heldQuotes();
    const more = { ...waiting, parts: [...waiting.parts, part('DCB3', { status: 'waiting', grade: null, availability: 'missing', asin: null })] };
    const tab = (r: BundleRow) => createElement(DealsTab, { api, report: report([r]), state: state(), sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() });
    const view = render(tab(waiting));
    await answer(2);
    expect(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ })).not.toHaveAttribute('aria-disabled');
    view.rerender(tab(more));
    expect(screen.getByRole('button', { name: /^Look up 2 searches, .+$/ })).toHaveAttribute('aria-disabled', 'true');
    await answer(3);
    expect(await screen.findByRole('button', { name: /^Look up 3 searches, .+$/ })).not.toHaveAttribute('aria-disabled');
  });

  it('asks again when a new report comes, so a refusal from a paid action elsewhere does not stay', async () => {
    const paying = 'A Look up or Verify is running.';
    let refusal: string | null = paying;
    const { api, send } = fakeApi((r) => (r.type === 'quote' ? { ok: true, data: { searches: 2, refusal } } : { ok: true, data: null }));
    const tab = (r: PanelReport) => createElement(DealsTab, { api, report: r, state: state(), sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() });
    const view = render(tab(report([waiting])));
    expect(await screen.findByText(paying)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Look up 2 searches, .+$/ })).toHaveAttribute('aria-disabled', 'true');
    // The other screen's Verify ended: the worker broadcast, and the panel read the report again.
    refusal = null;
    view.rerender(tab(report([waiting])));
    expect(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ })).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(paying)).toBeNull();
    expect(send.mock.calls.filter((c) => c[0].type === 'quote')).toHaveLength(2);
  });

  it('offers Look up for parts with no match yet, as when the owner chose the split after the scan', async () => {
    const chosen = row('u1', {
      estimate: null,
      section: 'missing_listing',
      parts: [part('DCKTS650D1P1', { status: 'unmatched', grade: null, availability: 'missing', asin: null }), part('DCF921B', { status: 'unmatched', grade: null, availability: 'missing', asin: null })],
    });
    const { api, send } = fakeApi({ searches: 2, refusal: null });
    show(report([chosen]), state(), { api });
    expect(await screen.findByRole('button', { name: /^Look up 2 searches, .+$/ })).not.toHaveAttribute('aria-disabled');
    expect(send).toHaveBeenCalledWith({ type: 'quote', action: { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'DCKTS650D1P1' }, { brand: 'DEWALT', model: 'DCF921B' }] } });
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
  it('says the first scan is running while it runs and none has finished', () => {
    show(report([]), state({ scanRunning: true, lastJob: null }));
    expect(screen.getByText('The first scan is running.')).toBeInTheDocument();
    cleanup();
    show(report([]), state({ scanRunning: true, lastJob: job({ status: 'running', finishedAt: null }) }));
    expect(screen.getByText('The first scan is running.')).toBeInTheDocument();
    expect(screen.queryByText(/No scan yet/)).toBeNull();
  });
  it('says the last scan found no bundles only when it finished', () => {
    show(report([]));
    expect(screen.getByText('The last scan found no bundles.')).toBeInTheDocument();
  });
  it('says nothing of its own when an error or rate limit stopped the scan: the notice explains it', () => {
    for (const stopReason of ['error', 'rate_limited'] as const) {
      show(report([]), state({ lastJob: job({ status: 'stopped', stopReason }) }));
      expect(screen.queryByText(/The last scan/)).toBeNull();
      cleanup();
    }
  });
  it('says the owner stopped the scan, with no limit link, and not the plain empty-state sentence as well', () => {
    show(report([]), state({ lastJob: job({ status: 'stopped', stopReason: 'user' }) }));
    expect(screen.getByText('You stopped the last scan')).toBeInTheDocument();
    expect(screen.getByText('Scan now picks up where it left off.')).toBeInTheDocument();
    expect(screen.queryByText('Change the limit')).toBeNull();
    expect(screen.queryByText(/did not finish/)).toBeNull();
  });
  it('under a limit notice, says nothing else', () => {
    show(report([]), state({ lastJob: job({ status: 'stopped', stopReason: 'run_cap' }) }));
    expect(screen.getByText('Scan stopped at your search limit')).toBeInTheDocument();
    expect(screen.queryByText(/The last scan/)).toBeNull();
    expect(screen.queryByText(/No scan yet/)).toBeNull();
  });
});

describe('Download CSV', () => {
  // Hand-made rows (labelled): they only need distinct sections and profits to show the order.
  const bundles = [
    row('s1', { section: 'split', parts: [], estimate: null }),
    row('c1', { estimate: est(100, 0.1) }),
    row('c2', { estimate: est(300, 0.3) }),
    row('m1', { section: 'missing_listing', estimate: null, parts: [part('X1', { status: 'none', availability: 'missing', grade: null })] }),
  ];

  it('saves every bundle in the order Deals shows, named for the local date', async () => {
    const { api } = fakeApi({ searches: 1, refusal: null });
    show(report(bundles), state(), { api });
    // The clock moves two days between render and click: the click day names the file.
    vi.setSystemTime(NOW + 2 * DAY);
    await userEvent.click(screen.getByRole('button', { name: 'Download CSV' }));
    const download = api.download as ReturnType<typeof vi.fn>;
    expect(download).toHaveBeenCalledTimes(1);
    const [file, text, type] = download.mock.calls[0] as [string, string, string];
    expect(file).toBe('split-finder-deals-2026-11-12.csv');
    expect(type).toBe('text/csv');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(1 + bundles.length);
    expect(lines[0]).toBe(bundlesCsv([]).trimEnd());
    expect(lines.slice(1).map((l) => bundles.find((b) => l.includes(`Title of ${b.key}`))!.key)).toEqual(['c2', 'c1', 'm1', 's1']);
  });

  it('is absent with no bundles', () => {
    show(report([]), state({ lastJob: job() }));
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
  });
});

describe('stale prices', () => {
  const aged = (days: number) => row('c1', { parts: [part('A'), part('B', { priceSeenAt: NOW - days * DAY - 3_600_000 })] });
  it('names the age of the oldest shown price when it is past the freshness period', () => {
    show(report([aged(4)]));
    expect(screen.getByText('Prices seen 4 days ago. The next scan refreshes them.')).toBeInTheDocument();
  });
  it('is absent when prices are fresh', () => {
    show(report([aged(2)]));
    expect(screen.queryByText(/^Prices seen/)).toBeNull();
  });
});
