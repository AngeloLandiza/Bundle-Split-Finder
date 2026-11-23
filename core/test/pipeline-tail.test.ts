// Nov 23, "honest progress": the owner's scan 5 showed "Step 8 of 8, finishing up, less than a minute left" for about ten
// minutes while the long work after the runner (the AI on 9 Review cards) ran. The long work now has steps of its own with
// counts, "Finishing up" is only the short tail, and a time left is shown only from timings that were measured.
// The shape of the real run: fixtures/e2e-2026-11-23/after-scan5 (eBay 80 calls, the listing check 60, the runner's
// steps all done) with the two steps the desktop app adds after the runner.

import { describe, expect, it } from 'vitest';

import {
  DESKTOP_STEP_WORDS, estimateSteps, finishUnit, newTailSteps, type PipelineStep, pipelineViewOf, samplesOf, startStep, TAIL_IDS, type UnitRates,
} from '../src/scan/pipeline';
import type { ScanJob } from '../src/scan/types';

const NOW = 1_795_475_782_108;
const done = (id: PipelineStep['id'], units: number, extra: Partial<PipelineStep> = {}): PipelineStep => ({ id, state: 'done', unitsDone: units, unitsTotal: units, ...extra });

/** The runner's steps as the real scan ended them (scan 5), without the runner's own finish. */
const RUNNER: PipelineStep[] = [
  done('hdPages', 22, { source: 'chrome', found: 191, unitsMeasured: 0 }),
  done('bundlePages', 25, { activeMs: 20_976, unitsMeasured: 25 }),
  done('kitPages', 0),
  done('amazon', 29, { activeMs: 62_394, unitsMeasured: 28 }),
  { id: 'partPrices', state: 'skipped', unitsDone: 0, unitsTotal: null, skippedReason: 'Home Depot refused' },
  done('ebay', 80, { activeMs: 45_093, unitsMeasured: 80 }),
  done('judge', 60, { model: 'claude-haiku-5-5', activeMs: 160_237, unitsMeasured: 60, costSoFar: 0.0321 }),
];
const FINISH = (state: PipelineStep['state']): PipelineStep => ({ id: 'finish', state, unitsDone: state === 'done' ? 1 : 0, unitsTotal: 1 });
const viewOf = (tail: PipelineStep[], finish: PipelineStep['state'], rates: UnitRates = {}) =>
  pipelineViewOf([...RUNNER, ...tail, FINISH(finish)], rates, NOW, { unknown: '', measuredOnly: true, words: DESKTOP_STEP_WORDS });

describe('the steps after the runner', () => {
  it('there are two, waiting, and the runner\'s own eight are unchanged', () => {
    expect(TAIL_IDS).toEqual(['review', 'confirm']);
    expect(newTailSteps()).toEqual([
      { id: 'review', state: 'next', unitsDone: 0, unitsTotal: null },
      { id: 'confirm', state: 'next', unitsDone: 0, unitsTotal: null },
    ]);
  });

  it('while the AI works the Review cards the line says "Review cards 3 of 9", not "Finishing up"', () => {
    const review: PipelineStep = { id: 'review', state: 'now', unitsDone: 3, unitsTotal: 9, startedAt: NOW };
    const v = viewOf([review, { id: 'confirm', state: 'next', unitsDone: 0, unitsTotal: null }], 'next');
    expect(v.current).toEqual({ label: 'Review cards', count: '3 of 9' });
    expect(v.steps.map((s) => s.label)).toEqual([
      'Home Depot bundle lists', 'Bundle pages', 'Kit pages', 'Amazon lookups', 'Home Depot part prices', 'eBay prices', 'Listing check', 'Review cards', 'Listing confirmation', 'Finishing up',
    ]);
    expect(v.steps.find((s) => s.label === 'Review cards')).toMatchObject({ state: 'now', figure: '3 of 9', done: 3, total: 9 });
    // The step number counts the ten steps, and the runner's eight are all behind it.
    expect(v.stepsTotal).toBe(10);
    expect(v.stepsDone).toBe(7);
    expect(v.ariaValueText).toMatch(/^Step 8 of 10, review cards, /);
  });

  it('eBay is named by what it counts: "eBay prices 34 of 80"', () => {
    const ebay: PipelineStep = { id: 'ebay', state: 'now', unitsDone: 34, unitsTotal: 80, activeMs: 20_000, unitsMeasured: 34 };
    const steps = [...RUNNER.slice(0, 5), ebay, { ...RUNNER[6]!, state: 'now' as const, unitsDone: 20, unitsTotal: 60 }, ...newTailSteps(), FINISH('next')];
    const v = pipelineViewOf(steps, {}, NOW, { unknown: '', measuredOnly: true, words: DESKTOP_STEP_WORDS });
    expect(v.current).toEqual({ label: 'eBay prices', count: '34 of 80' });
    expect(v.steps.find((s) => s.label === 'Listing check')).toMatchObject({ state: 'now', done: 20, total: 60 });
  });

  it('"Finishing up" is the last step only, and says so only when it is the one running', () => {
    const v = viewOf([done('review', 9), done('confirm', 0)], 'now');
    expect(v.current).toEqual({ label: 'Finishing up', count: '' });
    expect(v.stepsDone).toBe(9);
    expect(viewOf([{ id: 'review', state: 'now', unitsDone: 0, unitsTotal: null }, ...newTailSteps().slice(1)], 'next').current.label).toBe('Review cards');
  });

  it('without the words the extension keeps the spec\'s names', () => {
    const v = pipelineViewOf([...RUNNER, ...newTailSteps(), FINISH('next')], {}, NOW, {});
    expect(v.steps.map((s) => s.label)).toContain('eBay listings');
    expect(v.steps.map((s) => s.label)).toContain('Listing check (Claude)');
  });
});

describe('the time left is measured or not shown', () => {
  const review = (done_: number, total: number | null, over: Partial<PipelineStep> = {}): PipelineStep => ({ id: 'review', state: 'now', unitsDone: done_, unitsTotal: total, ...over });
  // The listing confirmation, with nothing for it to read.
  const waiting: PipelineStep[] = [{ id: 'confirm', state: 'next', unitsDone: 0, unitsTotal: 0 }];

  it('before any card was timed there is no estimate: not a seed\'s guess', () => {
    // askAi has a seed of 8 s a card; with measuredOnly it is not used.
    const v = viewOf([review(0, 9), ...waiting], 'next');
    expect(v.estimateText).toBe('');
    expect(estimateSteps([...RUNNER, review(0, 9), ...waiting, FINISH('next')], {}, true).kind).toBe('estimating');
    // The extension, which says "estimating" or a seeded figure, is unchanged.
    expect(estimateSteps([...RUNNER, review(0, 9), ...waiting, FINISH('next')], {}).kind).toBe('about');
  });

  it('after three cards were timed in this scan the estimate is theirs: 6 left at 40 s each is about 4 min', () => {
    const v = viewOf([review(3, 9, { activeMs: 120_000, unitsMeasured: 3 }), { id: 'confirm', state: 'next', unitsDone: 0, unitsTotal: 0 }], 'next');
    expect(v.estimateText).toBe('about 4 min');
    expect(v.ariaValueText).toContain('about 4 minutes left');
  });

  it('fewer than three timed cards are noise: no estimate yet, unless an earlier scan measured the rate', () => {
    expect(viewOf([review(2, 9, { activeMs: 80_000, unitsMeasured: 2 }), ...waiting], 'next').estimateText).toBe('');
    const earlier: UnitRates = { askAi: [30, 34, 36] };
    // The median of the earlier scans, 34 s a card: 7 left is about 4 min.
    expect(viewOf([review(2, 9, { activeMs: 80_000, unitsMeasured: 2 }), ...waiting], 'next', earlier).estimateText).toBe('about 4 min');
  });

  it('a step whose total is not known yet gives no estimate under a minute, and a lower bound over one', () => {
    expect(viewOf([review(3, null, { activeMs: 120_000, unitsMeasured: 3 }), ...waiting], 'next').estimateText).toBe('');
    // The confirmation's size is not known until it starts: what is added up is "at least", never "about".
    expect(viewOf([review(3, 9, { activeMs: 120_000, unitsMeasured: 3 }), ...newTailSteps().slice(1)], 'next').estimateText).toBe('at least 4 min');
  });

  it('the bar does not weigh a step by a seed: it counts steps while a rate is missing', () => {
    const v = viewOf([review(0, 9), ...waiting], 'next');
    // 7 of 10 steps done (skipped counts as done), so 0.7; no guessed seconds in it.
    expect(v.fraction).toBeCloseTo(0.7, 5);
  });
});

describe('timings of the tail are kept for the next scan', () => {
  it('each card the AI is asked about is timed; a card not asked is not', () => {
    const job = { pipeline: newTailSteps() } as unknown as ScanJob;
    startStep(job, 'review', { remaining: 3, now: NOW });
    finishUnit(job, 'review', { ms: 30_000, remaining: 2 });
    finishUnit(job, 'review', { ms: null, remaining: 1 });
    finishUnit(job, 'review', { ms: 50_000, remaining: 0 });
    expect(job.pipeline!.find((s) => s.id === 'review')).toMatchObject({ unitsDone: 3, unitsTotal: 3, unitsMeasured: 2, activeMs: 80_000 });
    expect(samplesOf(job)).toEqual([{ kind: 'askAi', seconds: 40 }]);
  });
});
