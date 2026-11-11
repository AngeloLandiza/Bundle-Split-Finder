// The scan pipeline's contracts: what it needs from the outside (a search client, a
// budget, a store) and what it keeps (records, the resumable job).
//
// Everything here is plain data and interfaces, so the same pipeline runs in Node
// (tests, the command line) with an in-memory store and in the extension's service
// worker with IndexedDB behind the same ScanStore.

import type { Decomposition } from '../decompose';
import type { PageContent } from '../hdPage';
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
  /** Searches this run's own limit still allows (before any spend, the per-scan limit itself). */
  readonly leftThisRun: number;
  /** Searches left on the account above the reserve (for a manual action, whose reserve is 0, all that is left this month). */
  readonly leftAboveReserve: number;
  /** The plan's searches an hour, or null when not known. */
  readonly hourlyLimit: number | null;
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
  /** Home Depot pages read at most per scan: bundle pages, then (step 6) kit pages, from one count. */
  pageReadsPerScan: number;
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
  pageReadsPerScan: 60,
};

// ---------------------------------------------------------------- records

/** Key of a bundle record. */
export const bundleKey = (itemId: string): string => `homedepot:${itemId}`;

/** Key of a catalog entry and of a match record: brand and model, upper case. */
export const partKey = (brand: string, model: string): string => `${brand.trim().toUpperCase()}:${model.trim().toUpperCase()}`;

/**
 * The parts a bundle's split holds, once per unit, brand and model trimmed and upper case: none
 * unless the split is resolved. The one reading of a bundle's parts, shared by the lookups'
 * planning (bundleParts) and the report, so the two cannot drift.
 */
export const resolvedParts = (b: Pick<BundleRecord, 'brand' | 'split'>): { key: string; brand: string; model: string }[] =>
  b.split?.status === 'resolved'
    ? b.split.components.map((c) => ({ key: partKey(b.brand, c), brand: b.brand.trim().toUpperCase(), model: c.trim().toUpperCase() }))
    : [];

/**
 * Whether a matched listing is active: its price was seen at its last check. The report's
 * availability, and (step 6) what keeps a scan from looking up a kit's items.
 */
export const priceActive = (price: PriceRecord | undefined): boolean =>
  price !== undefined && price.price !== null && price.seenAt === price.checkedAt;

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
  /** What the bundle's own page said. Undefined or null: not read yet. */
  page?: PageReading | null;
}

export interface PageReading extends PageContent {
  /** Clock time of the reading. */
  readAt: number;
}

/**
 * read        the page was read
 * unreadable  the page came back but its data could not be read
 * refused     Home Depot answered with something other than the page; reading stopped here
 * skipped     not tried, because reading stopped earlier
 */
export type PageOutcome =
  | { itemId: string; kind: 'read'; content: PageContent }
  | { itemId: string; kind: 'unreadable' | 'refused' | 'skipped' };

/** Reads bundle pages in the owner's browser. Never a search. */
export type ReadPages = (itemIds: string[]) => Promise<PageOutcome[]>;

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
  /**
   * Step 6: the Home Depot item id of the listing row the entry was last saved from. Absent on an
   * entry saved before step 6: its page cannot be read until a listing row shows it again.
   */
  itemId?: string | null;
  /**
   * Step 6: a kit's own page, read by `itemId` once a resolved split holds the kit, and kept as a
   * bundle's is (a later listing row keeps it). Undefined or null: not read yet.
   */
  page?: PageReading | null;
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
  /**
   * Q1a fix round 2: 'page' when Verify wrote this result from a listing's detail page. A scan never
   * judges such a result again from search rows, which carry no part number or packaging. Absent
   * otherwise, and on records saved before it existed.
   */
  source?: 'page';
  /**
   * Q1a fix round 2: listings a detail page showed are not this part (Verify sent them to review).
   * Matching from saved listings never chooses one of them for the part or its twin. Absent when none.
   */
  rejectedAsins?: string[];
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
  /**
   * When the response that showed this listing was received (SearchResult.at): the time of `price`.
   * A candidate saved before step 5's final review has none; it reads as null.
   */
  seenAt: number | null;
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
  /**
   * Split questions: the readings the owner can choose from, each a list of parts. Empty for match
   * questions. An item saved before step 5 has none stored, and reads as [] (see answers.ts).
   */
  choices: string[][];
  openedAt: number;
  /**
   * The user's answer; null while open. A scan never changes an item the user answered. A split
   * question a scan closed itself ('resolved by a later scan') is opened again when the bundle
   * needs review again. The user answers a split with the chosen or typed parts joined by ',',
   * a match with the chosen ASIN, and either with 'none' (answers.ts).
   */
  answer: string | null;
  /**
   * Split questions: the parts the owner's answer fixes, whether chosen from `choices` or typed
   * ({ parts }); `answer` is them joined by ','. Null for "none" and while open. An item answered
   * before typed parts existed has none: its answer counts only when it equals one of its choices.
   */
  answerParts?: string[] | null;
  answeredAt: number | null;
}

// ---------------------------------------------------------------- the job

export type ScanStep =
  | { kind: 'catalog'; brand: string; page: number }
  | { kind: 'listing'; q: string; page: number; filterTokens: string | null; bundlesOnly: boolean }
  | { kind: 'lookup'; brand: string; model: string }
  | { kind: 'refresh'; brand: string; model: string; asin: string };

/** A budget limit, SerpApi's own 429, a failed request, or the user pressing Stop. */
export type StopReason = BlockReason | 'rate_limited' | 'error' | 'user';

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
  /** Home Depot pages read and saved: on their bundles, and (step 6) on their kits' catalog entries. Never a search. */
  pagesRead: number;
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
  /**
   * The error text when stopReason is "error" or "rate_limited". Also set, with stopReason
   * left as it was, when a step failed and was set aside while the scan went on.
   */
  stopMessage: string | null;
  /** listing: Amazon catalog pages, then retailer pages. parts: lookups then refreshes. finish: nothing paid is left. */
  phase: 'listing' | 'parts' | 'finish';
  /** Paid steps still to run in this phase, in order. */
  queue: ScanStep[];
  /** Steps that did not fit or could not run. Lookups among them are marked "waiting". */
  deferred: ScanStep[];
  /**
   * Ruling 50: partKey of every lookup or refresh this job set aside after a failure. The next
   * job plans them after the steps the budget deferred. Absent on a job that set nothing aside,
   * and on jobs saved before it existed, which plan as before.
   */
  setAsideParts?: string[];
  /**
   * Ruling 57: partKey of every part whose last lookup or refresh failed, in this job or one before
   * it, and that has not been answered since, least recent failure first. Carried from job to job;
   * the next job plans these after every other candidate, in this order. Absent when there are
   * none; a job saved before it existed is read from its setAsideParts.
   */
  failingParts?: string[];
  /**
   * Ruling 52: the listing page whose search failed and stopped this job, as a key of its query,
   * page and filter tokens. The next job plans it after every other page and never tops it up.
   * Absent otherwise, and on jobs saved before it existed, which plan as before.
   */
  failedPages?: string[];
  /**
   * Listing pages (keyed as failedPages) whose last answer said there is a next page, in this job or
   * one before it; carried from job to job. A page N > 1 is planned before page N−1 of its query
   * only while N−1 is in this list and did not fail; otherwise it waits behind N−1 (F9 review).
   * Absent when there are none; a job saved before it existed holds every page behind its earlier one.
   */
  answeredPages?: string[];
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
  /** Title of the chosen listing, when it is among the saved listings. */
  title: string | null;
}

/**
 * complete      split resolved and every part has a priced listing
 * partial       split resolved, at least one part has no priced listing (it counts as liquidated once it has been looked up; while a part waits, there is no estimate)
 * needs_review  the split is not resolved; no estimate
 */
export type BundleStatus = 'complete' | 'partial' | 'needs_review';

/**
 * Where a bundle is shown.
 * confirmed         the bundle has a price and every part has an active listing: buying it leaves nothing over
 * waiting           the bundle has a price and at least one part was not looked up on Amazon yet (status
 *                   waiting or unmatched); this comes before inactive_listing and missing_listing
 * inactive_listing  every part has a listing, but at least one is not for sale right now, or the bundle itself has no price
 * missing_listing   at least one part has no Amazon listing
 * split             what the bundle contains is not known yet (also a resolved split that names no parts)
 */
export type ReportSection = 'confirmed' | 'waiting' | 'inactive_listing' | 'missing_listing' | 'split';

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
  /** When Home Depot's price for the bundle was seen: the bundle record's seenAt, the time of the listing response. */
  seenAt: number;
  status: BundleStatus;
  section: ReportSection;
  parts: PartRow[];
  /** An estimate from fee settings, never the seller's real fees. Null without a resolved split and a price, or while a part is waiting for its lookup. */
  estimate: BundleResult | null;
  /**
   * Parts no priced listing covers, sorted; for a split primary, then its kits' items with no model
   * number, by their page text in page order. With an estimate they are valued at the liquidation
   * rate; waiting parts are listed but not valued.
   */
  uncovered: string[];
  /**
   * Set when the bundle's split, or its None of these, is the owner's answer to its split question
   * (answers.ts, ownerAnswer): a reading chosen, parts entered, or none. Null otherwise.
   */
  answer: OwnerAnswer | null;
  /**
   * The ways to sell the bundle (step 6): each kit inside it whose own Home Depot page lists its
   * items (kitContents) sold whole or split into them. options[0] is the primary, and `section`,
   * `parts`, `estimate` and `uncovered` above are its. One option when no part is such a kit; none
   * while the split is not resolved.
   */
  options: SaleOption[];
  /** Parts the stored catalog marks as kits whose own Home Depot page is not stored, in part order. */
  kitsNotRead: string[];
}

/** One way to sell a bundle: each kit inside it sold whole, or split into the items its page lists. */
export interface SaleOption {
  /** 'whole', or 'split:' and the split kits' models, sorted and joined by '+'. */
  id: string;
  /** "PCL1600K2 sold whole", "PCL1600K2 split into its parts", ... (Ruling 68: on screen a kit holds parts, never items); '' when the bundle holds no such kit. */
  label: string;
  /** The kits split into their items, in part order. */
  splitKits: string[];
  /** The option's model items, one row per model, quantities summed (a kit item that is also another part adds to it). */
  parts: PartRow[];
  /** An estimate from fee settings, never the seller's real fees. Null without a bundle price, or while any of its parts waits or is unmatched. */
  estimate: BundleResult | null;
  /**
   * What the option leaves unsold, as display names with ` ×N` after a quantity above 1: first the
   * models no priced listing covers (looked up, in part order), then the kits' items with no model
   * number, in page order. Empty when it leaves nothing.
   */
  leftovers: string[];
  /** True when a kit is split: its items have no retail box of their own. */
  loose: boolean;
}

/** Which of the owner's answers decides a bundle's split, and the question it answered. */
export interface OwnerAnswer {
  reviewId: string;
  kind: 'chosen' | 'entered' | 'none';
}

export interface ScanReport {
  /** By section: confirmed, waiting, inactive_listing, missing_listing, split; within each, highest estimated profit first. */
  bundles: BundleRow[];
  /** Open review items, oldest first. */
  review: ReviewItem[];
}

/**
 * An index into the review item's `choices` (split) or `candidates` (match), none of them, or
 * (split questions only) the parts the owner typed: 1 to 8 model numbers.
 * `seen` is reviewSignature (answers.ts) of the item as it was shown: an answer to a question a
 * scan has changed since is refused.
 */
export type ReviewAnswer = { choice: number; seen: string } | { none: true; seen: string } | { parts: string[]; seen: string };

/** A paid action the side panel can ask for. */
export type PaidAction =
  | { kind: 'verify'; brand: string; model: string; asin: string }
  | { kind: 'lookUp'; parts: { brand: string; model: string }[] };

export interface Quote {
  /** Searches the action would spend now. */
  searches: number;
  /** One plain sentence when it may not run now; null when it may. */
  refusal: string | null;
  /**
   * Ruling 72: the parts a Look up needs a search for that the per-scan limit leaves out of this
   * press. They stay waiting, and the next quote is for them. Absent when every part fits.
   */
  leftWaiting?: number;
}
