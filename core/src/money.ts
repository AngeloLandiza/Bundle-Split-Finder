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
  /**
   * Whether the owner has answered the sales tax (a saved value, a typed 0 or "0 is right" all count). A stored 0 alone
   * cannot tell "none" from "never asked", so profit estimates say they leave it out until this is true (core/src/estimateNote.ts).
   * Absent reads as: answered when `salesTaxRate` is not 0 (the agent migrates a store once, agent/store.ts COST_ANSWERED_MIGRATION).
   */
  salesTaxAnswered?: boolean;
  /** The same for `inboundCost`. */
  inboundAnswered?: boolean;
  /**
   * Signals round 2: where a part's fulfillment fee comes from. 'keepa': Amazon's FBA pick-and-pack fee Keepa stored for
   * the part's listing, else `fulfillmentFee`; 'flat': `fulfillmentFee` for every unit. Absent reads as 'flat' (a store
   * written before it; the agent migrates once, agent/store.ts FULFILLMENT_KEEPA_MIGRATION).
   */
  fulfillmentSource?: FeeSource;
  /** Where a part's referral rate comes from: 'keepa' (Keepa's referralFeePercentage when stored) or 'flat' (`referralRate`). Absent: 'flat'. */
  referralSource?: FeeSource;
}

export type FeeSource = 'keepa' | 'flat';

export const DEFAULT_FEES: FeeSettings = {
  referralRate: 0.15,
  fulfillmentFee: 0,
  minReferral: 0.3,
  salesTaxRate: 0,
  inboundCost: 0,
  fulfillmentSource: 'keepa',
  referralSource: 'flat',
};

/** One listing's own fees in place of the settings' (Keepa's, for its listing). Absent fields keep the settings. */
export interface ListingFees {
  fulfillmentFee?: number;
  referralRate?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function amazonNet(price: number, fees: FeeSettings = DEFAULT_FEES, own: ListingFees = {}): number {
  const referral = Math.max(price * (own.referralRate ?? fees.referralRate), fees.minReferral);
  return round2(price - referral - (own.fulfillmentFee ?? fees.fulfillmentFee));
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

// ---------------------------------------------------------------- figures beside a threshold

/**
 * A percentage in words, whole by default. One that is below its `threshold` never reads as the threshold: 19.9% against
 * 20% shows "19.9%", not "20%" (a sentence saying "20% ... below your 20%" contradicts itself). Rounded down to a tenth then.
 */
export function pctVs(value: number, threshold: number): string {
  const whole = Math.round(value);
  if (value < threshold && whole >= threshold) return `${Math.floor(value * 10) / 10}%`;
  return `${whole}%`;
}

/** Dollars with cents; one below its `threshold` never reads as the threshold ($19.996 against $20 shows $19.99). */
export function usdVs(value: number, threshold: number): string {
  const text = (n: number): string => (n < 0 ? `-$${(-n).toFixed(2)}` : `$${n.toFixed(2)}`);
  if (value < threshold && Math.round(value * 100) / 100 >= threshold) return text(Math.floor(value * 100) / 100);
  return text(value);
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

/**
 * Nov 23: the lowest Amazon price, to the cent, at which one unit nets `net` after fees (amazonNet's inverse). Null
 * when no price does (a referral rate of 100% or more) or `net` is not above 0. An estimate from the fee settings.
 */
export function priceForNet(net: number, fees: FeeSettings = DEFAULT_FEES): number | null {
  if (!(net > 0) || !(fees.referralRate < 1)) return null;
  const atRate = (net + fees.fulfillmentFee) / (1 - fees.referralRate);
  const price = atRate * fees.referralRate >= fees.minReferral ? atRate : net + fees.fulfillmentFee + fees.minReferral;
  // The cent at or above the exact price, then down while amazonNet (which rounds to the cent) still nets `net`.
  let cents = Math.ceil(Math.round(price * 10_000) / 100);
  while (cents > 1 && amazonNet((cents - 1) / 100, fees) >= net) cents -= 1;
  return cents / 100;
}
