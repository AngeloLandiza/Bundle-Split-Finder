// The scan pipeline's contracts: what it needs from the outside (a search client, a
// budget, a store) and what it keeps (records, the resumable job).
//
// Everything here is plain data and interfaces, so the same pipeline runs in Node
// (tests, the command line) with an in-memory store and in the extension's service
// worker with IndexedDB behind the same ScanStore.

import type { Decomposition } from '../decompose';
import type { Grade } from '../match';
import { DEFAULT_FEES, type BundleResult, type FeeSettings } from '../money';
import type { BlockReason } from '../serpapi/budget';
import type { Params, SearchOptions, SearchResult } from '../serpapi/client';

// ---------------------------------------------------------------- ports

/** The one way the pipeline searches. SerpApiClient satisfies it. */
export interface SearchClient {
  search(params: Params, options?: SearchOptions): Promise<SearchResult>;
}

/** What the pipeline may know about the budget. SearchBudget satisfies it. */
export interface BudgetView {
  /** Paid searches that may still happen right now. */
  readonly spendable: number;
  /** The limit that refuses `n` more searches, or null when they fit. */
  blockReason(n?: number): BlockReason | null;
}

// ---------------------------------------------------------------- settings

/** One Home Depot search the scan pages through. */
export interface ScanQuery {
  q: string;
  /** Home Depot filter tokens, comma-separated, sent as hd_filter_tokens. */
  filterTokens?: string;
  /** True when the query is filtered to Home Depot's own "Bundle" products: every row is a bundle. */
  bundlesOnly?: boolean;
}

export interface ScanSettings {
  /** Brands to keep, upper case. Rows of any other brand are ignored. */
  brands: string[];
  queries: ScanQuery[];
  /** Listing pages wanted per query (24 products each). */
  pagesPerQuery: number;
  /** An Amazon price older than this is refreshed. */
  freshnessMs: number;
  /** A listing page cached more recently than this is reused instead of paid for again. */
  listingMaxAgeMs: number;
  fees: FeeSettings;
  /** Value of a part with no listing, as a share of the bundle's per-part cost. */
  liquidationRate: number;
  amazonDomain: string;
  /** Pages of a brand's own Amazon listings to save at the start of a scan (about 48 listings each). 0 turns the phase off. */
  catalogPagesPerScan: number;
  /** Amazon's brand filter per brand, sent as `rh`. Read from recorded responses. */
  brandFilters: Record<string, string>;
}

const HOUR = 60 * 60 * 1000;

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  brands: ['DEWALT', 'RYOBI'],
  queries: [{ q: 'dewalt 20v combo kit' }, { q: 'ryobi 18v combo kit' }],
  pagesPerQuery: 1,
  freshnessMs: 3 * 24 * HOUR,
  // SerpApi itself serves an identical request from its cache, free, for one hour.
  listingMaxAgeMs: HOUR,
  fees: DEFAULT_FEES,
  liquidationRate: 0,
  amazonDomain: 'amazon.com',
  catalogPagesPerScan: 1,
  brandFilters: { DEWALT: 'p_123:195991', RYOBI: 'p_123:252605' },
};

// ---------------------------------------------------------------- records

/** Key of a bundle record. */
export const bundleKey = (itemId: string): string => `homedepot:${itemId}`;

/** Key of a catalog entry and of a match record: brand and model, upper case. */
export const partKey = (brand: string, model: string): string => `${brand.trim().toUpperCase()}:${model.trim().toUpperCase()}`;

export interface BundleRecord {
  /** bundleKey(itemId) */
  key: string;
  retailer: 'homedepot';
  itemId: string;
  title: string;
  brand: string;
  model: string;
  upc: string | null;
  price: number | null;
  regularPrice: number | null;
  percentOff: number | null;
  link: string | null;
  seenAt: number;
  /** Result of the last split attempt; null before the first one. */
  split: Decomposition | null;
}

export interface CatalogRecord {
  /** partKey(brand, model) */
  key: string;
  brand: string;
  model: string;
  title: string;
  /** Tool-type words from the title (see kindsFromTitle). */
  kinds: string[];
  isKit: boolean;
  upc: string | null;
  seenAt: number;
}

/**
 * matched  a listing is chosen
 * review   candidates exist but none is certain enough; a review item is open
 * none     looked up, nothing usable found
 * waiting  not looked up yet because the allowance ran out; goes first next scan
 */
export type MatchStatus = 'matched' | 'review' | 'none' | 'waiting';

export interface MatchRecord {
  /** partKey(brand, model) */
  key: string;
  brand: string;
  model: string;
  status: MatchStatus;
  asin: string | null;
  grade: Grade | null;
  /** Other usable ASINs of the same grade. */
  alternatives: string[];
  /** A match the user decided is never changed by a scan. */
  decidedBy: 'auto' | 'user';
  updatedAt: number;
  /** When the part first had to wait; null unless status is "waiting". */
  waitingSince: number | null;
}

export interface PriceRecord {
  asin: string;
  price: number | null;
  reviews: number | null;
  /** When `price` was last seen in a response; null if never. */
  seenAt: number | null;
  /** When this ASIN was last looked for, found or not. Staleness is measured from here. */
  checkedAt: number;
}

/**
 * One Amazon listing the tool has seen, saved so parts can be matched without a search.
 * Only listings whose brand field is one of the scanned brands are saved.
 */
export interface ListingRecord {
  asin: string;
  /** Upper case, exactly as Amazon's brand field gives it. */
  brand: string;
  title: string;
  /** Model numbers found in the title as whole tokens, upper case. Empty when the title carries none. */
  models: string[];
  /** Picture URL from the search result; null when there was none. */
  image: string | null;
  price: number | null;
  reviews: number | null;
  /** When a response last showed this listing with a price; null if never. */
  seenAt: number | null;
  /** When a response last showed this listing at all. */
  checkedAt: number;
}

/** How far the crawl of one brand's Amazon listings has got. It continues across scans. */
export interface CatalogCursor {
  brand: string;
  /** The next page to read; back to 1 after the last page. */
  nextPage: number;
  /** Complete passes over the brand's listings so far. */
  passes: number;
  updatedAt: number;
}

export interface ReviewCandidate {
  asin: string;
  title: string;
  price: number | null;
  reviews: number | null;
  reasons: string[];
}

export interface ReviewItem {
  /** `${kind}:${subject}`: one open question per subject, never duplicated. */
  id: string;
  kind: 'split' | 'match';
  /** A bundle key for a split question, a part key for a match question. */
  subject: string;
  brand: string;
  model: string;
  title: string | null;
  /** Why this could not be decided automatically, in plain words. */
  reason: string;
  /** Listings a person can choose from (match questions only). */
  candidates: ReviewCandidate[];
  openedAt: number;
  /** The user's answer; null while open. A scan never changes an answered item. */
  answer: string | null;
  answeredAt: number | null;
}

// ---------------------------------------------------------------- the job

export type ScanStep =
  | { kind: 'catalog'; brand: string; page: number }
  | { kind: 'listing'; q: string; page: number; filterTokens: string | null; bundlesOnly: boolean }
  | { kind: 'lookup'; brand: string; model: string }
  | { kind: 'refresh'; brand: string; model: string; asin: string };

/** A budget limit, SerpApi's own 429, or a failed request. */
export type StopReason = BlockReason | 'rate_limited' | 'error';

export interface ScanCounts {
  pagesFetched: number;
  productsSeen: number;
  bundlesSeen: number;
  bundlesResolved: number;
  reviewsOpened: number;
  lookupsDone: number;
  refreshesDone: number;
  partsMatched: number;
  /** Amazon brand pages read by the catalog phase. */
  catalogPages: number;
  /** Listing rows saved from any Amazon response (a row seen twice counts twice). */
  listingsSaved: number;
  /** Parts matched from saved listings, with no search. */
  partsFromCatalog: number;
}

/**
 * A scan, saved after every step so it can continue after an interruption.
 *
 * running  in progress, or interrupted: the next run continues it
 * done     everything wanted was done
 * stopped  finished early; `stopReason` says why and `deferred` holds what is left
 */
export interface ScanJob {
  /** String(startedAt) */
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'done' | 'stopped';
  stopReason: StopReason | null;
  /** The error text when stopReason is "error" or "rate_limited". */
  stopMessage: string | null;
  /** listing: Amazon catalog pages, then retailer pages. parts: lookups then refreshes. finish: nothing paid is left. */
  phase: 'listing' | 'parts' | 'finish';
  /** Paid steps still to run in this phase, in order. */
  queue: ScanStep[];
  /** Steps that did not fit or could not run. Lookups among them are marked "waiting". */
  deferred: ScanStep[];
  /** Searches that counted against the quota (responses that came from the network). */
  searchesUsed: number;
  counts: ScanCounts;
}

// ---------------------------------------------------------------- the store

/**
 * Persistence for the pipeline. put* inserts or replaces by key. get* and list*
 * return copies: changing a returned record does not change the store.
 * list* results are sorted by key ascending; listScans is newest first.
 */
export interface ScanStore {
  getBundle(key: string): Promise<BundleRecord | undefined>;
  putBundle(record: BundleRecord): Promise<void>;
  listBundles(): Promise<BundleRecord[]>;

  getCatalogEntry(key: string): Promise<CatalogRecord | undefined>;
  putCatalogEntry(record: CatalogRecord): Promise<void>;
  listCatalog(): Promise<CatalogRecord[]>;

  getMatch(key: string): Promise<MatchRecord | undefined>;
  putMatch(record: MatchRecord): Promise<void>;
  listMatches(): Promise<MatchRecord[]>;

  getPrice(asin: string): Promise<PriceRecord | undefined>;
  putPrice(record: PriceRecord): Promise<void>;

  getListing(asin: string): Promise<ListingRecord | undefined>;
  putListing(record: ListingRecord): Promise<void>;
  /** Sorted by asin ascending. */
  listListings(): Promise<ListingRecord[]>;

  getCursor(brand: string): Promise<CatalogCursor | undefined>;
  putCursor(cursor: CatalogCursor): Promise<void>;

  getReview(id: string): Promise<ReviewItem | undefined>;
  putReview(item: ReviewItem): Promise<void>;
  listReview(): Promise<ReviewItem[]>;

  getScan(id: string): Promise<ScanJob | undefined>;
  putScan(job: ScanJob): Promise<void>;
  listScans(): Promise<ScanJob[]>;
}

// ---------------------------------------------------------------- the report

/**
 * Whether a part can be sold on Amazon right now.
 * active    a listing is chosen, and the last check saw it with a price
 * inactive  a listing is chosen, but the last check saw no price for it, or did not see it
 * missing   no listing is chosen for this part
 */
export type PartAvailability = 'active' | 'inactive' | 'missing';

export interface PartRow {
  model: string;
  qty: number;
  /** "unmatched" when the part has no match record yet. */
  status: MatchStatus | 'unmatched';
  availability: PartAvailability;
  asin: string | null;
  grade: Grade | null;
  price: number | null;
  priceSeenAt: number | null;
  /** Picture of the chosen listing, when it is among the saved listings. */
  image: string | null;
}

/**
 * complete      split resolved and every part has a priced listing
 * partial       split resolved, at least one part has no priced listing (it counts as liquidated)
 * needs_review  the split is not resolved; no estimate
 */
export type BundleStatus = 'complete' | 'partial' | 'needs_review';

/**
 * Where a bundle is shown.
 * confirmed         the bundle has a price and every part has an active listing: buying it leaves nothing over
 * inactive_listing  every part has a listing, but at least one is not for sale right now, or the bundle itself has no price
 * missing_listing   at least one part has no Amazon listing
 * split             what the bundle contains is not known yet (also a resolved split that names no parts)
 */
export type ReportSection = 'confirmed' | 'inactive_listing' | 'missing_listing' | 'split';

export interface BundleRow {
  key: string;
  itemId: string;
  brand: string;
  model: string;
  title: string;
  link: string | null;
  price: number | null;
  regularPrice: number | null;
  percentOff: number | null;
  status: BundleStatus;
  section: ReportSection;
  parts: PartRow[];
  /** An estimate from fee settings, never the seller's real fees. Null without a resolved split and a price. */
  estimate: BundleResult | null;
  /** Parts valued at the liquidation rate because no priced listing covers them. */
  uncovered: string[];
}

export interface ScanReport {
  /** By section: confirmed, inactive_listing, missing_listing, split; within each, highest estimated profit first. */
  bundles: BundleRow[];
  /** Open review items, oldest first. */
  review: ReviewItem[];
}
