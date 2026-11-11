// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEES } from '@core/money';
import { DEFAULT_SETTINGS } from '@core/settings';
import { reviewSignature } from '@core/scan/answers';
import type { BundleRow, PartRow, ReviewItem, ScanJob } from '@core/scan/types';
import type { AppState, PanelReport, Quote, Reply, Request } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { Detail } from './Detail';

afterEach(cleanup);

const NOW = new Date(2026, 10, 10, 14, 0, 0).getTime();
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
  asin: 'B0B3JWF5ZV',
  grade: 'exact',
  price: 169,
  priceSeenAt: NOW - 3 * 3_600_000,
  image: null,
  title: 'RYOBI ONE+ HP 18V 3/8 in. Extended Reach Ratchet',
  ...over,
});

const row = (over: Partial<BundleRow> = {}): BundleRow => ({
  key: 'homedepot:1',
  itemId: '1',
  brand: 'RYOBI',
  model: 'PBLRC2501SB',
  title: 'ONE+ HP 18V Extended Reach Ratchets (Tools Only)',
  link: 'https://www.homedepot.com/p/328814689',
  price: 189,
  regularPrice: 338,
  percentOff: 44,
  seenAt: NOW - 3 * 3_600_000,
  status: 'complete',
  section: 'confirmed',
  parts: [part('PBLRC25B'), part('PBLRC01B', { asin: 'B0B6Z2ZGVK' })],
  estimate: { cost: 189, netRevenue: 287.3, profit: 98.3, roi: 0.52 },
  uncovered: [],
  answer: null,
  ...over,
});

const state = (over: Partial<AppState> = {}): AppState => ({
  hasKey: true,
  account: null,
  accountCheckedAt: 1,
  problem: null,
  settings: DEFAULT_SETTINGS,
  scanRunning: false,
  lastJob: null as unknown as ScanJob,
  nextRunAt: null,
  ...over,
});

function fakeApi(handler: (r: Request) => Reply = () => ({ ok: true, data: null }), quote: Quote = { searches: 1, refusal: null }) {
  const send = vi.fn(async (r: Request): Promise<Reply> => (r.type === 'quote' ? { ok: true, data: quote } : handler(r)));
  const download = vi.fn();
  const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download };
  return { api, send, download };
}

const question = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: 'split:homedepot:1',
  kind: 'split',
  subject: 'homedepot:1',
  brand: 'RYOBI',
  model: 'PCL1600K2-P553',
  title: 'ONE+ 18V Drill and Impact Driver Kit',
  reason: 'The model number names its parts, but not all of them are known products yet.',
  candidates: [],
  choices: [['PCL1600K2', 'P553']],
  openedAt: 1,
  answer: null,
  answeredAt: null,
  ...over,
});

function show(r: BundleRow, extra: { packaging?: PanelReport['packaging']; api?: WorkerApi; state?: AppState; onBack?: () => void; review?: ReviewItem[] } = {}) {
  const report: PanelReport = { bundles: [r], review: extra.review ?? [], packaging: extra.packaging ?? {} };
  const onBack = extra.onBack ?? vi.fn();
  const api = extra.api ?? fakeApi().api;
  render(createElement(Detail, { api, report, state: extra.state ?? state(), bundleKey: r.key, onBack }));
  return { onBack, api };
}

describe('head and top bar', () => {
  it('goes back, and opens Home Depot in a new tab safely', async () => {
    const user = userEvent.setup();
    const { onBack } = show(row());
    await user.click(screen.getByRole('button', { name: 'Deals' }));
    expect(onBack).toHaveBeenCalled();
    const open = screen.getByRole('link', { name: /^Open on Home Depot/ });
    expect(open).toHaveAttribute('href', 'https://www.homedepot.com/p/328814689');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows brand, title, model and when the price was seen', () => {
    show(row());
    expect(screen.getByText('RYOBI')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ONE+ HP 18V Extended Reach Ratchets (Tools Only)');
    expect(screen.getByText('PBLRC2501SB')).toBeInTheDocument();
    expect(screen.getByText(/^Home Depot · price seen 11:00/)).toBeInTheDocument();
  });

  it("reads Home Depot's time from the row, not the newest part's", () => {
    show(row({ seenAt: NOW - 3 * 3_600_000, parts: [part('A1', { priceSeenAt: NOW - 60_000 })] }));
    expect(screen.getByText(/^Home Depot · price seen 11:00/)).toBeInTheDocument();
  });

  it('takes focus on its title when it opens, which can be focused but is not a tab stop', () => {
    show(row());
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveFocus();
    expect(title).toHaveAttribute('tabindex', '-1');
  });

  it('says so when the bundle is no longer in the report', () => {
    render(createElement(Detail, { api: fakeApi().api, report: { bundles: [], review: [], packaging: {} }, state: state(), bundleKey: 'gone', onBack: vi.fn() }));
    expect(screen.getByText('This bundle is no longer in the report.')).toBeInTheDocument();
  });
});

describe('headline', () => {
  it('shows profit, ROI, cost, sells for and after fees, with the estimate line and a Change link', () => {
    show(row());
    expect(screen.getByText('+$98.30')).toBeInTheDocument();
    expect(screen.getByText('ROI 52%')).toBeInTheDocument();
    const figures = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(figures('Bundle costs')).toBe('$189.00');
    expect(figures('Parts sell for')).toBe('$338.00');
    expect(figures('After fees')).toBe('$287.30');
    expect(screen.getByText(/^Estimate from your fee settings \(15% referral, no fulfillment fee\)\./)).toBeInTheDocument();
    const change = screen.getByRole('link', { name: 'Change' });
    expect(change.getAttribute('href')).toMatch(/options\.html$/);
  });

  it('writes the fee settings it was given', () => {
    show(row(), { state: state({ settings: { ...DEFAULT_SETTINGS, fees: { ...DEFAULT_FEES, referralRate: 0.12, fulfillmentFee: 3.5 } } }) });
    expect(screen.getByText(/\(12% referral, \$3\.50 fulfillment per unit\)\./)).toBeInTheDocument();
  });

  it('adds sales tax and inbound cost to the fee text only when they are not zero', () => {
    show(row(), { state: state({ settings: { ...DEFAULT_SETTINGS, fees: { ...DEFAULT_FEES, salesTaxRate: 0.07, inboundCost: 2 } } }) });
    expect(screen.getByText(/\(15% referral, no fulfillment fee, 7% sales tax, \$2\.00 inbound per bundle\)\./)).toBeInTheDocument();
  });

  it('shows the scan progress under the top bar while a scan runs', () => {
    show(row(), { state: state({ scanRunning: true }) });
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(/^Scanning/);
  });

  it('writes a loss with the real minus and the loss colour', () => {
    show(row({ estimate: { cost: 300, netRevenue: 277.3, profit: -22.7, roi: -0.0757 } }));
    const figure = screen.getByText('−$22.70');
    expect(figure.parentElement).toHaveAttribute('data-loss', 'true');
    expect(screen.getByText('ROI −8%')).toBeInTheDocument();
  });

  it('says how many parts wait and offers Look up, quoting it first', async () => {
    const { api } = fakeApi();
    show(
      row({
        estimate: null,
        section: 'missing_listing',
        parts: [part('A1', { status: 'waiting', asin: null, grade: null, price: null, availability: 'missing', title: null }), part('A2', { status: 'waiting', asin: null, grade: null, price: null, availability: 'missing', title: null })],
      }),
      { api },
    );
    expect(screen.getByText('No estimate yet: 2 parts still need an Amazon lookup.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Look up/ })).toBeEnabled();
    expect(screen.queryByText(/^Estimate from your fee settings/)).toBeNull();
  });

  it('counts parts with no match yet as waiting, and offers Look up for them', async () => {
    const { api, send } = fakeApi();
    const none = { asin: null, grade: null, price: null, availability: 'missing' as const, title: null };
    show(row({ estimate: null, section: 'missing_listing', parts: [part('A1', { status: 'unmatched', ...none }), part('A2', { status: 'waiting', ...none })] }), { api });
    expect(screen.getByText('No estimate yet: 2 parts still need an Amazon lookup.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Look up/ })).toBeEnabled();
    expect(send).toHaveBeenCalledWith({ type: 'quote', action: { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'A1' }, { brand: 'RYOBI', model: 'A2' }] } });
  });

  it('shows at most N searches on Look up until a quote returns', () => {
    const send = vi.fn(() => new Promise<Reply>(() => {}));
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(row({ estimate: null, section: 'missing_listing', parts: [part('A1', { status: 'waiting', asin: null, grade: null, price: null, availability: 'missing' })] }), { api });
    expect(screen.getByRole('button', { name: 'Look up at most 1 search' })).toBeDisabled();
  });

  it('says why when there is no estimate for another reason', () => {
    show(row({ estimate: null, section: 'split', status: 'needs_review', parts: [] }));
    expect(screen.getByText('No estimate: what this bundle contains is not known yet.')).toBeInTheDocument();
    cleanup();
    show(row({ estimate: null, price: null }));
    expect(screen.getByText('No estimate: Home Depot shows no price for this bundle.')).toBeInTheDocument();
  });
});

describe('the open question', () => {
  const noParts = (over: Partial<BundleRow> = {}) => row({ estimate: null, section: 'split', status: 'needs_review', parts: [], ...over });

  it('shows the bundle\'s split question in place of the no-estimate sentence', () => {
    show(noParts(), { review: [question()] });
    expect(screen.getByText('Which parts come in this bundle?', { selector: 'legend' })).toBeInTheDocument();
    expect(screen.queryByText('No estimate: what this bundle contains is not known yet.')).toBeNull();
    expect(screen.getByRole('radio', { name: 'PCL1600K2 + P553' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Enter the parts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
  });

  it('ignores a question about another bundle and a match question', () => {
    show(noParts(), { review: [question({ subject: 'homedepot:2' }), question({ id: 'match:x', kind: 'match', subject: 'homedepot:1' })] });
    expect(screen.getByText('No estimate: what this bundle contains is not known yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('saves exactly as the Review tab does, and shows a refusal', async () => {
    const user = userEvent.setup();
    const q = question();
    const { api, send } = fakeApi((r) => (r.type === 'answerReview' ? { ok: false, error: 'That question changed. Choose again.' } : { ok: true, data: null }));
    show(noParts(), { review: [q], api });
    await user.click(screen.getByRole('radio', { name: 'PCL1600K2 + P553' }));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: q.id, answer: { choice: 0, seen: reviewSignature(q) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('That question changed. Choose again.');
  });

  it('moves focus to the title after a save, and keeps it where it is after a refusal', async () => {
    const user = userEvent.setup();
    const ok = fakeApi();
    show(noParts(), { review: [question()], api: ok.api });
    await user.click(screen.getByRole('radio', { name: 'PCL1600K2 + P553' }));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    cleanup();
    const refused = fakeApi((r) => (r.type === 'answerReview' ? { ok: false, error: 'No.' } : { ok: true, data: null }));
    show(noParts(), { review: [question()], api: refused.api });
    await user.click(screen.getByRole('radio', { name: 'PCL1600K2 + P553' }));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Save answer' })).toHaveFocus();
  });

  it('sends typed parts', async () => {
    const user = userEvent.setup();
    const q = question();
    const { api, send } = fakeApi();
    show(noParts(), { review: [q], api });
    await user.click(screen.getByRole('radio', { name: 'Enter the parts' }));
    await user.type(screen.getByLabelText('Model numbers, separated by commas'), 'PCL1600K2, P553');
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(send).toHaveBeenCalledWith({ type: 'answerReview', id: q.id, answer: { parts: ['PCL1600K2', 'P553'], seen: reviewSignature(q) } });
  });
});

describe('a part with no listing', () => {
  const none = { status: 'none' as const, asin: null, grade: null, price: null, availability: 'missing' as const, title: null };

  it('says which part counts as nothing, and says so on the part', () => {
    show(row({ status: 'partial', section: 'missing_listing', parts: [part('PCL1201K2', none), part('PCL515B')], uncovered: ['PCL1201K2'] }));
    expect(screen.getByText('Counts PCL1201K2 at $0: no Amazon listing was found.')).toBeInTheDocument();
    expect(within(screen.getAllByRole('listitem')[0]!).getByText('No Amazon listing found')).toBeInTheDocument();
  });

  it('names every such part', () => {
    show(row({ status: 'partial', section: 'missing_listing', parts: [part('A1', none), part('A2', none)], uncovered: ['A1', 'A2'] }));
    expect(screen.getByText('Counts A1 and A2 at $0: no Amazon listing was found.')).toBeInTheDocument();
  });

  it('keeps the old label on a part with no ASIN that the sentence does not name', () => {
    show(row({ parts: [part('A1', { asin: null, status: 'matched', availability: 'active', grade: null, price: null })] }));
    expect(screen.queryByText('No Amazon listing found')).toBeNull();
    expect(screen.getByText('No listing')).toBeInTheDocument();
  });

  it('adds nothing for a part that was never looked up, or when every part has a listing', () => {
    const waiting = { ...none, status: 'waiting' as const };
    show(row({ estimate: null, section: 'waiting', parts: [part('A1', waiting)] }));
    expect(screen.queryByText(/no Amazon listing was found/)).toBeNull();
    cleanup();
    show(row());
    expect(screen.queryByText(/no Amazon listing was found/)).toBeNull();
  });
});

describe('parts', () => {
  const blocks = () => screen.getAllByRole('listitem');

  it('shows model, clipped title with the full title, price, what it nets and the ASIN link', () => {
    show(row());
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('PARTS · 2');
    const first = within(blocks()[0]!);
    expect(first.getByText('PBLRC25B')).toBeInTheDocument();
    expect(first.getByText('RYOBI ONE+ HP 18V 3/8 in. Extended Reach Ratchet')).toHaveAttribute('title', 'RYOBI ONE+ HP 18V 3/8 in. Extended Reach Ratchet');
    expect(first.getByText('$169.00')).toBeInTheDocument();
    expect(first.getByText('nets $143.65')).toBeInTheDocument();
    const link = first.getByRole('link', { name: 'B0B3JWF5ZV' });
    expect(link).toHaveAttribute('href', 'https://www.amazon.com/dp/B0B3JWF5ZV');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('nets by the fee settings', () => {
    show(row(), { state: state({ settings: { ...DEFAULT_SETTINGS, fees: { ...DEFAULT_FEES, fulfillmentFee: 5 } } }) });
    expect(screen.getAllByText('nets $138.65').length).toBe(2);
  });

  const label = (p: Partial<PartRow>) => {
    cleanup();
    show(row({ parts: [part('X1', p)] }));
    return within(screen.getAllByRole('listitem')[0]!);
  };

  it('labels each grade and state', () => {
    expect(label({ grade: 'exact' }).getByText('Barcode verified')).toBeInTheDocument();
    expect(label({ grade: 'strong' }).getByText('Verified')).toBeInTheDocument();
    expect(label({ grade: 'probable' }).getByText('Title match')).toBeInTheDocument();
    expect(label({ grade: null }).getByText('Chosen by you')).toBeInTheDocument();
    expect(label({ status: 'none', asin: null, grade: null, price: null, availability: 'missing' }).getByText('No Amazon listing found')).toBeInTheDocument();
    expect(label({ status: 'waiting', asin: null, grade: null, price: null, availability: 'missing' }).getByText('Not looked up yet')).toBeInTheDocument();
    expect(label({ status: 'unmatched', asin: null, grade: null, price: null, availability: 'missing' }).getByText('Not looked up yet')).toBeInTheDocument();
    expect(label({ availability: 'inactive', price: null }).getByText('Listing inactive')).toBeInTheDocument();
  });

  it('offers Verify only for a title match', () => {
    label({ grade: 'exact' });
    expect(screen.queryByRole('button', { name: /^Verify/ })).toBeNull();
  });

  it('quotes Verify before the click, and runs it once', async () => {
    const user = userEvent.setup();
    const { api, send } = fakeApi();
    show(row({ parts: [part('PBLRC25B', { grade: 'probable' })] }), { api });
    const button = await screen.findByRole('button', { name: /^Verify/ });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAccessibleName('Verify · 1 search');
    expect(send).toHaveBeenCalledWith({ type: 'quote', action: { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' } });
    await user.click(button);
    expect(send).toHaveBeenCalledWith({ type: 'runPaid', action: { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' } });
    expect(send.mock.calls.filter(([r]) => r.type === 'runPaid')).toHaveLength(1);
  });

  it('disables Verify and says why when the quote is refused, still showing its price', async () => {
    const { api } = fakeApi(undefined, { searches: 1, refusal: 'The hourly search limit is reached.' });
    show(row({ parts: [part('PBLRC25B', { grade: 'probable' })] }), { api });
    const sentence = await screen.findByText('The hourly search limit is reached.');
    const button = screen.getByRole('button', { name: 'Verify · 1 search' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-describedby', sentence.id);
  });

  it('shows the price of Verify before any quote came back', () => {
    const send = vi.fn(() => new Promise<Reply>(() => {}));
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    show(row({ parts: [part('PBLRC25B', { grade: 'probable' })] }), { api });
    expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeDisabled();
  });

  it('reads Needs your answer in Review for a part left in review', () => {
    show(row({ parts: [part('X1', { status: 'review', asin: null, grade: null, price: null, availability: 'missing' })] }));
    expect(screen.getByText('Needs your answer in Review')).toBeInTheDocument();
  });

  it('shows the sentence of a refused run under Verify', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi((r) => (r.type === 'runPaid' ? { ok: false, error: 'Not available yet.' } : { ok: true, data: null }));
    show(row({ parts: [part('PBLRC25B', { grade: 'probable' })] }), { api });
    await user.click(await screen.findByRole('button', { name: /^Verify/ }));
    expect(await screen.findByText('Not available yet.')).toBeInTheDocument();
  });

  /** Quotes answer only when told to, oldest first; anything else answers at once. */
  function heldQuotes() {
    const pending: ((r: Reply) => void)[] = [];
    const send = vi.fn((r: Request): Promise<Reply> => (r.type === 'quote' ? new Promise((ok) => pending.push(ok)) : Promise.resolve({ ok: true, data: null })));
    const api: WorkerApi = { send: send as unknown as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    const answer = async (refusal: string | null = null) => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!({ ok: true, data: { searches: 1, refusal } });
    };
    return { api, send, answer };
  }

  const detailOf = (api: WorkerApi, r: BundleRow, s: AppState = state()) =>
    createElement(Detail, { api, report: { bundles: [r], review: [], packaging: {} }, state: s, bundleKey: r.key, onBack: vi.fn() });

  it('Verify stays disabled after a scan ends until the new quote comes', async () => {
    const { api, answer } = heldQuotes();
    const r = row({ parts: [part('PBLRC25B', { grade: 'probable' })] });
    const view = render(detailOf(api, r));
    await answer();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeEnabled());
    view.rerender(detailOf(api, r, state({ scanRunning: true })));
    view.rerender(detailOf(api, r, state({ scanRunning: false })));
    expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeDisabled();
    await answer();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeEnabled());
  });

  it('Verify stays disabled after the listing changes until its quote comes', async () => {
    const { api, send, answer } = heldQuotes();
    const view = render(detailOf(api, row({ parts: [part('PBLRC25B', { grade: 'probable' })] })));
    await answer();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeEnabled());
    view.rerender(detailOf(api, row({ parts: [part('PBLRC25B', { grade: 'probable', asin: 'B0OTHER001' })] })));
    expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeDisabled();
    await answer();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeEnabled());
    expect(send).toHaveBeenLastCalledWith({ type: 'quote', action: { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0OTHER001' } });
  });

  it('Verify asks again when a new report comes, so a refusal from a paid action elsewhere does not stay', async () => {
    const paying = 'A Look up or Verify is running.';
    let refusal: string | null = paying;
    const send = vi.fn(async (r: Request): Promise<Reply> => (r.type === 'quote' ? { ok: true, data: { searches: 1, refusal } } : { ok: true, data: null }));
    const api: WorkerApi = { send: send as WorkerApi['send'], onStateChanged: () => () => {}, download: vi.fn() };
    const r = row({ parts: [part('PBLRC25B', { grade: 'probable' })] });
    const view = render(detailOf(api, r));
    expect(await screen.findByText(paying)).toBeInTheDocument();
    refusal = null;
    // detailOf builds a new report: as after the worker's broadcast when the other action ended.
    view.rerender(detailOf(api, r));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify · 1 search' })).toBeEnabled());
    expect(screen.queryByText(paying)).toBeNull();
  });

  it('tells the panel when its Verify has ended', async () => {
    const user = userEvent.setup();
    const onPaidEnd = vi.fn();
    const { api } = fakeApi();
    const r = row({ parts: [part('PBLRC25B', { grade: 'probable' })] });
    render(createElement(Detail, { api, report: { bundles: [r], review: [], packaging: {} }, state: state(), bundleKey: r.key, onBack: vi.fn(), onPaidEnd }));
    const button = await screen.findByRole('button', { name: /^Verify/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(onPaidEnd).toHaveBeenCalledTimes(1));
  });

  it('runs one paid request at a time', async () => {
    const user = userEvent.setup();
    let release: (r: Reply) => void = () => {};
    const { api, send } = fakeApi((r) => (r.type === 'runPaid' ? ({ then: (f: (r: Reply) => void) => (release = f) } as unknown as Reply) : { ok: true, data: null }));
    show(row({ parts: [part('PBLRC25B', { grade: 'probable' }), part('PBLRC01B', { grade: 'probable', asin: 'B0B6Z2ZGVK' })] }), { api });
    const buttons = await screen.findAllByRole('button', { name: /^Verify/ });
    await waitFor(() => expect(buttons[0]).toBeEnabled());
    await user.click(buttons[0]!);
    await waitFor(() => expect(buttons[1]).toBeDisabled());
    await user.click(buttons[1]!);
    expect(send.mock.calls.filter(([r]) => r.type === 'runPaid')).toHaveLength(1);
    release({ ok: true, data: null });
  });
});

describe('packaging', () => {
  it('asks until answered, and saves the answer for the model', async () => {
    const user = userEvent.setup();
    const { api, send } = fakeApi();
    show(row(), { api });
    expect(screen.getByText('Do these arrive individually boxed?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, boxed' }));
    expect(send).toHaveBeenCalledWith({ type: 'setPackaging', model: 'PBLRC2501SB', packaging: 'retail_boxed' });
    expect(await screen.findByText('Boxed')).toBeInTheDocument();
    expect(screen.queryByText('Do these arrive individually boxed?')).toBeNull();
  });

  it('shows the Loose tag and note at once after saving Loose', async () => {
    const user = userEvent.setup();
    show(row());
    expect(document.querySelector('.detail-tag')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'No, loose' }));
    expect(await screen.findByText('Loose', { selector: '.detail-tag' })).toBeInTheDocument();
    expect(screen.getByText(/Loose parts cannot be listed as New/)).toBeInTheDocument();
  });

  it('hides the question again with Cancel when it was opened by Change, saving nothing', async () => {
    const user = userEvent.setup();
    const { api, send } = fakeApi();
    show(row(), { api, packaging: { PBLRC2501SB: 'retail_boxed' } });
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Do these arrive individually boxed?')).toBeNull();
    expect(screen.getByText('Boxed')).toBeInTheDocument();
    expect(send.mock.calls.filter(([r]) => r.type === 'setPackaging')).toHaveLength(0);
  });

  it('has no Cancel while the question has never been answered', () => {
    show(row());
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows the saved answer as one line, and asks again after Change', async () => {
    const user = userEvent.setup();
    show(row(), { packaging: { PBLRC2501SB: 'retail_boxed' } });
    expect(screen.queryByText('Do these arrive individually boxed?')).toBeNull();
    expect(screen.getByText('Boxed')).toBeInTheDocument();
    // The Change link of the estimate line is a link; this one is a button.
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByText('Do these arrive individually boxed?')).toBeInTheDocument();
  });

  it('says why when the answer could not be saved', async () => {
    const user = userEvent.setup();
    const { api } = fakeApi((r) => (r.type === 'setPackaging' ? { ok: false, error: 'Could not save.' } : { ok: true, data: null }));
    show(row(), { api });
    await user.click(screen.getByRole('button', { name: 'No, loose' }));
    expect(await screen.findByText('Could not save.')).toBeInTheDocument();
    expect(screen.getByText('Do these arrive individually boxed?')).toBeInTheDocument();
  });

  it('marks a loose bundle with a tag and a note on the estimate', () => {
    show(row(), { packaging: { PBLRC2501SB: 'loose' } });
    expect(screen.getByText('Loose', { selector: '.detail-tag' })).toBeInTheDocument();
    expect(screen.getByText(/Loose parts cannot be listed as New on Amazon; this estimate assumes they can\./)).toBeInTheDocument();
  });

  it('shows no tag or note for a boxed or unanswered bundle', () => {
    show(row(), { packaging: { PBLRC2501SB: 'retail_boxed' } });
    expect(document.querySelector('.detail-tag')).toBeNull();
    expect(screen.queryByText(/Loose parts cannot/)).toBeNull();
  });
});

describe('footer', () => {
  it('copies both ASINs joined by a space, then says Copied for two seconds', async () => {
    const user = userEvent.setup();
    show(row());
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await user.click(screen.getByRole('button', { name: 'Copy both ASINs' }));
    expect(await navigator.clipboard.readText()).toBe('B0B3JWF5ZV B0B6Z2ZGVK');
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    // Still there after a second, gone after two (real timers: only the clock's Date is faked).
    await new Promise((r) => setTimeout(r, 1000));
    expect(screen.getByRole('status')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toBeEmptyDOMElement(), { timeout: 2000 });
  }, 8000);

  it('is called Copy ASINs for one or three, and is disabled with none', () => {
    show(row({ parts: [part('A1')] }));
    expect(screen.getByRole('button', { name: 'Copy ASINs' })).toBeEnabled();
    cleanup();
    show(row({ parts: [part('A1'), part('A2', { asin: 'B000000002' }), part('A3', { asin: 'B000000003' })] }));
    expect(screen.getByRole('button', { name: 'Copy ASINs' })).toBeEnabled();
    cleanup();
    show(row({ parts: [part('A1', { asin: null, status: 'none', grade: null, availability: 'missing', price: null })] }));
    expect(screen.getByRole('button', { name: 'Copy ASINs' })).toBeDisabled();
  });

  it('says which part has no ASIN after copying, and nothing more when all have one', async () => {
    const user = userEvent.setup();
    const none = (m: string) => part(m, { asin: null, status: 'none', grade: null, availability: 'missing', price: null });
    show(row({ parts: [part('A1'), none('PCL515B')] }));
    await user.click(screen.getByRole('button', { name: 'Copy ASINs' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied 1 ASIN. PCL515B has no ASIN.');
    cleanup();
    show(row({ parts: [part('A1'), none('PCL515B'), none('PCL526B'), part('A4', { asin: 'B000000004' })] }));
    await user.click(screen.getByRole('button', { name: 'Copy both ASINs' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied 2 ASINs. PCL515B and PCL526B have no ASIN.');
  });

  it('downloads this row as CSV with the run file columns', async () => {
    const user = userEvent.setup();
    const { api, download } = fakeApi();
    show(row(), { api });
    await user.click(screen.getByRole('button', { name: 'Export row' }));
    expect(download).toHaveBeenCalledTimes(1);
    const [name, text, type] = download.mock.calls[0] as [string, string, string];
    expect(name).toBe('split-finder-PBLRC2501SB.csv');
    expect(type).toBe('text/csv');
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^section,brand,bundle_model,bundle_title,/);
    expect(lines[1]).toBe(
      'confirmed,RYOBI,PBLRC2501SB,ONE+ HP 18V Extended Reach Ratchets (Tools Only),1,189,338,44,PBLRC25B | PBLRC01B,B0B3JWF5ZV | B0B6Z2ZGVK,exact | exact,169 | 169,287.3,189,98.3,0.52,,https://www.homedepot.com/p/328814689',
    );
  });
});
