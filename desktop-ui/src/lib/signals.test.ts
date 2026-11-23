import { describe, expect, it } from 'vitest';
import { DETAILS } from '../api/mockData';
import type { DealSignals, OptionSignals, Velocity } from '../api/types';
import { marginWords, velocityWords, verdictOf } from './signals';

const signalsOf = (model: string): DealSignals => {
  const d = Object.values(DETAILS).find((x) => x.model === model);
  if (!d?.signals) throw new Error(`no mock signals for ${model}`);
  return d.signals;
};

const velocity = (v: Partial<Velocity>): Velocity => ({ status: 'pass', reason: '', minMonthlySold: 50, slowest: { model: 'DCB207', monthlySold: 120 }, parts: [{ model: 'DCB207', asin: 'B00UXDJG9M', monthlySold: 120, salesRank: null, offers: 6, pulledAt: 0 }], ...v });

describe('velocity in words', () => {
  it('says what Keepa shows for a part that sells, and where the minimum is', () => {
    expect(velocityWords(velocity({}))).toMatchObject({ text: 'Sells about 120 a month (Keepa).', sub: 'Your minimum is 50 a month.', tone: 'quiet' });
  });
  it('names the slowest part when the way to sell has several', () => {
    const v = velocity({ parts: [...velocity({}).parts, { model: 'DCD771B', asin: null, monthlySold: 450, salesRank: null, offers: 6, pulledAt: 0 }] });
    expect(velocityWords(v).sub).toBe('The slowest part is DCB207. Your minimum is 50 a month.');
  });
  it('flags a slow seller, and never calls missing data slow or fast', () => {
    expect(velocityWords(velocity({ status: 'slow', slowest: { model: 'DCB207', monthlySold: 30 } }))).toMatchObject({ text: 'Sells about 30 a month (Keepa), under your minimum.', tone: 'attention' });
    const none = velocityWords(velocity({ status: 'no_data', slowest: null, parts: [{ model: 'DCF809B', asin: null, monthlySold: null, salesRank: null, offers: null, pulledAt: null }] }));
    expect(none.text).toBe('No sales data — Keepa leaves it out for slow sellers.');
    expect(none.sub).toBe('No figure for DCF809B.');
  });
});

describe('the margin against the last scan and the 7-day average', () => {
  const option = (o: Partial<OptionSignals>): OptionSignals => ({ ...signalsOf('DCK240C2').options[0]!, ...o });
  it('says up or down with the figures it compares', () => {
    const o = option({ profit: 50, roiPercent: 33.6, baseline: { last: { at: 1, profit: 38, roiPercent: 25 }, rolling7d: { profit: 41.5, roiPercent: 27, points: 6, since: 1 } } });
    expect(marginWords(o, { minProfit: 30, minRoiPercent: 25 })).toBe(
      'Estimated profit is $50.00 (34% ROI), up $12.00 from the last scan ($38.00) and $8.50 above its 7-day average of $41.50 (6 scans). Your numbers: $30.00 and 25%.',
    );
  });
  it('uses a real minus and says what it lacks instead of inventing a baseline', () => {
    const o = option({ profit: -12.5, roiPercent: -8, baseline: { last: null, rolling7d: null } });
    expect(marginWords(o, null)).toBe('Estimated profit is −$12.50 (−8% ROI).');
    expect(marginWords(option({ profit: null }), null)).toBeNull();
  });
});

describe('the verdict of a watched bundle', () => {
  it('is worth buying now with its reasons: the margin, the sales and what happened', () => {
    const v = verdictOf(signalsOf('DCK240C2'));
    expect(v.buyNow).toBe(true);
    expect(v.headline).toBe('Worth buying now');
    expect(v.sentence).toMatch(/^An estimated \$\d+\.\d\d profit \(\d+% ROI\) clears your numbers/);
    expect(v.reasons.map((r) => r.label)).toEqual(['Margin', 'Sales']);
    expect(v.reasons[1]).toMatchObject({ text: 'Sells about 90 a month (Keepa).', asin: { model: 'DCB207' } });
  });
  it('says why not in the agent\'s own sentence, and still shows the sales', () => {
    const v = verdictOf(signalsOf('PCL1200K2'));
    expect(v.buyNow).toBe(false);
    expect(v.headline).toBe('Not worth buying now');
    expect(v.sentence).toBe('It leaves 18V Charger unsold.');
    expect(v.reasons.find((r) => r.label === 'Sales')?.text).toMatch(/^Sells about 38 a month \(Keepa\), under your minimum/);
  });
  it('does not call a bundle with no sales data fast or slow', () => {
    const v = verdictOf(signalsOf('PCL1600K2-A983002'));
    expect(v.buyNow).toBe(false);
    expect(v.reasons.find((r) => r.label === 'Sales')?.text).toBe('No sales data — Keepa leaves it out for slow sellers.');
  });
  it('has nothing to judge when no way to sell has an estimate', () => {
    const v = verdictOf({ at: '2026-11-23T10:00:00.000Z', buyNow: null, signals: [], options: [] });
    expect(v).toMatchObject({ buyNow: false, way: null, reasons: [], sentence: 'No way to sell has an estimate yet, so there is nothing to judge.' });
  });
  it('shows a margin that fell below the floor as its own line', () => {
    const s = signalsOf('DCK240C2');
    const down = { ...s, buyNow: null, signals: [{ ...s.signals[0]!, kind: 'marginDown' as const, reason: 'Estimated profit fell from $38.10 to -$2.00, below your $30.00 floor.' }], options: s.options.map((o) => ({ ...o, buyNow: false, notBuyNow: 'Below your numbers.' })) };
    const v = verdictOf(down);
    expect(v.reasons.at(-1)).toMatchObject({ label: 'Margin fell', tone: 'attention', text: 'Estimated profit fell from $38.10 to −$2.00, below your $30.00 floor.' });
  });
});
