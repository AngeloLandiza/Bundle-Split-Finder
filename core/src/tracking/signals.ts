// "Recommend when to buy" (Keepa plan §3b): each scan compares a watched bundle's ways to sell with a stored baseline
// (the last scan's point and a 7-day rolling average of stored points) and says, in plain sentences with the numbers
// behind them, what changed. Pure: the caller passes the stored history and the stored Keepa part trends.
//
// Rule 4 (never guess): a way to sell is "worth buying now" only with an estimate at or above both of the owner's
// numbers, a velocity check that passed on stored Keepa data, and a change (better than the baseline, or newly
// confirmed). With no sales data for a part the check does not pass: it says "no sales data". Rule 5: every figure
// is an estimate from the fee settings.

import type { PartTrend } from '../keepa/trends';
import type { BundleRow, PartRow, ReportSection, SaleOption } from '../scan/types';
import { DEFAULT_MIN_MONTHLY_SOLD, estimateRoiPercent, type AlertSettings } from '../settings';

/** A part's stored Keepa trend by ASIN (keepa:trend:<asin> in the cache). */
export type TrendLookup = (asin: string) => PartTrend | undefined;

// ---------------------------------------------------------------- history

export interface OptionPoint {
  id: string;
  profit: number | null;
  roiPercent: number | null;
}

/** One scan's figures for a bundle, kept for its baseline and its small chart. Everything here was stored by a scan. */
export interface HistoryPoint {
  at: number;
  section: ReportSection;
  /** Home Depot's bundle price. */
  price: number | null;
  /** The primary way to sell's counted Amazon New prices times their quantities; null when none is counted. */
  amazonNew: number | null;
  options: OptionPoint[];
  /** A Review question held the bundle up at this scan. */
  reviewOpen: boolean;
  /** The primary way to sell's slowest part by Keepa monthlySold; null unless every part had a figure. */
  monthlySold: number | null;
  /** The primary way to sell's highest (slowest) Keepa sales rank among parts that have one; null when none has. */
  salesRank: number | null;
  /** The most buy-box-eligible offers (Keepa, every condition) on any primary part; null when none has a figure. */
  offers: number | null;
}

/** Points older than this are dropped; the 7-day baseline needs at most a week of them. */
export const HISTORY_DAYS = 30;
/** And at most this many per bundle (an hourly schedule fills 30 days with 720). */
export const HISTORY_MAX = 200;
/** A rise smaller than this (dollars of estimated profit) is noise, not an improvement. */
export const IMPROVE_MIN_DOLLARS = 1;
const DAY_MS = 86_400_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const usd = (n: number): string => (n < 0 ? `-$${(-n).toFixed(2)}` : `$${n.toFixed(2)}`);
const pct = (n: number): string => `${Math.round(n)}%`;
const names = (models: string[]): string => (models.length <= 2 ? models.join(' and ') : `${models.slice(0, -1).join(', ')} and ${models.at(-1)}`);

/** Amazon-sold parts of a way to sell: those with a listing chosen (the ones whose sales say anything). */
const sellingParts = (parts: PartRow[]): PartRow[] => parts.filter((p) => p.qty > 0);

export function historyPoint(row: BundleRow, reviewOpen: boolean, trend: TrendLookup, at: number): HistoryPoint {
  const primary: SaleOption | undefined = row.options[0];
  const parts = primary ? primary.parts : row.parts;
  const counted = parts.flatMap((p) => {
    const o = p.prices.find((x) => x.kind === 'amazon_new' && !x.reference);
    return o ? [o.price * p.qty] : [];
  });
  const trends = sellingParts(parts).map((p) => (p.asin ? trend(p.asin) : undefined));
  const sold = trends.map((t) => t?.monthlySold ?? null);
  const ranks = trends.flatMap((t) => (t?.salesRank != null ? [t.salesRank] : []));
  const offers = trends.flatMap((t) => (t?.buyBoxEligibleOffers != null ? [t.buyBoxEligibleOffers] : []));
  return {
    at,
    section: row.section,
    price: row.price,
    amazonNew: counted.length > 0 ? round2(counted.reduce((a, b) => a + b, 0)) : null,
    options: row.options.map((o) => ({
      id: o.id, profit: o.estimate?.profit ?? null, roiPercent: o.estimate ? estimateRoiPercent(o.estimate.roi) : null,
    })),
    reviewOpen,
    monthlySold: sold.length > 0 && sold.every((s) => s !== null) ? Math.min(...(sold as number[])) : null,
    salesRank: ranks.length > 0 ? Math.max(...ranks) : null,
    offers: offers.length > 0 ? Math.max(...offers) : null,
  };
}

/** The history with `point` added, oldest first, without points past HISTORY_DAYS or beyond HISTORY_MAX. */
export function appendHistory(points: readonly HistoryPoint[], point: HistoryPoint, now: number): HistoryPoint[] {
  const kept = points.filter((p) => p.at < point.at && now - p.at <= HISTORY_DAYS * DAY_MS);
  return [...kept, point].slice(-HISTORY_MAX);
}

export interface OptionBaseline {
  /** The way to sell's figures at the last stored scan, when that scan had the way to sell. */
  last: { at: number; profit: number | null; roiPercent: number | null } | null;
  /** The average of the last 7 days' stored estimates of the way to sell; null without one. */
  rolling7d: { profit: number; roiPercent: number; points: number; since: number } | null;
}

/** The baseline of one way to sell from the stored history (the current scan not in it). */
export function baselineOf(history: readonly HistoryPoint[], optionId: string, now: number): OptionBaseline {
  const of = (p: HistoryPoint) => p.options.find((o) => o.id === optionId);
  const lastPoint = [...history].reverse().find((p) => of(p) !== undefined);
  const lastOpt = lastPoint ? of(lastPoint)! : undefined;
  const week = history.flatMap((p) => {
    const o = of(p);
    return now - p.at <= 7 * DAY_MS && o && o.profit !== null && o.roiPercent !== null ? [{ at: p.at, profit: o.profit, roi: o.roiPercent }] : [];
  });
  return {
    last: lastPoint && lastOpt ? { at: lastPoint.at, profit: lastOpt.profit, roiPercent: lastOpt.roiPercent } : null,
    rolling7d:
      week.length === 0
        ? null
        : {
            profit: round2(week.reduce((a, w) => a + w.profit, 0) / week.length),
            roiPercent: round2(week.reduce((a, w) => a + w.roi, 0) / week.length),
            points: week.length,
            since: week[0]!.at,
          },
  };
}

// ---------------------------------------------------------------- velocity

export interface PartVelocity {
  model: string;
  asin: string | null;
  monthlySold: number | null;
  salesRank: number | null;
  offers: number | null;
  /** When Keepa's figures were pulled; null without a stored trend. */
  pulledAt: number | null;
}

/**
 * pass     every part has Keepa's monthlySold and the slowest reaches the owner's minimum
 * slow     every part has a figure and the slowest is under the minimum
 * no_data  at least one part has no stored figure (no listing, never pulled, or Keepa gave none): never a pass
 */
export interface Velocity {
  status: 'pass' | 'slow' | 'no_data';
  reason: string;
  minMonthlySold: number;
  slowest: { model: string; monthlySold: number } | null;
  parts: PartVelocity[];
}

export function velocityOf(parts: PartRow[], trend: TrendLookup, minMonthlySold: number): Velocity {
  const rows: PartVelocity[] = sellingParts(parts).map((p) => {
    const t = p.asin ? trend(p.asin) : undefined;
    return {
      model: p.model, asin: p.asin, monthlySold: t?.monthlySold ?? null, salesRank: t?.salesRank ?? null,
      offers: t?.buyBoxEligibleOffers ?? null, pulledAt: t?.pulledAt ?? null,
    };
  });
  const missing = rows.filter((r) => r.monthlySold === null).map((r) => r.model);
  if (rows.length === 0 || missing.length > 0) {
    return {
      status: 'no_data',
      reason: rows.length === 0 ? 'No sales data: this way to sell has no parts yet.' : `No sales data for ${names(missing)}: Keepa has no monthly-sold figure stored for ${missing.length === 1 ? 'it' : 'them'}.`,
      minMonthlySold, slowest: null, parts: rows,
    };
  }
  const slowest = rows.reduce((a, b) => (b.monthlySold! < a.monthlySold! ? b : a));
  const s = { model: slowest.model, monthlySold: slowest.monthlySold! };
  if (s.monthlySold >= minMonthlySold) {
    return { status: 'pass', reason: `The slowest part, ${s.model}, sold ${s.monthlySold} last month on Amazon (Keepa); your minimum is ${minMonthlySold}.`, minMonthlySold, slowest: s, parts: rows };
  }
  return { status: 'slow', reason: `${s.model} sold ${s.monthlySold} last month on Amazon (Keepa), under your minimum of ${minMonthlySold}.`, minMonthlySold, slowest: s, parts: rows };
}

// ---------------------------------------------------------------- signals

export type SignalKind = 'buyNow' | 'marginUp' | 'marginDown' | 'reviewCleared' | 'discoveryDone';

/** The figures a signal's sentence is built from. Dollars and percents are estimates from the fee settings. */
export interface SignalNumbers {
  profit: number | null;
  roiPercent: number | null;
  minProfit: number;
  minRoiPercent: number;
  floorProfit: number;
  lastProfit: number | null;
  lastRoiPercent: number | null;
  rollingProfit: number | null;
  rollingPoints: number;
  monthlySold: number | null;
  minMonthlySold: number;
}

export interface Signal {
  kind: SignalKind;
  /** The way to sell it is about; null for reviewCleared and discoveryDone, which are about the bundle. */
  optionId: string | null;
  reason: string;
  numbers: SignalNumbers;
}

export interface OptionSignals {
  optionId: string;
  label: string;
  profit: number | null;
  roiPercent: number | null;
  /** At or above both of the owner's numbers now, whatever changed. */
  meetsThresholds: boolean;
  velocity: Velocity;
  baseline: OptionBaseline;
  buyNow: boolean;
  /** Why it is not worth buying now, in one sentence; null when it is. */
  notBuyNow: string | null;
}

export interface BundleSignals {
  bundleKey: string;
  brand: string;
  model: string;
  at: number;
  options: OptionSignals[];
  /** Every signal that fired at this scan: bundle events first, then each way to sell's. */
  signals: Signal[];
  /** The best way to sell worth buying now (highest estimated profit), or null. */
  buyNow: Signal | null;
}

export interface SignalInput {
  row: BundleRow;
  /** The stored points before this scan, oldest first. */
  history: readonly HistoryPoint[];
  /** A Review question holds the bundle up now. */
  reviewOpen: boolean;
  trend: TrendLookup;
  alerts: AlertSettings;
  now: number;
}

const SECTION_WORDS: Record<ReportSection, string> = {
  confirmed: 'confirmed',
  waiting: 'waiting for a part to be looked up',
  inactive_listing: 'a part listing is not for sale',
  missing_listing: 'a part has no Amazon listing',
  split: 'what it holds is not known yet',
};

export function bundleSignals(input: SignalInput): BundleSignals {
  const { row, history, alerts, now } = input;
  const minMonthlySold = alerts.minMonthlySold ?? DEFAULT_MIN_MONTHLY_SOLD;
  const floorProfit = alerts.floorProfit ?? alerts.minProfit;
  const last = history.at(-1);
  const signals: Signal[] = [];
  const base = (profit: number | null, roi: number | null): SignalNumbers => ({
    profit, roiPercent: roi, minProfit: alerts.minProfit, minRoiPercent: alerts.minRoiPercent, floorProfit,
    lastProfit: null, lastRoiPercent: null, rollingProfit: null, rollingPoints: 0, monthlySold: null, minMonthlySold,
  });

  // Bundle events: the estimate became real since the last scan.
  const confirmed = row.section === 'confirmed' && row.estimate !== null;
  const profit0 = row.estimate?.profit ?? null;
  const roi0 = row.estimate ? estimateRoiPercent(row.estimate.roi) : null;
  const reviewCleared = !!last && last.reviewOpen && !input.reviewOpen && row.estimate !== null;
  if (reviewCleared) {
    signals.push({ kind: 'reviewCleared', optionId: null, reason: `Your Review answers cleared it: it now has an estimated profit of ${usd(profit0!)} (${pct(roi0!)} ROI).`, numbers: base(profit0, roi0) });
  }
  const discoveryDone = confirmed && history.length > 0 && !history.some((p) => p.section === 'confirmed');
  if (discoveryDone) {
    signals.push({ kind: 'discoveryDone', optionId: null, reason: `Confirmed for the first time: every part has an Amazon listing for sale, est. profit ${usd(profit0!)} (${pct(roi0!)} ROI).`, numbers: base(profit0, roi0) });
  }
  const firstSeen = confirmed && history.length === 0;

  const options: OptionSignals[] = [];
  const buys: Signal[] = [];
  for (const o of row.options) {
    const baseline = baselineOf(history, o.id, now);
    const velocity = velocityOf(o.parts, input.trend, minMonthlySold);
    const profit = o.estimate?.profit ?? null;
    const roi = o.estimate ? estimateRoiPercent(o.estimate.roi) : null;
    const numbers: SignalNumbers = {
      ...base(profit, roi),
      lastProfit: baseline.last?.profit ?? null, lastRoiPercent: baseline.last?.roiPercent ?? null,
      rollingProfit: baseline.rolling7d?.profit ?? null, rollingPoints: baseline.rolling7d?.points ?? 0,
      monthlySold: velocity.slowest?.monthlySold ?? null,
    };
    const meets = profit !== null && roi !== null && profit >= alerts.minProfit && roi >= alerts.minRoiPercent;
    const lastP = baseline.last?.profit ?? null;
    const lastR = baseline.last?.roiPercent ?? null;
    const thresholds = `your ${usd(alerts.minProfit)} and ${pct(alerts.minRoiPercent)} thresholds`;

    let why: string | null = null;
    if (meets && lastP !== null && lastR !== null && (lastP < alerts.minProfit || lastR < alerts.minRoiPercent)) {
      const reason = `Estimated profit rose from ${usd(lastP)} (${pct(lastR)} ROI) to ${usd(profit!)} (${pct(roi!)} ROI), through ${thresholds}.`;
      signals.push({ kind: 'marginUp', optionId: o.id, reason, numbers });
      why = reason;
    }
    if (profit !== null && lastP !== null && lastP >= floorProfit && profit < floorProfit) {
      signals.push({ kind: 'marginDown', optionId: o.id, reason: `Estimated profit fell from ${usd(lastP)} to ${usd(profit)}, below your ${usd(floorProfit)} floor.`, numbers });
    }
    if (why === null && meets && lastP !== null && profit! - lastP >= IMPROVE_MIN_DOLLARS) {
      why = `Estimated profit is up ${usd(profit! - lastP)} since the last scan, to ${usd(profit!)} (${pct(roi!)} ROI).`;
    }
    const rolling = baseline.rolling7d;
    if (why === null && meets && rolling && profit! - rolling.profit >= IMPROVE_MIN_DOLLARS) {
      why = `Estimated profit of ${usd(profit!)} (${pct(roi!)} ROI) is ${usd(profit! - rolling.profit)} above its 7-day average of ${usd(rolling.profit)}.`;
    }
    if (why === null && meets && o === row.options[0]) {
      if (reviewCleared || discoveryDone) why = signals.find((s) => s.kind === 'reviewCleared' || s.kind === 'discoveryDone')!.reason;
      else if (firstSeen) why = `First seen with an estimate: est. profit ${usd(profit!)} (${pct(roi!)} ROI).`;
    }

    let notBuyNow: string | null = null;
    if (row.section !== 'confirmed') notBuyNow = `Not confirmed yet: ${SECTION_WORDS[row.section]}.`;
    else if (profit === null || roi === null) notBuyNow = 'No estimate for this way to sell yet.';
    else if (o.leftovers.length > 0) notBuyNow = `It leaves ${names(o.leftovers)} unsold.`;
    else if (!meets) notBuyNow = `Below ${thresholds}: est. profit ${usd(profit)} (${pct(roi)} ROI).`;
    else if (velocity.status !== 'pass') notBuyNow = velocity.reason;
    else if (why === null) {
      notBuyNow = `Still above ${thresholds}, but no better than ${lastP !== null ? `the last scan (${usd(lastP)})` : 'before'}${rolling ? ` or the 7-day average (${usd(rolling.profit)})` : ''}.`;
    }
    const buyNow = notBuyNow === null;
    if (buyNow) buys.push({ kind: 'buyNow', optionId: o.id, reason: `${why} ${velocity.reason}`, numbers });
    options.push({ optionId: o.id, label: o.label, profit, roiPercent: roi, meetsThresholds: meets, velocity, baseline, buyNow, notBuyNow });
  }
  const best = buys.reduce<Signal | null>((a, b) => (a === null || (b.numbers.profit ?? 0) > (a.numbers.profit ?? 0) ? b : a), null);
  return { bundleKey: row.key, brand: row.brand, model: row.model, at: now, options, signals: [...signals, ...buys], buyNow: best };
}
