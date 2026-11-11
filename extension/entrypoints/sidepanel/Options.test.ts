// @vitest-environment jsdom
// Ways to sell in Detail and the Deals tag, on the report a replayed scan really produced for PCL1600K2-P553
// (core/test/kit-world.ts): recorded Home Depot and Amazon responses, the recorded bundle pages, the owner's
// answer, and the panel's own Look up. Nothing reaches the network.
import '@testing-library/jest-dom/vitest';
import { createElement, useState } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaidAction } from '@core/scan/types';
import { DEFAULT_SETTINGS } from '@core/settings';
import { answeredKitWorld, KIT_KEY, kitLookUpItems, kitQuote, kitReport, kitRunPaid, type KitWorld, P553_KEY } from '../../../core/test/kit-world';
import { profit } from '../../lib/format';
import type { AppState, PanelReport } from '../../lib/messages';
import type { WorkerApi } from '../../lib/pageClient';
import { DealsTab } from './DealsTab';
import { waitingOf } from './dealsModel';
import { Detail } from './Detail';

afterEach(cleanup);

const state: AppState = { hasKey: true, account: null, accountCheckedAt: 1, problem: null, settings: DEFAULT_SETTINGS, scanRunning: false, lastJob: null, nextRunAt: null };

/**
 * The worker's answers over the replayed world: the real quote and the real Look up, under the settings' searches
 * per scan (`perScan`, default 20) and the recorded account with `account` over it.
 */
function workerApi(w: KitWorld, sent: unknown[] = [], perScan = 20, account: Record<string, unknown> = {}): WorkerApi {
  return {
    send: (async (r: { type: string; action?: PaidAction }) => {
      sent.push(r);
      if (r.type === 'quote') return { ok: true, data: await kitQuote(w, r.action!, perScan, account) };
      if (r.type === 'runPaid') {
        const error = await kitRunPaid(w, r.action!, perScan);
        return error === null ? { ok: true, data: null } : { ok: false, error };
      }
      return { ok: true, data: null };
    }) as WorkerApi['send'],
    onStateChanged: () => () => {},
    download: vi.fn(),
  };
}

/** Detail that reads the report again when a paid action ends, as the panel does. */
function Harness({ w, api, first, bundleKey, scanRunning = false }: { w: KitWorld; api: WorkerApi; first: PanelReport; bundleKey: string; scanRunning?: boolean }) {
  const [report, setReport] = useState(first);
  return createElement(Detail, {
    api, report, state: { ...state, scanRunning }, bundleKey, onBack: vi.fn(),
    onPaidEnd: () => void kitReport(w).then((r) => act(() => setReport(r))),
  });
}

async function openP553(opts: { answer?: 'choice' | 'none'; pages?: boolean; perScan?: number; account?: Record<string, unknown>; brandPage?: boolean } = {}) {
  const w = await answeredKitWorld(opts.answer, opts.pages, opts.brandPage);
  const first = await kitReport(w);
  const sent: unknown[] = [];
  const api = workerApi(w, sent, opts.perScan, opts.account);
  const view = render(createElement(Harness, { w, api, first, bundleKey: P553_KEY }));
  /** The same Detail with a scan running or not, as the panel's state says. */
  const scanning = (scanRunning: boolean) => view.rerender(createElement(Harness, { w, api, first, bundleKey: P553_KEY, scanRunning }));
  return { w, first, sent, scanning };
}

const UNNAMED = [
  '18T Carbide Blade', 'Hex Wrench', 'Reciprocating Saw Blade', 'Hex Key', 'Flush Cut Blade', 'Plunge Cut Blade', '6 in. Wood Blade', 'Sanding Pad',
  '5-Pieces Sandpaper', '18V. Charger', 'Tool Bag',
];

const region = () => screen.getByRole('region', { name: 'Ways to sell' });
const blocks = () => within(region()).getAllByRole('listitem');
const splitBlock = () => blocks().find((b) => b.textContent!.includes('split into its parts'))!;

describe('Detail: Ways to sell, PCL1600K2-P553 after the owner chose PCL1600K2 + P553', () => {
  it('lists both ways, the primary first and marked as the one shown above', async () => {
    const { first } = await openP553();
    const row = first.bundles.find((b) => b.key === P553_KEY)!;
    expect(screen.getByRole('heading', { level: 2, name: 'Ways to sell' })).toBeInTheDocument();
    const [a, b] = blocks();
    expect(a).toHaveTextContent(row.options[0]!.label);
    expect(a).toHaveTextContent('PCL1600K2 sold whole');
    expect(b).toHaveTextContent('PCL1600K2 split into its parts');
    expect(within(a!).getByText('Shown above')).toBeInTheDocument();
    expect(within(b!).queryByText('Shown above')).toBeNull();
    expect(screen.getAllByText('Shown above')).toHaveLength(1);
  });

  it('says what each leaves: nothing, or the count and the items, and the loose note only on the split', async () => {
    await openP553();
    const [whole, split] = blocks();
    expect(within(whole!).getByText('Leaves nothing')).toBeInTheDocument();
    expect(within(split!).getByText(`Leaves ${UNNAMED.length} parts: ${UNNAMED.join(', ')}`)).toBeInTheDocument();
    expect(within(whole!).queryByText('Parts from a kit have no retail box of their own.')).toBeNull();
    expect(within(split!).getByText('Parts from a kit have no retail box of their own.')).toBeInTheDocument();
  });

  it("has no figure for either way yet, and offers Look up N parts with the worker's own quote", async () => {
    const { w, first } = await openP553();
    const row = first.bundles.find((b) => b.key === P553_KEY)!;
    const [whole, split] = blocks();
    expect(within(whole!).queryByText(/^[+−]\$/)).toBeNull();
    // Nine items, but PBP005 was matched for free from a saved listing: only the rest still wait for a lookup.
    expect(row.options[1]!.parts).toHaveLength(9);
    expect(row.options[1]!.parts.find((p) => p.model === 'PBP005')!.status).toBe('matched');
    const waiting = waitingOf('RYOBI', row.options[1]!.parts);
    expect(waiting).toHaveLength(8);
    // The quote is whatever the worker's quotePaid says (it counts what Look up would search for).
    const quoted = async (o: number) => (await kitQuote(w, { kind: 'lookUp', parts: o === 1 ? waiting : row.options[o]!.parts.map((p) => ({ brand: 'RYOBI', model: p.model })) })).searches;
    const cost = (n: number) => (n === 0 ? '· no search' : `· ${n} ${n === 1 ? 'search' : 'searches'}`);
    expect(await within(split!).findByRole('button', { name: `Look up ${waiting.length} parts ${cost(await quoted(1))}` })).not.toHaveAttribute('aria-disabled');
    expect(await quoted(0)).toBe(2);
    expect(await within(whole!).findByRole('button', { name: 'Look up 2 parts · 2 searches' })).not.toHaveAttribute('aria-disabled');
    // The estimate band does not repeat them: the options hold the buttons.
    expect(screen.getAllByRole('button', { name: /^Look up/ })).toHaveLength(2);
  });

  it("pressing the whole way's Look up sends exactly its parts and gives it an estimate, with the estimate label under the list", async () => {
    const user = userEvent.setup();
    const { sent } = await openP553();
    await user.click(await within(blocks()[0]!).findByRole('button', { name: 'Look up 2 parts · 2 searches' }));
    expect(sent).toContainEqual({ type: 'runPaid', action: { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PCL1600K2' }, { brand: 'RYOBI', model: 'P553' }] } });
    await waitFor(() => expect(within(region()).queryByRole('button', { name: /Look up 2 parts/ })).toBeNull());
    expect(within(blocks()[0]!).getByText(/^[+−]\$/)).toBeInTheDocument();
    expect(within(region()).getByText(/^Estimated profit and ROI/)).toBeInTheDocument();
  });

  it("pressing the split way's Look up sends its waiting items and fills them in, leaving the way an estimate or its remaining leftovers", async () => {
    const user = userEvent.setup();
    const { w, first, sent } = await openP553();
    const split = first.bundles.find((b) => b.key === P553_KEY)!.options[1]!;
    const waiting = waitingOf('RYOBI', split.parts);
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.length).toBeLessThan(split.parts.length);
    await user.click(await within(splitBlock()).findByRole('button', { name: new RegExp(`^Look up ${waiting.length} parts · `) }));
    expect(sent).toContainEqual({ type: 'runPaid', action: { kind: 'lookUp', parts: waiting } });
    // Afterwards the report is read again: the items are no longer waiting, and the button is gone or quoted for what is left.
    const after = await kitReport(w);
    const next = after.bundles.find((b) => b.key === P553_KEY)!.options.find((o) => o.id === split.id)!;
    const left = waitingOf('RYOBI', next.parts);
    expect(left.length).toBeLessThan(waiting.length);
    await waitFor(() => {
      const block = blocks().find((b) => b.textContent!.includes('split into its parts'))!;
      const button = within(block).queryByRole('button', { name: /^Look up/ });
      if (left.length === 0) expect(button).toBeNull();
      else expect(button).toHaveAccessibleName(new RegExp(`^Look up ${left.length} parts`));
      if (next.estimate) expect(within(block).getByText(/^[+−]\$/)).toBeInTheDocument();
      else expect(within(block).getByText(/^Leaves \d+ parts/)).toBeInTheDocument();
    });
  });

  it('with the items looked up, the split has an estimate, is the primary and is the one shown above', async () => {
    const w = await answeredKitWorld();
    await kitRunPaid(w, { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PCL1600K2' }, { brand: 'RYOBI', model: 'P553' }] });
    await kitLookUpItems(w, ['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL430', 'PCL660', 'PBP005', 'PBP002']);
    const first = await kitReport(w);
    const row = first.bundles.find((b) => b.key === P553_KEY)!;
    expect(row.options.map((o) => o.id)).toEqual(['split:PCL1600K2', 'whole']);
    render(createElement(Harness, { w, api: workerApi(w), first, bundleKey: P553_KEY }));
    const [a, b] = blocks();
    expect(a).toHaveTextContent('PCL1600K2 split into its parts');
    expect(within(a!).getByText('Shown above')).toBeInTheDocument();
    expect(within(a!).getByText(/^[+−]\$/)).toHaveTextContent(profit(row.options[0]!.estimate!.profit));
    expect(within(a!).queryByRole('button', { name: /^Look up/ })).toBeNull();
    expect(within(a!).getByText(/^Leaves \d+ parts: /)).toBeInTheDocument();
    expect(within(b!).getByText(/^Leaves 2 parts:/)).toHaveTextContent('Leaves 2 parts: PCL1600K2, P553');
    // The headline is the primary's: the same figure.
    expect(screen.getByText(profit(row.estimate!.profit), { selector: '.detail-profit' })).toBeInTheDocument();
  });
});

describe('Detail: a Look up above the searches per scan looks up what fits (Ruling 72)', () => {
  const cost = (n: number) => (n === 0 ? '· no search' : `· ${n} ${n === 1 ? 'search' : 'searches'}`);
  const splitWaiting = async (w: KitWorld) => waitingOf('RYOBI', (await kitReport(w)).bundles.find((b) => b.key === P553_KEY)!.options.find((o) => o.id === 'split:PCL1600K2')!.parts);
  const panelLookups = (w: KitWorld) => w.ledger.filter((l) => l.startsWith('panel:lookup:')).length;

  it('at the default 5, the split reads "Look up 5 of 8 parts · 5 searches"; a press spends exactly 5, the button is quoted for the rest, and a second press finishes them', async () => {
    const user = userEvent.setup();
    expect(DEFAULT_SETTINGS.searchesPerScan).toBe(5);
    const { w, sent } = await openP553({ perScan: DEFAULT_SETTINGS.searchesPerScan });
    const waiting = await splitWaiting(w);
    expect(waiting).toHaveLength(8);
    const button = await within(splitBlock()).findByRole('button', { name: 'Look up 5 of 8 parts · 5 searches' });
    expect(button).toHaveTextContent(/^Look up 5 of 8 parts · 5 searches$/);
    expect(button).not.toHaveAttribute('aria-disabled');
    // The whole way's 2 parts fit: its button is unchanged.
    expect(within(blocks()[0]!).getByRole('button', { name: 'Look up 2 parts · 2 searches' })).toBeInTheDocument();

    await user.click(button);
    // The panel sends every waiting part; the worker looks up what fits.
    expect(sent).toContainEqual({ type: 'runPaid', action: { kind: 'lookUp', parts: waiting } });
    await waitFor(() => expect(panelLookups(w)).toBe(5));
    const left = await splitWaiting(w);
    expect(left).toHaveLength(3);
    const next = (await kitQuote(w, { kind: 'lookUp', parts: left }, 5)).searches;
    expect(next).toBeLessThanOrEqual(3);
    const again = await within(splitBlock()).findByRole('button', { name: `Look up 3 parts ${cost(next)}` });
    await waitFor(() => expect(again).not.toHaveAttribute('aria-disabled'));

    await user.click(again);
    await waitFor(() => expect(within(splitBlock()).queryByRole('button', { name: /^Look up/ })).toBeNull());
    expect(panelLookups(w)).toBe(5 + next);
    expect(await splitWaiting(w)).toEqual([]);
  });

  it('at 1, the split reads "Look up 1 of 8 parts · 1 search"', async () => {
    await openP553({ perScan: 1 });
    const button = await within(splitBlock()).findByRole('button', { name: 'Look up 1 of 8 parts · 1 search' });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(within(blocks()[0]!).getByRole('button', { name: 'Look up 1 of 2 parts · 1 search' })).toBeInTheDocument();
  });

  it('at 0 nothing fits: refused with the per-scan sentence for the whole cost, as before', async () => {
    await openP553({ perScan: 0 });
    const button = await within(splitBlock()).findByRole('button', { name: 'Look up 8 parts · 8 searches' });
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(within(splitBlock()).getByText('This needs 8 searches, and a scan may use 0. Raise the searches per scan in settings to do it here.')).toBeInTheDocument();
  });

  it('with the hour used up, refused with the hourly sentence, never the per-scan one', async () => {
    await openP553({ perScan: 5, account: { this_hour_searches: 50 } });
    const button = await within(splitBlock()).findByRole('button', { name: 'Look up 5 of 8 parts · 5 searches' });
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'true'));
    expect(within(splitBlock()).getByText('SerpApi allows 50 searches an hour, and they are used. Try again later.')).toBeInTheDocument();
    expect(within(region()).queryByText(/a scan may use/)).toBeNull();
  });
});

describe('Detail: a press that made progress and then failed still says why (Ruling 72 review)', () => {
  // Without the brand page no saved listing answers PBP005, and its Amazon search is not recorded: the replay answers 404.
  const FAILED = 'SerpApi answered with an error (HTTP 404). Try again later.';

  it('shows the failure under the button quoted again for the parts left, until the next press or the end of a scan', async () => {
    const user = userEvent.setup();
    const { w, scanning } = await openP553({ perScan: 5, brandPage: false });
    const before = await within(splitBlock()).findByRole('button', { name: 'Look up 5 of 9 parts · 5 searches' });
    await waitFor(() => expect(before).not.toHaveAttribute('aria-disabled'));
    await user.click(before);
    // P553 and PBP002 were looked up before PBP005 failed: fewer parts wait, and the button is quoted for them.
    await waitFor(() => expect(w.ledger.filter((l) => l.startsWith('panel:lookup:'))).toEqual(['panel:lookup:P553', 'panel:lookup:PBP002']));
    const after = await within(splitBlock()).findByRole('button', { name: /^Look up \d+ of 7 parts · / });
    await waitFor(() => expect(after).not.toHaveAttribute('aria-disabled'));
    const sentence = within(splitBlock()).getByText(FAILED);
    expect(after.getAttribute('aria-describedby')?.split(' ')).toContain(sentence.id);
    // The whole way's Look up was not pressed: it says nothing of it.
    expect(within(blocks()[0]!).queryByText(FAILED)).toBeNull();

    // A scan that ends clears it.
    scanning(true);
    expect(within(splitBlock()).queryByText(FAILED)).toBeNull();
    scanning(false);
    await waitFor(() => expect(within(splitBlock()).getByRole('button', { name: /^Look up/ })).not.toHaveAttribute('aria-disabled'));
    expect(within(splitBlock()).queryByText(FAILED)).toBeNull();
  });
});

describe('Detail: a refusal in Ways to sell is its own line under the button (QA, 360px)', () => {
  it('sets the button first and the sentence after it in the stacked layout, and the sentence still describes the button', async () => {
    await openP553({ perScan: 5, account: { this_hour_searches: 50 } });
    for (const block of blocks()) {
      const sentence = await within(block).findByText('SerpApi allows 50 searches an hour, and they are used. Try again later.');
      const wrapper = sentence.parentElement!;
      expect(wrapper).toHaveClass('deal-lookup', 'deal-lookup-stacked');
      const button = within(wrapper).getByRole('button', { name: /^Look up/ });
      expect(Array.from(wrapper.children)).toEqual([button, sentence]);
      expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(sentence.id);
    }
  });
});

describe('Deals: a Look up above the searches per scan (Ruling 72)', () => {
  it('names how many of the row\'s parts it looks up, and the row, at a limit of 1', async () => {
    const w = await answeredKitWorld();
    const report = await kitReport(w);
    const row = report.bundles.find((b) => b.key === P553_KEY)!;
    expect(waitingOf('RYOBI', row.parts)).toHaveLength(2);
    render(createElement(DealsTab, { api: workerApi(w, [], 1), report, state, sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() }));
    const button = await screen.findByRole('button', { name: `Look up 1 of 2 parts · 1 search, for ${row.model}` });
    expect(button).toHaveTextContent(/^Look up 1 of 2 parts · 1 search$/);
  });
});

describe('Detail: model numbers and names in Ways to sell', () => {
  const mono = (el: HTMLElement) => Array.from(el.querySelectorAll('.figure')).map((m) => m.textContent);

  it('sets each kit model of a label, and a leftover that is a part model, in the figure face, and leaves unnamed parts in the body face', async () => {
    await openP553();
    const [whole, split] = blocks();
    expect(mono(within(whole!).getByText(/sold whole/))).toEqual(['PCL1600K2']);
    expect(mono(within(split!).getByText(/split into its/))).toEqual(['PCL1600K2']);
    // The split leaves only unnamed parts here: none of them is a model.
    expect(mono(split!.querySelector('.detail-way-line') as HTMLElement)).toEqual([]);
  });

  it('sets the leftover models in the figure face once the looked-up parts have no listing', async () => {
    const w = await answeredKitWorld();
    await kitRunPaid(w, { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PCL1600K2' }, { brand: 'RYOBI', model: 'P553' }] });
    const first = await kitReport(w);
    render(createElement(Harness, { w, api: workerApi(w), first, bundleKey: P553_KEY }));
    const line = within(blocks()[0]!).getByText(/^Leaves 2 parts:/);
    expect(Array.from(line.querySelectorAll('.figure')).map((m) => m.textContent)).toEqual(['PCL1600K2', 'P553']);
  });

  it('sets the kit model of the not-known sentence in the figure face', async () => {
    await openP553({ pages: false });
    const sentence = screen.getByText(/contents are not known yet/);
    expect(Array.from(sentence.querySelectorAll('.figure')).map((m) => m.textContent)).toEqual(['PCL1600K2']);
  });

  it('describes each Look up by its own way to sell, so two buttons of one name are told apart', async () => {
    await openP553();
    const [whole, split] = blocks();
    for (const block of [whole!, split!]) {
      const button = await within(block).findByRole('button', { name: /^Look up/ });
      const label = block.querySelector('.detail-way-label') as HTMLElement;
      expect(label.id).not.toBe('');
      expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(label.id);
    }
  });
});

describe('Detail: a kit whose page has not been read', () => {
  it('says its contents are not known, with one way to sell and no Ways to sell', async () => {
    const { first } = await openP553({ pages: false });
    const row = first.bundles.find((b) => b.key === P553_KEY)!;
    expect(row.kitsNotRead).toEqual(['PCL1600K2']);
    expect(screen.getByText(/contents are not known yet/)).toHaveTextContent("PCL1600K2's contents are not known yet: its Home Depot page has not been read.");
    expect(screen.queryByRole('heading', { name: 'Ways to sell' })).toBeNull();
    expect(screen.queryByText('Shown above')).toBeNull();
  });
});

describe('Detail: a bundle with one way to sell', () => {
  it('shows no Ways to sell and no not-known sentence', async () => {
    await openP553({ answer: 'none' });
    expect(screen.queryByRole('heading', { name: 'Ways to sell' })).toBeNull();
    expect(screen.queryByText(/contents are not known yet/)).toBeNull();
  });
});

describe('Deals: the tag', () => {
  const rows = (report: PanelReport) => render(createElement(DealsTab, { api: workerApi({} as KitWorld), report, state, sort: 'profit', onSort: vi.fn(), onOpen: vi.fn() }));

  it('tags a bundle with two ways to sell, and only those', async () => {
    const report = await kitReport(await answeredKitWorld());
    expect(report.bundles.find((b) => b.key === P553_KEY)!.options).toHaveLength(2);
    expect(report.bundles.find((b) => b.key === KIT_KEY)!.options).toHaveLength(2);
    rows(report);
    const link = document.querySelector(`[data-key="${P553_KEY}"]`) as HTMLElement;
    expect(within(link).getByText('2 ways to sell')).toBeInTheDocument();
    expect(screen.getAllByText('2 ways to sell')).toHaveLength(report.bundles.filter((b) => b.options.length > 1).length);
  });

  it('shows no tag on a bundle with one way to sell', async () => {
    const report = await kitReport(await answeredKitWorld('none'));
    rows(report);
    const link = document.querySelector(`[data-key="${P553_KEY}"]`) as HTMLElement;
    expect(within(link).queryByText(/ways to sell/)).toBeNull();
  });
});
