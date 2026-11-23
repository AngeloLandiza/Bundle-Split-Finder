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
  /**
   * Keepa's `model`: often the part number again (DCF921B), sometimes a packaging variant (DCB606YY for DCB606) or a
   * barcode fragment (33287199938 for PCL235B), as recorded in fixtures/keepa/. Read by the catalog check only.
   */
  model?: string | null;
  /** Keepa's `numberOfItems`, null for its -1 or 0 ("no data"). Recorded: 1 for most, 4 for a tool pack or a kit. */
  numberOfItems?: number | null;
  /** Keepa's `packageQuantity`, null for its -1 or 0 ("no data"). */
  packageQuantity?: number | null;
  /** Keepa's `type` (DRILL, BATTERY, POWER_TOOL_SET …). Not read by any rule: recorded values are unreliable (a brad nailer, Tool Only, is POWER_TOOL_SET). */
  type?: string;
  productType?: number;
  /** Keepa's `features`: the listing's feature bullets. Absent when Keepa gives none. Read by keepa/listingFields.ts only. */
  features?: string[];
  /** Keepa's `gtinList`: the listing's barcodes (recorded: "00033287199938"). Absent when none. Read by keepa/listingFields.ts only. */
  gtinList?: string[];
  /** Amazon price in the marketplace's smallest currency unit (cents). */
  amazonPrice?: number | null;
  /** Where amazonPrice came from: stats.current[0] (Amazon selling) or stats.current[1] (the lowest New offer). */
  amazonPriceSource?: 'amazon' | 'new_lowest';
  /**
   * Suggested prices: the average New price in cents over 30 and 90 days (stats.avg30 / stats.avg90: Amazon's own offer,
   * else the lowest New offer). Null when the pull's stats have none; absent when the pull carried no stats.
   */
  newAvg30?: number | null;
  newAvg90?: number | null;
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