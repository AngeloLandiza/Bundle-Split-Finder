// Mock tracking data for `VITE_MOCK=1`: the watchlist, the buy-now signals, the stored scan history, Amazon's FBA fee estimate
// and the BOGO promotion. Bundle titles, models, item ids and prices are the recorded ones (mockData.ts). EVERYTHING in this
// file is INVENTED for the look of the screens: no recording holds a Keepa monthlySold, a sales rank, a history point, an FBA fee
// or a BOGO eligible list. The sentences are written the way core/src/tracking/signals.ts words them, from the invented numbers.

import { bogoGroups, bogoTagOf, type BogoPair } from '@core/tracking/bogoPairs';
import type { BogoView, DealDetail, DealRow, DealHistoryPoint, DealSignals, FbaEstimate, FreeItem, OptionSignals, Signal, Velocity, WatchState } from './types';

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number): string => (n < 0 ? `-$${(-n).toFixed(2)}` : `$${n.toFixed(2)}`);
const pct = (n: number): string => `${Math.round(n)}%`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The owner's numbers in the mock settings (mockData.ts SETTINGS.alerts) and the flat fulfillment fee. */
export const MOCK_ALERTS = { minProfit: 30, minRoiPercent: 25, minMonthlySold: 50, floorProfit: 30 };
const FLAT_FULFILLMENT = 5.5;

export interface TrackSeed {
  /** Who put it on the watchlist. */
  by: 'auto' | 'owner';
  /** Keepa's monthlySold by part model; a model left out (or null) has no figure, as Keepa leaves slow sellers out. */
  sold: Record<string, number | null>;
  /** How many stored scans: 1 is the empty chart, 2 the least that draws. */
  scans: number;
  /** Home Depot's regular price, so the history shows the price falling to the sale price. */
  regular?: number | null;
  /** The previous scan's estimated profit, to make the signal say what changed. */
  lastProfit?: number;
  /** Sales ranks to chart (invented; no recording has one). */
  rank?: number;
  /** Keepa's pick-and-pack fee by part model (invented); the FBA estimate is built from these. */
  fba?: Record<string, number>;
}

export interface Tracked {
  watch: WatchState;
  signals: DealSignals | null;
  history: DealHistoryPoint[];
  fbaEstimate: FbaEstimate | null;
  buyNow: boolean;
}

/** One way to sell, with the stored points behind its baseline. */
export function trackingFor(d: DealDetail, seed: TrackSeed, now: number, was: number | null): Tracked {
  const e = d.estimate;
  const watch: WatchState = { watched: true, by: seed.by, since: new Date(now - 6 * DAY).toISOString() };
  if (!e || d.price === null) return { watch, signals: null, history: [], fbaEstimate: null, buyNow: false };

  const n = Math.max(1, seed.scans);
  const last = now - 47 * 60_000;
  const wig = (i: number) => 0.04 * Math.sin(i * 1.3) + 0.02 * Math.cos(i * 0.7);
  const regular = seed.regular ?? was ?? d.price;
  const parts = d.parts.filter((p) => !p.unnamed);
  const soldList = parts.map((p) => seed.sold[p.model] ?? null);
  const slowest = soldList.length > 0 && soldList.every((s) => s !== null) ? Math.min(...(soldList as number[])) : null;

  const history: DealHistoryPoint[] = [];
  for (let i = 0; i < n; i++) {
    const at = last - (n - 1 - i) * 11 * HOUR;
    const price = n === 1 || i >= n - 5 ? d.price : i < Math.floor(n / 4) ? regular : r2((regular + d.price) / 2);
    let amazonNew = r2(e.partsSellFor * (1 + wig(i) - wig(n - 1)));
    if (i === n - 2 && seed.lastProfit !== undefined) amazonNew = r2(e.partsSellFor - (e.profit - seed.lastProfit) / 0.84);
    const profit = r2(e.profit + 0.84 * (amazonNew - e.partsSellFor) - (price - d.price));
    const drift = 1 + 0.05 * Math.sin(i * 0.9 + 1) - 0.05 * Math.sin((n - 1) * 0.9 + 1);
    history.push({
      at: new Date(at).toISOString(),
      section: d.section,
      price,
      amazonNew,
      profit,
      roiPercent: r2((profit / price) * 100),
      monthlySold: slowest === null ? null : Math.round(slowest * drift),
      salesRank: seed.rank ? Math.round(seed.rank * (1 + 0.08 * Math.sin(i * 1.1) - 0.08 * Math.sin((n - 1) * 1.1))) : null,
      offers: slowest === null ? null : 6 + (i % 3 === 0 ? 1 : 0),
    });
  }

  const way = d.ways[0];
  const profit = e.profit;
  const roiPercent = Math.round(e.roi * 1000) / 10;
  const before = history.slice(0, -1);
  const lastPoint = before.at(-1) ?? null;
  const rolling = before.filter((p) => now - Date.parse(p.at) <= 7 * DAY && p.profit !== null && p.roiPercent !== null);
  const rollingProfit = rolling.length ? r2(rolling.reduce((a, p) => a + (p.profit ?? 0), 0) / rolling.length) : null;
  const rollingRoi = rolling.length ? r2(rolling.reduce((a, p) => a + (p.roiPercent ?? 0), 0) / rolling.length) : null;
  const lastP = lastPoint?.profit ?? null;
  const lastR = lastPoint?.roiPercent ?? null;

  const velocity: Velocity = {
    status: slowest === null ? 'no_data' : slowest >= MOCK_ALERTS.minMonthlySold ? 'pass' : 'slow',
    minMonthlySold: MOCK_ALERTS.minMonthlySold,
    slowest: slowest === null ? null : { model: parts.find((p) => seed.sold[p.model] === slowest)!.model, monthlySold: slowest },
    reason: '',
    parts: parts.map((p) => ({ model: p.model, asin: p.asin, monthlySold: seed.sold[p.model] ?? null, salesRank: null, offers: seed.sold[p.model] != null ? 6 : null, pulledAt: now - 47 * 60_000 })),
  };
  const missing = velocity.parts.filter((p) => p.monthlySold === null).map((p) => p.model);
  velocity.reason =
    velocity.status === 'no_data'
      ? `No sales data for ${missing.join(' and ')}: Keepa has no monthly-sold figure stored for ${missing.length === 1 ? 'it' : 'them'}.`
      : velocity.status === 'pass'
        ? `The slowest part, ${velocity.slowest!.model}, sold ${slowest} last month on Amazon (Keepa); your minimum is ${MOCK_ALERTS.minMonthlySold}.`
        : `${velocity.slowest!.model} sold ${slowest} last month on Amazon (Keepa), under your minimum of ${MOCK_ALERTS.minMonthlySold}.`;

  const meets = profit >= MOCK_ALERTS.minProfit && roiPercent >= MOCK_ALERTS.minRoiPercent;
  const thresholds = `your ${usd(MOCK_ALERTS.minProfit)} and ${pct(MOCK_ALERTS.minRoiPercent)} thresholds`;
  const numbers = {
    profit, roiPercent, minProfit: MOCK_ALERTS.minProfit, minRoiPercent: MOCK_ALERTS.minRoiPercent, floorProfit: MOCK_ALERTS.floorProfit,
    lastProfit: lastP, lastRoiPercent: lastR, rollingProfit, rollingPoints: rolling.length, monthlySold: slowest, minMonthlySold: MOCK_ALERTS.minMonthlySold,
  };
  const signals: Signal[] = [];
  let why: string | null = null;
  if (meets && lastP !== null && lastR !== null && (lastP < MOCK_ALERTS.minProfit || lastR < MOCK_ALERTS.minRoiPercent)) {
    why = `Estimated profit rose from ${usd(lastP)} (${pct(lastR)} ROI) to ${usd(profit)} (${pct(roiPercent)} ROI), through ${thresholds}.`;
    signals.push({ kind: 'marginUp', optionId: 'w1', reason: why, numbers });
  }
  if (lastP !== null && lastP >= MOCK_ALERTS.floorProfit && profit < MOCK_ALERTS.floorProfit) {
    signals.push({ kind: 'marginDown', optionId: 'w1', reason: `Estimated profit fell from ${usd(lastP)} to ${usd(profit)}, below your ${usd(MOCK_ALERTS.floorProfit)} floor.`, numbers });
  }
  if (why === null && meets && lastP !== null && profit - lastP >= 1) why = `Estimated profit is up ${usd(profit - lastP)} since the last scan, to ${usd(profit)} (${pct(roiPercent)} ROI).`;
  if (why === null && meets && rollingProfit !== null && profit - rollingProfit >= 1) why = `Estimated profit of ${usd(profit)} (${pct(roiPercent)} ROI) is ${usd(profit - rollingProfit)} above its 7-day average of ${usd(rollingProfit)}.`;

  let notBuyNow: string | null = null;
  if (d.section !== 'confirmed') notBuyNow = 'Not confirmed yet.';
  else if (way && way.leaves.length > 0) notBuyNow = `It leaves ${way.leaves.join(' and ')} unsold.`;
  else if (!meets) notBuyNow = `Below ${thresholds}: est. profit ${usd(profit)} (${pct(roiPercent)} ROI).`;
  else if (velocity.status !== 'pass') notBuyNow = velocity.reason;
  else if (why === null) notBuyNow = `Still above ${thresholds}, but no better than the last scan (${usd(lastP ?? 0)}).`;
  const buyNow = notBuyNow === null;
  if (buyNow) signals.push({ kind: 'buyNow', optionId: 'w1', reason: `${why} ${velocity.reason}`, numbers });

  const option: OptionSignals = {
    optionId: 'w1',
    label: way?.label ?? 'Sell every part on Amazon',
    profit,
    roiPercent,
    meetsThresholds: meets,
    velocity,
    baseline: {
      last: lastPoint && lastP !== null && lastR !== null ? { at: Date.parse(lastPoint.at), profit: lastP, roiPercent: lastR } : null,
      rolling7d: rollingProfit !== null && rollingRoi !== null ? { profit: rollingProfit, roiPercent: rollingRoi, points: rolling.length, since: Date.parse(rolling[0]!.at) } : null,
    },
    buyNow,
    notBuyNow,
  };

  // Amazon's FBA fee estimate (Keepa, pick and pack) in place of the flat fulfillment fee, part by part.
  let fbaEstimate: FbaEstimate | null = null;
  if (seed.fba) {
    const fp = parts.filter((p) => p.price !== null).map((p) => ({ model: p.model, qty: p.qty, fee: seed.fba![p.model] ?? FLAT_FULFILLMENT, source: seed.fba![p.model] !== undefined ? ('keepa' as const) : ('settings' as const) }));
    const delta = fp.reduce((a, p) => a + (FLAT_FULFILLMENT - p.fee) * p.qty, 0);
    const netRevenue = r2(e.afterFees + delta);
    const fbaProfit = r2(netRevenue - e.cost);
    fbaEstimate = { label: "Amazon's FBA fee estimate (Keepa)", estimate: { cost: e.cost, netRevenue, profit: fbaProfit, roi: Math.round((fbaProfit / e.cost) * 10_000) / 10_000 }, parts: fp };
  }

  return {
    watch,
    signals: { at: new Date(last).toISOString(), buyNow: signals.find((s) => s.kind === 'buyNow') ?? null, signals, options: [option] },
    history,
    fbaEstimate,
    buyNow,
  };
}

// ---------------------------------------------------------------- BOGO

/** Free items some DEWALT BOGO offers (invented list; no recording shows how Home Depot marks a BOGO). */
export const MOCK_ELIGIBLE: FreeItem[] = [
  { brand: 'DEWALT', model: 'DCF887B', title: '20V MAX XR Brushless Cordless 1/4 in. 3-Speed Impact Driver (Tool Only)', itemId: null, link: 'https://www.homedepot.com/s/DCF887B', parts: null },
  { brand: 'DEWALT', model: 'DCS391B', title: '20V MAX Cordless 6-1/2 in. Circular Saw (Tool Only)', itemId: null, link: 'https://www.homedepot.com/s/DCS391B', parts: null },
  { brand: 'DEWALT', model: 'DCG413B', title: '20V MAX Brushless Cordless 4-1/2 in. Angle Grinder (Tool Only)', itemId: null, link: 'https://www.homedepot.com/s/DCG413B', parts: null },
];

/** Amazon New prices the mock "has looked up" for free items (invented); a model not here is not looked up yet. */
const FREE_PRICES: Record<string, { asin: string; price: number }> = {
  DCF887B: { asin: 'B00DL7QDBW', price: 129 },
  DCG413B: { asin: 'B07GJV2L7B', price: 119 },
};

const fee = (p: number) => r2(p - Math.max(p * 0.15, 0.3) - FLAT_FULFILLMENT);

/** The promotion's view as the agent builds it (core/src/tracking/bogo.ts bogoView), with the mock's price list. */
export function mockBogoView(d: DealDetail, state: { eligible: FreeItem[] | null; chosen: FreeItem[]; freeCount: number; link: string | null }): BogoView {
  const e = d.estimate;
  const base = e ? { cost: e.cost, netRevenue: e.afterFees, profit: e.profit, roi: e.roi } : null;
  const chosen = state.chosen.length > 0;
  const counted: BogoView['counted'] = [];
  const notCounted: BogoView['notCounted'] = [];
  for (const item of state.chosen) {
    const known = FREE_PRICES[item.model];
    if (known) counted.push({ model: item.model, asin: known.asin, qty: 1, price: known.price, net: fee(known.price) });
    else notCounted.push({ model: item.model, why: 'not looked up on Amazon yet' });
  }
  let estimate = base;
  if (base && counted.length > 0) {
    const netRevenue = r2(base.netRevenue + counted.reduce((a, c) => a + c.net, 0));
    const profit = r2(netRevenue - base.cost);
    estimate = { cost: base.cost, netRevenue, profit, roi: Math.round((profit / base.cost) * 10_000) / 10_000 };
  }
  const free = state.freeCount === 1 ? 'free tool' : 'free tools';
  return {
    status: chosen ? 'chosen' : 'choose',
    label: chosen ? `BOGO: ${state.chosen.map((c) => c.model).join(' + ')} free` : `BOGO: choose your ${free}`,
    freeCount: state.freeCount,
    eligible: state.eligible,
    chosen: state.chosen,
    link: state.link,
    optionId: d.ways[0]?.id ?? null,
    base,
    estimate,
    counted,
    notCounted,
    note: !chosen ? `+ ${free} not counted yet` : notCounted.length > 0 ? `+ ${notCounted.map((n) => `${n.model} not counted yet (${n.why})`).join('; ')}` : null,
  };
}

// ---------------------------------------------------------------- BOGO found by the agent

/** A pair's starter and promotion (the recorded ones, mockData.ts). */
export interface PairSeed {
  starterItemId: string;
  starterModel: string;
  promotionId: string;
  endsAt: string;
  description: string;
}

/**
 * Tags the pair deals and groups them by starter with core's own bogoGroups, ranked by each pair's mock estimate (the
 * estimates are the mock's, built from invented Amazon prices; the models, item ids and Home Depot prices are recorded).
 */
export function withMockBogoGroups<T extends { row: DealRow; detail: DealDetail; pair?: PairSeed; was: number | null }>(built: T[]): T[] {
  const pairs: BogoPair[] = [];
  for (const b of built) {
    if (!b.pair || b.row.price === null || !b.row.itemId) continue;
    const joiner = b.row.brand === 'DEWALT' ? 'W' : '-';
    pairs.push({
      key: b.row.id, itemId: b.row.itemId, brand: b.row.brand, model: b.row.model, title: b.row.title, price: b.row.price,
      wasPrice: b.was, link: b.row.link ?? `https://www.homedepot.com/p/${b.row.itemId}`,
      promotionId: b.pair.promotionId, starterItemId: b.pair.starterItemId, starterModel: b.pair.starterModel,
      freeModel: b.row.model.slice(b.pair.starterModel.length + joiner.length), endsAt: b.pair.endsAt, description: b.pair.description,
    });
  }
  const rows = built.map((b) => ({
    key: b.row.id, section: b.row.section,
    estimate: b.row.profit !== null && b.row.roi !== null ? { profit: b.row.profit, roi: b.row.roi, cost: 0, netRevenue: 0 } : null,
  }));
  const groups = bogoGroups(pairs, rows);
  for (const b of built) {
    const pair = pairs.find((p) => p.key === b.row.id);
    const group = groups.find((g) => g.choices.some((c) => c.key === b.row.id));
    if (!pair || !group) continue;
    b.row.bogoPair = bogoTagOf(pair);
    b.row.bogoChoices = { label: group.label, count: group.choices.length, bestId: group.best?.key ?? null, best: group.best?.key === b.row.id };
    b.detail.bogoGroup = group;
  }
  return built;
}
