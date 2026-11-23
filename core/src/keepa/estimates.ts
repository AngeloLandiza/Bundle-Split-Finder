// Token estimates for budget checks and run planning (plan §2c, §3c).

import type { KeepaTrackingDepth } from './types';

/** Keepa product search: fixtures/keepa/search-RYOBI-PCL235B.json consumed 10 tokens for 20 products. */
export const KEEPA_SEARCH_TOKEN_ESTIMATE = 10;
/**
 * One Amazon lookup on Keepa, as recorded (Nov 23): the search (10 tokens) returns its products with title, brand,
 * partNumber, monthlySold and fees, but no `stats` and no `csv`, so no price; the listing the matcher chooses is then
 * pulled once with stats (1 token: product-…-stats.json consumed 3 for 3 ASINs) for its current price. 10 + 1.
 * The old figure, 30, counted a 20-ASIN detail batch the recorded search never needs.
 */
export const KEEPA_PRICE_PULL_TOKENS = 1;
export const KEEPA_LOOKUP_TOKEN_ESTIMATE = KEEPA_SEARCH_TOKEN_ESTIMATE + KEEPA_PRICE_PULL_TOKENS;

/**
 * Offer pages `offers=20` can return per product: Keepa bills "6 for every found offer page (contains up to 10 offers)
 * per product, with a minimum of 5 tokens if the retrieval succeeds but no offer page is found"
 * (keepa.com/api-docs/product.html, read Nov 23, 2026).
 */
export const KEEPA_OFFER_PAGES_AT_FULL = 2;
export const KEEPA_TOKENS_PER_OFFER_PAGE = 6;

/**
 * Tokens one product pull may cost before the first response, per depth (keepa.com/api-docs/product.html, Nov 23):
 *   price_only      1 per ASIN: the product, with stats (current Amazon / New price, sales rank) at no extra cost
 *   price_and_rank  1 per ASIN: the same request (sales rank is in stats.current, also free)
 *   full            1 + 12 per ASIN: offers=20 adds up to 2 offer pages at 6 tokens each (at least 5)
 */
export function productTokenEstimate(depth: KeepaTrackingDepth | undefined, asinCount = 1): number {
  const base = Math.max(1, asinCount);
  if (depth === 'full') return base * (1 + KEEPA_OFFER_PAGES_AT_FULL * KEEPA_TOKENS_PER_OFFER_PAGE);
  return base;
}