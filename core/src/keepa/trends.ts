// Prototype trend baselines in the cache pattern (plan §6).

import type { Cache, SearchResult } from '../serpapi/client';
import { centsToDollars, parseProductResponse } from './parse';
import type { KeepaMarket, KeepaProduct } from './types';

export const partTrendCacheKey = (asin: string): string => `keepa:trend:${asin}`;

export interface PartTrend {
  asin: string;
  amazonPrice: number | null;
  salesRank: number | null;
  offerCount: number | null;
  pulledAt: number;
  /** Keepa's monthlySold for the listing (units bought in the past month); null or absent when Keepa gave none. */
  monthlySold?: number | null;
  /** Keepa's FBA pick-and-pack fee estimate, in dollars; null or absent when Keepa gave none. */
  fbaFee?: number | null;
  /** The sum of Keepa's buyBoxEligibleOfferCounts (every condition together); null or absent when Keepa gave none. */
  buyBoxEligibleOffers?: number | null;
  /** Keepa's referralFeePercentage for the listing (recorded: 12, 13.83); null or absent when Keepa gave none. */
  referralPercent?: number | null;
  /**
   * Suggested prices (Nov 23): Keepa's average New price over 90 and 30 days, in dollars (KeepaProduct.newAvg90/newAvg30).
   * Null when Keepa had none; absent on a trend stored before the field, or from a pull without stats: not asked yet.
   */
  newAvg90?: number | null;
  newAvg30?: number | null;
  /**
   * The market around the listing (Nov 25, core/src/tracking/market.ts), in dollars, from the same pull. Absent on a trend
   * stored before it or from a pull without stats: not read yet (the agent fills it once from its cached pulls at start).
   */
  market?: TrendMarket;
}

/** KeepaMarket in dollars, with the averages it is judged against and when the pull read them. */
export interface TrendMarket {
  /** When Keepa's figures were read: the pull's time (a cached answer's own time). */
  at: number;
  newAvg30: number | null;
  newAvg90: number | null;
  newAvg180: number | null;
  /** Amazon's own current offer; null when Amazon is not selling it now. */
  amazonPrice: number | null;
  /** True when Keepa says Amazon holds the Buy Box; null when it does not say (it never says false in the recordings). */
  buyBoxIsAmazon: boolean | null;
  newOffers: number | null;
  newOffersAvg90: number | null;
  outOfStock90: number | null;
  hazmat: KeepaMarket['hazmat'];
}

/** The trend's market from a parsed product, or undefined when the pull carried no stats. */
export function trendMarketOf(p: KeepaProduct, at: number): TrendMarket | undefined {
  const m = p.market;
  if (!m) return undefined;
  return {
    at,
    newAvg30: centsToDollars(p.newAvg30 ?? null),
    newAvg90: centsToDollars(p.newAvg90 ?? null),
    newAvg180: centsToDollars(m.newAvg180),
    amazonPrice: centsToDollars(m.amazonCurrent),
    buyBoxIsAmazon: m.buyBoxIsAmazon,
    newOffers: m.newOffers,
    newOffersAvg90: m.newOffersAvg90,
    outOfStock90: m.outOfStock90,
    hazmat: m.hazmat,
  };
}

/**
 * The market of every product in a cached Keepa answer (the raw body the client stores, read at `at`): how a trend stored
 * before the market figures gets them once from a pull already made, with no new call (agent/marketBackfill.ts).
 */
export function marketsOfBody(body: unknown, at: number): { asin: string; market: TrendMarket }[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { products?: unknown }).products)) return [];
  return parseProductResponse(body as Record<string, unknown>).products.flatMap((p) => {
    const market = trendMarketOf(p, at);
    return market ? [{ asin: p.asin, market }] : [];
  });
}

export function partTrendFromProduct(p: KeepaProduct, pulledAt: number): PartTrend {
  const raw = p as KeepaProduct & { offerCount?: number };
  // The current rank from stats (sent at every depth); else the last point of a salesRanks history when one came.
  let salesRank: number | null = p.statsSalesRank ?? null;
  const ranks = salesRank === null ? raw.salesRanks : undefined;
  if (ranks && typeof ranks === 'object') {
    const first = Object.values(ranks).find((arr) => Array.isArray(arr) && arr.length > 0);
    if (first && typeof first[first.length - 1] === 'number') salesRank = first[first.length - 1] as number;
  }
  return {
    asin: p.asin,
    amazonPrice: centsToDollars(p.amazonPrice ?? null),
    salesRank,
    offerCount: typeof raw.offerCount === 'number' ? raw.offerCount : null,
    pulledAt,
    monthlySold: p.monthlySold ?? null,
    fbaFee: p.fbaPickAndPackFee == null ? null : Math.round(p.fbaPickAndPackFee) / 100,
    buyBoxEligibleOffers: p.buyBoxEligibleOfferCounts ? p.buyBoxEligibleOfferCounts.reduce((a, b) => a + b, 0) : null,
    referralPercent: p.referralFeePercentage ?? null,
    ...(p.newAvg90 !== undefined ? { newAvg90: centsToDollars(p.newAvg90) } : {}),
    ...(p.newAvg30 !== undefined ? { newAvg30: centsToDollars(p.newAvg30) } : {}),
    ...(p.market ? { market: trendMarketOf(p, pulledAt)! } : {}),
  };
}

/**
 * Signals round 2: every Keepa product pull keeps its trend (monthlySold and when it was read, the FBA pick-and-pack fee,
 * the referral percentage, the sales rank, the offer counts), not only a scan's refresh and identify steps. Wraps a pull
 * (keepa/fetchStep.ts keepaProductSearchResult) so the lookup's price pull, the catalog check's pull and the sales pull
 * between scans write the same `keepa:trend:<asin>` the scan writes. A cached answer writes its own time. A failed write
 * never fails the pull.
 */
export function keepingTrends<A extends unknown[]>(
  pull: (...args: A) => Promise<SearchResult>,
  write: (trend: PartTrend) => void | Promise<void>,
): (...args: A) => Promise<SearchResult> {
  return async (...args: A) => {
    const r = await pull(...args);
    if (r.keepaProduct) {
      try {
        await write(partTrendFromProduct(r.keepaProduct, r.at));
      } catch {
        // The trend is a record; the pull's price is already in hand.
      }
    }
    return r;
  };
}

/** The stored trends of `asins`, read once, as a lookup (missing: undefined). Reads only. */
export async function readTrends(cache: Cache, asins: Iterable<string>): Promise<(asin: string) => PartTrend | undefined> {
  const found = new Map<string, PartTrend>();
  for (const asin of new Set(asins)) {
    const t = await readPartTrend(cache, asin).catch(() => undefined);
    if (t) found.set(asin, t);
  }
  return (asin) => found.get(asin);
}

export interface AlertBaseline {
  bundleKey: string;
  profit: number;
  roiPercent: number;
  notifiedAt: number;
}

export const alertBaselineKey = (bundleKey: string): string => `keepa:alert:${bundleKey}`;

export async function readPartTrend(cache: Cache, asin: string): Promise<PartTrend | undefined> {
  const hit = await cache.get(partTrendCacheKey(asin));
  if (!hit || typeof hit.data !== 'object' || hit.data === null) return undefined;
  return hit.data as PartTrend;
}

export async function writePartTrend(cache: Cache, trend: PartTrend): Promise<void> {
  await cache.set(partTrendCacheKey(trend.asin), { at: trend.pulledAt, data: trend });
}

/** Positive when Amazon price fell vs the last cached pull (plan §3b buy-side trend). */
export function amazonPriceDelta(previous: PartTrend | undefined, next: PartTrend): number | null {
  if (previous?.amazonPrice == null || next.amazonPrice == null) return null;
  return previous.amazonPrice - next.amazonPrice;
}

export async function readAlertBaseline(cache: Cache, bundleKey: string): Promise<AlertBaseline | undefined> {
  const hit = await cache.get(alertBaselineKey(bundleKey));
  if (!hit || typeof hit.data !== 'object' || hit.data === null) return undefined;
  return hit.data as AlertBaseline;
}

export async function writeAlertBaseline(cache: Cache, baseline: AlertBaseline): Promise<void> {
  await cache.set(alertBaselineKey(baseline.bundleKey), { at: baseline.notifiedAt, data: baseline });
}