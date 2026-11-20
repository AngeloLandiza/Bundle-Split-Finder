// The progress row for "Ask AI about all" (step 12): the same view the scan's row draws, from the queue's own counts.

import { describe, expect, it } from 'vitest';
import { askAllView, SEED_SECONDS, secondsPerUnit, type AskAllProgress } from '../src/scan/pipeline';

const progress = (over: Partial<AskAllProgress> = {}): AskAllProgress => ({ done: 7, total: 26, costUsd: 0.41, estimateUsd: 2.6, ...over });

describe('askAllView', () => {
  it('says the step and its own count in plain words, as the scan\'s steps do', () => {
    const v = askAllView(progress(), {});
    expect(v.current).toEqual({ label: 'Asking AI', count: '7 of 26' });
  });

  it('shows what it has cost so far in Details, one line, the step now', () => {
    const v = askAllView(progress(), {});
    expect(v.steps).toEqual([{ label: 'Asking AI', state: 'now', figure: '$0.41 so far' }]);
  });

  it('estimates the time left from the seed until a rate has been measured, then from the measured rate', () => {
    // 19 left at the seed.
    expect(SEED_SECONDS.askAi).toBeGreaterThan(0);
    const seeded = askAllView(progress(), {});
    expect(seeded.estimateText).toBe(`about ${Math.round((19 * SEED_SECONDS.askAi!) / 60)} min`);
    const measured = askAllView(progress(), { askAi: [30, 30, 30] });
    expect(measured.estimateText).toBe('about 10 min');
    expect(secondsPerUnit({ askAi: [30] }, 'askAi')).toEqual({ seconds: 30, measured: true });
  });

  it('says under a minute when little is left, and never counts down by the second', () => {
    expect(askAllView(progress({ done: 25 }), { askAi: [10] }).estimateText).toBe('under a minute');
    expect(askAllView(progress({ done: 26 }), { askAi: [10] }).estimateText).toBe('under a minute');
  });

  it('fills the bar by the questions asked, and speaks the same words', () => {
    const v = askAllView(progress({ done: 13 }), { askAi: [60] });
    expect(v.fraction).toBeCloseTo(0.5, 5);
    expect(v.ariaValueText).toBe('Asking AI, 13 of 26, about 13 minutes left');
    expect(v.stepsDone).toBe(0);
    expect(v.stepsTotal).toBe(1);
    expect(v.labels).toEqual({ bar: 'Asking AI progress', steps: 'Asking AI steps' });
  });

  it('has an empty bar before the first answer and none when there is nothing to ask', () => {
    expect(askAllView(progress({ done: 0, costUsd: 0 }), {}).fraction).toBe(0);
    expect(askAllView(progress({ done: 0, total: 0, costUsd: 0 }), {}).fraction).toBe(0);
    expect(askAllView(progress({ done: 0, costUsd: 0 }), {}).steps[0]!.figure).toBe('$0.00 so far');
  });
});
