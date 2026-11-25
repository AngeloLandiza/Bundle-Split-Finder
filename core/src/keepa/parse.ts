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

/**
 * `stats.current` uses Keepa's price-type indexes (keepa.com/api-docs/statistics-object.html, read Nov 23, 2026):
 * 0 AMAZON (Amazon itself selling), 1 NEW (the lowest marketplace New offer), 3 SALES (the sales rank, not a price);
 * -1 means no offer in the interval. Prices are cents.
 */
const statsCurrent = (stats: unknown, index: number, field = 'current'): number | null => {
  if (!stats || typeof stats !== 'object') return null;
  const cur = (stats as Record<string, unknown>)[field];
  if (!Array.isArray(cur)) return null;
  const v = cur[index];
  return typeof v === 'number' && v > 0 ? v : null;
};

/**
 * Suggested prices (Nov 23): the average New price over `field`'s window (stats.avg90 or stats.avg30, the same price-type
 * indexes as current): Keepa's NEW (index 1, the lowest New offer), else Amazon's own offer (index 0) when only Amazon sold
 * it. NEW first, unlike the current price, because it is the lower and the owner sells as a third party: the recording has
 * DCF921B (B09M3TL9BB) at $235.14 from Amazon and $146.37 lowest New over 90 days. Recorded in
 * fixtures/keepa/product-…-stats.json (stats=180 carries avg, avg30, avg90, avg180 and avg365). Null when the window has
 * neither, or stats is absent: never a figure from another window.
 */
function averageCents(stats: unknown, field: 'avg30' | 'avg90'): number | null {
  return statsCurrent(stats, 1, field) ?? statsCurrent(stats, 0, field);
}

/**
 * The current New price in cents: Amazon's own offer when Amazon sells it, else the lowest marketplace New offer, so a
 * tool only third parties sell still has a price. The lowest New offer is at or below what the Buy Box usually shows:
 * the estimate can only come out lower, never higher. Null without stats or without a New offer.
 */
function amazonCentsFromStats(stats: unknown): { cents: number; source: 'amazon' | 'new_lowest' } | null {
  const amazon = statsCurrent(stats, 0);
  if (amazon !== null) return { cents: amazon, source: 'amazon' };
  const lowest = statsCurrent(stats, 1);
  return lowest !== null ? { cents: lowest, source: 'new_lowest' } : null;
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

/** The non-empty strings of an array, or none. */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

function parseOneProduct(raw: Record<string, unknown>): KeepaProduct {
  const asin = typeof raw.asin === 'string' ? raw.asin : '';
  const price = amazonCentsFromStats(raw.stats);
  const rank = statsCurrent(raw.stats, 3);
  const hasStats = !!raw.stats && typeof raw.stats === 'object';
  return {
    ...tracking(raw),
    // Present (a number or null) only when the pull carried stats, so a trend stored without them reads as "not asked".
    ...(hasStats ? { newAvg30: averageCents(raw.stats, 'avg30'), newAvg90: averageCents(raw.stats, 'avg90') } : {}),
    ...(price ? { amazonPriceSource: price.source } : {}),
    ...(rank !== null ? { statsSalesRank: rank } : {}),
    asin,
    title: typeof raw.title === 'string' ? raw.title : null,
    brand: typeof raw.brand === 'string' ? raw.brand : null,
    manufacturer: typeof raw.manufacturer === 'string' ? raw.manufacturer : null,
    partNumber: typeof raw.partNumber === 'string' ? raw.partNumber : null,
    // Identity fields for the catalog check (keepa/verify.ts). Keepa writes -1 or 0 for "no data" in the two counts.
    model: typeof raw.model === 'string' ? raw.model : null,
    numberOfItems: typeof raw.numberOfItems === 'number' && raw.numberOfItems > 0 ? raw.numberOfItems : null,
    packageQuantity: typeof raw.packageQuantity === 'number' && raw.packageQuantity > 0 ? raw.packageQuantity : null,
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
    // Rung 1 of the listing ladder (keepa/listingFields.ts): the feature bullets and barcodes, when Keepa gives them.
    ...(strings(raw.features).length > 0 ? { features: strings(raw.features) } : {}),
    ...(strings(raw.gtinList).length > 0 ? { gtinList: strings(raw.gtinList) } : {}),
    // Nov 25: the catalog's barcodes, read by keepa/barcode.ts (a product found by code is a candidate, not a proof).
    ...(strings(raw.upcList).length > 0 ? { upcList: strings(raw.upcList) } : {}),
    ...(strings(raw.eanList).length > 0 ? { eanList: strings(raw.eanList) } : {}),
    productType: typeof raw.productType === 'number' ? raw.productType : undefined,
    amazonPrice: price?.cents ?? null,
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