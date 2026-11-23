// Decide what a scan does with the searches it is allowed to spend.
//
// A scan has three kinds of paid work, in this order of value:
//   1. Home Depot listing pages  - today's bundles and prices (24 products per search)
//   2. New component lookups     - find the Amazon listing for a part never seen before
//   3. Price refreshes           - re-check Amazon prices that have gone stale
//
// When the allowance is too small for everything, the rest is deferred to the
// next scan and reported, never silently dropped.

import { bestPlan, type Listing, type Plan } from './optimize';
import { amazonNet, bundleProfit, type BundleResult, DEFAULT_FEES, type FeeSettings, type ListingFees } from './money';

export interface ScanRequest {
  /** Listing pages the settings ask for (brands x pages). */
  hdPagesWanted: number;
  /** Component models with no Amazon listing yet, most valuable first. */
  pendingLookups: string[];
  /** Component models whose Amazon price is stale, most valuable first. */
  staleRefreshes: string[];
}

export interface ScanPlan {
  hdPages: number;
  lookups: string[];
  refreshes: string[];
  deferredLookups: string[];
  deferredRefreshes: string[];
  searches: number;
}

/** Share of a tight allowance kept for listing pages, so prices are always seen. */
const PAGE_SHARE = 0.4;

export function planScan(spendable: number, req: ScanRequest): ScanPlan {
  const allowance = Math.max(0, Math.floor(spendable));
  const everything = req.hdPagesWanted + req.pendingLookups.length + req.staleRefreshes.length;

  let hdPages = req.hdPagesWanted;
  if (everything > allowance) {
    hdPages = allowance === 0 ? 0 : Math.min(req.hdPagesWanted, Math.max(1, Math.floor(allowance * PAGE_SHARE)));
  }
  let left = allowance - hdPages;
  const lookups = req.pendingLookups.slice(0, left);
  left -= lookups.length;
  const refreshes = req.staleRefreshes.slice(0, left);

  return {
    hdPages,
    lookups,
    refreshes,
    deferredLookups: req.pendingLookups.slice(lookups.length),
    deferredRefreshes: req.staleRefreshes.slice(refreshes.length),
    searches: hdPages + lookups.length + refreshes.length,
  };
}

// ---------------------------------------------------------------- evaluating one bundle

export interface PricedListing {
  asin: string;
  /** Component model -> quantity the listing sells. */
  covers: Record<string, number>;
  /** Current Amazon price. */
  price: number;
  /** Signals round 2: this listing's own fees (Keepa's FBA fee, referral rate) in place of the settings'. */
  fees?: ListingFees;
}

export interface BundleEvaluation {
  plan: Plan;
  result: BundleResult;
  /** Components with no usable Amazon listing; they are valued at the liquidation rate. */
  uncovered: string[];
}

/**
 * Profit estimate for one bundle from what is known right now.
 * `liquidationRate` values a part with no listing as a share of the bundle's
 * per-part cost (0 = worth nothing until a listing is found).
 */
export function evaluateBundle(
  bundlePrice: number,
  components: Record<string, number>,
  priced: PricedListing[],
  fees: FeeSettings = DEFAULT_FEES,
  liquidationRate = 0,
): BundleEvaluation {
  const listings: Listing[] = priced.map((p) => ({ id: p.asin, covers: p.covers, net: amazonNet(p.price, fees, p.fees) }));
  const units = Object.values(components).reduce((a, b) => a + b, 0) || 1;
  const perPart = (bundlePrice / units) * liquidationRate;
  const liquidation = Object.fromEntries(Object.keys(components).map((m) => [m, Math.round(perPart * 100) / 100]));
  const plan = bestPlan(components, listings, liquidation);
  return { plan, result: bundleProfit(bundlePrice, plan.totalNet, fees), uncovered: [...new Set(plan.liquidated)] };
}
