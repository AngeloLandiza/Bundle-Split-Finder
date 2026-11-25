// "Recommend when to buy" (Keepa plan §3b): each scan compares a watched bundle's ways to sell with a stored baseline
// (the last scan's point and a 7-day rolling average of stored points) and says, in plain sentences with the numbers
// behind them, what changed. Pure: the caller passes the stored history and the stored Keepa part trends.
//
// Rule 4 (never guess): a way to sell is "worth buying now" only with an estimate at or above both of the owner's
// numbers, a velocity check that passed on stored Keepa data, every fee counted, nothing left unsold, every counted
// listing confirmed and nothing holding it. With no sales data for a part the check does not pass: it says "no sales
// data". Rule 5: every figure is an estimate from the fee settings.
//
// Buy now is a state; the announcement is an event (Nov 25, docs/decisions.md). The state needs no change: a deal stays
// worth buying for as long as every condition holds, and its movement against the last check is information. What is
// sent to the owner (`BundleSignals.announce`) is a deal entering the state, or one already in it rising by at least
// ANNOUNCE_MARGIN_DOLLARS over the figure he was last told, as the baseline (last check, 7-day average) sees it too.

import { sellerFails, type SellerLookup } from '../amazon/seller';
import type { PartTrend } from '../keepa/trends';
import { fulfillmentGap } from '../scan/report';
import { cannotBuyWords } from './buying';
import type { BundleRow, PartFees, PartRow, ReportSection, SaleOption, VerifiedBy } from '../scan/types';
import { DEFAULT_MIN_MONTHLY_SOLD, estimateRoiPercent, type AlertSettings } from '../settings';
import { optionMarket, todayOnlyVerdict, usualFailWords, usualHoldsWords, type OptionMarket } from './market';

/** A part's stored Keepa trend by ASIN (keepa:trend:<asin> in the cache). */
export type TrendLookup = (asin: string) => PartTrend | undefined;

// ---------------------------------------------------------------- history

export interface OptionPoint {
  id: string;
  profit: number | null;
  roiPercent: number | null;
  /** Buy safety (Nov 23): counted Amazon listings not confirmed yet (unconfirmedListings); absent when none. */
  unconfirmed?: number;
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
/**
 * A deal already worth buying is announced again only when its estimated profit is at least this much above the figure
 * the owner was last told. Measured on the first keep-current re-check (fixtures/e2e-2026-11-23/after-keepcurrent, Nov 25):
 * of the 22 watched estimates that moved, 16 moved by less than $5 (one listing's ordinary price move, as PBP004 from
 * $53.99 to $50.00: $3.12 on two deals; the largest of them $4.79); the 6 above it moved $5.88 to $38.26 (PCL515B from
 * $79.99 to $53.00: -$26.46). Below it, a re-check every 2 hours would announce ordinary price noise.
 */
export const ANNOUNCE_MARGIN_DOLLARS = 5;
const DAY_MS = 86_400_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const usd = (n: number): string => (n < 0 ? `-$${(-n).toFixed(2)}` : `$${n.toFixed(2)}`);
const pct = (n: number): string => `${Math.round(n)}%`;
/** "$20" for a whole number of dollars (the owner's own numbers), "$6.63" otherwise. */
const usdShort = (n: number): string => (Number.isInteger(n) ? (n < 0 ? `-$${-n}` : `$${n}`) : usd(n));
const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);
const names = (models: string[]): string => (models.length <= 2 ? models.join(' and ') : `${models.slice(0, -1).join(', ')} and ${models.at(-1)}`);

/** Amazon-sold parts of a way to sell: those with a listing chosen (the ones whose sales say anything). */
const sellingParts = (parts: PartRow[]): PartRow[] => parts.filter((p) => p.qty > 0);

/** What confirms a listing beside its grade: Amazon's catalog (Keepa), a SerpApi product page, or the owner's choice. */
// The listing ladder (Nov 23): rung 1's 'listing_fields' confirms (measured 0 wrong); rung 3's 'ai_checked' does not
// until its own measurement says so (docs/decisions.md): it shows as "confirmed by AI check" and a buy still waits.
export const CONFIRMING_SOURCES: readonly VerifiedBy[] = ['keepa_catalog', 'serpapi_product', 'listing_fields', 'owner'];

/**
 * Buy safety (Nov 23): a part's Amazon listing is confirmed when its grade is exact (barcode) or strong (manufacturer part
 * number, or Amazon's catalog confirmed it), or when Amazon's catalog, a product page or the owner verified it. A title
 * match (grade probable, verifiedBy 'title') is not.
 */
export function isConfirmedListing(p: Pick<PartRow, 'grade' | 'verifiedBy'>): boolean {
  return p.grade === 'exact' || p.grade === 'strong' || (p.verifiedBy !== undefined && CONFIRMING_SOURCES.includes(p.verifiedBy));
}

/**
 * The parts whose Amazon listing an estimate counts but nobody has confirmed: sold on Amazon (qty above 0), priced by the
 * listing's own New price (not a confirmed price), and not isConfirmedListing. A buy never rests on one of them.
 */
export function unconfirmedListings(parts: readonly PartRow[]): PartRow[] {
  return parts.filter(
    (p) => p.qty > 0 && p.asin !== null && p.availability === 'active' && p.prices.some((o) => o.kind === 'amazon_new' && !o.reference) && !isConfirmedListing(p),
  );
}

/** "1 listing not confirmed yet", "2 listings not confirmed yet". */
export const unconfirmedWords = (n: number): string => `${n} ${n === 1 ? 'listing' : 'listings'} not confirmed yet`;

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
    options: row.options.map((o) => {
      const unconfirmed = o.estimate ? unconfirmedListings(o.parts).length : 0;
      return { id: o.id, profit: o.estimate?.profit ?? null, roiPercent: o.estimate ? estimateRoiPercent(o.estimate.roi) : null, ...(unconfirmed > 0 ? { unconfirmed } : {}) };
    }),
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
  last: { at: number; profit: number | null; roiPercent: number | null; unconfirmed?: number } | null;
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
    last: lastPoint && lastOpt ? { at: lastPoint.at, profit: lastOpt.profit, roiPercent: lastOpt.roiPercent, ...(lastOpt.unconfirmed ? { unconfirmed: lastOpt.unconfirmed } : {}) } : null,
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
  const missing = rows.filter((r) => r.monthlySold === null);
  if (rows.length === 0 || missing.length > 0) {
    return {
      status: 'no_data',
      reason: rows.length === 0 ? 'No sales data: this way to sell has no parts yet.' : `${capital(noSalesWords(missing))}.`,
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

/**
 * Signals round 2: why a part has no sales figure, in words. A part Keepa was pulled for but gave no monthlySold: Keepa
 * leaves it out for slow sellers (the existing wording). A listing never pulled: not asked yet, and (`keepa`) asked on the
 * next lookup when the agent can pull it. A part with no listing of its own (priced by a confirmed price): none to read.
 */
export function noSalesWords(missing: Pick<PartVelocity, 'model' | 'asin' | 'pulledAt'>[], keepa?: boolean): string {
  const noListing = missing.filter((p) => p.asin === null).map((p) => p.model);
  const unpulled = missing.filter((p) => p.asin !== null && p.pulledAt === null).map((p) => p.model);
  const quiet = missing.filter((p) => p.asin !== null && p.pulledAt !== null).map((p) => p.model);
  const out: string[] = [];
  if (unpulled.length > 0) {
    const tail = keepa === true ? 'Keepa is asked on the next lookup' : keepa === false ? 'add a Keepa key to read it' : 'Keepa has not been asked about its listing';
    out.push(`no sales data for ${names(unpulled)} yet — ${tail}`);
  }
  if (quiet.length > 0) out.push(`no sales data for ${names(quiet)} — Keepa leaves it out for slow sellers`);
  if (noListing.length > 0) out.push(`no sales data for ${names(noListing)} — no Amazon listing of ${noListing.length === 1 ? 'its' : 'their'} own to read`);
  return out.join('; ');
}

/**
 * Signals round 3, no silent mixing: an estimate that counts no fulfillment fee for some part (PartFees 'none', with
 * fees.fulfillmentSource 'keepa') says so, with why: "before fulfillment for 1 of 2 parts — Keepa is asked next". Such an
 * estimate is never worth buying now.
 */
export function beforeFulfillmentWords(parts: Pick<PartRow, 'model' | 'fees'>[], flat: number, keepa?: boolean): string | null {
  const gap = fulfillmentGap(parts);
  if (gap.before.length === 0) return null;
  const why = (w: NonNullable<PartFees['fulfillmentWhy']>) => gap.before.filter((p) => p.fees!.fulfillmentWhy === w).map((p) => p.model);
  const out: string[] = [];
  if (why('not_pulled').length > 0) {
    const tail = keepa === true ? 'Keepa is asked next' : keepa === false ? "add a Keepa key to read Amazon's FBA fee" : 'Keepa has not been asked yet';
    out.push(gap.before.length === why('not_pulled').length ? tail : `${tail} for ${names(why('not_pulled'))}`);
  }
  if (why('no_keepa_fee').length > 0) out.push(`Keepa has no FBA fee for ${names(why('no_keepa_fee'))} and your flat fee is ${usd(flat)}`);
  if (why('no_listing').length > 0) out.push(`${names(why('no_listing'))} has a confirmed price, no listing, and your flat fee is ${usd(flat)}`);
  return `before fulfillment for ${gap.before.length} of ${gap.total} ${gap.total === 1 ? 'part' : 'parts'} — ${out.join('; ')}`;
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
  /**
   * Buy safety (Nov 23): everything else holds, but the estimate counts listings nobody confirmed yet (unconfirmedListings):
   * "looks worth buying", never announced, until the catalog check confirms them. Absent otherwise.
   */
  buyPending?: { listings: number; asins: string[] };
  /** Counted Amazon listings not confirmed yet, by ASIN, whatever else fails. Absent when none. */
  unconfirmed?: string[];
  /**
   * Why it is not worth buying now, in one sentence, the binding condition first ("Est. profit $6.63 is below your $20.",
   * "No sales data for DCS382B yet — Keepa is asked on the next lookup."); null when it is.
   */
  notBuyNow: string | null;
  /**
   * The market around each counted part's listing (core/src/tracking/market.ts), from the stored Keepa trends, and the
   * estimate at the usual prices when a part is unusually priced. Absent when no counted part has market figures stored.
   */
  market?: OptionMarket;
}

export interface BundleSignals {
  bundleKey: string;
  brand: string;
  model: string;
  at: number;
  options: OptionSignals[];
  /** Every signal that fired at this scan: bundle events first, then each way to sell's. */
  signals: Signal[];
  /** The best way to sell worth buying now (highest estimated profit), or null. The state: no change is needed for it. */
  buyNow: Signal | null;
  /**
   * The event: whether `buyNow` is news to send (it entered the state, or rose by ANNOUNCE_MARGIN_DOLLARS over the figure
   * last announced, SignalInput.announced). False for a deal that stays in the state without that change; absent on a stored
   * signal from before Nov 25, when every buy was news.
   */
  announce?: boolean;
  /**
   * Buy safety (Nov 23): when no way to sell is worth buying now, the best one that would be but for listings not confirmed
   * yet (OptionSignals.buyPending). Absent otherwise.
   */
  buyPending?: { optionId: string; listings: number; asins: string[] };
  /**
   * Signals round 2: the one-line verdict, always saying which condition fails ("Not worth buying now: sells about 12 a
   * month, below your 50") or why it is worth buying ("Worth buying now: est. profit $69.15 (26% ROI), sells about 120 a
   * month, confirmed for the first time"). About the way to sell worth buying, else the primary one. Absent on a stored
   * signal from before it.
   */
  verdict?: string;
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
  /** Whether the agent can pull a part's listing on Keepa (a key is set): the "no sales data" words say what happens next. */
  keepa?: boolean;
  /** The owner's flat fulfillment fee, for the words of an estimate before fulfillment (signals round 3). Default $0. */
  flatFee?: number;
  /**
   * Checking the app's own work (core/src/audit/sanity.ts): the sentence of a `hold` finding on this bundle. Such a
   * bundle is never worth buying now and never "looks worth buying" until the owner looks; nothing else changes.
   */
  held?: string;
  /**
   * The buy last announced for this deal while it has stayed in the state (TrackingState.announced); absent when it was
   * never announced or has left the state since. Without it a buy is news.
   */
  announced?: { profit: number; at: number };
  /**
   * Nov 25: the owner's Amazon seller account, when one is connected (core/src/amazon/seller.ts). Then every counted part
   * must be allowed to list and eligible for FBA (or shipped by him), and a part not checked yet keeps the deal from Buy
   * now. Absent (no account): nothing changes.
   */
  seller?: SellerLookup;
}

const SECTION_WORDS: Record<ReportSection, string> = {
  confirmed: 'confirmed',
  waiting: 'waiting for a part to be looked up',
  inactive_listing: 'a part listing is not for sale',
  missing_listing: 'a part has no Amazon listing',
  split: 'what it holds is not known yet',
  other_brands: "it holds other brands' items, so it is not estimated",
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

  const cannotBuy = cannotBuyWords(row.buying, now);
  const options: OptionSignals[] = [];
  const buys: Signal[] = [];
  const pendings: { optionId: string; listings: number; asins: string[]; profit: number }[] = [];
  const verdicts = new Map<string, string>();
  const newsOf = new Set<string>();
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
    // The market (Nov 25): a part counted at a price unusual for its listing is judged at its 90-day average too.
    const market = optionMarket(o, input.trend, alerts);
    const usual = market?.usual ?? null;
    const lastP = baseline.last?.profit ?? null;
    const lastR = baseline.last?.roiPercent ?? null;
    const thresholds = `your ${usd(alerts.minProfit)} and ${pct(alerts.minRoiPercent)} thresholds`;

    let why: string | null = null;
    let whyShort = '';
    if (meets && lastP !== null && lastR !== null && (lastP < alerts.minProfit || lastR < alerts.minRoiPercent)) {
      const reason = `Estimated profit rose from ${usd(lastP)} (${pct(lastR)} ROI) to ${usd(profit!)} (${pct(roi!)} ROI), through ${thresholds}.`;
      signals.push({ kind: 'marginUp', optionId: o.id, reason, numbers });
      why = reason;
      whyShort = `up from ${usd(lastP)} through your numbers`;
    }
    if (profit !== null && lastP !== null && lastP >= floorProfit && profit < floorProfit) {
      signals.push({ kind: 'marginDown', optionId: o.id, reason: `Estimated profit fell from ${usd(lastP)} to ${usd(profit)}, below your ${usd(floorProfit)} floor.`, numbers });
    }
    if (why === null && meets && lastP !== null && profit! - lastP >= IMPROVE_MIN_DOLLARS) {
      why = `Estimated profit is up ${usd(profit! - lastP)} since the last scan, to ${usd(profit!)} (${pct(roi!)} ROI).`;
      whyShort = `up ${usd(profit! - lastP)} since the last check`;
    }
    // Buy safety: the last check held it back for listings not confirmed yet; now every counted listing is confirmed.
    const pendingAsins = o.estimate ? unconfirmedListings(o.parts).map((p) => p.asin!) : [];
    if (why === null && meets && (baseline.last?.unconfirmed ?? 0) > 0 && pendingAsins.length === 0) {
      why = `Its Amazon listings are confirmed now: est. profit ${usd(profit!)} (${pct(roi!)} ROI).`;
      whyShort = 'its listings confirmed now';
    }
    const rolling = baseline.rolling7d;
    if (why === null && meets && rolling && profit! - rolling.profit >= IMPROVE_MIN_DOLLARS) {
      why = `Estimated profit of ${usd(profit!)} (${pct(roi!)} ROI) is ${usd(profit! - rolling.profit)} above its 7-day average of ${usd(rolling.profit)}.`;
      whyShort = `${usd(profit! - rolling.profit)} above its 7-day average`;
    }
    if (why === null && meets && o === row.options[0]) {
      if (reviewCleared || discoveryDone) {
        why = signals.find((s) => s.kind === 'reviewCleared' || s.kind === 'discoveryDone')!.reason;
        whyShort = reviewCleared ? 'your Review answers cleared it' : 'confirmed for the first time';
      } else if (firstSeen) {
        why = `First seen with an estimate: est. profit ${usd(profit!)} (${pct(roi!)} ROI).`;
        whyShort = 'first seen with an estimate';
      }
    }

    // Signals round 2: every condition that fails, the binding one first, in one sentence (rule 5: estimates). Nov 25: no
    // "needs a change" among them: a deal that stays good stays worth buying (the announcement is what needs a change).
    const fails: string[] = [];
    const account: string[] = [];
    if (row.section !== 'confirmed') fails.push(`not confirmed yet: ${SECTION_WORDS[row.section]}`);
    else if (profit === null || roi === null) fails.push('no estimate for this way to sell yet');
    else {
      if (profit < alerts.minProfit) {
        fails.push(`est. ${usd(profit)} is below your ${usdShort(alerts.minProfit)}${roi < alerts.minRoiPercent ? ` and ${pct(roi)} ROI below your ${pct(alerts.minRoiPercent)}` : ''}`);
      } else if (roi < alerts.minRoiPercent) {
        fails.push(`est. ROI ${pct(roi)} is below your ${pct(alerts.minRoiPercent)} (profit ${usd(profit)})`);
      }
      // Rule 1 of the market: a buy clears the owner's numbers at today's prices and at the usual ones.
      if (meets && usual !== null && !usual.meets) fails.push(usualFailWords(usual, alerts));
      // Signals round 3: an estimate missing a fulfillment fee is never a buy (a profit already below the number binds first).
      const before = beforeFulfillmentWords(o.parts, input.flatFee ?? 0, input.keepa);
      if (before !== null) fails.push(before);
      if (o.leftovers.length > 0) fails.push(`it leaves ${names(o.leftovers)} unsold`);
      if (velocity.status === 'slow') {
        const sl = velocity.slowest!;
        fails.push(`${velocity.parts.length > 1 ? `${sl.model} ` : ''}sells about ${sl.monthlySold} a month, below your ${minMonthlySold}`);
      } else if (velocity.status === 'no_data') {
        // One Keepa pull answers both: a part before fulfillment because Keepa was not asked has no sales figure for the same
        // reason, and the fee words already say it is asked next.
        const askedNext = new Set(o.parts.filter((p) => p.fees?.fulfillmentWhy === 'not_pulled' && p.fees.fulfillmentFrom === 'none').map((p) => p.model));
        const missing = velocity.parts.filter((p) => p.monthlySold === null && !(p.pulledAt === null && askedNext.has(p.model)));
        if (velocity.parts.length === 0) fails.push('no sales data: this way to sell has no parts yet');
        else if (missing.length > 0) fails.push(noSalesWords(missing, input.keepa));
      }
      // Nov 25: what his own Amazon account says about each part (may he list it, will FBA take it). Said after his
      // numbers, the usual-price rule, the listings' confirmation and the holds (below).
      if (input.seller) account.push(...sellerFails(o.parts, input.seller, now));
    }
    // Buy safety (Nov 23): a buy never rests on a listing nobody confirmed. When the estimate meets the owner's numbers, that
    // is the binding condition and is said first; otherwise after what fails. A buy held back only for its listings stays
    // pending from scan to scan.
    const pending = pendingAsins.length > 0 && fails.length === 0 && account.length === 0;
    if (pendingAsins.length > 0) {
      if (meets) fails.unshift(unconfirmedWords(pendingAsins.length));
      else fails.push(unconfirmedWords(pendingAsins.length));
    }
    fails.push(...account);
    // A sanity hold binds first: the deal waits for the owner's look, whatever else holds or fails. A buy held back for its
    // listings keeps its buyPending (the catalog check still reads those listings first), but is never "looks worth buying".
    if (input.held) fails.unshift(`needs a look: ${input.held.replace(/\.$/, '')}`);
    // Nov 25: Home Depot's own page, as last read, says it cannot be bought (not buyable, or discontinued). It comes back by
    // itself when a later read says it can. A bundle whose page was not read since this was kept is not here: not checked yet.
    if (cannotBuy !== null) fails.unshift(cannotBuy);
    const notBuyNow = fails.length > 0 ? `${capital(fails.join('; '))}.` : null;
    const buyNow = notBuyNow === null;
    if (buyNow) {
      // The event (Nov 25): news when it was not announced in the state yet, or when it rose by the margin over the figure
      // last announced and the baseline sees a rise too (`why`: through the numbers, since the last check, its 7-day average).
      const told = input.announced;
      const rise = told ? profit! - told.profit : null;
      const news = rise === null || (rise >= ANNOUNCE_MARGIN_DOLLARS && why !== null);
      const reason = rise !== null && news
        ? `Estimated profit is up ${usd(rise)} since you were last told (${usd(told!.profit)}), to ${usd(profit!)} (${pct(roi!)} ROI).`
        : (why ?? `Est. profit ${usd(profit!)} (${pct(roi!)} ROI) clears ${thresholds}.`);
      buys.push({ kind: 'buyNow', optionId: o.id, reason: `${reason} ${velocity.reason}`, numbers });
      if (news) newsOf.add(o.id);
    }
    if (pending) pendings.push({ optionId: o.id, listings: pendingAsins.length, asins: pendingAsins, profit: profit! });
    options.push({
      optionId: o.id, label: o.label, profit, roiPercent: roi, meetsThresholds: meets, velocity, baseline, buyNow,
      ...(pending ? { buyPending: { listings: pendingAsins.length, asins: pendingAsins } } : {}),
      ...(pendingAsins.length > 0 ? { unconfirmed: pendingAsins } : {}),
      notBuyNow,
      ...(market ? { market } : {}),
    });
    const figures = () => `+${usd(profit!)} (${Math.round(roi! * 10) / 10}% ROI), sells about ${velocity.slowest!.monthlySold} a month`;
    // The state in the present tense; how it moved since the last check is information, never the reason.
    const moved = buyNow && lastP !== null && Math.abs(profit! - lastP) >= 0.005 && (profit! < lastP || whyShort === '')
      ? `. ${profit! < lastP ? 'Down' : 'Up'} from ${usd(lastP)} at the last check`
      : '';
    // Held back by its usual prices alone: it says so in those words, not as "not worth buying".
    const todayOnly = !buyNow && usual !== null && !usual.meets && fails.length === 1 && fails[0] === usualFailWords(usual, alerts);
    verdicts.set(o.id, buyNow
      ? `Worth buying now: ${figures()}${whyShort ? `, ${whyShort}` : ''}${moved}${usual ? `. ${usualHoldsWords(usual)}` : ''}`
      : todayOnly
        ? todayOnlyVerdict(usual, alerts)
        : pending && !input.held && cannotBuy === null
          ? `Looks worth buying: ${figures()} — ${unconfirmedWords(pendingAsins.length)}`
          : `Not worth buying now: ${fails.join('; ')}`);
  }
  const best = buys.reduce<Signal | null>((a, b) => (a === null || (b.numbers.profit ?? 0) > (a.numbers.profit ?? 0) ? b : a), null);
  const held = best === null ? pendings.reduce<(typeof pendings)[number] | null>((a, b) => (a === null || b.profit > a.profit ? b : a), null) : null;
  const focus = best?.optionId ?? held?.optionId ?? row.options[0]?.id ?? null;
  const verdict = focus !== null ? `${verdicts.get(focus)!}.` : 'Not worth buying now: no way to sell has an estimate yet.';
  return {
    bundleKey: row.key, brand: row.brand, model: row.model === '' && row.setItems !== undefined ? `Set ${row.itemId}` : row.model, at: now, options, signals: [...signals, ...buys], buyNow: best,
    announce: best !== null && newsOf.has(best.optionId!),
    ...(held ? { buyPending: { optionId: held.optionId, listings: held.listings, asins: held.asins } } : {}),
    verdict,
  };
}
