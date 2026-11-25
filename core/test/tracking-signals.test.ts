import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type AlertSettings } from '../src/settings';
import { appendHistory, baselineOf, bundleSignals, historyPoint, isConfirmedListing, velocityOf, type HistoryPoint } from '../src/tracking/signals';
import { ASIN, bundle, option, part, recordedTrend, titleMatch } from './tracking-world';

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
    // Signals round 2: why each has none. DCB205's listing was never pulled; DCB115 has no listing of its own.
    expect(v.reason).toBe('No sales data for DCB205 yet — Keepa has not been asked about its listing; no sales data for DCB115 — no Amazon listing of its own to read.');
  });

  it('a part Keepa was pulled for but gave no monthlySold: Keepa leaves it out for slow sellers', () => {
    // fixtures/keepa/search-RYOBI-PCL235B.json: B08L32HTBC has fees and offer counts but no monthlySold.
    const quiet = (asin: string) => (asin === 'B08L32HTBC' ? { asin, amazonPrice: 99, salesRank: null, offerCount: null, pulledAt: 1_000, monthlySold: null, fbaFee: 8.37 } : recordedTrend(asin));
    const v = velocityOf([part('DCF921B', ASIN.DCF921B, 249), part('PCL235B', 'B08L32HTBC', 99)], quiet, 50);
    expect(v.status).toBe('no_data');
    expect(v.reason).toBe('No sales data for PCL235B — Keepa leaves it out for slow sellers.');
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

  // Nov 25 (Buy now is a state): this test asserted the old conflation, "still good but no better: not worth buying now …
  // a buy needs a change". Now the deal stays worth buying; what needs a change is the announcement.
  it('still good but no better: still worth buying now (the state), and not news once announced (the event)', () => {
    const s = bundleSignals({ row: good(), history: [point(NOW - DAY, 81.8, 27.36)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.buyNow).toMatchObject({ kind: 'buyNow', optionId: 'whole' });
    expect(s.options[0]).toMatchObject({ meetsThresholds: true, buyNow: true, notBuyNow: null });
    expect(s.verdict).toBe('Worth buying now: +$81.80 (27.4% ROI), sells about 600 a month.');
    // Never announced in the state: news. Announced at this figure: not sent again.
    expect(s.announce).toBe(true);
    const told = bundleSignals({ row: good(), history: [point(NOW - DAY, 81.8, 27.36)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW, announced: { profit: 81.8, at: NOW - DAY } });
    expect(told.buyNow).not.toBeNull();
    expect(told.announce).toBe(false);
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
    expect(s.options[0]!.notBuyNow).toBe('No sales data for DCB205 yet — Keepa has not been asked about its listing.');
    // With a Keepa key the agent queues the pull, and the verdict says so.
    const keyed = bundleSignals({ row, history: [point(NOW - DAY, 15, 5)], reviewOpen: false, trend: recordedTrend, alerts, now: NOW, keepa: true });
    expect(keyed.verdict).toBe('Not worth buying now: no sales data for DCB205 yet — Keepa is asked on the next lookup.');
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

describe('the verdict: always which condition fails, the binding one first (signals round 2)', () => {
  const owner = { ...alerts, minProfit: 20, minRoiPercent: 20, minMonthlySold: 50 };

  it('worth buying now: the estimate, the sales and what changed', () => {
    const s = bundleSignals({ row: good(), history: [], reviewOpen: false, trend: recordedTrend, alerts: owner, now: NOW });
    expect(s.verdict).toBe('Worth buying now: +$81.80 (27.4% ROI), sells about 600 a month, first seen with an estimate.');
  });

  it('below the profit number: the profit first, in the owner\'s own figure', () => {
    // after-scan3's best before Keepa fees: PCL1201K2-PCL424B at $179, est. +$6.63 (4% ROI).
    const row = bundle([option('whole', 179, [part('DCF921B', ASIN.DCF921B, 120), part('DCB606', ASIN.DCB606, 92)])], { price: 179 });
    const s = bundleSignals({ row, history: [], reviewOpen: false, trend: recordedTrend, alerts: owner, now: NOW });
    expect(s.options[0]!.profit).toBe(1.2);
    expect(s.verdict).toBe('Not worth buying now: est. $1.20 is below your $20 and 1% ROI below your 20%.');
  });

  it('selling too slowly: the slowest part and its figure against the minimum', () => {
    const s = bundleSignals({ row: good(), history: [], reviewOpen: false, trend: recordedTrend, alerts: { ...owner, minMonthlySold: 700 }, now: NOW });
    expect(s.verdict).toBe('Not worth buying now: DCF921B sells about 600 a month, below your 700.');
  });

  it('an estimate before fulfillment for a part is never worth buying now, and says why first (signals round 3)', () => {
    const keepaFee = { fulfillment: 7.6, fulfillmentFrom: 'keepa' as const, referralRate: 0.15, referralFrom: 'flat' as const };
    const none = { fulfillment: 0, fulfillmentFrom: 'none' as const, fulfillmentWhy: 'not_pulled' as const, referralRate: 0.15, referralFrom: 'flat' as const };
    const row = good();
    row.options[0]!.parts = [{ ...row.options[0]!.parts[0]!, fees: keepaFee }, { ...row.options[0]!.parts[1]!, fees: none }];
    const s = bundleSignals({ row, history: [], reviewOpen: false, trend: recordedTrend, alerts: owner, now: NOW, keepa: true });
    expect(s.buyNow).toBeNull();
    expect(s.verdict).toBe('Not worth buying now: before fulfillment for 1 of 2 parts — Keepa is asked next.');
    // Asked, no FBA fee, flat fee $0: it stays before fulfillment, and says so.
    row.options[0]!.parts[1] = { ...row.options[0]!.parts[1]!, fees: { ...none, fulfillmentWhy: 'no_keepa_fee' } };
    const asked = bundleSignals({ row, history: [], reviewOpen: false, trend: recordedTrend, alerts: owner, now: NOW, keepa: true });
    expect(asked.verdict).toBe('Not worth buying now: before fulfillment for 1 of 2 parts — Keepa has no FBA fee for DCB606 and your flat fee is $0.00.');
  });

  it('an incomplete estimate never signals, and says it is not confirmed', () => {
    const row = bundle([option('whole', null, [part('DCF921B', ASIN.DCF921B, 249), part('DCB606', 'B0NOTPULLED', null)])], { section: 'waiting', estimate: null });
    const s = bundleSignals({ row, history: [point(NOW - DAY, 15, 5)], reviewOpen: false, trend: recordedTrend, alerts: owner, now: NOW });
    expect(s.signals).toEqual([]);
    expect(s.verdict).toBe('Not worth buying now: not confirmed yet: waiting for a part to be looked up.');
  });
});

describe('buy safety: a buy never rests on a listing nobody confirmed (Nov 23)', () => {
  // Shaped like PSK1212SB-PCL515B on Nov 23: above the numbers, selling well, but two of its listings are title matches.
  const titled = () => bundle([option('whole', 299, [titleMatch(part('DCF921B', ASIN.DCF921B, 249)), titleMatch(part('DCB606', ASIN.DCB606, 199))])]);

  it('title matches above the numbers: looks worth buying, held back, the listings named; not a buy', () => {
    const s = bundleSignals({ row: titled(), history: [], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(s.buyNow).toBeNull();
    expect(s.signals.some((x) => x.kind === 'buyNow')).toBe(false);
    expect(s.buyPending).toEqual({ optionId: 'whole', listings: 2, asins: [ASIN.DCF921B, ASIN.DCB606] });
    expect(s.verdict).toBe('Looks worth buying: +$81.80 (27.4% ROI), sells about 600 a month — 2 listings not confirmed yet.');
    expect(s.options[0]!.notBuyNow).toBe('2 listings not confirmed yet.');
  });

  it('an owner-chosen, catalog-verified or part-number listing counts as confirmed; a title match does not', () => {
    const p = part('DCF921B', ASIN.DCF921B, 249);
    expect(isConfirmedListing(p)).toBe(true);
    expect(isConfirmedListing(titleMatch(p))).toBe(false);
    expect(isConfirmedListing({ ...titleMatch(p), verifiedBy: 'owner' })).toBe(true);
    expect(isConfirmedListing({ grade: 'strong', verifiedBy: 'keepa_catalog' })).toBe(true);
    expect(isConfirmedListing({ grade: 'exact' })).toBe(true);
  });

  it('below the numbers the threshold binds first; the listings follow', () => {
    const s = bundleSignals({ row: titled(), history: [], reviewOpen: false, trend: recordedTrend, alerts: { ...alerts, minProfit: 100 }, now: NOW });
    expect(s.buyPending).toBeUndefined();
    expect(s.verdict).toBe('Not worth buying now: est. $81.80 is below your $100; 2 listings not confirmed yet.');
  });

  it('stays held back from scan to scan, and is a buy once the catalog confirms every listing', () => {
    const first = historyPoint(titled(), false, recordedTrend, NOW - DAY);
    expect(first.options[0]!.unconfirmed).toBe(2);
    const again = bundleSignals({ row: titled(), history: [first], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(again.buyPending?.listings).toBe(2);
    const confirmed = bundleSignals({ row: good(), history: [first], reviewOpen: false, trend: recordedTrend, alerts, now: NOW });
    expect(confirmed.buyNow).toMatchObject({ kind: 'buyNow', optionId: 'whole' });
    expect(confirmed.buyPending).toBeUndefined();
    expect(confirmed.verdict).toBe('Worth buying now: +$81.80 (27.4% ROI), sells about 600 a month, its listings confirmed now.');
  });
});
