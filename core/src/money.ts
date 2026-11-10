// Profit math and the packaging rule.
//
// v1 has no access to the seller's own fee data, so fees are settings the
// founder can change. The UI must label profit as an estimate.

export interface FeeSettings {
  /** 0.15 for Tools & Home Improvement, 0.12 for base equipment power tools. */
  referralRate: number;
  /** Flat per-unit fulfillment estimate in dollars (FBA or his own shipping). */
  fulfillmentFee: number;
  /** Amazon's per-item minimum referral fee. */
  minReferral: number;
  /** Sales tax paid on the purchase; 0 with a resale certificate. */
  salesTaxRate: number;
  /** Per-bundle cost to get stock to Amazon or to the buyer. */
  inboundCost: number;
}

export const DEFAULT_FEES: FeeSettings = {
  referralRate: 0.15,
  fulfillmentFee: 0,
  minReferral: 0.3,
  salesTaxRate: 0,
  inboundCost: 0,
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function amazonNet(price: number, fees: FeeSettings = DEFAULT_FEES): number {
  const referral = Math.max(price * fees.referralRate, fees.minReferral);
  return round2(price - referral - fees.fulfillmentFee);
}

export interface BundleResult {
  cost: number;
  netRevenue: number;
  profit: number;
  roi: number;
}

export function bundleProfit(bundlePrice: number, netRevenue: number, fees: FeeSettings = DEFAULT_FEES): BundleResult {
  const cost = round2(bundlePrice * (1 + fees.salesTaxRate) + fees.inboundCost);
  const profit = round2(netRevenue - cost);
  return { cost, netRevenue: round2(netRevenue), profit, roi: cost ? Math.round((profit / cost) * 10000) / 10000 : 0 };
}

// ---------------------------------------------------------------- packaging rule

export type Packaging = 'retail_boxed' | 'loose' | 'unknown';

export interface Route {
  channel: 'amazon' | 'ebay';
  condition: 'new' | 'new_other';
  note: string;
}

/**
 * Where a component may be sold, and in what condition.
 *
 * Amazon's "New" means factory packaging, so only retail-boxed items go to a
 * normal Amazon listing as New. "unknown" is treated like "loose" until the
 * founder confirms the packaging once.
 */
export function route(packaging: Packaging): Route {
  if (packaging === 'retail_boxed') {
    return { channel: 'amazon', condition: 'new', note: 'own retail box; list on the retail ASIN' };
  }
  if (packaging === 'loose') {
    return { channel: 'ebay', condition: 'new_other', note: 'no retail box; eBay "New (other)" fits unused items without packaging' };
  }
  return { channel: 'ebay', condition: 'new_other', note: 'packaging not confirmed; treated as loose until checked once' };
}
