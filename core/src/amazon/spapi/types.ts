// Amazon's Selling Partner API, read-only, for the one seller's own account (docs/sp-api-notes-2026-11-25.md). Types and
// the fixed facts the client is built on. Pure: no node:*, no chrome.*.
//
// What is read: whether he may list an ASIN (Listings Restrictions), whether FBA takes it (FBA Inbound Eligibility), what
// Amazon would charge him for it (Product Fees), and later his own sales by ASIN and day (Sales, the seam only). Nothing
// is ever listed, changed or ordered: the client has no method that writes.

/** The "Amazon seller account" key, as the agent's store keeps it (owner-only). Every field is a secret (rule 3). */
export interface SellerCredentials {
  /** The LWA client id of his private app (Seller Central, Develop Apps). */
  clientId: string;
  clientSecret: string;
  /** From "Authorize app" in Develop Apps. */
  refreshToken: string;
  /** His seller id ("merchant token"). */
  sellerId: string;
}

/** The two hosts a seller key is ever sent to (docs/security-review-2026-11-23.md, addendum Nov 25). */
export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
export const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
/** US only for now (the notes: North America endpoint, the US marketplace). */
export const US_MARKETPLACE_ID = 'ATVPDKIKX0DER';
/** The access token lasts 3600 s (the notes); it is used until this long before it ends. */
export const TOKEN_MARGIN_MS = 5 * 60_000;

export type SpOperation = 'restrictions' | 'eligibility' | 'fees' | 'sales';
export const SP_OPERATIONS: readonly SpOperation[] = ['restrictions', 'eligibility', 'fees', 'sales'];

/**
 * The documented rates (requests a second), from the notes. The limiter keeps one request per 1/rate seconds per
 * operation and ignores the burst, so it stays at or below them.
 */
export const SP_RATES: Readonly<Record<SpOperation, number>> = { restrictions: 5, eligibility: 1, fees: 0.5, sales: 0.5 };

/**
 * The app's own cap a day per operation (fees: batches of up to FEES_BATCH_MAX). Far above what the deals need (a few
 * dozen listings), far below what Amazon allows; the owner sees the day's use in Settings and Costs.
 */
export const SP_DAILY_CAPS: Readonly<Record<SpOperation, number>> = { restrictions: 400, eligibility: 400, fees: 40, sales: 100 };
export const FEES_BATCH_MAX = 20;

export const SP_OPERATION_WORDS: Readonly<Record<SpOperation, string>> = {
  restrictions: 'listing checks',
  eligibility: 'FBA checks',
  fees: 'fee estimates',
  sales: 'sales reads',
};

// ---------------------------------------------------------------- results

/** One reason Amazon gives on Listings Restrictions. `code` is Amazon's own; an unknown one is kept as it came. */
export interface RestrictionReason {
  code: string;
  /** False for a code the notes do not list (APPROVAL_REQUIRED, ASIN_NOT_FOUND, NOT_ELIGIBLE). */
  known: boolean;
  message: string;
  /** The first link Amazon gave that passes sellerCentralLink (https, sellercentral.amazon.com only); null otherwise. */
  link: string | null;
}

/**
 * allowed            no restriction for new_new
 * approval_required  APPROVAL_REQUIRED (he may apply)
 * not_eligible       NOT_ELIGIBLE (no path)
 * not_found          ASIN_NOT_FOUND
 * unknown            a reason whose code the notes do not list: shown as its code, never as allowed
 */
export type ListingStatus = 'allowed' | 'approval_required' | 'not_eligible' | 'not_found' | 'unknown';

export interface RestrictionsResult {
  asin: string;
  status: ListingStatus;
  reasons: RestrictionReason[];
}

export interface EligibilityReason {
  code: string;
  known: boolean;
}

export interface EligibilityResult {
  asin: string;
  eligible: boolean;
  reasons: EligibilityReason[];
}

/** One fee line as Amazon names it; an unknown type is kept by name. Dollars per unit. */
export interface FeeLine {
  type: string;
  amount: number;
}

/**
 * Product Fees for one ASIN at one price. `referral` is the line named ReferralFee; `other` is everything else Amazon
 * counted (FBA fees, closing fees, any unknown type), so referral + other = total. Null `estimate` with `problem` when
 * Amazon gave no usable estimate for it (its own error, or no ReferralFee line to tell referral from the rest).
 */
export interface FeesResult {
  asin: string;
  price: number;
  estimate: { total: number; referral: number; other: number; lines: FeeLine[] } | null;
  problem: string | null;
}

/** Sales getOrderMetrics, one interval (a day). Money in the marketplace's currency. */
export interface OrderMetric {
  interval: string;
  unitCount: number;
  orderItemCount: number;
  orderCount: number;
  averageUnitPrice: number | null;
  totalSales: number | null;
}

/** One call as the ledger keeps it (spapi-ledger.jsonl): never an address with a query, never a key. */
export interface SpCallRow {
  at: string;
  op: SpOperation | 'token';
  status: number | null;
  /** Items asked in one call (a fee batch: up to 20). */
  items: number;
}

/** A first response kept so the notes can be corrected from real data (bounded, scrubbed). */
export interface SpSample {
  op: SpOperation | 'token';
  at: string;
  status: number;
  /** The body as JSON text with every secret and every seller id taken out, cut to SAMPLE_CHARS. */
  body: string;
}

export const SAMPLES_PER_OPERATION = 3;
export const SAMPLE_CHARS = 6_000;
