// Parse Keepa JSON into the fields the matcher and ROI logic need later.

import type { KeepaMeta, KeepaProduct, KeepaProductResponse, KeepaSearchResponse } from './types';

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export function parseMeta(body: Record<string, unknown>): KeepaMeta {
  const err = body.error as Record<string, unknown> | undefined;
  return {
    refillRate: num(body.refillRate),
    refillIn: num(body.refillIn),
    tokensLeft: num(body.tokensLeft),
    tokensConsumed: num(body.tokensConsumed),
    processingTimeInMs: num(body.processingTimeInMs),
    ...(err && typeof err.type === 'string' && typeof err.message === 'string'
      ? { error: { type: err.type, message: err.message, details: typeof err.details === 'string' ? err.details : undefined } }
      : {}),
  };
}

/** `stats.current[0]` is the current Amazon price in cents when stats is present. */
function amazonCentsFromStats(stats: unknown): number | null {
  if (!stats || typeof stats !== 'object') return null;
  const cur = (stats as Record<string, unknown>).current;
  if (!Array.isArray(cur) || cur.length === 0) return null;
  const v = cur[0];
  return typeof v === 'number' && v > 0 ? v : null;
}

/** A Keepa count or fee: a finite number of 0 or more; Keepa's -1 ("no data") and anything else is null. */
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function tracking(raw: Record<string, unknown>): Pick<KeepaProduct, 'monthlySold' | 'fbaPickAndPackFee' | 'referralFeePercentage' | 'buyBoxEligibleOfferCounts' | 'salesRanks'> {
  const fba = raw.fbaFees && typeof raw.fbaFees === 'object' ? (raw.fbaFees as Record<string, unknown>) : null;
  const offers = Array.isArray(raw.buyBoxEligibleOfferCounts) && raw.buyBoxEligibleOfferCounts.every((n) => typeof n === 'number')
    ? (raw.buyBoxEligibleOfferCounts as number[])
    : null;
  const ranks = raw.salesRanks && typeof raw.salesRanks === 'object' && !Array.isArray(raw.salesRanks) ? (raw.salesRanks as Record<string, number[]>) : undefined;
  return {
    monthlySold: count(raw.monthlySold),
    fbaPickAndPackFee: fba ? count(fba.pickAndPackFee) : null,
    referralFeePercentage: count(raw.referralFeePercentage),
    buyBoxEligibleOfferCounts: offers,
    ...(ranks ? { salesRanks: ranks } : {}),
  };
}

function parseOneProduct(raw: Record<string, unknown>): KeepaProduct {
  const asin = typeof raw.asin === 'string' ? raw.asin : '';
  return {
    ...tracking(raw),
    asin,
    title: typeof raw.title === 'string' ? raw.title : null,
    brand: typeof raw.brand === 'string' ? raw.brand : null,
    manufacturer: typeof raw.manufacturer === 'string' ? raw.manufacturer : null,
    partNumber: typeof raw.partNumber === 'string' ? raw.partNumber : null,
    productType: typeof raw.productType === 'number' ? raw.productType : undefined,
    amazonPrice: amazonCentsFromStats(raw.stats),
  };
}

export function parseProductResponse(body: Record<string, unknown>): KeepaProductResponse {
  const meta = parseMeta(body);
  const products = Array.isArray(body.products)
    ? body.products
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map(parseOneProduct)
        .filter((p) => p.asin.length > 0)
    : [];
  return { meta, products };
}

export function parseSearchResponse(body: Record<string, unknown>): KeepaSearchResponse {
  const meta = parseMeta(body);
  let asinList = Array.isArray(body.asinList) ? body.asinList.filter((a): a is string => typeof a === 'string') : undefined;
  const products = Array.isArray(body.products)
    ? body.products
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map(parseOneProduct)
        .filter((p) => p.asin.length > 0)
    : [];
  if ((!asinList || asinList.length === 0) && products.length > 0) {
    asinList = products.map((p) => p.asin);
  }
  return { meta, asinList, ...(products.length > 0 ? { products } : {}) };
}

/** Cents to dollars for display and comparison with SerpApi dollars. */
export function centsToDollars(cents: number | null | undefined): number | null {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return null;
  return Math.round(cents) / 100;
}