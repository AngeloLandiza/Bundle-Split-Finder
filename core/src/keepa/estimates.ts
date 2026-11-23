// Token estimates for budget checks and run planning (plan §2c, §3c).

import type { KeepaTrackingDepth } from './types';

/** Keepa product search. */
export const KEEPA_SEARCH_TOKEN_ESTIMATE = 10;
/** Search plus up to a 20-ASIN detail batch when search returns `asinList` only. */
export const KEEPA_LOOKUP_TOKEN_ESTIMATE = KEEPA_SEARCH_TOKEN_ESTIMATE + 20;

/** Per-ASIN product pull before the first response (conservative vs stats/offers query params). */
export function productTokenEstimate(depth: KeepaTrackingDepth | undefined, asinCount = 1): number {
  const base = Math.max(1, asinCount);
  if (depth === 'price_and_rank') return base + 1;
  if (depth === 'full') return base + 3;
  return base;
}