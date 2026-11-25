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
  /**
   * Keepa's `upcList` and `eanList`: the listing's barcodes as Amazon's catalog lists them (1,838 of 2,216 products in the
   * owner's cache carry one; fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json has `eanList`). Absent when none.
   * Read by keepa/barcode.ts only, to record whether a product found by code holds the part's barcode: never a proof.
   */
  upcList?: string[];
  eanList?: string[];
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
  /**
   * The market around the listing (Nov 25, docs/decisions.md "The market around a listing"), read from the same pull's
   * stats and product fields: no extra call, no extra token. Absent when the pull carried no stats.
   */
  market?: KeepaMarket;
}

/**
 * What a pull says about the listing's market, as recorded in fixtures/keepa/stats-sample-2026-11-25.json (83 listings,
 * stats=180, no offers). Cents for prices; null where Keepa wrote -1 / -2 or nothing. Fields Keepa leaves empty without
 * offers (offerCountFBA/FBM -2, buyBoxPrice -2, every buyBoxIs* but buyBoxIsAmazon) are not read.
 */
export interface KeepaMarket {
  /** stats.avg180: the average New price over 180 days (NEW, else Amazon's own offer), as newAvg30/newAvg90. */
  newAvg180: number | null;
  /** stats.current[0] (AMAZON): Amazon's own current offer; null when Amazon is not selling it now. */
  amazonCurrent: number | null;
  /** stats.buyBoxIsAmazon: recorded only as true (20 of 83) or null, never false; null is "not stated". */
  buyBoxIsAmazon: boolean | null;
  /** stats.current[11] and stats.avg90[11] (COUNT_NEW): how many New offers now and on average over 90 days. */
  newOffers: number | null;
  newOffersAvg90: number | null;
  /** stats.outOfStockPercentage90[1] (NEW): the percent of the last 90 days with no New offer at all (0-100). */
  outOfStock90: number | null;
  /**
   * The product's `hazardousMaterials`, when it names a UN number: the proper shipping name, the UN number and the transport
   * class as recorded (PBP004: "LITHIUM ION BATTERIES", "UN3480", "9"). An entry with no UN number (FVB02's lone class "0")
   * is not a hazard the record states, and gives null.
   */
  hazmat: { unId: string; name: string | null; transportClass: string | null } | null;
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