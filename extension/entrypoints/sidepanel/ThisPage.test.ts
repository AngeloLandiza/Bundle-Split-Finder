// @vitest-environment jsdom
// The This page tab on views that notePage really made: the recorded Home Depot pages (fixtures/homedepot-pages), priced
// in the shape captured on Nov 17, over a store that a replayed scan did or did not fill. Nothing reaches the network.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { replayRecorded } from '../../../scripts/replay';
import { SERPAPI_ACCOUNT_FREE } from '../../../core/test/fixtures';
import { parseProductPage, type ProductPage } from '@core/hdPage';
import { reviewSignature } from '@core/scan/answers';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { notePage } from '@core/scan/pageView';
import { buildReport } from '@core/scan/report';
import { runScan } from '@core/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@core/scan/types';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, SerpApiClient } from '@core/serpapi/client';
import { DEFAULT_SETTINGS } from '@core/settings';
import type { AppState, PanelReport, Reply, Request, ThisPage } from '../../lib/messages';
import type { ActiveTab, PanelTabs, WorkerApi } from '../../lib/pageClient';
import { App } from './App';
import { NO_PAGE, ThisPageTab } from './ThisPageTab';

afterEach(cleanup);

const T0 = Date.UTC(2026, 10, 9, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

const recorded = (JSON.parse(readFileSync(resolve('fixtures/homedepot-pages/pages-2026-11-10.json'), 'utf8')) as {
  pages: { itemId: string; text: string }[];
}).pages;
const textOf = (id: string) => recorded.find((p) => p.itemId === id)!.text;
/** 328814689 as the owner sees it: the recorded page, priced as captured ($189, was $338). */
const founderPage = (): ProductPage => {
  const mark = '"base-catalog-328814689":{';
  const entry = '"pricing({\\"isBrandPricingPolicyCompliant\\":false,\\"storeId\\":\\"8119\\"})":{"value":189,"original":338},';
  return parseProductPage(textOf('328814689').replace(mark, mark + entry), '328814689')!;
};
/** PCL500525SB: no split rule and no Includes list, so its split is a question that offers no reading. */
const askedPage = (): ProductPage => parseProductPage(textOf('328690510'), '328690510')!;

const FOUNDER_URL = 'https://www.homedepot.com/p/RYOBI-ONE-HP-18V-Extended-Reach-Ratchets/328814689';
const ASKED_URL = 'https://www.homedepot.com/p/328690510';

interface World {
  /** The founder's page after a replayed ratchet scan: priced, matched, estimated. */
  scanned: { view: ThisPage; report: PanelReport };
  /** The founder's page on an empty store: split from the page, nothing looked up. */
  fresh: { view: ThisPage; report: PanelReport };
  /** A page that needs an answer, on an empty store. */
  asked: { view: ThisPage; report: PanelReport };
}

let w: World;
beforeAll(async () => {
  const scanned = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store: scanned, settings: RATCHET, now: () => T0 });
  const of = async (store: MemoryScanStore, page: ProductPage) => ({
    view: (await notePage(store, RATCHET, page, T0 + 3_600_000)) as ThisPage,
    report: { ...(await buildReport(store, RATCHET)), packaging: {} } as PanelReport,
  });
  w = { scanned: await of(scanned, founderPage()), fresh: await of(new MemoryScanStore(), founderPage()), asked: await of(new MemoryScanStore(), askedPage()) };
});

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null, ...over,
});
const EMPTY_REPORT = { bundles: [], review: [], packaging: {} } as unknown as PanelReport;

/** A panel's world: the worker's answers by tab, and a browser whose active tab and nudges the test drives. */
function browser(initial: ActiveTab | null, pages: Record<number, ThisPage>, report: PanelReport = EMPTY_REPORT) {
  let active = initial;
  const changed = new Set<() => void>();
  const nudged = new Set<(tabId: number) => void>();
  const wanted = new Set<number>();
  let stateListener: (s: AppState) => void = () => {};
  const send = vi.fn(async (r: Request): Promise<Reply> => {
    if (r.type === 'getState') return { ok: true, data: state() };
    if (r.type === 'getReport') return { ok: true, data: report };
    if (r.type === 'getThisPage') return { ok: true, data: pages[r.tabId] ?? { kind: 'empty' } };
    if (r.type === 'takeShowThisPage') {
      const was = wanted.has(r.tabId);
      wanted.delete(r.tabId);
      return { ok: true, data: was };
    }
    return { ok: true, data: null };
  });
  const tabs: PanelTabs = {
    active: async () => active,
    onChanged: (l) => {
      changed.add(l);
      return () => changed.delete(l);
    },
    onShowThisPage: (l) => {
      nudged.add(l);
      return () => nudged.delete(l);
    },
  };
  const api: WorkerApi = {
    send: send as WorkerApi['send'],
    onStateChanged: (l) => {
      stateListener = l;
      return () => {};
    },
    download: vi.fn(),
    tabs,
  };
  return {
    api,
    send,
    wanted,
    /** The owner switches to another tab, or a page in the tab navigates. */
    goTo: (tab: ActiveTab | null) => act(async () => {
      active = tab;
      changed.forEach((l) => l());
    }),
    chipClicked: (tabId: number) => act(async () => {
      wanted.add(tabId);
      nudged.forEach((l) => l(tabId));
    }),
    emit: (s: AppState) => act(async () => stateListener(s)),
    pages,
  };
}

const openDetail = vi.fn();
const renderTab = (b: ReturnType<typeof browser>, tab: ActiveTab | null, over: { report?: PanelReport; state?: AppState } = {}) =>
  render(createElement(ThisPageTab, { api: b.api, report: over.report ?? EMPTY_REPORT, state: over.state ?? state(), tab, onOpenDetail: openDetail }));

describe('This page: a bundle read from the page', () => {
  it('after a scan: the header line, an estimate labelled as one, the cost line, both parts and no search spent', async () => {
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.scanned.view });
    renderTab(b, { id: 7, url: FOUNDER_URL }, { report: w.scanned.report });
    await screen.findByText('read from this page · no search used');
    const head = screen.getByRole('region', { name: 'Estimate' });
    expect(within(head).getByText('PBLRC2501SB')).toBeInTheDocument();
    expect(within(head).getByText('Est. profit')).toBeInTheDocument();
    expect(within(head).getByText('+$79.55')).toBeInTheDocument();
    expect(within(head).getByText('ROI 42%')).toBeInTheDocument();
    expect(head.querySelector('.thispage-cost')).toHaveTextContent('Costs $189.00 · parts net $268.55 after fees');
    expect(head).toHaveTextContent('Estimate from your fee settings');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('PARTS · 2');
    const parts = screen.getAllByRole('listitem');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveTextContent('PBLRC25B');
    expect(parts[1]).toHaveTextContent('PBLRC01B');
    expect(within(parts[0]!).getByRole('link', { name: /B0B3JWF5ZV on Amazon/ })).toHaveAttribute('href', 'https://www.amazon.com/dp/B0B3JWF5ZV');
    expect(within(parts[0]!).getByText('Title match')).toBeInTheDocument();
    // It asked the worker for this tab's page, once, and nothing that spends.
    expect(b.send.mock.calls.map((c) => c[0].type)).toEqual(['getThisPage']);
    expect(b.send).toHaveBeenCalledWith({ type: 'getThisPage', tabId: 7 });
    // A Title match offers Verify in Detail, which costs a search; This page offers none.
    expect(screen.queryByRole('button', { name: /^Verify/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Look up/ })).toBeNull();
  });

  it('a loss is a real minus in the loss colour and still says it is an estimate', async () => {
    const view = structuredClone(w.scanned.view) as Extract<ThisPage, { kind: 'bundle' }>;
    view.row.estimate = { ...view.row.estimate!, profit: -22.7, roi: -0.06 };
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: view });
    renderTab(b, { id: 7, url: FOUNDER_URL }, { report: w.scanned.report });
    expect(await screen.findByText('−$22.70')).toBeInTheDocument();
    expect(screen.getByText('ROI −6%')).toBeInTheDocument();
    expect(screen.getByText('Est. profit')).toBeInTheDocument();
    expect(screen.getByText('−$22.70').parentElement).toHaveAttribute('data-loss', 'true');
  });

  it('on an empty store: split from the page, no estimate and no number, and the way to look the parts up', async () => {
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.fresh.view });
    renderTab(b, { id: 7, url: FOUNDER_URL }, { report: w.fresh.report });
    expect(await screen.findByText(/^No estimate yet: 2 parts still need an Amazon lookup\./)).toBeInTheDocument();
    expect(screen.queryByText('Est. profit')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByText('Not looked up yet')).toHaveLength(2);
  });

  it('a bundle that needs an answer shows the Review question; saving sends the answer as shown', async () => {
    const user = userEvent.setup();
    const view = w.asked.view as Extract<ThisPage, { kind: 'bundle' }>;
    const b = browser({ id: 4, url: ASKED_URL }, { 4: view });
    renderTab(b, { id: 4, url: ASKED_URL }, { report: w.asked.report });
    expect(await screen.findByRole('group', { name: /Which parts come in this bundle\?/ })).toBeInTheDocument();
    expect(screen.queryByText('Est. profit')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'None of these' }));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(b.send).toHaveBeenCalledWith({ type: 'answerReview', id: view.question!.id, answer: { none: true, seen: reviewSignature(view.question!) } });
  });

  it('a refused answer says why, in the worker\'s sentence', async () => {
    const user = userEvent.setup();
    const view = w.asked.view as Extract<ThisPage, { kind: 'bundle' }>;
    const b = browser({ id: 4, url: ASKED_URL }, { 4: view });
    b.send.mockImplementation(async (r: Request) => (r.type === 'answerReview' ? { ok: false, error: 'A search is running. Answer again when it has finished.' } : { ok: true, data: view }));
    renderTab(b, { id: 4, url: ASKED_URL });
    await user.click(await screen.findByRole('radio', { name: 'None of these' }));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A search is running. Answer again when it has finished.');
  });

  it('while a scan runs the question cannot be saved, and says so', async () => {
    const view = w.asked.view as Extract<ThisPage, { kind: 'bundle' }>;
    const b = browser({ id: 4, url: ASKED_URL }, { 4: view });
    renderTab(b, { id: 4, url: ASKED_URL }, { state: state({ scanRunning: true }) });
    expect(await screen.findByRole('button', { name: 'Save answer' })).toBeDisabled();
    expect(screen.getByText('A scan is running. Answer when it has finished.')).toBeInTheDocument();
  });

  it('Open full detail opens Detail for the bundle; Copy ASINs copies both', async () => {
    const user = userEvent.setup();
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.scanned.view });
    renderTab(b, { id: 7, url: FOUNDER_URL }, { report: w.scanned.report });
    await user.click(await screen.findByRole('button', { name: 'Open full detail' }));
    expect(openDetail).toHaveBeenCalledWith('homedepot:328814689');
    await user.click(screen.getByRole('button', { name: 'Copy both ASINs' }));
    expect(await navigator.clipboard.readText()).toBe('B0B3JWF5ZV B0B6Z2ZGVK');
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  });

  it('a bundle not saved yet (a scan holds it back) cannot open Detail, and the panel says when it can', async () => {
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.fresh.view });
    renderTab(b, { id: 7, url: FOUNDER_URL }, { report: EMPTY_REPORT });
    expect(await screen.findByRole('button', { name: 'Open full detail' })).toBeDisabled();
    expect(screen.getByText('Full detail opens when the scan has ended and this bundle is saved.')).toBeInTheDocument();
  });
});

describe('This page: no bundle to show', () => {
  it('no tab, a tab with no page seen, and a tab on another address say to open a bundle page', async () => {
    const none = browser(null, {});
    const { unmount } = renderTab(none, null);
    expect(screen.getByText(NO_PAGE)).toBeInTheDocument();
    unmount();

    const unseen = browser({ id: 9, url: 'https://www.homedepot.com/' }, {});
    renderTab(unseen, { id: 9, url: 'https://www.homedepot.com/' });
    expect(await screen.findByText(NO_PAGE)).toBeInTheDocument();
  });

  it('a tab that went on to a page the chip does not read is empty, even if the worker still holds the last bundle', async () => {
    const b = browser({ id: 7, url: 'https://www.homedepot.com/b/Tools/N-5yc1v' }, { 7: w.scanned.view });
    renderTab(b, { id: 7, url: 'https://www.homedepot.com/b/Tools/N-5yc1v' }, { report: w.scanned.report });
    expect(await screen.findByText(NO_PAGE)).toBeInTheDocument();
    expect(screen.queryByText('Est. profit')).toBeNull();
    // Another bundle's address is no match either.
    cleanup();
    renderTab(b, { id: 7, url: ASKED_URL }, { report: w.scanned.report });
    expect(await screen.findByText(NO_PAGE)).toBeInTheDocument();
  });

  it('an unreachable worker says so in one sentence', async () => {
    const b = browser({ id: 7, url: FOUNDER_URL }, {});
    b.send.mockRejectedValue(new Error('gone'));
    renderTab(b, { id: 7, url: FOUNDER_URL });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the extension.');
  });
});

describe('This page in the panel', () => {
  const tab = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
  const mount = (b: ReturnType<typeof browser>) => render(createElement(App, { api: b.api, openSettings: vi.fn(), now: () => T0 }));

  it('opens on Deals when the owner opened the panel, and shows the page of the active tab on This page', async () => {
    const user = userEvent.setup();
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.scanned.view }, w.scanned.report);
    mount(b);
    await screen.findByRole('navigation', { name: 'Views' });
    expect(tab('Deals')).toHaveAttribute('aria-current', 'true');
    // It took the chip's answer for the active tab, and there was none.
    await waitFor(() => expect(b.send).toHaveBeenCalledWith({ type: 'takeShowThisPage', tabId: 7 }));
    await user.click(tab('This page'));
    expect(await screen.findByText('read from this page · no search used')).toBeInTheDocument();
    expect(tab('This page')).toHaveAttribute('aria-current', 'true');
  });

  it('opens on This page when the chip opened the panel for the active tab, once', async () => {
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.scanned.view }, w.scanned.report);
    b.wanted.add(7);
    mount(b);
    expect(await screen.findByText('read from this page · no search used')).toBeInTheDocument();
    expect(tab('This page')).toHaveAttribute('aria-current', 'true');
    cleanup();
    // Taken: a panel that starts later opens on Deals.
    mount(b);
    await screen.findByRole('navigation', { name: 'Views' });
    await waitFor(() => expect(b.send.mock.calls.filter((c) => c[0].type === 'takeShowThisPage')).toHaveLength(2));
    expect(tab('Deals')).toHaveAttribute('aria-current', 'true');
  });

  it('a chip click while the panel is open on Deals, or in a bundle\'s Detail, brings it to This page', async () => {
    const user = userEvent.setup();
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.scanned.view }, w.scanned.report);
    mount(b);
    await screen.findByRole('navigation', { name: 'Views' });
    await screen.findByText(/^\d+ bundles$/);
    await user.click(document.querySelector<HTMLElement>('[data-key="homedepot:328814689"]')!);
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    await b.chipClicked(7);
    expect(await screen.findByText('read from this page · no search used')).toBeInTheDocument();
    expect(tab('This page')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('follows the owner: another tab shows its own page, a tab with none says to open one, and the last page is not left on screen', async () => {
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.scanned.view, 4: w.asked.view }, w.scanned.report);
    b.wanted.add(7);
    mount(b);
    expect(await screen.findByText('+$79.55')).toBeInTheDocument();

    await b.goTo({ id: 4, url: ASKED_URL });
    expect(await screen.findByRole('group', { name: /Which parts come in this bundle\?/ })).toBeInTheDocument();
    expect(screen.queryByText('+$79.55')).toBeNull();

    await b.goTo({ id: 12, url: 'https://www.amazon.com/' });
    expect(await screen.findByText(NO_PAGE)).toBeInTheDocument();

    // The page in a tab navigates inside the site: the same tab, a new address, a new page.
    await b.goTo({ id: 7, url: FOUNDER_URL });
    expect(await screen.findByText('+$79.55')).toBeInTheDocument();
  });

  it('asks the worker again when the state changes (an answer, a scan ending), with the same tab', async () => {
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.fresh.view }, w.fresh.report);
    b.wanted.add(7);
    mount(b);
    await screen.findByText(/^No estimate yet/);
    const reads = () => b.send.mock.calls.filter((c) => c[0].type === 'getThisPage').length;
    const before = reads();
    b.pages[7] = w.scanned.view;
    await b.emit(state());
    await screen.findByText('+$79.55');
    expect(reads()).toBeGreaterThan(before);
  });

  it('Open full detail goes to Detail, whose Back says This page and returns to it', async () => {
    const user = userEvent.setup();
    const b = browser({ id: 7, url: FOUNDER_URL }, { 7: w.scanned.view }, w.scanned.report);
    b.wanted.add(7);
    mount(b);
    await user.click(await screen.findByRole('button', { name: 'Open full detail' }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(/Extended Reach Ratchets/);
    const back = screen.getByRole('button', { name: 'This page' });
    await user.click(back);
    expect(await screen.findByText('read from this page · no search used')).toBeInTheDocument();
    expect(tab('This page')).toHaveAttribute('aria-current', 'true');
  });
});
