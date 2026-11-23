import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type AlertSettings } from '../src/settings';
import { appendHistory, baselineOf, bundleSignals, historyPoint, velocityOf, type HistoryPoint } from '../src/tracking/signals';
import { ASIN, bundle, option, part, recordedTrend } from './tracking-world';

const alerts: AlertSettings = { ...DEFAULT_SETTINGS.alerts, enabled: true, minProfit: 20, minRoiPercent: 20 };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 15);

// $299 bundle; DCF921B at $249 and DCB606 at $199 net $211.65 + $169.15 = $380.80: est. profit $81.80, 27% ROI.
const good = () => bundle([option('whole', 299, [part('DCF921B', ASIN.DCF921B, 249), part('DCB606', ASIN.DCB606, 199)])]);
const point = (at: number, profit: number | null, roi: number | null, over: Partial<HistoryPoint> = {}): HistoryPoint => ({
  at, section: 'confirmed', price: 299, amazonNew: 448, options: [{ id: 'whole', profit, roiPercent: roi }], reviewOpen: false,
  monthlySold: 600, salesRank: null, offers: 40, ...over,
});

describe('velocity from the stored Keepa figures', () => {
  it('passes when the slowest part reaches the minimum, and names it with the figure', () => {
    const v = velocityOf(good().options[0]!.parts, recordedTrend, 50);
    expect(v.status).toBe('pass');
    expect(v.slowest).toEqual({ model: 'DCF921B', monthlySold: 600 });
    expect(v.reason).toBe('The slowest part, DCF921B, sold 600 last month on Amazon (Keepa); your minimum is 50.');
  });

  it('is slow under the minimum', () => {
    const v = velocityOf(good().options[0]!.parts, recordedTrend, 700);
    expect(v.status).toBe('slow');
    expect(v.reason).toBe('DCF921B sold 600 last month on Amazon (Keepa), under your minimum of 700.');
  });

  it('says "no sales data" when a part has no stored figure, and never passes', () => {
    const parts = [part('DCF921B', ASIN.DCF921B, 249), part('DCB205', 'B0NOTPULLED', 99), part('DCB115', null, null)];
    const v = velocityOf(parts, recordedTrend, 0);
    expect(v.status).toBe('no_data');
    expect(v.reason).toBe('No sales data for DCB205 and DCB115: Keepa has no monthly-sold figure stored for them.');
  });
});

describe('history and baselines', () => {
  it('a point holds the bundle price, the counted Amazon New total and the slowest part', () => {
    const p = historyPoint(good(), false, recordedTrend, NOW);
    expect(p).toEqual({
      at: NOW, section: 'confirmed', price: 299, amazonNew: 448, options: [{ id: 'whole', profit: 81.8, roiPercent: 27.36 }],
      reviewOpen: false, monthlySold: 600, salesRank: null, offers: 61,
    });
  });

  it('drops points older than 30 days and keeps the 7-day average of the rest', () => {
    const old = point(NOW - 40 * DAY, 10, 5);
    const h = appendHistory([old, point(NOW - 8 * DAY, 30, 10), point(NOW - 2 * DAY, 60, 20)], point(NOW - DAY, 70, 24), NOW);
    expect(h.map((p) => p.options[0]!.profit)).toEqual([30, 60, 70]);
    expect(baselineOf(h, 'whole', NOW)).toEqual({
      last: { at: NOW - DAY, profit: 70, roiPercent: 24 },
      rolling7d: { profit: 65, roiPercent: 22, points: 2, since: NOW - 2 * DAY },
    });
  });
});

describe('signals: today against the stored baseline', () => {
  it('first seen confirmed, above both numbers, selling: worth buying now, with the reason and the numbers', () => {
    const s = bundleSignals({ row: good(), history: [], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.buyNow?.reason).toBe(
      'First seen with an estimate: est. profit $81.80 (27% ROI). The slowest part, DCF921B, sold 600 last month on Amazon (Keepa); your minimum is 50.',
    );
    expect(s.buyNow?.numbers).toMatchObject({ profit: 81.8, roiPercent: 27.36, minProfit: 20, minRoiPercent: 20, monthlySold: 600, minMonthlySold: 50 });
    expect(s.signals.map((x) => x.kind)).toEqual(['buyNow']);
  });

  it('margin crossed up through the thresholds since the last scan: marginUp and buyNow', () => {
    const s = bundleSignals({ row: good(), history: [point(NOW - DAY, 15, 5)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.signals.map((x) => x.kind)).toEqual(['marginUp', 'buyNow']);
    expect(s.signals[0]!.reason).toBe('Estimated profit rose from $15.00 (5% ROI) to $81.80 (27% ROI), through your $20.00 and 20% thresholds.');
  });

  it('still good but no better: not worth buying now, and says why', () => {
    const s = bundleSignals({ row: good(), history: [point(NOW - DAY, 81.8, 27.36)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.buyNow).toBeNull();
    expect(s.options[0]).toMatchObject({ meetsThresholds: true, buyNow: false });
    expect(s.options[0]!.notBuyNow).toBe('Still above your $20.00 and 20% thresholds, but no better than the last scan ($81.80) or the 7-day average ($81.80).');
  });

  it('a dollar above its 7-day average counts as improved even when the last scan was close', () => {
    const s = bundleSignals({ row: good(), history: [point(NOW - 3 * DAY, 70, 23), point(NOW - DAY, 81.3, 27.2)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.buyNow?.reason).toMatch(/^Estimated profit of \$81\.80 \(27% ROI\) is \$6\.15 above its 7-day average of \$75\.65\./);
  });

  it('no sales data: never worth buying now, whatever the margin', () => {
    const row = bundle([option('whole', 299, [part('DCF921B', ASIN.DCF921B, 249), part('DCB205', 'B0NOTPULLED', 199)])]);
    const s = bundleSignals({ row, history: [point(NOW - DAY, 15, 5)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.buyNow).toBeNull();
    expect(s.signals.map((x) => x.kind)).toEqual(['marginUp']);
    expect(s.options[0]!.notBuyNow).toBe('No sales data for DCB205: Keepa has no monthly-sold figure stored for it.');
  });

  it('margin fell through the floor: marginDown; a lower floor stays quiet', () => {
    const row = bundle([option('whole', 299, [part('DCF921B', ASIN.DCF921B, 189), part('DCB606', ASIN.DCB606, 159)])]);
    const s = bundleSignals({ row, history: [point(NOW - DAY, 81.8, 27.36)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.signals.map((x) => x.kind)).toEqual(['marginDown']);
    expect(s.signals[0]!.reason).toBe('Estimated profit fell from $81.80 to -$3.20, below your $20.00 floor.');
    const quiet = bundleSignals({ row, history: [point(NOW - DAY, 81.8, 27.36)], reviewOpen: false, trend: recordedTrend, alerts: { ...alerts, floorProfit: -10 }, now: NOW });
    expect(quiet.signals).toEqual([]);
  });

  it('Review cleared and discovery finished: both said, and the deal is worth buying now', () => {
    const s = bundleSignals({
      row: good(), history: [point(NOW - DAY, null, null, { section: 'split', reviewOpen: true })], reviewOpen: false, trend: recordedTrend, alerts, now: NOW,
    });
    expect(s.signals.map((x) => x.kind)).toEqual(['reviewCleared', 'discoveryDone', 'buyNow']);
    expect(s.signals[0]!.reason).toBe('Your Review answers cleared it: it now has an estimated profit of $81.80 (27% ROI).');
    expect(s.buyNow?.reason).toMatch(/^Your Review answers cleared it/);
  });

  it('a bundle not confirmed, or a way to sell that leaves parts, is never worth buying now', () => {
    const waiting = bundleSignals({ row: { ...good(), section: 'waiting' }, history: [], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(waiting.options[0]!.notBuyNow).toBe('Not confirmed yet: waiting for a part to be looked up.');
    const left = bundle([good().options[0]!, option('split:DCK200', 299, [part('DCF921B', ASIN.DCF921B, 249), part('DCB606', ASIN.DCB606, 199)], ['DCB115'])]);
    const s = bundleSignals({ row: left, history: [point(NOW - DAY, 15, 5)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.options[1]!.notBuyNow).toBe('It leaves DCB115 unsold.');
    expect(s.buyNow?.optionId).toBe('whole');
  });
});
