// The scan pipeline's contracts: what it needs from the outside (a search client, a
// budget, a store) and what it keeps (records, the resumable job).
//
// Everything here is plain data and interfaces, so the same pipeline runs in Node
// (tests, the command line) with an in-memory store and in the extension's service
// worker with IndexedDB behind the same ScanStore.

import type { Decomposition, SetContent, SettledPart, SplitEvidence, UnsettledPart } from '../decompose';
import type { PartFact } from '../facts/fact';
import type { EbayValue, EbayVerdict } from '../ebay/types';
import type { PageContent } from '../hdPage';
import type { Grade } from '../match';
import { DEFAULT_FEES, type BundleResult, type FeeSettings } from '../money';
import type { BlockReason } from '../serpapi/budget';
import type { Params, SearchOptions, SearchResult } from '../serpapi/client';
import type { LookupBlock } from '../keepa/route';
import type { LookupWays } from '../deals/lookupCopy';
import type { PipelineStep } from './pipeline';

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
  /**
   * Step 9: parts whose Home Depot price (sold alone) is read at most per scan, in the owner's browser
   * (readPartPrices). Never a search. A value above PART_PRICE_READS_MAX counts as it.
   */
  partPriceReadsPerScan: number;
  /** v2: optional stats depth on Keepa product pulls (plan §3c). */
  keepaTrackingDepth?: 'price_only' | 'price_and_rank' | 'full';
  /** v2: extension may route refresh/identify through Keepa when a key is set. */
  amazonRefreshViaKeepa?: boolean;
}

const HOUR = 60 * 60 * 1000;

/**
 * Step 9: the most parts one call to readPartPrices is asked for, and the most the extension's reader reads in
 * one call (two Home Depot fetches each: the search and the product page). One number for both, so the scan
 * never asks for a part the reader would leave unread.
 */
export const PART_PRICE_READS_MAX = 40;

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
  partPriceReadsPerScan: PART_PRICE_READS_MAX,
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
  /**
   * Step 15: Home Depot lists this bundle as a BOGO pair (tracking/bogoPairs.ts findBogoPairs: the starter's model, its
   * joiner and the free item, at the starter's price to the cent, the starter carrying the promotion). The pair rule's
   * own fields; the split reads it (scan/settle.ts rule 1). Absent on any other bundle.
   */
  bogo?: BundleBogo | null;
  /**
   * Free scan, fix round 3: Home Depot sells this as a set (its Bundle list's CONFIGURABLE_BUNDLE entries): no model number
   * (`model` is ''), and Home Depot's own list of its items. The split is that list (split.ts setSplit), once each item's own
   * page has been read for its brand and model. Absent on any other bundle.
   */
  set?: BundleSet;
}

/** A set's items as Home Depot lists them, each with what its own page said once read. */
export interface BundleSet {
  items: SetItem[];
  /** The listing's promotion.dollarOff and percentageOff (a reference; the saving shown is original − value). */
  dollarOff: number | null;
  percentageOff: number | null;
}

export interface SetItem {
  itemId: string;
  quantity: number;
  /** From the item's own page (the free page read), once read; absent before. */
  brand?: string;
  model?: string;
  title?: string;
  /** Its price sold alone, from that page; null when the page showed none. */
  price?: number | null;
  readAt?: number;
}

/** Step 15: the pair rule's facts a BOGO pair's split is read from. */
export interface BundleBogo {
  promotionId: string;
  starterItemId: string;
  starterModel: string;
  /** After the joiner, as Home Depot writes it ("FVC51K", "921B"). */
  freeModel: string;
}

export interface PageReading extends PageContent {
  /** Clock time of the reading. */
  readAt: number;
}

/**
 * read        the page was read
 * unreadable  the page came back but its data could not be read (a 200 without the page state, or state the parser
 *             could not read); reading goes on, and stops after two in a row
 * refused     Home Depot answered with something other than the page (403, 429, 5xx, a thrown request), or the
 *             doorway tab's own page never showed its state; reading stopped here
 * skipped     not tried, because reading stopped earlier
 * `note`: what came back instead of the page, in at most 80 characters (its title), when it is known.
 */
export type PageOutcome =
  | { itemId: string; kind: 'read'; content: PageContent }
  | { itemId: string; kind: 'skipped' }
  | { itemId: string; kind: 'unreadable'; note?: string }
  /** status: the HTTP status Home Depot answered with; 0 when the request threw; absent when it is not known. */
  | { itemId: string; kind: 'refused'; status?: number; note?: string };

/** Reads bundle pages in the owner's browser. Never a search. */
export type ReadPages = (itemIds: string[]) => Promise<PageOutcome[]>;

/**
 * Step 9: what one lookup of a part's Home Depot price gave.
 * found      Home Depot's search showed the part sold alone, and its page confirmed the brand and model and named a price
 * not_found  Home Depot answered and has no price for the part sold alone: its search showed no product for the model,
 *            the product it showed was not confirmed by its page (a kit whose address ends with the model), or the
 *            confirmed page named no price
 * not_read   the part was never looked up, or Home Depot refused or the page could not be read: it says nothing
 */
export type PartPriceStatus = 'found' | 'not_found' | 'not_read';

/**
 * Step 9: what Home Depot sells one part for on its own, read in the owner's browser: Home Depot's
 * search for the model, then the product's page. One per part asked, in order.
 */
export interface PartPriceReading {
  brand: string;
  model: string;
  status: PartPriceStatus;
  /** Home Depot's item id of the product sold alone; null unless the product was found. */
  itemId: string | null;
  /**
   * The model the product's own page names: the part's, or for RYOBI its one-trailing-B twin (PCL206B for
   * PCL206, Ruling 70). Null unless the page was read and confirmed.
   */
  matchedModel: string | null;
  /** Null unless status is found. */
  price: number | null;
  title: string | null;
  link: string | null;
  /**
   * Nov 25: the barcode the product's own page states (hdPage.ts barcodeOf), a 12-digit UPC-A. Absent when the page was not
   * read, gave none, or is not the part's. Kept on the part price record (PartPriceRecord.upc).
   */
  upc?: string | null;
}

/** Step 9: reads Home Depot's own price for parts sold alone, in the owner's browser. Never a search. */
export type ReadPartPrices = (parts: { brand: string; model: string }[]) => Promise<PartPriceReading[]>;

/**
 * Step 9: a part's Home Depot price (sold alone), in its own store keyed by the part, so the splitter, the
 * known models and the kit pages never read it: a price reading is never a fact about what a bundle holds.
 * Only a found or not_found reading is saved. A not_found keeps an earlier found price with its time
 * (`seenAt`) and moves `checkedAt` only, as an Amazon price record keeps its last seen price.
 */
export interface PartPriceRecord {
  /** partKey(brand, model) of the part asked for. */
  key: string;
  brand: string;
  model: string;
  /** Null when no reading has found the part. */
  itemId: string | null;
  /** The model on the page read (PartPriceReading.matchedModel); null when none was found. */
  matchedModel: string | null;
  price: number | null;
  title: string | null;
  /** Home Depot's address of the product; null when none was found. */
  link: string | null;
  /** When `price` was read; null if never. */
  seenAt: number | null;
  /** When the part was last read, found or not. Freshness is measured from here. */
  checkedAt: number;
  /**
   * Nov 24 (fewer questions, rule C): the part's own Home Depot page (by `itemId`), read free when a bundle's page names a
   * model none of its parts explains and this part's own Includes list may (scan/settle.ts). Absent until read.
   */
  page?: PageReading | null;
  /** Nov 24: how many times Home Depot refused or could not give that page; at PART_PAGE_REFUSALS_MAX the split asks. */
  pageRefusals?: number;
  /**
   * Nov 25: the barcode Home Depot's page of the part sold alone states (12-digit UPC-A), from the reading that found it.
   * Kept while later readings give none. The Amazon lookup asks Keepa by it first (keepa/barcode.ts): a way to find
   * candidates, never proof of a listing.
   */
  upc?: string | null;
}

/**
 * Step 10: one eBay listing a part's eBay value was built from, as the judge and the checks left it. The
 * listing's text is not kept, only what the panel shows and the value needs. No seller or buyer field exists
 * here (no eBay user data).
 */
export interface EbayJudgedListing {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  /** Units this listing has sold (eBay's estimatedSoldQuantity); null when eBay does not say. */
  soldQuantity: number | null;
  /** The listing's page on eBay. */
  url: string;
  /** eBay's sellerItemRevision: an owner's answer holds only while it is the same. */
  revision?: string;
  /** What the judge and the code-side checks made of the listing: the only verdict a model can give. */
  verdict: EbayVerdict;
  /** The judge's reason and each check that lowered its answer, in plain sentences. */
  reasons: string[];
  /** The owner's answer to "Is this eBay listing exactly this part?": it overrides `verdict`. Absent until answered. */
  owner?: 'match' | 'not_match';
  ownerAt?: number;
}

/** A listing's verdict as the value counts it: the owner's answer, else the judge's checked verdict. */
export const effectiveVerdict = (l: Pick<EbayJudgedListing, 'verdict' | 'owner'>): EbayVerdict => l.owner ?? l.verdict;

/**
 * Step 10: what New units of a part sell for on eBay, as a reference (never counted in an estimate), in
 * its own store keyed by the part. `value` is null when no listing is a verified match that has sold:
 * the part then shows no eBay line, never $0.
 */
export interface EbayValueRecord {
  /** partKey(brand, model) of the part asked for. */
  key: string;
  brand: string;
  model: string;
  value: EbayValue | null;
  /** Every listing judged for the part this check, in search order. */
  listings: EbayJudgedListing[];
  /** Listings the check left unjudged (a failed or refused call, or a limit reached). Never a verdict. */
  notJudged: number;
  /** False when listings were left unjudged: the part is asked for again next scan whatever its age. */
  complete: boolean;
  /** When the part was last checked. Freshness is measured from here. */
  checkedAt: number;
}

/**
 * Step 10: the owner's Yes or No to "Is this eBay listing exactly this part?", kept on its own, by part, listing and revision,
 * so no check of the part, however it ends, can lose it: every value is computed with the answers (ebayPass.ts), and the audit
 * file exports them as labels. Self-contained: the listing's title and page and what the judge said are kept with it.
 */
export interface EbayOwnerAnswer {
  /** ebayAnswerKey(part, itemId, revision) */
  key: string;
  /** partKey of the part. */
  part: string;
  model: string;
  itemId: string;
  /** The listing's sellerItemRevision, empty when eBay gave none: an answer holds only for the revision it was given for. */
  revision: string;
  owner: 'match' | 'not_match';
  ownerAt: number;
  /** What the judge's checked verdict was (unsure, for a question asked). */
  judged: EbayVerdict;
  reasons: string[];
  title: string;
  url: string;
}

export const ebayAnswerKey = (part: string, itemId: string, revision: string | undefined): string => [part, itemId, revision ?? ''].join('|');

/**
 * Step 10: one model answer, kept so a listing is judged once for a part, item revision, prompt and model.
 * It holds the model's raw answer text, never a verdict: verification rules change without a prompt
 * version change, so every read is verified again (core/src/judge/verify.ts).
 */
export interface JudgementRecord {
  /** judgementKey(...) */
  key: string;
  itemId: string;
  revision: string;
  promptVersion: string;
  model: string;
  /** partKey of the part judged for: the answer is about that part's identity and contents. */
  part: string;
  /** The model's answer text, exactly as received. */
  answer: string;
  usage: { inputTokens: number; outputTokens: number };
  judgedAt: number;
}

/** A short fingerprint of a text (FNV-1a, 32 bits, in hex): enough to tell two part names apart in a key, not a security measure. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The key of a judgement: item, revision (empty when eBay gives none), prompt version, model and part, with everything else the
 * model is shown about the part: its other written form and its name (Home Depot's title, as a hash). A change of any of them is
 * a new question for the model, so a saved answer to the old one is not used.
 */
export const judgementKey = (
  itemId: string, revision: string | undefined, promptVersion: string, model: string, part: string, twin?: string, name?: string,
): string => [itemId, revision ?? '', promptVersion, model, part, twin ?? '', name ? textHash(name) : ''].join('|');

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
   * Q1a fix round 2: 'page' when Verify wrote this result from a listing's detail page (or, since the catalog check,
   * when Amazon's catalog verified the listing: scan/catalogCheck.ts). A scan never
   * judges such a result again from search rows, which carry no part number or packaging. Absent
   * otherwise, and on records saved before it existed.
   */
  source?: 'page';
  /**
   * The ASIN of a same-brand search row whose title omitted the model, still to be read (one product
   * page) because every row that named the model was an accessory. Cleared once that page is read.
   * Absent when none is owed.
   */
  pageDue?: string;
  /**
   * Q1a fix round 2: listings a detail page showed are not this part (Verify sent them to review).
   * Matching from saved listings never chooses one of them for the part or its twin. Absent when none.
   */
  rejectedAsins?: string[];
  /**
   * Catalog check (scan/catalogCheck.ts): what verified this match's listing. 'keepa_catalog' or 'serpapi_product' when
   * Amazon's structured fields confirmed it (keepa/verify.ts). Absent otherwise; a report derives 'owner' and 'title'.
   */
  verifiedBy?: VerifiedBy;
  /**
   * The evidence in one plain sentence with the listing's link: what confirmed it ("Amazon's catalog lists brand
   * DEWALT, part number DCF921B: https://www.amazon.com/dp/B09M3TL9BB"), or why the catalog removed the listing.
   */
  verifyEvidence?: string;
  /** Listings Amazon's catalog was read for, for this part, each once: none is pulled twice. Absent when none. */
  catalogChecks?: CatalogCheckRecord[];
  /**
   * Nov 25: the last lookup that asked Keepa by the part's barcode (scan/barcodeLookup.ts): each product the code returned,
   * whether its catalog barcodes hold Home Depot's, and what the matcher and the ladder made of it. A record for measuring
   * "same barcode" later, never what decided the match. Absent when the part was never asked by barcode.
   */
  barcodeLookup?: BarcodeLookupRecord;
}

/** Nov 25: one product a barcode lookup returned, as recorded for measurement (scan/barcodeLookup.ts). */
export interface BarcodeProductRecord {
  asin: string;
  /** Its own catalog barcodes (upcList, eanList, gtinList) hold the part's barcode. */
  sameBarcode: boolean;
  /** The matcher's grade of it as a search row (match.ts grade), and the ladder's rungs 0 and 1 on its fields (checkListingFields). */
  grade: 'exact' | 'strong' | 'probable' | 'review' | 'reject';
  check: 'confirmed' | 'contradicted' | 'unknown';
  /** The part's match ended on this listing, confirmed by the ladder (CONFIRMING_SOURCES). */
  confirmed: boolean;
  /** "same barcode as Home Depot's page; not confirmed because ...", or what confirmed it. */
  note: string;
}

/** Nov 25: what one lookup by barcode found and cost (MatchRecord.barcodeLookup). */
export interface BarcodeLookupRecord {
  /** Home Depot's barcode for the part, a 12-digit UPC-A. */
  code: string;
  at: number;
  /** 'code': the code's products were the candidates; 'search': the term search ran after it. */
  via: 'code' | 'search';
  /** Tokens Keepa counted, as its answers said (0 from the cache). */
  codeTokens: number;
  searchTokens: number;
  /** The listing ladder's version that judged the products (catalogCheck.ts LADDER_VERSION). */
  ladder: number;
  products: BarcodeProductRecord[];
}

/** How a match's listing was verified: Amazon's catalog by Keepa, a SerpApi product page, the owner, or only its title. */
/**
 * The listing ladder (Nov 23) adds 'listing_fields' (rung 1: the pulled fields' own evidence, keepa/listingFields.ts) and
 * 'ai_checked' (rung 3: the AI listing judge, every quote checked; shown, never a buy's confirmation by itself).
 */
export type VerifiedBy = 'keepa_catalog' | 'serpapi_product' | 'listing_fields' | 'ai_checked' | 'owner' | 'title';

/** One catalog check of one listing for one part (keepa/verify.ts checkIdentity), when it was read. */
export interface CatalogCheckRecord {
  asin: string;
  status: 'confirmed' | 'contradicted' | 'unknown';
  reason: string;
  at: number;
  /**
   * The listing ladder's version that read it (catalogCheck.ts LADDER_VERSION). An unknown from before rung 1 (absent) is
   * read again once, from the cached pull when there is one, so rung 1 runs over every listing already checked.
   */
  ladder?: number;
}

/**
 * Who withdrew a listing from a part (scan/recheck.ts): the price guard, the ladder's title rule (a stored confirmation
 * read again whose title names another model of the family), the audit's certain findings (a title that names another
 * model and not the part's; one listing counted for two different models), or the owner's "Wrong listing".
 */
export type WithdrawnBy = 'price_guard' | 'title_rule' | 'audit_title' | 'audit_two_models' | 'owner';

/** One listing withdrawn from a part: the app never chooses it for the part again (the owner may). */
export interface WithdrawnListing {
  asin: string;
  /** The plain reason ("Amazon's price is 9.7× Home Depot's price for this part: check the listing"). */
  reason: string;
  by: WithdrawnBy;
  at: number;
}

/** One stored candidate the re-check tried for the part, and why it was or was not taken. */
export interface RecheckTry {
  asin: string;
  /** passed: the ladder confirmed it and the price guard and the audit passed it; else why not, in one plain phrase. */
  passed: boolean;
  reason: string;
  at: number;
  /** For a candidate that passed: which rung confirmed it (MatchRecord.verifiedBy when it is chosen). */
  by?: VerifiedBy;
}

/**
 * The re-check of a part whose listing was withdrawn (scan/recheck.ts, docs/decisions.md "The app replaces a wrong
 * listing itself"): its other stored candidates tried in order through the ladder, then the lookup queue, then the owner.
 * Kept beside the match (ScanStore.putRecheck), not on it, so a lookup that rewrites the match does not lose it.
 *
 *   trying   candidates are left to try, or a try waits for Keepa tokens: the part is "being re-checked", not a question
 *   lookup   no stored candidate passed: the part waits in the lookup queue (match status 'waiting') for a fresh search
 *   asked    the owner's "Which listing" question is open, saying what was tried
 *   done     the part has a listing again: exactly one candidate passed and the part is matched to it, or the fresh
 *            lookup chose one (which the ladder then reads as any other)
 */
export interface RecheckRecord {
  /** partKey(brand, model) */
  key: string;
  brand: string;
  model: string;
  stage: 'trying' | 'lookup' | 'asked' | 'done';
  /** Every listing withdrawn from the part, oldest first; never chosen for it again by the app. */
  withdrawn: WithdrawnListing[];
  /** The candidates of this round still to try, in order. */
  pending: string[];
  /** The candidates of this round tried so far, in order. */
  tried: RecheckTry[];
  /** The listings a question offers if it comes to asking, with their titles: the withdrawn one first. */
  offered: ReviewCandidate[];
  startedAt: number;
  updatedAt: number;
  /** While trying: what the next try waits for ("Keepa tokens"), absent when nothing waits. */
  waitingFor?: string;
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
  /**
   * Step 9: the list price the last row showed (`extracted_old_price`, Amazon's struck-through price),
   * as of checkedAt. Absent when that row showed none. A reference figure, never counted in an estimate.
   */
  listPrice?: number;
  /**
   * Step 9: the "Buy New" box on the listing's own page (`purchase_options.buy_new`, or a one-seller page's
   * `single_offer`), read by Verify.
   * Null when the last page read showed none; absent when no page was read. Kept when a search row
   * rewrites the listing.
   */
  buyBox?: BuyBox | null;
}

/**
 * Step 9: a listing page's "Buy New" box: its price, who sells it and who ships it. A page with one seller
 * shows `purchase_options.single_offer` instead: read only when it names a price and a seller ("Shipper /
 * Seller", so soldBy and shipsFrom are both that seller), and marked `singleOffer`.
 */
export interface BuyBox {
  price: number;
  soldBy: string | null;
  shipsFrom: string | null;
  /** True when the page's only offer was read (single_offer), not a Buy New box. Absent otherwise. */
  singleOffer?: true;
  /** When SerpApi answered with the page. */
  seenAt: number;
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
  /**
   * Step 16 (round 2), split questions: when Home Depot read every part of the reading and confirmed only some, the ones it
   * confirmed (with its page) and the ones it did not (with why). The question is about the unsettled ones. Absent otherwise.
   */
  settledParts?: SettledPart[];
  unsettledParts?: UnsettledPart[];
  /**
   * A match question the re-check opened (scan/recheck.ts) after no candidate passed: each listing it tried and why it was
   * not taken, so the owner starts where the app stopped. Absent on every other question.
   */
  tried?: RecheckTry[];
}

// ---------------------------------------------------------------- the job

export type ScanStep =
  | { kind: 'catalog'; brand: string; page: number }
  | { kind: 'listing'; q: string; page: number; filterTokens: string | null; bundlesOnly: boolean }
  /**
   * Step 15: `via` is what the plan pays the lookup with (keepa/route.ts). Absent on a plan without Keepa (SerpApi) and on
   * a job saved before step 15 (Keepa when a Keepa lookup is set, as before).
   */
  | { kind: 'lookup'; brand: string; model: string; via?: 'keepa' | 'serpapi' }
  | { kind: 'refresh'; brand: string; model: string; asin: string }
  /**
   * A product page owed (pageDue). `check: 'catalog'`: a catalog check of a title match or a match question's listing
   * (scan/catalogCheck.ts), pulled only on Keepa (1 token), after the lookups and before the refreshes.
   */
  | { kind: 'identify'; brand: string; model: string; asin: string; check?: 'catalog' };

/**
 * A budget limit, SerpApi's own 429, Keepa with no tokens, a failed request, or the user pressing Stop. Step 15:
 * `keepa_tokens`: the scan ended with Amazon lookups waiting for Keepa tokens to refill (every other budget used too).
 */
export type StopReason = BlockReason | 'keepa_tokens' | 'no_tokens' | 'rate_limited' | 'error' | 'user';

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
  /**
   * Step 9: parts whose Home Depot price (sold alone) was read and saved, found or not found. Never a search.
   * Absent on a job saved before step 9; it reads as 0.
   */
  partPricesRead?: number;
  /**
   * Step 10: eBay searches and item reads this scan made (free, from the owner's own eBay keys), listings a
   * model was asked about (not those answered from a saved judgement), and the tokens those calls used.
   * Absent on a job saved before step 10; they read as 0.
   */
  ebaySearches?: number;
  ebayItemReads?: number;
  listingsJudged?: number;
  judgeTokensIn?: number;
  judgeTokensOut?: number;
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
  /**
   * Free scan (Nov 23): the bundle lists were read in the owner's Chrome (scan/listingSource.ts), not searched on SerpApi:
   * the list pages read, the bundles they listed, the item pages read for prices, and whether every list was read to its
   * end. `done` once the pass has run, so a continued job does not read the lists again. Absent: SerpApi's listing pages.
   */
  /** Fix round 3: set items whose own Home Depot page this job read. Absent when none. */
  setItemsRead?: number;
  chromeListing?: {
    done: boolean; pages: number; bundles: number; itemPagesRead: number; complete: boolean;
    /** Fix round: each list read (a brand with the query, and without it), so a run shows which lists more. */
    lists?: {
      brand: string; query: string | null; pages: number; listed: number; added: number; complete: boolean; empty: boolean;
      /** Fix round 3: which kind of list, and whether a page limit cut it. */
      source?: 'bundle' | 'search'; cut?: boolean;
      /** Fix round 2: the list's own totalProducts, the final address it was paged on, and what an empty state held. */
      total?: number | null; pagedOn?: string; sample?: import('../hdPage').ListingSample;
      /** Home Depot's pace: not read now, read through at this time (within a day); or left part-way for the next scan. */
      readAt?: number; waits?: boolean;
    }[];
    /** Items whose price came with the listing entry. */
    pricedByList?: number;
    /** Every list came back empty (LIST_EMPTY); the bundles found before are kept. */
    empty?: boolean;
    /** The empty lists were searched on SerpApi instead, as the owner allowed. */
    serpFallback?: boolean;
    /** Home Depot's pace: lists not read now because they were read through in the last day (HD_LIST_REREAD_MS). */
    readToday?: number;
  };
  /**
   * Step 10: one plain sentence when the eBay step was skipped or stopped early (keys missing, eBay or the
   * model refused or limited a call). Not a failure of the scan: Home Depot and Amazon results are unaffected.
   */
  ebayNotice?: string | null;
  /**
   * Step 11: what the scan is doing, one entry per stage in run order (pipeline.ts): its state, its units done and
   * to do, when it started and ended, and why a stage was skipped. Set by the runner and saved with the job, so it
   * survives a worker eviction. Absent on a job saved before step 11; pipelineOf derives one for the panel.
   */
  pipeline?: PipelineStep[];
  /** Searches that counted against the quota (responses that came from the network). */
  searchesUsed: number;
  /** Keepa tokens spent on refresh/identify when amazonRefreshViaKeepa is on. */
  keepaTokensUsed?: number;
  /** Planned discovery vs tracking token slices at parts planning (when Keepa scale is on). */
  keepaPlan?: { discoveryTokens: number; trackingTokens: number; lookups: number; refreshes: number };
  /**
   * Step 15: Amazon lookups this job answered, by what paid for them (a cached answer counts where it was sent), the
   * lookups it left waiting (in `deferred`), and why they wait. Absent on a job saved before step 15.
   */
  lookupsVia?: { keepa: number; serpapi: number };
  /**
   * Nov 25: the Keepa lookups of this job by what found their candidates: Home Depot's barcode (the code request alone) or
   * the term search (with or without a code request before it), and the tokens Keepa counted for each kind of request.
   * `codeMisses`: code requests that left nothing the matcher keeps, so the search ran after them. Absent when none.
   */
  lookupsBy?: LookupWays;
  lookupsWaiting?: number;
  lookupsBlockedBy?: LookupBlock | null;
  /**
   * Catalog check (scan/catalogCheck.ts): listings Amazon's catalog verified for a part in this job, and listings it
   * showed are not the part's and were removed, each ASIN once. Absent when none was checked.
   */
  matchesVerified?: number;
  matchesRemoved?: number;
  /** Part refreshes where Amazon price fell vs the previous Keepa trend cache. */
  partPriceDrops?: { partModel: string; delta: number }[];
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

  /** Step 9: Home Depot's prices of parts sold alone, by partKey. Never read by the splitter. */
  getPartPrice(key: string): Promise<PartPriceRecord | undefined>;
  putPartPrice(record: PartPriceRecord): Promise<void>;
  listPartPrices(): Promise<PartPriceRecord[]>;

  /** A New sell price the owner confirmed, with a link to the listing. By partKey. Never read by the splitter. */
  getConfirmedPrice(key: string): Promise<ConfirmedPrice | undefined>;
  putConfirmedPrice(record: ConfirmedPrice): Promise<void>;
  deleteConfirmedPrice(key: string): Promise<void>;
  listConfirmedPrices(): Promise<ConfirmedPrice[]>;

  /** Step 10: eBay reference values, by partKey. Never read by the splitter, and never counted in an estimate. */
  getEbayValue(key: string): Promise<EbayValueRecord | undefined>;
  putEbayValue(record: EbayValueRecord): Promise<void>;
  listEbayValues(): Promise<EbayValueRecord[]>;

  /** Step 10: the owner's answers about eBay listings, by ebayAnswerKey. Listed by key. */
  putEbayAnswer(record: EbayOwnerAnswer): Promise<void>;
  listEbayAnswers(): Promise<EbayOwnerAnswer[]>;

  /** Step 10: saved model answers, by judgementKey. */
  getJudgement(key: string): Promise<JudgementRecord | undefined>;
  putJudgement(record: JudgementRecord): Promise<void>;

  getScan(id: string): Promise<ScanJob | undefined>;
  putScan(job: ScanJob): Promise<void>;
  listScans(): Promise<ScanJob[]>;

  /**
   * Answer once (Nov 23): what the owner settled about a model, by partKey (core/src/facts/fact.ts). Optional: a store without
   * them (the extension's) applies no facts, as before.
   */
  getPartFact?(key: string): Promise<PartFact | undefined>;
  putPartFact?(record: PartFact): Promise<void>;
  deletePartFact?(key: string): Promise<void>;
  listPartFacts?(): Promise<PartFact[]>;

  /**
   * A part's re-check after its listing was withdrawn (scan/recheck.ts), by partKey. Optional: a store without them (the
   * extension's) withdraws nothing by itself and asks at once, as before.
   */
  getRecheck?(key: string): Promise<RecheckRecord | undefined>;
  putRecheck?(record: RecheckRecord): Promise<void>;
  listRechecks?(): Promise<RecheckRecord[]>;

  /** Drops every record. The next write starts from empty. */
  clearAll(): Promise<void>;
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
  /** Step 9: every price known for the part, each labelled, highest first (report.ts priceOptions). */
  prices: PriceOption[];
  /**
   * 'bulk' when the chosen listing's saved title says bulk or non-retail packaging, or repackaged
   * (match.ts isBulkPackaging): still New, so its price counts; the panel says "Amazon · New · bulk packaging" on its price.
   * Absent for a retail-boxed listing, and when the listing is not saved (no title to read).
   */
  packaging?: 'bulk';
  /**
   * Catalog check: what verified the chosen listing. 'keepa_catalog' or 'serpapi_product' from Amazon's structured fields
   * (MatchRecord.verifiedBy), 'owner' when the owner chose it, 'title' for a title match. Absent otherwise.
   */
  verifiedBy?: VerifiedBy;
  /** The evidence of verifiedBy, or why Amazon's catalog removed a listing, with the listing's link (MatchRecord.verifyEvidence). */
  /** The listing ladder, round 2: why no automatic rung could confirm this part's counted listing (agent/autoConfirm.ts). */
  confirmNote?: string;
  verifyEvidence?: string;
  /**
   * The part's listing was withdrawn and the app is replacing it by itself (scan/recheck.ts): "being re-checked" while it
   * tries the part's other stored candidates or waits for a fresh lookup; the sentence says what was tried. Absent otherwise
   * (also once the owner's question is open: the question says it).
   */
  recheck?: { stage: 'trying' | 'lookup'; sentence: string };
  /**
   * Suggested prices (Nov 23): at most one price the agent prepares for a part with no counted price, with its evidence,
   * for the owner to confirm in one click (scan/suggest.ts). Never counted until he confirms it (the PO, Nov 20: his
   * approval is the answer). Absent when the part has a counted price, is in Review or not looked up, or no rule gives one.
   */
  priceSuggestion?: PriceSuggestion;
  /**
   * Answer once (Nov 23): what the owner settled about this model, applied in every bundle that holds it (core/src/facts).
   * Absent when he settled nothing about it.
   */
  fact?: PartFactView;
  /**
   * Signals round 2: the fees the estimate used for one unit of this part, each with where it came from: Keepa's figure for
   * the part's listing (fees.fulfillmentSource / referralSource 'keepa' and a stored figure) or the flat setting. Absent
   * while the part has no counted price.
   */
  fees?: PartFees;
}

/** Signals round 2: one part's fees in the estimate (report.ts feesOf). Estimates, never the seller's real fees. */
export interface PartFees {
  fulfillment: number;
  /**
   * keepa  Amazon's FBA fee Keepa stored for the part's listing
   * flat   the owner's flat fee (his choice 'flat', or with 'keepa' a fallback above $0: see `fulfillmentWhy`)
   * none   signals round 3: no fulfillment fee counted ($0): the estimate is "before fulfillment" for this part
   */
  fulfillmentFrom: 'keepa' | 'flat' | 'none';
  /**
   * With fees.fulfillmentSource 'keepa' and no Keepa fee: why. not_pulled: Keepa was not asked about the listing yet (the
   * drip asks); no_keepa_fee: Keepa was asked and has no FBA fee for it; no_listing: priced by a confirmed price, no listing.
   */
  fulfillmentWhy?: 'not_pulled' | 'no_keepa_fee' | 'no_listing';
  /** A fraction (0.15). */
  referralRate: number;
  referralFrom: 'keepa' | 'flat';
}

/**
 * Step 9: where a part's price comes from. amazon_new, a current amazon_buybox, and a confirmed price count.
 * amazon_new     the matched New listing's featured price, while the listing is active (the estimate's price)
 * amazon_buybox  the matched listing's "Buy New" box, or its only offer (singleOffer), from its page (Verify);
 *                counted only while no older than the featured price, else shown for reference
 * confirmed      a New price the owner entered, with a link to the listing. Counted while no Amazon New price is;
 *                once one is, shown for reference
 * amazon_list    the matched listing's list price (struck through): reference only
 * homedepot      Home Depot's own price for the part sold alone: reference only
 * ebay_sold_new  step 10: what New units of the part sell for on eBay (listings a model checked, with units sold): reference only
 */
export type PriceKind = 'amazon_new' | 'amazon_buybox' | 'confirmed' | 'amazon_list' | 'homedepot' | 'ebay_sold_new';

/**
 * Suggested prices (Nov 23): a price the agent prepares for a part with no counted price, never counted until the owner
 * confirms it. amazon_average: its Amazon listing is not for sale now, and Keepa's recent average New price (90 days, else
 * 30) is the figure. ebay_median: it has no Amazon listing, and the middle of at least 3 stored eBay listings (New, Buy It
 * Now) the judge or the owner marked the same product is the figure. Home Depot's own price for the part sold alone is his
 * cost side, never a suggestion: it may be a context line in `evidence`.
 */
export interface PriceSuggestion {
  price: number;
  kind: 'amazon_average' | 'ebay_median';
  /** "Amazon listing not for sale now; its 90-day average was $X (Keepa)", "6 eBay listings, $58–$74, middle $66". */
  label: string;
  /** What the figure rests on, each with its link when it has one. */
  evidence: { text: string; url?: string }[];
  /**
   * fba: the part has an Amazon listing to sell on (its FBA fee can be read); none: no listing, so a confirmed price takes
   * the fee settings' rule for a price with no listing (report.ts feesOf 'confirmed').
   */
  fulfillment?: 'fba' | 'none';
}

/** A suggested price the owner confirmed: what it was and what it rested on, kept with the price. */
export interface ConfirmedSource {
  kind: PriceSuggestion['kind'];
  label: string;
  evidence: { text: string; url?: string }[];
}

/**
 * Answer once (Nov 23): what the owner settled about one model, as a part row shows it. `from`: when he said it, and the
 * question he said it in when there was one. `stale`: newer evidence contradicts it (Home Depot or Amazon now sells it on its
 * own), in one sentence: the fact is then not applied until he keeps or changes it.
 */
export interface PartFactView {
  /** In the owner's words: "In the box, not sold separately", "Sold whole", "Sold as PCL406B and PCL424B", "A part of these bundles". */
  text: string;
  /** Which of the fact's answers the row shows (facts/fact.ts FactField): "Change" forgets that one. */
  field: 'isPart' | 'sellAs' | 'notSoldSeparately';
  at: number;
  questionId?: string;
  stale?: string;
  /** True when the fact keeps the part out of the count: in the box, not sold separately, with no counted price and nothing newer. */
  notCounted?: true;
}

/** A New sell price the owner confirmed for one part, and the listing that shows it. */
export interface ConfirmedPrice {
  /** partKey(brand, model). */
  key: string;
  brand: string;
  model: string;
  /** Dollars, above zero, to the cent. */
  price: number;
  /** http or https link to the listing. The proof. */
  link: string;
  confirmedAt: number;
  /** A line the owner added ("seen at the Milwaukee store"). Never read as data; shown with the price. */
  note?: string;
  /** Present when he confirmed one of the agent's suggested prices (scan/suggest.ts): what it was and what it rested on. */
  source?: ConfirmedSource;
}

/** Step 9: one labelled price for a part. */
export interface PriceOption {
  kind: PriceKind;
  price: number;
  /**
   * Only New prices are shown or counted (the PO, Nov 18: "no used or refurbished listings"). Renewed and
   * the mixed used-and-new offers were dropped before they were built; a later condition is added here
   * with its producer.
   */
  condition: 'new';
  /** Who sells it, when known: the Buy Box's seller, or "Home Depot". */
  seller: string | null;
  shipsFrom: string | null;
  /** How many offers the figure stands for; null for every kind produced today. */
  offers: number | null;
  asin: string | null;
  link: string | null;
  /** When the figure was seen: the response's time, or the reading's clock time. */
  seenAt: number;
  /**
   * True for a figure shown for reference only (amazon_list, homedepot, and a Buy Box older than the featured
   * price): never counted in an estimate or a range.
   */
  reference: boolean;
  /**
   * homedepot only: the model Home Depot sells alone, when it is not the part's own but its RYOBI twin (the
   * page read for PCL206 is PCL206B's): "Home Depot · sold alone as PCL206B · reference". Absent for an exact match.
   */
  soldAs?: string;
  /** amazon_buybox only: the page's only offer (single_offer), not a Buy New box. Absent otherwise. */
  singleOffer?: true;
  /** ebay_sold_new only: the value the figure is the median of (listings, units sold, range, up to 3 links). */
  ebay?: EbayValue;
  /** confirmed only: the owner's note on the price, when he wrote one. */
  note?: string;
  /** confirmed only: the suggestion he confirmed, when the price was one (ConfirmedPrice.source). */
  source?: ConfirmedSource;
}

/**
 * Step 9: a way to sell's estimate at each end of its parts' counting prices (estimates from fee
 * settings, like `estimate`). lowest: each part at its lowest counting price, $0 where it has none.
 * amazonNew: exactly `estimate`. highest: each part at its highest counting price, a part with none at
 * the liquidation rate as in `estimate`. All null when `estimate` is.
 */
export interface PriceRange {
  lowest: BundleResult | null;
  amazonNew: BundleResult | null;
  highest: BundleResult | null;
}

/**
 * Why a model part has no counted price (Nov 23, the third real scan):
 * waiting     not looked up on Amazon yet (the next scan or the drip looks it up)
 * review      its Amazon match waits for the owner's answer in Review
 * no_listing  looked up, and no Amazon listing was found (the owner can confirm a price)
 * inactive    its Amazon listing is not for sale now (the owner can confirm a price until it is)
 */
export type UnpricedState = 'waiting' | 'review' | 'no_listing' | 'inactive';

/** A model part with no counted price, and why. */
export interface UnpricedPart {
  model: string;
  qty: number;
  state: UnpricedState;
}

/**
 * Nov 23, the third real scan: what an option says when some model part has no counted price, in place of an estimate.
 * A part with no price is never counted at $0 (that showed a $299 bundle "losing" $299). Figures are estimates from the
 * fee settings (rule 5), never the seller's real fees.
 */
export interface IncompleteEstimate {
  /** Model parts (one per model) with a counted price. */
  priced: number;
  /** Model parts (one per model) the option sells. Items with no model number are not counted here. */
  total: number;
  /** What the bundle costs with tax and inbound (bundleProfit's cost). */
  cost: number;
  /** What the priced parts bring after fees, with any item with no model number the owner priced. */
  pricedNet: number;
  /** What the unpriced parts together must bring after fees for the bundle to pay for itself: cost - pricedNet, at least 0. */
  breakEvenNet: number;
  /**
   * With one unpriced model (any quantity) and breakEvenNet above 0: the Amazon price per unit that nets
   * breakEvenNet / qty after fees (money.ts priceForNet). Null otherwise.
   */
  breakEvenPrice: number | null;
  /** The model parts with no counted price, in part order. */
  unpriced: UnpricedPart[];
  /**
   * Suggested prices (Nov 23): what the option would make if the owner accepted every unpriced part's suggestion, from the
   * fee settings (rule 5). A second line, never the headline and never a buy. Present only when every unpriced part has one.
   */
  ifAccepted?: { profit: number; roi: number; suggested: number };
}

/**
 * complete      split resolved and every part has a priced listing
 * partial       split resolved, at least one part has no priced listing (Nov 23: then there is no estimate, only an incomplete one)
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
 * other_brands      Nov 24: a Home Depot set whose items Home Depot lists, one or more of a brand the app does not price:
 *                   not estimated (BundleRow.otherBrands), never a question
 */
export type ReportSection = 'confirmed' | 'waiting' | 'inactive_listing' | 'missing_listing' | 'split' | 'other_brands';

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
  /** Fix round 3: a Home Depot set (no model number): how many items Home Depot lists in it ("Set · 5 items"). Absent otherwise. */
  setItems?: number;
  /**
   * An estimate from fee settings, never the seller's real fees. Null without a resolved split and a price, or (Nov 23)
   * while any model part has no counted price: waiting for its lookup, in Review, no listing, or an inactive listing.
   */
  estimate: BundleResult | null;
  /**
   * Parts no priced listing covers, sorted; for a split primary, then its kits' items with no model
   * number, by their page text in page order. With an estimate (Nov 23) only items with no model number can be here:
   * they are not counted (the liquidation rate, default $0), and the owner can confirm a price for each.
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
  /**
   * Unread kits the owner can read now, in the same order: the Home Depot item id a scan would read
   * for that kit. A kit in `kitsNotRead` with no entry here has no item id yet. Absent on a row
   * built before this field.
   */
  kitReads?: { model: string; itemId: string }[];
  /**
   * Nov 23: the split is not resolved, the bundle's own Home Depot page is not read, and no split question is open or
   * answered for it: it waits for its page (match state `waiting_page`), not for the owner. Absent otherwise.
   */
  waitingPage?: boolean;
  /**
   * Step 15: the split is not resolved, the bundle's page is read, its one reading waits for Home Depot's part pages
   * (Decomposition.waitingFor: the free part-price read, a kit's own page), and no split question is open or answered for
   * it: it waits for them (match state `waiting_parts`), not for the owner. Absent otherwise.
   */
  waitingParts?: boolean;
  /**
   * Nov 24 (fewer questions): the parts the split waits for (Decomposition.waitingFor) while `waitingParts`, named on the
   * row's line ("Waiting for Home Depot's pages of PSBCK102K2 and A98401"). Absent otherwise.
   */
  waitingFor?: string[];
  /**
   * Nov 24 (rule E): a set holding an item of a brand the app does not price (section `other_brands`): every item Home
   * Depot lists, with its own brand, model and page. Not estimated; never a question. Absent otherwise.
   */
  otherBrands?: SetContent[];
  /** Step 15: what settled the split when a settle rule did (scan/settle.ts), each with its link. Absent otherwise. */
  splitEvidence?: SplitEvidence[];
  /** Step 9: the primary option's range; all null while the split is not resolved. */
  range: PriceRange;
  /**
   * Nov 23: the primary option's incomplete estimate, when the bundle has a price and a resolved split but some model
   * part has no counted price (`estimate` is then null). Absent otherwise.
   */
  incomplete?: IncompleteEstimate;
}

/**
 * A kit item the page names without a model number. The owner can confirm a price for it.
 * Nothing invents a model, and the item is never looked up.
 */
export interface UnnamedItem {
  /** '~' and the page's text. The stored price key is this, in upper case. */
  model: string;
  /** The page's text, without the '~'. */
  name: string;
  qty: number;
  /** The owner's confirmed price, when one is stored. */
  price: number | null;
  link: string | null;
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
  /** An estimate from fee settings, never the seller's real fees. Null without a bundle price, or (Nov 23) while any model part has no counted price. */
  estimate: BundleResult | null;
  /**
   * What the option leaves unsold, as display names with ` ×N` after a quantity above 1: first the
   * models no priced listing covers (looked up, in part order), then the kits' items with no model
   * number, in page order. Empty when it leaves nothing.
   */
  leftovers: string[];
  /**
   * Kit items with no model number, in page order, priced or not. A confirmed price counts in
   * this option's estimate. Absent on an option built before this field.
   */
  unnamed?: UnnamedItem[];
  /** True when a kit is split: its items have no retail box of their own. */
  loose: boolean;
  /** Step 9: the estimate at each end of the parts' counting prices; `range.amazonNew` is `estimate`. */
  range: PriceRange;
  /** Nov 23: with a bundle price, while some model part has no counted price (`estimate` is null). Absent otherwise. */
  incomplete?: IncompleteEstimate;
  /** Nov 23: how many parts each split kit's own page lists (models and items with no model number). Absent when none is split. */
  kitParts?: Record<string, number>;
}

/** Which of the owner's answers decides a bundle's split, and the question it answered. */
export interface OwnerAnswer {
  reviewId: string;
  kind: 'chosen' | 'entered' | 'none';
}

/**
 * Step 10: "Is this eBay listing exactly <MODEL>, New, with the same contents?", asked for a listing the judge
 * left unsure that could count (a USD price, units sold). Its own list, not a ReviewItem: the answer is a
 * listing's verdict (answerEbay), not a split or a match.
 */
export interface EbayQuestion {
  /** `${key}|${itemId}`: one open question per part and listing. */
  id: string;
  /** partKey of the part. */
  key: string;
  brand: string;
  model: string;
  itemId: string;
  title: string;
  /** The listing's page; may be empty. */
  url: string;
  price: number | null;
  soldQuantity: number | null;
  /** The judge's reason and every check that lowered its answer. */
  reasons: string[];
  /** When the part's eBay value was checked: questions go oldest first. */
  openedAt: number;
}

export interface ScanReport {
  /** By section: confirmed, waiting, inactive_listing, missing_listing, split; within each, highest estimated profit first. */
  bundles: BundleRow[];
  /** Open review items, oldest first. */
  review: ReviewItem[];
  /** Step 10: open eBay listing questions, oldest first. Absent in a report built before step 10 (it reads as none). */
  ebayQuestions?: EbayQuestion[];
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
  /** Keepa tokens when verify/identify use Keepa instead of SerpApi. */
  keepaTokens?: number;
  /** One plain sentence when it may not run now; null when it may. */
  refusal: string | null;
  /**
   * Ruling 72: the parts a Look up needs a search for that the per-scan limit leaves out of this
   * press. They stay waiting, and the next quote is for them. Absent when every part fits.
   */
  leftWaiting?: number;
}
