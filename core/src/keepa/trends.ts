// Prototype trend baselines in the cache pattern (plan §6).

import type { Cache } from '../serpapi/client';
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
}

export function partTrendFromProduct(p: KeepaProduct, pulledAt: number): PartTrend {
  const raw = p as KeepaProduct & { offerCount?: number };
  let salesRank: number | null = null;
  const ranks = raw.salesRanks;
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
  };
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