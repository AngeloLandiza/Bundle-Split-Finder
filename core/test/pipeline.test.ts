// Step 11, P1: the estimate, the rates and the words, on jobs written by hand for the edge cases. The jobs the runner
// builds are in pipeline-runner.test.ts.

import { describe, expect, it } from 'vitest';

import {
  addSamples, closeRest, CURRENT_LABELS, derivePipeline, endStep, estimate, moveUnits, newPipeline, type PipelineStep, pipelineView, RATE_WINDOW, secondsPerUnit, SEED_SECONDS, skipStep,
  startStep, STEP_IDS, trustedRates, type UnitRates,
} from '../src/scan/pipeline';
import type { ScanJob } from '../src/scan/types';

const NOW = Date.UTC(2026, 10, 20, 9);

/**
 * The jobs below list their steps in the order a scan ran them before step 15 (the lookups after eBay); each entry is
 * put on its step by id, so the cases read as they were written whatever the run order is now.
 */
const WRITTEN = ['hdPages', 'bundlePages', 'kitPages', 'partPrices', 'ebay', 'judge', 'amazon', 'finish'] as const;
const at = (j: ScanJob, id: (typeof WRITTEN)[number]): PipelineStep => j.pipeline!.find((s) => s.id === id)!;

function job(steps: Partial<PipelineStep>[], over: Partial<ScanJob> = {}): ScanJob {
  const base = newPipeline(1);
  return {
    id: '1', startedAt: NOW, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'listing', queue: [], deferred: [], searchesUsed: 0,
    counts: { pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0 },
    pipeline: base.map((s) => ({ ...s, ...(steps[WRITTEN.indexOf(s.id as (typeof WRITTEN)[number])] ?? {}) })),
    ...over,
  };
}

/** All eight steps, in order: done unless said otherwise. */
const done = (n: number): Partial<PipelineStep>[] => Array.from({ length: n }, (_, i) => ({ state: 'done' as const, unitsDone: i, unitsTotal: i }));

describe('estimate', () => {
  it('adds up the units left times the seconds a unit takes, from the seeds when nothing is measured', () => {
    // 10 Home Depot pages read of 20 left: 10 searches at the 3 s seed; nothing else has a total, so it is a lower bound of 30 s.
    const j = job([{ state: 'now', unitsDone: 10, unitsTotal: 20 }]);
    expect(estimate(j, {}, NOW)).toEqual({ kind: 'estimating', seconds: 0 });
    const bigger = job([{ state: 'now', unitsDone: 10, unitsTotal: 60 }]);
    expect(estimate(bigger, {}, NOW)).toEqual({ kind: 'atLeast', seconds: 150 });
  });

  it('is exact, with "about" and "under a minute", once every step that will run has a total', () => {
    const all = (extra: Partial<PipelineStep>[]): ScanJob => job(extra.map((e) => ({ unitsTotal: 0, ...e })));
    // 1 search at 3 s and 4 page reads at 3 s, and the rest skipped or done: 15 s.
    const small = all([{ state: 'now', unitsDone: 0, unitsTotal: 1 }, { state: 'next', unitsTotal: 4 }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'next', unitsTotal: 0 }, { state: 'next', unitsTotal: 1 }]);
    expect(estimate(small, {}, NOW)).toEqual({ kind: 'underMinute', seconds: 15 });
    const bigger = all([{ state: 'next', unitsTotal: 30 }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'next', unitsTotal: 30 }, { state: 'next', unitsTotal: 1 }]);
    expect(estimate(bigger, {}, NOW)).toEqual({ kind: 'about', seconds: 180 });
  });

  it('a skipped step is not counted, and neither is a done one', () => {
    const j = job([{ state: 'done', unitsDone: 9, unitsTotal: 9 }, { state: 'skipped', unitsTotal: 500 }, { state: 'skipped', unitsTotal: 500 }, { state: 'skipped', unitsTotal: 500 }, { state: 'skipped' }, { state: 'skipped' }, { state: 'next', unitsTotal: 20 }, { state: 'next', unitsTotal: 1 }]);
    expect(estimate(j, {}, NOW)).toEqual({ kind: 'about', seconds: 60 });
  });

  it('while a step has no total yet, the sum is a lower bound: "atLeast", or "estimating" when that bound is under a minute', () => {
    // Before the bundles are split: the Home Depot pages are known, the rest are not.
    const early = job([{ state: 'now', unitsDone: 0, unitsTotal: 30 }]);
    expect(estimate(early, {}, NOW)).toEqual({ kind: 'atLeast', seconds: 90 });
    const tiny = job([{ state: 'now', unitsDone: 0, unitsTotal: 5 }]);
    expect(estimate(tiny, {}, NOW).kind).toBe('estimating');
  });

  it('a step with units left and no rate, measured or seeded, is "estimating"', () => {
    const j = job([{ state: 'done' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'now', unitsDone: 0, unitsTotal: 4 }, { state: 'now', unitsDone: 0, unitsTotal: 50, model: 'claude-future-9' }, { state: 'next', unitsTotal: 3 }]);
    expect(estimate(j, {}, NOW).kind).toBe('estimating');
    // A rate for that model makes it a number.
    expect(estimate(j, { 'judgeCall:claude-future-9': [4] }, NOW)).toMatchObject({ kind: 'about' });
  });

  it('a worker evicted in the middle of a step: the step is "now" with its units, and the estimate carries on from them', () => {
    // Saved as the eviction left it: 15 of 40 listings read. The next run starts the step again with 25 left.
    const saved = job([{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'now', unitsDone: 15, unitsTotal: 40, startedAt: NOW }, { state: 'skipped' }, { state: 'next', unitsTotal: 0 }, { state: 'next', unitsTotal: 1 }]);
    const before = estimate(saved, {}, NOW);
    startStep(saved, 'ebay', { remaining: 25, now: NOW + 1000 });
    expect(at(saved, 'ebay')).toMatchObject({ state: 'now', unitsDone: 15, unitsTotal: 40, startedAt: NOW });
    expect(estimate(saved, {}, NOW + 60_000)).toEqual(before);
    // 25 calls at 0.6 s.
    expect(before).toEqual({ kind: 'underMinute', seconds: 15 });
  });

  it('does not count down with the clock: the same job at any time is the same estimate', () => {
    const j = job([{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'now', unitsDone: 3, unitsTotal: 300 }, { state: 'skipped' }, { state: 'next', unitsTotal: 0 }, { state: 'next', unitsTotal: 1 }]);
    expect(estimate(j, {}, NOW)).toEqual(estimate(j, {}, NOW + 600_000));
  });

  it("uses this scan's own measurement of a kind before the older ones", () => {
    const j = job([
      { state: 'done', unitsDone: 4, unitsTotal: 4, activeMs: 40_000, unitsMeasured: 4 },
      { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' },
      { state: 'next', unitsTotal: 6 }, { state: 'next', unitsTotal: 1 },
    ]);
    // Amazon lookups are searches too: this scan's searches took 10 s each, whatever the median says.
    expect(estimate(j, { serpapiSearch: [2] }, NOW)).toEqual({ kind: 'about', seconds: 60 });
    const none = job([{ state: 'done' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'next', unitsTotal: 6 }, { state: 'next', unitsTotal: 1 }]);
    expect(estimate(none, { serpapiSearch: [2] }, NOW)).toEqual({ kind: 'underMinute', seconds: 12 });
  });
});

describe('rates', () => {
  it('the seeds are those the plan names; a kind with no seed has none', () => {
    expect(SEED_SECONDS).toMatchObject({ serpapiSearch: 3, hdPageRead: 3, ebayCall: 0.6, 'judgeCall:claude-haiku-5-5': 2.5, 'judgeCall:claude-opus-5-5': 7 });
    expect(secondsPerUnit({}, 'serpapiSearch')).toEqual({ seconds: 3, measured: false });
    expect(secondsPerUnit({}, 'judgeCall:claude-future-9')).toBeNull();
    expect(secondsPerUnit({}, 'constructor')).toBeNull();
  });

  it('the rate is the median of what was measured, the seed only until then', () => {
    expect(secondsPerUnit({ serpapiSearch: [1, 9, 2] }, 'serpapiSearch')).toEqual({ seconds: 2, measured: true });
    expect(secondsPerUnit({ serpapiSearch: [1, 3] }, 'serpapiSearch')).toEqual({ seconds: 2, measured: true });
  });

  it('keeps the last 20 samples of each kind, oldest dropped', () => {
    let rates: UnitRates = {};
    for (let i = 1; i <= 25; i++) rates = addSamples(rates, [{ kind: 'ebayCall', seconds: i }]);
    expect(rates.ebayCall).toHaveLength(RATE_WINDOW);
    expect(rates.ebayCall![0]).toBe(6);
    expect(rates.ebayCall![19]).toBe(25);
    expect(secondsPerUnit(rates, 'ebayCall')!.seconds).toBe(15.5);
  });

  it('does not change the rates it was given', () => {
    const before: UnitRates = { hdPageRead: [3] };
    addSamples(before, [{ kind: 'hdPageRead', seconds: 5 }]);
    expect(before).toEqual({ hdPageRead: [3] });
  });

  it('stored rates are untrusted: anything but positive numbers in a list is dropped', () => {
    expect(trustedRates(null)).toEqual({});
    expect(trustedRates([1, 2])).toEqual({});
    expect(trustedRates({ a: [1, 'x', -2, NaN, 0, 3], b: 'no', c: [], d: Array.from({ length: 30 }, (_, i) => i + 1) }).a).toEqual([1, 3]);
    expect(Object.keys(trustedRates({ a: [1], b: 'no', c: [] }))).toEqual(['a']);
    expect(trustedRates({ d: Array.from({ length: 30 }, (_, i) => i + 1) }).d).toHaveLength(RATE_WINDOW);
  });
});

describe('the helpers the runner calls', () => {
  it('start, advance, end: a step that ends has exactly the units it did', () => {
    const j = job([]);
    startStep(j, 'bundlePages', { remaining: 12, now: NOW });
    expect(at(j, 'bundlePages')).toMatchObject({ state: 'now', unitsDone: 0, unitsTotal: 12, startedAt: NOW });
    moveUnits(j, 'bundlePages', { done: 9 });
    endStep(j, 'bundlePages', NOW + 5);
    expect(at(j, 'bundlePages')).toMatchObject({ state: 'done', unitsDone: 9, unitsTotal: 9, endedAt: NOW + 5 });
  });

  it('a skipped step stays skipped, and its reason is cut to four words', () => {
    const j = job([]);
    skipStep(j, 'kitPages', 'the page reader was not given to this run');
    expect(at(j, 'kitPages').skippedReason).toBe('the page reader was');
    startStep(j, 'kitPages', { remaining: 3, now: NOW });
    expect(at(j, 'kitPages').state).toBe('skipped');
  });

  it('a step that has run is not skipped afterwards', () => {
    const j = job([]);
    startStep(j, 'hdPages', { remaining: 1, now: NOW });
    endStep(j, 'hdPages', NOW);
    skipStep(j, 'hdPages', 'stopped');
    expect(j.pipeline![0]!.state).toBe('done');
  });

  it('closing the rest: what was going ends, what never began did not run, and the finish is left to the runner', () => {
    const j = job([{ state: 'now', unitsDone: 2, unitsTotal: 9 }, { state: 'next' }]);
    closeRest(j, 'stopped', NOW);
    expect(j.pipeline!.map((s) => s.state)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'next']);
    expect(j.pipeline![0]).toMatchObject({ unitsDone: 2, unitsTotal: 2 });
    expect(j.pipeline![1]!.skippedReason).toBe('stopped');
  });

  it('every helper does nothing to a job with no record', () => {
    const j = job([]);
    delete j.pipeline;
    startStep(j, 'ebay', { remaining: 3, now: NOW });
    moveUnits(j, 'ebay', { done: 1 });
    skipStep(j, 'judge', 'x');
    endStep(j, 'ebay', NOW);
    expect(j.pipeline).toBeUndefined();
  });

  it('a record derived for a job without one: the phase says which steps are over', () => {
    const j = job([], { phase: 'parts', queue: [{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' }], counts: { ...job([]).counts, lookupsDone: 3, pagesFetched: 2, catalogPages: 1, pagesRead: 7 } });
    delete j.pipeline;
    const steps = derivePipeline(j);
    // A job that old read its part prices and eBay before the lookups, so they are over too.
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'now', 'done', 'done', 'done', 'next']);
    expect(steps[0]).toMatchObject({ unitsDone: 3, unitsTotal: 3 });
    expect(steps.find((s) => s.id === 'amazon')).toMatchObject({ unitsDone: 3, unitsTotal: 4 });
  });
});

describe('pipelineView', () => {
  /** The search side of a scan under way: Home Depot done, bundles and kits read, eBay going, lookups not planned. */
  const midScan = (): ScanJob =>
    job([
      { state: 'done', unitsDone: 6, unitsTotal: 6, unitsMeasured: 4, activeMs: 12_000 },
      { state: 'done', unitsDone: 15, unitsTotal: 15 },
      { state: 'done', unitsDone: 4, unitsTotal: 4 },
      { state: 'done', unitsDone: 22, unitsTotal: 22 },
      { state: 'now', unitsDone: 23, unitsTotal: 60 },
      { state: 'now', unitsDone: 9, unitsTotal: 20, model: 'claude-opus-5-5', costSoFar: 0.42 },
      { state: 'next', unitsTotal: null },
      { state: 'next', unitsTotal: 1 },
    ]);

  it('says what the spec says, in the spec words, for a scan under way', () => {
    const rates: UnitRates = { ebayCall: [0.6], 'judgeCall:claude-opus-5-5': [7] };
    const v = pipelineView(midScan(), rates, NOW);
    expect(v.current).toEqual({ label: 'Checking eBay listings', count: '23 of 60' });
    expect(v.steps).toEqual([
      { label: 'Home Depot deals pages', state: 'done', figure: '4 searches', done: 6, total: 6 },
      { label: 'Bundle pages', state: 'done', figure: '15 read', done: 15, total: 15 },
      { label: 'Kit pages', state: 'done', figure: '4 read', done: 4, total: 4 },
      { label: 'Amazon lookups', state: 'next', figure: '' },
      { label: 'Home Depot part prices', state: 'done', figure: '22 read', done: 22, total: 22 },
      { label: 'eBay listings', state: 'now', figure: '23 of 60', done: 23, total: 60 },
      { label: 'Listing check (Claude)', state: 'now', figure: '$0.42 so far', done: 9, total: 20 },
      { label: 'Finish', state: 'next', figure: '' },
    ]);
    expect(v.stepsDone).toBe(4);
    expect(v.stepsTotal).toBe(8);
  });

  it('the estimate text: about, under a minute, at least, estimating', () => {
    const text = (j: ScanJob, r: UnitRates = {}) => pipelineView(j, r, NOW).estimateText;
    // 37 eBay calls and 11 model calls at 7 s = 99 s; the lookups are unknown: at least 2 min.
    expect(text(midScan())).toBe('at least 2 min');
    const planned = midScan();
    at(planned, 'amazon').unitsTotal = 10;
    // 10 more searches at 3 s: 99 + 30 = 129 s = about 2 min.
    expect(text(planned)).toBe('about 2 min');
    at(planned, 'ebay').unitsDone = 60;
    at(planned, 'judge').unitsDone = 20;
    // 10 searches at 3 s.
    expect(text(planned)).toBe('under a minute');
    const unknown = midScan();
    at(unknown, 'judge').model = 'claude-future-9';
    expect(text(unknown)).toBe('estimating');
    // Step 15: the desktop app asks for '' while the time is not known, and shows the counts only.
    expect(pipelineView(unknown, {}, NOW, { unknown: '' }).estimateText).toBe('');
    // 4 min: 8 searches at 30 s.
    const four = job([{ state: 'done' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'now', unitsDone: 0, unitsTotal: 8 }, { state: 'next', unitsTotal: 1 }]);
    expect(text(four, { serpapiSearch: [30] })).toBe('about 4 min');
  });

  it('the bar names the step and the time left, singular for one minute', () => {
    const one = job([{ state: 'done' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'now', unitsDone: 0, unitsTotal: 20 }, { state: 'next', unitsTotal: 1 }]);
    const v = pipelineView(one, {}, NOW);
    expect(v.estimateText).toBe('about 1 min');
    expect(v.ariaValueText).toBe('Step 4 of 8, looking up parts, about 1 minute left');
    const small = job([{ state: 'done' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'now', unitsDone: 0, unitsTotal: 3 }, { state: 'next', unitsTotal: 1 }]);
    expect(pipelineView(small, {}, NOW).ariaValueText).toBe('Step 4 of 8, looking up parts, less than a minute left');
  });

  it('skipped steps give the reason as their figure, and the next model step the estimated cost', () => {
    const j = job([{ state: 'done', unitsMeasured: 1 }, { state: 'skipped', skippedReason: 'no page reader' }, { state: 'skipped', skippedReason: 'no page reader' }, { state: 'skipped', skippedReason: 'no price reader' }, { state: 'skipped', skippedReason: 'no eBay keys' }, { state: 'next', costEstimate: 1.08, model: 'claude-opus-5-5' }, { state: 'next', unitsTotal: 4 }]);
    const v = pipelineView(j, {}, NOW);
    expect(v.steps.map((s) => s.figure)).toEqual(['1 search', 'no page reader', 'no page reader', '', 'no price reader', 'no eBay keys', 'est. $1.08', '']);
    expect(v.stepsDone).toBe(5);
  });

  it('a done model step shows what it cost; a done search step says how many searches the network answered; a done lookup step how many it did, or what paid', () => {
    const j = job([{ state: 'done', unitsDone: 3, unitsMeasured: 0 }, { state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done', unitsDone: 12 }, { state: 'done', costSoFar: 0.1 }, { state: 'done', unitsDone: 3, unitsMeasured: 1 }, { state: 'now', unitsDone: 0, unitsTotal: 1 }]);
    const figure = (id: (typeof WRITTEN)[number]) => pipelineView(j, {}, NOW).steps[STEP_IDS.indexOf(id)]!.figure;
    expect(figure('hdPages')).toBe('0 searches');
    expect(figure('ebay')).toBe('12 calls');
    expect(figure('judge')).toBe('$0.10');
    // Lookups are Keepa calls or searches: the step counts lookups, and says what paid once the runner notes it.
    expect(figure('amazon')).toBe('3 lookups');
    at(j, 'amazon').note = '4 Keepa, 14 searches, 2 wait';
    expect(figure('amazon')).toBe('4 Keepa, 14 searches, 2 wait');
  });

  it('the bar: weighted by the time each step takes when every size is known, else steps done over steps in all', () => {
    // Known sizes: 30 s done of 30 + 60 s = 1/3.
    const known = job([{ state: 'done', unitsDone: 10, unitsTotal: 10 }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'next', unitsTotal: 20 }, { state: 'next', unitsTotal: 1 }]);
    expect(pipelineView(known, {}, NOW).fraction).toBeCloseTo(1 / 3, 10);
    // An unknown size: 4 of 8 steps.
    const unknown = job([{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'now', unitsDone: 1, unitsTotal: null }]);
    expect(pipelineView(unknown, {}, NOW).fraction).toBe(0.5);
    // Skipped steps count as passed.
    const skipped = job([{ state: 'done' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'now', unitsTotal: null }]);
    expect(pipelineView(skipped, {}, NOW).fraction).toBe(0.5);
  });

  it('the bar is never outside 0 to 1, even when a step has done more than its total said', () => {
    const over = job([{ state: 'now', unitsDone: 9, unitsTotal: 3 }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'skipped' }, { state: 'next', unitsTotal: 1 }]);
    const f = pipelineView(over, {}, NOW).fraction;
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });

  it('a job with no record is drawn from its phase, so the row works on a job from before step 11', () => {
    const j = job([], { phase: 'listing', queue: [{ kind: 'listing', q: 'x', page: 2, filterTokens: null, bundlesOnly: false }, { kind: 'listing', q: 'x', page: 3, filterTokens: null, bundlesOnly: false }], counts: { ...job([]).counts, pagesFetched: 1 } });
    delete j.pipeline;
    const v = pipelineView(j, {}, NOW);
    expect(v.current).toEqual({ label: 'Fetching deals pages', count: '1 of 3' });
    expect(v.steps[0]).toEqual({ label: 'Home Depot deals pages', state: 'now', figure: '1 of 3', done: 1, total: 3 });
  });

  it('every step name and the finish are the spec words', () => {
    expect(pipelineView(job([]), {}, NOW).steps.map((s) => s.label)).toEqual([
      'Home Depot deals pages', 'Bundle pages', 'Kit pages', 'Amazon lookups', 'Home Depot part prices', 'eBay listings', 'Listing check (Claude)', 'Finish',
    ]);
  });

  it('the current-step labels are short enough to sit whole beside the count and Details at 360px (UI review, fix 1)', () => {
    expect(STEP_IDS.map((id) => CURRENT_LABELS[id])).toEqual([
      'Fetching deals pages', 'Reading bundle pages', 'Reading kit pages', 'Looking up parts', 'Reading part prices', 'Checking eBay listings', 'Checking listings', 'Finishing up',
    ]);
    for (const id of STEP_IDS) expect(CURRENT_LABELS[id].length).toBeLessThanOrEqual(22);
  });
});
