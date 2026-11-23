// Prototype trend baselines in the cache pattern (plan §6).

import type { Cache, SearchResult } from '../serpapi/client';
import { centsToDollars } from './parse';
import type { KeepaProduct } from './types';

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