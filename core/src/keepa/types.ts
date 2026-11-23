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