// @vitest-environment jsdom
// The progress row on the jobs a replayed scan really saved, step by step: recorded SerpApi responses, the real
// pipeline into a memory store. Nothing reaches the network.
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { replayRecorded } from '../../../scripts/replay';
import { SERPAPI_ACCOUNT_FREE } from '../../../core/test/fixtures';
import { DEFAULT_SCAN_SETTINGS, type ScanJob, type ScanSettings } from '@core/scan/types';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { runScan } from '@core/scan/runner';
import { parseAccount, SearchBudget } from '@core/serpapi/budget';
import { MemoryCache, SerpApiClient } from '@core/serpapi/client';
import { CURRENT_LABELS, newPipeline, type PipelineStep, pipelineView, STEP_IDS, type UnitRates } from '@core/scan/pipeline';
import { DETAILS_KEY, LIVE_EVERY_MS, ProgressRow, progressOf, progressText } from './ProgressRow';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

const T0 = Date.UTC(2026, 10, 9, 12);
// One brand page, one Home Depot page, then the bundles' pages are read and parts are looked up.
const SETTINGS: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, brands: ['DEWALT'], queries: [{ q: 'dewalt 20v combo kit' }], catalogPagesPerScan: 1 };

/** Every job the runner saved, in order, as it was when saved. */
class RecordingStore extends MemoryScanStore {
  saved: ScanJob[] = [];
  override async putScan(job: ScanJob) {
    this.saved.push(structuredClone(job));
    return super.putScan(job);
  }
}

let saved: ScanJob[];
beforeAll(async () => {
  const store = new RecordingStore();
  const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings: SETTINGS, now: () => T0 });
  saved = store.saved.filter((j) => j.status === 'running');
});

describe('progress row on a replayed scan', () => {
  it('counts a brand page as a page fetched, so the total of the first phase holds', () => {
    const pages = saved.map(progressOf).filter((p) => p.phase === 'pages');
    expect(pages.length).toBeGreaterThan(1);
    // The first saved job is the plan: a brand page and a Home Depot page, nothing fetched.
    expect(pages[0]).toMatchObject({ current: 1, total: 2 });
    expect(new Set(pages.map((p) => (p.phase === 'pages' ? p.total : 0)))).toEqual(new Set([2]));
  });

  it('never goes backwards, names its phase, and moves through pages, reading and parts in that order', () => {
    const rows = saved.map(progressOf);
    const order = ['pages', 'reading', 'parts'];
    const phases = rows.map((r) => r.phase);
    expect(phases).toEqual([...phases].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(new Set(phases)).toEqual(new Set(order));
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      expect(b.searches).toBeGreaterThanOrEqual(a.searches);
      if (a.phase === 'pages' && b.phase === 'pages') {
        expect(b.current).toBeGreaterThanOrEqual(a.current);
        expect(b.total).toBeGreaterThanOrEqual(a.total);
      }
      if (a.phase === 'reading' && b.phase === 'reading') expect(b.read).toBeGreaterThanOrEqual(a.read);
      if (a.phase === 'parts' && b.phase === 'parts') {
        expect(b.done).toBeGreaterThanOrEqual(a.done);
        expect(b.total).toBeGreaterThanOrEqual(a.total);
      }
    }
  });

  it('says each phase in words', () => {
    const texts = saved.map(progressText);
    expect(texts[0]).toMatch(/^Scanning · page 1 of 2 · 0 searches used$/);
    expect(texts.some((t) => /^Reading bundle pages · \d+ read · \d+ searches? used$/.test(t))).toBe(true);
    expect(texts.some((t) => /^Looking up parts · \d+ of \d+ · \d+ searches? used$/.test(t))).toBe(true);
  });

  it('the last parts row has done equal to the total', () => {
    const parts = saved.map(progressOf).filter((p) => p.phase === 'parts');
    const last = parts.at(-1)!;
    if (last.phase === 'parts') expect(last.done).toBeLessThanOrEqual(last.total);
  });
});

// ---------------------------------------------------------------- step 11, P2: the row itself
// The row draws what pipelineView says and nothing else. These tests compare the two on the jobs the replayed scan
// saved, and on records built from newPipeline for what a replay without eBay keys does not reach (two steps at once,
// the listing check's cost, a long lookup step).

const RATES: UnitRates = {};
const line = (c: HTMLElement) => c.querySelector('.progress-now')!.textContent;
const estimateOf = (c: HTMLElement) => c.querySelector('.progress-estimate')!.textContent;
const bar = () => screen.getByRole('progressbar', { name: 'Scan progress' });
const details = () => screen.getByRole('button', { name: 'Details' });
const steps = () => within(screen.getByRole('list', { name: 'Scan steps' })).getAllByRole('listitem');

/** A running job (the replay's first) whose record is the eight steps with these changes, by id. */
function jobWith(changes: Partial<Record<PipelineStep['id'], Partial<PipelineStep>>>): ScanJob {
  const pipeline = newPipeline(2).map((s) => ({ ...s, ...(changes[s.id] ?? {}) }));
  return { ...structuredClone(saved[0]!), pipeline };
}

/** Pages read, eBay and the listing check skipped, the Amazon lookups under way. */
const lookingUp = (done: number, total = 200): ScanJob =>
  jobWith({
    hdPages: { state: 'done', unitsDone: 2, unitsTotal: 2, unitsMeasured: 2 }, bundlePages: { state: 'done', unitsDone: 15, unitsTotal: 15 },
    kitPages: { state: 'done', unitsDone: 0, unitsTotal: 0 }, partPrices: { state: 'done', unitsDone: 6, unitsTotal: 6 },
    ebay: { state: 'skipped', skippedReason: 'no eBay keys' }, judge: { state: 'skipped', skippedReason: 'no Anthropic key' },
    amazon: { state: 'now', unitsDone: done, unitsTotal: total },
  });

describe('progress row (step 11): on every job a replayed scan saved', () => {
  it('says what pipelineView says: the step and its count, the estimate, and the bar', () => {
    expect(saved.every((j) => j.pipeline !== undefined)).toBe(true);
    for (const job of saved) {
      const view = pipelineView(job, RATES, T0);
      const { container, unmount } = render(createElement(ProgressRow, { job, rates: RATES }));
      expect(line(container)).toBe(view.current.count ? `${view.current.label} · ${view.current.count}` : view.current.label);
      expect(estimateOf(container)).toBe(view.estimateText);
      expect(bar()).toHaveAttribute('aria-valuetext', view.ariaValueText);
      expect(bar()).toHaveAttribute('aria-valuenow', String(Math.floor(view.fraction * 100)));
      unmount();
    }
  });

  it('moves through the steps in run order, and the bar never goes back', () => {
    const seen: string[] = [];
    let last = -1;
    for (const job of saved) {
      const { container, unmount } = render(createElement(ProgressRow, { job, rates: RATES }));
      const label = line(container)!.split(' · ')[0]!;
      if (seen.at(-1) !== label) seen.push(label);
      const now = Number(bar().getAttribute('aria-valuenow'));
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
      unmount();
    }
    // This replay reads no bundle pages (no reader is given), so those steps are skipped and never the current one.
    expect(seen[0]).toBe(CURRENT_LABELS.hdPages);
    expect(seen).toContain(CURRENT_LABELS.amazon);
    const order = seen.map((l) => STEP_IDS.findIndex((id) => CURRENT_LABELS[id] === l));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('the figures are in the figure face, and searches used are not on the collapsed row', () => {
    const job = saved.find((j) => pipelineView(j, RATES, T0).current.count !== '')!;
    const { container } = render(createElement(ProgressRow, { job, rates: RATES }));
    expect(container.querySelector('.progress-now .figure')!.textContent).toBe(pipelineView(job, RATES, T0).current.count);
    expect(container.querySelector('.progress-estimate')).toHaveClass('figure');
    expect(container.querySelector('.progress-line')!.textContent).not.toMatch(/search|\$/);
  });
});

describe('progress row (step 11): collapsed', () => {
  it('is the default: one line, the bar, and a Details button that is not expanded', () => {
    render(createElement(ProgressRow, { job: saved[0]!, rates: RATES }));
    expect(details()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Scan steps' })).toBeNull();
    expect(bar()).toHaveAttribute('aria-valuemin', '0');
    expect(bar()).toHaveAttribute('aria-valuemax', '100');
  });

  it('the bar is as wide as the fraction done', () => {
    const job = lookingUp(50);
    const view = pipelineView(job, RATES, T0);
    const { container } = render(createElement(ProgressRow, { job, rates: RATES }));
    expect(view.fraction).toBeGreaterThan(0);
    expect(view.fraction).toBeLessThan(1);
    expect(container.querySelector<HTMLElement>('.progress-fill')!.style.width).toBe(`${(view.fraction * 100).toFixed(1)}%`);
  });

  it('does not say 100 while a unit is left (the replay in e2e reached 99.6%)', () => {
    const job = lookingUp(996, 1000);
    expect(pipelineView(job, RATES, T0).fraction).toBeGreaterThan(0.995);
    render(createElement(ProgressRow, { job, rates: RATES }));
    expect(bar()).toHaveAttribute('aria-valuenow', '99');
  });

  it('with no job yet it says Scanning, and that it is estimating', () => {
    const { container } = render(createElement(ProgressRow, { job: null, rates: RATES }));
    expect(line(container)).toBe('Scanning');
    expect(estimateOf(container)).toBe('estimating');
    expect(bar()).toHaveAttribute('aria-valuenow', '0');
  });

  it('when eBay and the listing check run together, the row shows the first and the list shows both', () => {
    const job = jobWith({
      hdPages: { state: 'done', unitsDone: 2, unitsTotal: 2 }, bundlePages: { state: 'done', unitsDone: 4, unitsTotal: 4 }, kitPages: { state: 'done', unitsDone: 0, unitsTotal: 0 },
      partPrices: { state: 'done', unitsDone: 3, unitsTotal: 3 }, ebay: { state: 'now', unitsDone: 23, unitsTotal: 60 },
      judge: { state: 'now', unitsDone: 5, unitsTotal: 40, model: 'claude-haiku-5-5', costSoFar: 0.42, costEstimate: 1.08 },
    });
    const { container } = render(createElement(ProgressRow, { job, rates: RATES }));
    expect(line(container)).toBe('Checking eBay listings · 23 of 60');
    fireEvent.click(details());
    const now = steps().filter((li) => li.dataset.state === 'now').map((li) => [...li.children].map((c) => c.textContent));
    expect(now).toEqual([['eBay listings', 'now', '23 of 60'], ['Listing check (Claude)', 'now', '$0.42 so far']]);
  });
});

describe('progress row (step 11): Details', () => {
  it('expands to one line a step, in run order: name, state word, figure', () => {
    const job = lookingUp(3, 10);
    render(createElement(ProgressRow, { job, rates: RATES }));
    fireEvent.click(details());
    expect(details()).toHaveAttribute('aria-expanded', 'true');
    expect(details()).toHaveAttribute('aria-controls', screen.getByRole('list', { name: 'Scan steps' }).id);
    const view = pipelineView(job, RATES, T0);
    expect(steps()).toHaveLength(STEP_IDS.length);
    steps().forEach((li, i) => {
      expect([...li.children].map((c) => c.textContent)).toEqual([view.steps[i]!.label, view.steps[i]!.state, view.steps[i]!.figure]);
    });
    expect(steps().map((li) => li.dataset.state)).toEqual(['done', 'done', 'done', 'done', 'skipped', 'skipped', 'now', 'next']);
  });

  it('a figure is in the figure face; a skipped step says why, in words', () => {
    render(createElement(ProgressRow, { job: lookingUp(3, 10), rates: RATES }));
    fireEvent.click(details());
    const all = steps();
    expect(all[0]!.lastElementChild).toHaveTextContent('2 searches');
    expect(all[0]!.lastElementChild).toHaveClass('figure');
    expect(all[4]!.lastElementChild).toHaveTextContent('no eBay keys');
    expect(all[4]!.lastElementChild).not.toHaveClass('figure');
  });

  it('carries no icons and no marks: the words carry the state', () => {
    const { container } = render(createElement(ProgressRow, { job: lookingUp(3, 10), rates: RATES }));
    fireEvent.click(details());
    expect(container.querySelector('svg, img')).toBeNull();
    expect(container.textContent).not.toMatch(/[✓✔•●○]/);
  });

  it('is remembered: the next row opens as it was left, and closes again', () => {
    const first = render(createElement(ProgressRow, { job: lookingUp(3, 10), rates: RATES }));
    fireEvent.click(details());
    expect(localStorage.getItem(DETAILS_KEY)).toBe('open');
    first.unmount();
    const second = render(createElement(ProgressRow, { job: lookingUp(3, 10), rates: RATES }));
    expect(details()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(details());
    expect(localStorage.getItem(DETAILS_KEY)).toBe('closed');
    second.unmount();
    render(createElement(ProgressRow, { job: lookingUp(3, 10), rates: RATES }));
    expect(details()).toHaveAttribute('aria-expanded', 'false');
  });

  it('still opens and closes when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(createElement(ProgressRow, { job: lookingUp(3, 10), rates: RATES }));
    fireEvent.click(details());
    expect(details()).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('progress row (step 11): the live region and the estimate', () => {
  const spoken = (n: number) => pipelineView(lookingUp(n), RATES, T0).ariaValueText;
  const status = () => screen.getByRole('status').textContent;

  it('is a polite status that says what the bar says', () => {
    render(createElement(ProgressRow, { job: lookingUp(0), rates: RATES }));
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(status()).toBe(spoken(0));
  });

  it('changes at most every 5 seconds, and lands on the newest words', () => {
    vi.useFakeTimers();
    // 200 lookups at the 3 s seed: 10 min, then 8, 6 and 4 as they are done. Each is a new sentence.
    expect(new Set([0, 40, 80, 120].map(spoken)).size).toBe(4);
    const view = render(createElement(ProgressRow, { job: lookingUp(0), rates: RATES }));
    view.rerender(createElement(ProgressRow, { job: lookingUp(40), rates: RATES }));
    expect(status()).toBe(spoken(0));
    act(() => vi.advanceTimersByTime(2_000));
    view.rerender(createElement(ProgressRow, { job: lookingUp(80), rates: RATES }));
    expect(status()).toBe(spoken(0));
    act(() => vi.advanceTimersByTime(LIVE_EVERY_MS - 2_000 - 1));
    expect(status()).toBe(spoken(0));
    act(() => vi.advanceTimersByTime(1));
    // 5 s after the last change it spoke: the newest words, not the ones in between.
    expect(status()).toBe(spoken(80));
    view.rerender(createElement(ProgressRow, { job: lookingUp(120), rates: RATES }));
    expect(status()).toBe(spoken(80));
    act(() => vi.advanceTimersByTime(LIVE_EVERY_MS));
    expect(status()).toBe(spoken(120));
  });

  it('the visible line and the bar follow the job at once; only the spoken status waits', () => {
    vi.useFakeTimers();
    const view = render(createElement(ProgressRow, { job: lookingUp(0), rates: RATES }));
    view.rerender(createElement(ProgressRow, { job: lookingUp(40), rates: RATES }));
    expect(line(view.container)).toBe('Looking up parts on Amazon · 40 of 200');
    expect(estimateOf(view.container)).toBe(pipelineView(lookingUp(40), RATES, T0).estimateText);
    expect(bar()).toHaveAttribute('aria-valuetext', spoken(40));
    expect(status()).toBe(spoken(0));
  });

  it('never counts down by the second: with the same job nothing changes, and no timer runs', () => {
    vi.useFakeTimers();
    const { container } = render(createElement(ProgressRow, { job: lookingUp(10), rates: RATES }));
    const read = () => ({ estimate: estimateOf(container), status: status(), now: bar().getAttribute('aria-valuenow') });
    const before = read();
    expect(before.estimate).toMatch(/^about \d+ min$/);
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(read()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the estimate changes when a step's units change", () => {
    const view = render(createElement(ProgressRow, { job: lookingUp(0), rates: RATES }));
    expect(estimateOf(view.container)).toBe('about 10 min');
    view.rerender(createElement(ProgressRow, { job: lookingUp(120), rates: RATES }));
    expect(estimateOf(view.container)).toBe('about 4 min');
  });
});

