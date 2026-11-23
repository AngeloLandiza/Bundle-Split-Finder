// Keepa API shapes used by the client and parsers. Full product objects are large; tests
// use recorded fixtures.

export const KEEPA_DOMAIN_US = 1;

export interface KeepaMeta {
  refillRate: number;
  refillIn: number;
  tokensLeft: number;
  tokensConsumed: number;
  processingTimeInMs: number;
  error?: { type: string; message: string; details?: string };
}

export interface KeepaProduct {
  asin: string;
  title?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  partNumber?: string | null;
  productType?: number;
  /** Amazon price in the marketplace's smallest currency unit (cents). */
  amazonPrice?: number | null;
  /** Where amazonPrice came from: stats.current[0] (Amazon selling) or stats.current[1] (the lowest New offer). */
  amazonPriceSource?: 'amazon' | 'new_lowest';
  /** stats.current[3]: the current sales rank (Keepa's SALES index), when stats has one. */
  statsSalesRank?: number;
  /**
   * Keepa's `monthlySold`: units bought in the past month (recorded: 500, 1000, 600 in
   * fixtures/keepa/product-*.json). Null when the product has none or a negative "no data" value.
   */
  monthlySold?: number | null;
  /** Keepa's `fbaFees.pickAndPackFee`, in cents (recorded: 802, 710, 760). Null when absent. */
  fbaPickAndPackFee?: number | null;
  /** Keepa's `referralFeePercentage` (recorded: 12, 13.83). Null when absent. */
  referralFeePercentage?: number | null;
  /** Keepa's `buyBoxEligibleOfferCounts`, an array of 8 counts as recorded; its index meanings are not interpreted here. */
  buyBoxEligibleOfferCounts?: number[] | null;
  /**
   * Keepa's `salesRanks` (category id -> history). Not in any recording yet (history=0 drops it);
   * kept only when a response carries it, and read by trends.ts as before.
   */
  salesRanks?: Record<string, number[]>;
}

export interface KeepaProductResponse {
  meta: KeepaMeta;
  products: KeepaProduct[];
}

export type KeepaTrackingDepth = 'price_only' | 'price_and_rank' | 'full';

export interface KeepaSearchResponse {
  meta: KeepaMeta;
  /** Slim product rows when Keepa returns them on search (fixtures and some live responses). */
  products?: KeepaProduct[];
  /** ASIN strings from a product search. */
  asinList?: string[];
}