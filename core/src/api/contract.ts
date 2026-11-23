// The agent's HTTP contract (step 13, Decision 3): one set of types for the agent, the desktop UI and
// the extension. Pure TypeScript; nothing here touches the network or chrome.*.
//
// Every /api request carries `Authorization: Bearer <token>` (see docs/decisions.md, step 13), except
// the two pairing calls an unpaired extension makes (POST /api/pair/request, POST /api/pair/claim).
// The app's token is in <app-data>/agent-token (UI_TOKEN_FILE); the shell injects it into the webview
// as window.__SPLIT_FINDER_TOKEN__. A paired extension gets its own token from POST /api/pair/claim.
// A failed request answers with an HTTP status and an ApiErrorBody. No response ever holds a key.

import type { ListingSourceSetting } from '../scan/listingSource';
import type { ListingSample } from '../hdPage';
import type { PipelineAiSettings } from '../ai/factory';
import type { StoredSuggestion } from '../assist/stored';
import type { ReviewBrief } from '../brief/types';
import type { SplitEvidence } from '../decompose';
import type { ReviewFollowUp } from '../research/followUp';
import type { HomeDepotPage, HomeDepotSearch, ToolError } from '../research/types';
import type { DealSortKey } from '../deals/sort';
import type { FeeSettings } from '../money';
import type { Schedule } from '../schedule';
import type { PipelineView } from '../scan/pipeline';
import type { AlertSettings, DiscoveryMode, EbaySettings, TrackingDepth } from '../settings';
import type { BundleRow, EbayQuestion, PageOutcome, PaidAction, PartFactView, PartPriceReading, PriceSuggestion, ReportSection, ReviewItem, UnpricedState } from '../scan/types';
import type { BogoView, FreeItem } from '../tracking/bogo';
import type { BogoChoice, BogoGroup, BogoTag, ListedItem, PromoPageOutcome } from '../tracking/bogoPairs';
import type { FbaEstimate } from '../tracking/fba';
import type { OptionSignals, Signal, SignalKind, SignalNumbers, Velocity } from '../tracking/signals';

export const AGENT_PORT = 8790;
/** The app's bearer token, in the agent's data dir; read by the desktop shell (src-tauri agent.rs TOKEN_FILE). */
export const UI_TOKEN_FILE = 'agent-token';
/** Largest JSON body the agent reads; a longer one is refused with 413. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** How long GET /api/worker/next holds a request open before answering 204. */
export const WORKER_LONG_POLL_MS = 25_000;

// ---------------------------------------------------------------- errors

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'conflict'
  | 'unavailable'
  | 'internal';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

export function isApiError(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null) return false;
  const err = (body as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

// ---------------------------------------------------------------- keys

/** The keys the agent holds. The UI and the extension only ever see whether each is set. */
export type KeyName = 'serpapi' | 'keepa' | 'anthropic' | 'openai' | 'ebay' | 'telegram';
export const KEY_NAMES: readonly KeyName[] = ['serpapi', 'keepa', 'anthropic', 'openai', 'ebay', 'telegram'];

/** Body of PUT /api/keys/:name, per key. Answered by PutKeyResponse; DELETE /api/keys/:name removes it and answers KeysPresence. */
export interface KeyValues {
  serpapi: { key: string };
  keepa: { key: string };
  anthropic: { key: string };
  openai: { key: string };
  ebay: { appId: string; certId: string };
  telegram: { botToken: string; chatId: string };
}

export type KeysPresence = Record<KeyName, boolean>;

/**
 * Nov 23: what a key's own service said when the key was checked (agent/keyChecks.ts). `rejected`: the service answered and
 * did not accept it. `network` and `service`: the service could not be reached or had an outage, so nothing is known about the
 * key; `limit`: the service asked to slow down (the key is probably fine). `unchecked`: nothing to check it against (an
 * OpenAI-compatible key before any pipeline names a service address, or a service with no model list). `problem` is one plain
 * sentence in the service's own words with what to do; never a key. `detail` says what the check found ("118 of 250 searches left").
 */
export type KeyCheck =
  | { ok: true; detail?: string }
  | { ok: false; problem: string; kind: 'rejected' | 'network' | 'service' | 'limit' | 'unchecked' };

/** PUT /api/keys/:name: the key is saved either way; `check` is its service's answer within ten seconds. */
export interface PutKeyResponse {
  saved: true;
  check: KeyCheck;
}

/** POST /api/keys/:name/check: the stored key checked again with its own service. */
export interface CheckKeyResponse {
  check: KeyCheck;
}

/** AgentState.keyChecks: the last time a key got a verdict (works or rejected); `at` is an ISO time. Absent while none is known. */
export interface KeyCheckRecord {
  ok: boolean;
  at: string;
  detail?: string;
}

// ---------------------------------------------------------------- state

/** 'paused' while the owner paused the agent (POST /api/agent/pause); the shell shows it in the tray. */
export type AgentStatus = 'idle' | 'scanning' | 'stopping' | 'paused' | 'error';

export interface LastScanSummary {
  at: string;
  status: string;
  stopMessage: string | null;
  searchesUsed: number;
  keepaTokensUsed: number;
  newDeals: number;
  reviewOpen: number;
  /** Nov 23: bundles whose own Home Depot page is not read (they wait for it, match state `waiting_page`). */
  pagesUnread?: number;
  /**
   * Nov 23, in GET /api/state only: Read again (POST /api/scan/read-pages) can start now: some page is unread, Chrome is
   * connected and nothing else runs.
   */
  canReadPagesAgain?: boolean;
  /**
   * Step 15: the Amazon lookups the last scan left waiting, those it did by what paid for them, and why the rest wait
   * (null when none waits). `keepa_tokens`: Keepa's tokens above its reserve ran out (they refill; the drip carries on).
   */
  waitingLookups?: number;
  lookupsDone?: { keepa: number; serpapi: number };
  lookupsBlockedBy?: 'keepa_tokens' | 'search_cap' | 'reserve' | 'hourly_limit' | null;
  /**
   * Catalog check: listings Amazon's catalog verified in the last scan (title matches made strong, questions withdrawn),
   * each ASIN once. Absent when the scan checked none.
   */
  matchesVerified?: number;
}

/**
 * Step 15, POST /api/lookups/run (UI, the owner's "Look up all"): the parts that wait for an Amazon lookup, looked up
 * now within the same budgets as a scan (Keepa's tokens above its reserve first, then searches within the per-scan cap,
 * the monthly reserve and the hourly limit). `maxSearches` lowers the search cap for this run only; `useReserve` is the
 * owner's yes to spend from the reserve.
 */
export interface LookupsRunRequest {
  maxSearches?: number;
  /**
   * Nov 23: the owner's explicit say-so to spend searches from the reserve ("Use searches for these (up to N of your M
   * left)"). Without it a lookup run keeps the reserve, whoever started it: at or below it, it spends no search.
   */
  useReserve?: boolean;
}

/** `viaKeepa` / `viaSerpapi`: the lookups the run is planned to make on each; `reason` says why it did not start. */
export interface LookupsRunResponse {
  started: boolean;
  reason?: string;
  viaKeepa: number;
  viaSerpapi: number;
}

/** Step 15: the drip, which looks up waiting parts with Keepa between scans as its tokens refill. */
export interface DripState {
  /** A lookup is being made now. */
  active: boolean;
  /** Parts waiting for a lookup. */
  waiting: number;
  /** When the drip looks at Keepa's tokens next (ISO), or null when it is off or nothing waits. */
  nextAt: string | null;
  lastLookupAt: string | null;
  /**
   * Signals round 3: listings waiting for their Keepa fee pull (Amazon's FBA fee, sales, referral, rank: 1 token each,
   * after the lookups and catalog checks), for the parts of bundles with an estimate; absent when none waits.
   */
  feesWaiting?: number;
  /** The listing ladder: counted Amazon listings an automatic rung (the catalog check, rung 2) will read; absent when none. */
  confirmWaiting?: number;
}

/**
 * Nov 23, POST /api/scan/read-pages (UI, no body): the free Chrome steps again (bundle pages, kit pages, part prices,
 * the BOGO listings) for the last scan's bundles, with no SerpApi search for them; then the Amazon lookups only for
 * what is now settled, within what the last scan left of the per-scan limit. `reason`: why it did not start, or, when it
 * started, how many searches it may spend ("... then at most 3 Amazon searches ...").
 */
export interface ReadPagesResponse {
  started: boolean;
  reason?: string;
}

/** GET /api/state, and the payload of the `state` event. */
export interface AgentState {
  agent: {
    status: AgentStatus;
    step?: string;
    progress?: { done: number; total: number };
    nextScanAt: string | null;
    lastScan: LastScanSummary | null;
    /**
     * W4: the running scan's stages as core's pipeline view says them (absent when nothing runs). Step 15: each step is
     * `{ label, state: 'done' | 'now' | 'next' | 'skipped' | 'failed', figure, done?, total? }`, and `estimateText` is '' while the time left
     * is not known (the view then gives counts only).
     */
    pipeline?: PipelineView;
    /** W4: what the agent is busy with: a scan, or the AI pass on Review questions. */
    busy?: 'scan' | 'ask' | null;
    /** Why the agent paused itself at start (saved settings or keys it could not read); gone after Resume. */
    problem?: string;
    /** Step 15: the drip of Keepa lookups between scans; absent before the agent has looked. */
    drip?: DripState;
  };
  /** The paired Chrome extension, the worker that reads Home Depot pages. `jobsWaiting`: reads waiting for it (W4). */
  helper: {
    paired: boolean;
    connected: boolean;
    lastSeenAt: string | null;
    jobsWaiting?: number;
    /**
     * Nov 23: the helper is not the build this app ships (its heartbeat named another version), or it answered a job with
     * "does not know that kind of job". The agent then queues one `reload` job; POST /api/helper/reload queues another.
     */
    outdated?: boolean;
    /** Nov 23: the helper's build as its heartbeat says it ("0.1.0+3c92cc7"); absent before one said it. */
    version?: string;
  };
  budget: {
    serpLeft: number | null;
    /** W4: the plan's searches a month, from the last account check; null before one. */
    serpMonthly?: number | null;
    /** W4: searches one scan may use (Settings). */
    serpPerScan?: number;
    serpReserve: number;
    keepaTokens: number | null;
    /** Step 15: Keepa's refill, tokens a minute, from its free token status (at a scan's start, after each call, and by the drip). */
    keepaRefillPerMin?: number | null;
    aiSpentUsd: number;
    aiCapUsd: number | null;
  };
  /**
   * Step 16: `review` is what needs the owner ("Needs you"): open questions minus those the app is working on (a follow-up queued
   * or running, ReviewQuestion.followUp), which are `reviewWorking`. A question comes back to `review` when its follow-up is done
   * or gave up.
   */
  counts: { review: number; reviewWorking?: number; autopilotApplied: number; newDeals: number; jobsWaiting: number };
  keys: KeysPresence;
  /**
   * Step 15: the last rejection of each key by its service, in plain words ("eBay did not accept the App ID and Cert ID"),
   * cleared when the key is replaced or next accepted. Never the key itself.
   */
  keyProblems?: Partial<Record<KeyName, string>>;
  /** Nov 23: when each saved key last got a verdict from its own service ("Checked 2 min ago · works"). Never a key. */
  keyChecks?: Partial<Record<KeyName, KeyCheckRecord>>;
  /** W4: true until the first scan has finished (the one-time first-run flow). */
  firstRun?: boolean;
  /** D2: when the settings last changed; the shell re-reads GET /api/settings when this moves. */
  settingsAt?: string;
}

// ---------------------------------------------------------------- deals

/** A labelled link to where a figure came from (memory: verify from source). */
export interface SourceLink {
  label: string;
  url: string;
  source: 'homedepot' | 'amazon' | 'ebay' | 'keepa';
}

/** One row of GET /api/deals. Profit and ROI are estimates from fee settings, never real fees. */
export interface DealRow {
  /** The bundle key; GET /api/deals/:id takes it URL-encoded. */
  id: string;
  /**
   * Fix round 3: a Home Depot set has no model number: `model` is "Set <itemId>" (shown and copied as that) and `setItems`
   * how many items Home Depot lists in it ("Set · 5 items"). `setItems` is absent on any other bundle.
   */
  bundle: { brand: string; model: string; title: string; itemId: string | null; link: string | null; setItems?: number };
  section: ReportSection;
  price: number | null;
  regularPrice: number | null;
  /** Percent off Home Depot's regular price. */
  off: number | null;
  /**
   * One line on how far the parts are matched ("2 of 3 parts matched"), or null. Nov 23: the code `waiting_page` when the
   * bundle's own Home Depot page is not read yet (core/src/scan/matchState.ts WAITING_PAGE; shown as "Waiting for its
   * Home Depot page", under Waiting for a lookup, never a question: `needsAnswer` is false).
   */
  matchState: string | null;
  /**
   * Nov 23: `waiting_page` beside matchState for such a bundle; absent otherwise. Step 15: `waiting_parts` when its split
   * waits for Home Depot's part pages (core/src/scan/matchState.ts WAITING_PARTS; shown as "Waiting for Home Depot's part
   * pages", under Waiting for a lookup, never a question: `needsAnswer` is false).
   */
  matchKind?: 'waiting_page' | 'waiting_parts' | null;
  profit: number | null;
  roi: number | null;
  roiRange: { low: number | null; high: number | null };
  needsAnswer: boolean;
  /** When Home Depot's price was seen (ISO), or when the row was stored. */
  updatedAt: string;
  /** W4: searches a Look up of the bundle's unmatched parts would spend now; null when every part is looked up. */
  lookup?: { searches: number } | null;
  /** Tracking: on the watchlist (by itself when confirmed and discounted, or by the owner). */
  watched?: boolean;
  /** Tracking: the last scan said a way to sell is worth buying now (DealSignals.buyNow). */
  buyNow?: boolean;
  /**
   * Buy safety (Nov 23): it would be worth buying now but for `listings` counted Amazon listings nobody confirmed yet
   * (title matches the catalog check has not read). Never announced, never in "Worth buying now". Absent otherwise.
   */
  /** Round 2 of the listing ladder: `blocked` when no automatic rung can confirm them; the owner confirms or replaces them. */
  buyPending?: { listings: number; blocked?: boolean };
  /**
   * Signals round 2: the watched bundle's one-line verdict (DealSignals.verdict), always saying which condition fails
   * ("Not worth buying now: est. profit $6.63 is below your $20.") or why it is worth buying. Absent when not watched or not
   * judged yet. Estimates from the fee settings.
   */
  signalNote?: string;
  /**
   * Signals round 3, no silent mixing: the estimate counts no fulfillment fee for `parts` of its `of` counted parts (Keepa
   * not asked yet, or no FBA fee and a flat fee of $0). Such a row is never worth buying now and sorts after full estimates
   * of the same sign. Absent or null when every counted part has a fee, or with no estimate.
   */
  beforeFulfillment?: { parts: number; of: number } | null;
  /** Tracking: on a BOGO promotion the owner entered; 'choose' until he chooses the free tool. */
  bogo?: 'choose' | 'chosen' | null;
  /**
   * BOGO found by the agent: this bundle is a starter + free tool pair Home Depot lists at the starter's price
   * (core/src/tracking/bogoPairs.ts); null when it is not one.
   */
  bogoPair?: BogoTag | null;
  /**
   * The automatic BOGO group this bundle belongs to (as a pair) or starts (as the starter): "BOGO: 11 free-tool choices —
   * best: PCL265B +$61.50 est.", how many choices, and the best pair's deal id. Null when none.
   */
  bogoChoices?: { label: string; count: number; bestId: string | null; best: boolean } | null;
  /**
   * Nov 23 (the third real scan): set when the bundle has a price and a split but some model part has no counted price.
   * `profit` and `roi` are then null: no headline estimate, never a part counted at $0. What the priced parts bring and
   * the break-even instead, from the fee settings (rule 5). Absent or null otherwise.
   */
  incomplete?: DealIncomplete | null;
}

/**
 * Nov 23: a bundle missing a price (BundleRow.incomplete, from the primary way to sell). Estimates from the fee settings,
 * never the seller's real fees.
 */
export interface DealIncomplete {
  /** Model parts with a counted price, of `total` (one per model; items with no model number are not counted). */
  priced: number;
  total: number;
  /** What the priced parts bring after fees. */
  pricedNet: number;
  /** What the unpriced parts together must bring after fees for the bundle to pay for itself (cost - pricedNet, at least 0). */
  breakEvenNet: number;
  /** With one unpriced model: the Amazon price per unit that nets the break-even; null otherwise or when it is 0. */
  breakEvenPrice: number | null;
  /** The unpriced models, in part order. */
  unpriced: string[];
}

/** Nov 23: what moves an unpriced part forward, one per part: its lookup, its Review answer, or a price the owner confirms. */
export type UnpricedAction = 'look_up' | 'answer' | 'confirm_price';

/** Nov 23: one unpriced part in a deal's incomplete estimate. */
export interface DealUnpricedPart {
  model: string;
  qty: number;
  /** waiting (not looked up yet), review (its match waits in Review), no_listing, inactive (its listing is not for sale now). */
  state: UnpricedState;
  action: UnpricedAction;
  /** The open match question for the part, when `action` is 'answer'; else null. */
  questionId: string | null;
  /**
   * When the part is a kit: whether its Home Depot page is read (`pageRead`), and when it lists its parts, how many
   * (`parts`, models and items with no model number) and how many of its models still wait for a lookup. Absent for a part
   * that is no kit the store knows.
   */
  kit?: { pageRead: boolean; parts: number | null; waiting: number };
  /**
   * Suggested prices (Nov 23): the part's one suggestion with its evidence (PartRow.priceSuggestion), for "Confirm $66 (eBay
   * middle of 6)". Never counted until he confirms it (POST …/price `{kind: 'suggested', suggestion}`). Absent when none.
   */
  priceSuggestion?: PriceSuggestion;
  /** Answer once (Nov 23): what he settled about this model, when he did ("from your answer on Nov 23 · Change"). */
  fact?: PartFactView;
}

/** Nov 23: GET /api/deals/:id's incomplete estimate: the row's figures, each unpriced part with its state, and the basis. */
export interface DealIncompleteEstimate extends DealIncomplete {
  /** The bundle price with tax and the inbound cost. */
  cost: number;
  /** The fee settings in words, ending with "An estimate from your fee settings, not your real Amazon fees." */
  basis: string;
  parts: DealUnpricedPart[];
  /** Items with no model number the primary way leaves unpriced: not counted (not sold separately by default). */
  notCounted: string[];
  /** When the primary way sells a kit as its parts: "Sold as PCL1600K2's 19 parts"; else null. */
  soldAs: string | null;
  /**
   * Suggested prices (Nov 23): what the bundle would make if he accepted every unpriced part's suggestion, from the fee
   * settings (rule 5). A second, labelled line: never the headline, never a buy. Absent unless every unpriced part has one.
   */
  ifAccepted?: { profit: number; roi: number; suggested: number };
}

export interface DealsQuery {
  sort?: DealSortKey;
  section?: ReportSection;
}

export interface DealsResponse {
  /** When the deals were last stored; null before the first scan. */
  at: string | null;
  sort: DealSortKey;
  rows: DealRow[];
  /** Days since the oldest bundle price was seen, when the list is stale; else null. */
  staleDays: number | null;
  notices: { limit: { title: string; text: string } | null; ebay: string | null };
}

/** W4: the estimate's figures, from the fee settings (CLAUDE.md rule 5: an estimate, never the seller's real fees). */
export interface DealEstimate {
  profit: number;
  roi: number;
  /** The bundle price with tax and the inbound cost. */
  cost: number;
  /** The counted part prices (Amazon New, or a confirmed price), times their quantity, before fees. */
  partsSellFor: number;
  /** What those parts net after the referral fee and fulfillment. */
  afterFees: number;
  /** The fee settings in words: "15% referral (at least $0.30), $0.00 fulfillment, 0% tax, $0.00 inbound." */
  basis: string;
  /**
   * Items with no model number (a charger, a bag) the way to sell leaves unpriced: not counted, at $0 (the liquidation
   * rate is 0), until the owner confirms a price. Nov 23: since an estimate exists only when every model part is priced,
   * no model part is ever here (before, a part with no listing was, and showed a $299 bundle "losing" $299).
   */
  countedAtZero: string[];
  /**
   * Catalog check: what the counted parts' listings rest on, beside the estimate (the ROI range is unchanged). `verified`:
   * parts on a listing Amazon's catalog, a product page or the owner verified; `titleMatches`: parts matched only by their
   * title. `label`: "2 parts on verified listings, 1 on a title match." Absent when no counted part has a listing.
   */
  listings?: EstimateListings;
}

/** Catalog check: how many of an estimate's parts rest on verified listings and how many on title matches. */
export interface EstimateListings {
  verified: number;
  titleMatches: number;
  label: string;
}

/** GET /api/deals/:id. `bundle` holds the parts with every labelled price and the ways to sell. */
export interface DealDetail {
  row: DealRow;
  bundle: BundleRow;
  sources: SourceLink[];
  /** Always says it is an estimate (CLAUDE.md rule 5). */
  estimateBasis: string;
  /** W4: the figures behind the row's profit; null when there is no estimate. */
  estimate?: DealEstimate | null;
  /** Nov 23: in place of `estimate` while some model part has no counted price; null or absent otherwise. */
  incompleteEstimate?: DealIncompleteEstimate | null;
  /** Tracking: whether the bundle is watched, by whom, since when; null when it never was. */
  watch?: WatchState | null;
  /** Tracking: the last scan's signals; null when the bundle is not watched or no scan has run since. */
  signals?: DealSignals | null;
  /** Tracking: the stored scan points, oldest first, for a small chart (stored data only; nothing is fetched). */
  history?: DealHistoryPoint[];
  /** Tracking: the BOGO promotion the owner entered, with its estimate; null when none. */
  bogo?: BogoView | null;
  /**
   * BOGO found by the agent: the group of starter + free tool pairs this deal is one of (or starts), each pair ranked by
   * its own estimate, with its Home Depot page and deal id. Null when the deal is in no group. When it is set, the
   * owner's BOGO entry is only a fallback.
   */
  bogoGroup?: BogoGroup | null;
  /**
   * Tracking: the primary way to sell's estimate with Amazon's FBA fee estimate (Keepa) per part in place of the flat
   * fulfillment setting, beside the estimate (never instead). Null when no part has a Keepa fee stored.
   */
  fbaEstimate?: FbaEstimate | null;
  /**
   * Step 15: what settled the bundle's split when a settle rule did, each with its link to check it: the BOGO pair
   * (`bogo_pair`), Home Depot's own page of each part (`hd_part_page`), a quote of the bundle's page (`page_quote`).
   * Absent when the split was read from the model number and page alone, or chosen by the owner.
   */
  splitEvidence?: SplitEvidence[];
}

export type { SplitEvidence };

// ---------------------------------------------------------------- tracking: watchlist, signals, BOGO

export interface WatchState {
  watched: boolean;
  /** auto: confirmed and discounted at a scan; owner: the owner's Watch or Unwatch, which scans never change. */
  by: 'auto' | 'owner';
  since: string;
}

/** POST /api/deals/:id/watch. Answered by WatchResponse. */
export interface WatchBody {
  watch: boolean;
}

export interface WatchResponse {
  id: string;
  watch: WatchState;
}

/**
 * A watched bundle's signals at the last scan (core/src/tracking/signals.ts). Each Signal has a plain sentence
 * (`reason`) and the numbers behind it; every dollar is an estimate from the fee settings. `options[].baseline` times
 * are epoch milliseconds. `buyNow` is the best way to sell worth buying now, or null; `options[].notBuyNow` says why not.
 */
export interface DealSignals {
  at: string;
  /** Signals round 2: the one-line verdict (BundleSignals.verdict); absent on signals stored before it. */
  verdict?: string;
  buyNow: Signal | null;
  signals: Signal[];
  options: OptionSignals[];
}

/** One stored scan of a bundle, for a small chart. Null where the scan had no figure; nothing is filled in. */
export interface DealHistoryPoint {
  at: string;
  section: ReportSection;
  /** Home Depot's bundle price. */
  price: number | null;
  /** The primary way to sell's counted Amazon New prices times their quantities. */
  amazonNew: number | null;
  /** The primary way to sell's estimate at that scan. */
  profit: number | null;
  roiPercent: number | null;
  /** The slowest part's Keepa monthlySold. */
  monthlySold: number | null;
  /** The slowest part's Keepa sales rank (not in any recording yet: usually null). */
  salesRank: number | null;
  /** The most buy-box-eligible offers on any part (Keepa, every condition). */
  offers: number | null;
}

/** One row of GET /api/watchlist. */
export interface WatchRow {
  row: DealRow;
  watch: WatchState;
  signals: DealSignals | null;
}

/** GET /api/watchlist: watched bundles, the ones worth buying now first, then by estimated profit. */
export interface WatchlistResponse {
  /** When the signals were computed (the last scan); null before one. */
  at: string | null;
  rows: WatchRow[];
  /** The numbers the signals were judged by (Settings, alerts). */
  thresholds: { minProfit: number; minRoiPercent: number; minMonthlySold: number; floorProfit: number };
}

/** A free item as the owner enters it; the model is upper-cased, the brand defaults to the bundle's. */
export interface FreeItemBody {
  brand?: string;
  model: string;
  title?: string;
  itemId?: string;
  link?: string;
  /** What the free item holds when it is a kit; omitted or null: sold whole, as its own model. */
  parts?: { model: string; qty: number }[] | null;
}

/**
 * POST /api/deals/:id/bogo: mark the deal as a BOGO promotion, give the eligible free items when known, and choose. Each
 * field omitted keeps what was saved. A chosen item must be on the eligible list when there is one. DELETE removes it.
 */
export interface BogoBody {
  freeCount?: number;
  eligible?: FreeItemBody[] | null;
  chosen?: FreeItemBody[] | null;
  link?: string | null;
}

export interface BogoResponse {
  bogo: BogoView | null;
}

export type { BogoChoice, BogoGroup, BogoTag, BogoView, FbaEstimate, FreeItem, OptionSignals, Signal, SignalKind, SignalNumbers, Velocity };

/** W4: GET /api/deals/:id/lookup (the quote shown before the click) and the answer to POST /api/deals/:id/lookup and /verify. */
export interface PaidResponse {
  searches: number;
}

/**
 * D3: POST /api/deals/:id/parts/:part/price confirms a sell price for one part of a deal (`:part` is the part's model,
 * or a kit item's '~name' with no model number, URL-encoded); DELETE removes it. A price counts only because the owner
 * chose it (docs/decisions.md, "A price counts when he confirms it"): `ebay-listing` takes one of the part's stored eBay
 * listings by its link and counts that listing's own price; `typed` takes a price and a link he typed (a Facebook link
 * is enough; it is not read). The agent never makes up a figure. Refused (409) while a scan or search runs, and for a
 * part still in Review.
 */
export type ConfirmPriceBody =
  | { kind: 'ebay-listing'; url: string; price?: number; note?: string }
  | { kind: 'typed'; price: number; url: string; note?: string }
  /**
   * Suggested prices (Nov 23): the part's suggestion as he was shown it. The agent checks it against the one the part carries
   * now (kind and price to the cent; 409 when it changed) and stores it as a price he confirmed, with its source.
   */
  | { kind: 'suggested'; suggestion: Pick<PriceSuggestion, 'kind' | 'price'> & Partial<PriceSuggestion>; note?: string };

/**
 * Answer once (Nov 23): POST /api/facts marks a model "in the box, not sold separately" (or keeps that answer after newer
 * evidence: a new date); DELETE /api/facts/:key (`BRAND:MODEL`, URL-encoded; `?field=` one of isPart, sellAs,
 * notSoldSeparately, else all of it) forgets it ("Change"), and the bundles it settled are asked about again (`reopened`).
 */
export interface FactBody {
  brand: string;
  model: string;
  notSoldSeparately: true;
}
export interface FactResponse {
  ok: true;
  reopened?: string[];
}

/** The price now stored for the part, or null after a DELETE. */
export interface ConfirmPriceResponse {
  confirmed: { price: number; link: string; note: string | null; confirmedAt: string } | null;
}

/**
 * POST /api/price-from-link `{ url }` (ui): the price the pasted link shows, read for him to confirm (the sheet still
 * needs his Confirm; nothing here counts as a price). eBay: the Browse item (free). Amazon: one Keepa product pull
 * (1 token, through the token budget; Amazon is never browsed). Home Depot: the page read in his Chrome (free). Any
 * other site: not read. USD only. Never a guess: whatever could not be read is `found: false` with the reason.
 */
export interface PriceFromLinkFound {
  found: true;
  price: number;
  currency: 'USD';
  title: string;
  condition?: string;
  /** eBay: the shipping cost the listing states (0 is free); null when it states none. Other sources omit it. */
  shipping?: number | null;
  source: 'eBay' | 'Amazon (Keepa)' | 'Home Depot';
  url: string;
  readAt: string;
  note?: string;
}
export type PriceFromLinkResponse = PriceFromLinkFound | { found: false; reason: string };

// ---------------------------------------------------------------- review

export type ReviewKind = 'split' | 'match' | 'ebay';

/** W4: a line of evidence or a quote, with the source it came from. */
export interface EvidenceQuote {
  text: string;
  source: { label: string; url: string | null };
}

// W4 fields are optional in the types so clients built before them still compile; the agent always sends them.

/** W4: one answer a question offers. Answer it with `{choice: index}` or `{choiceId: id}`. */
export interface QuestionChoice {
  id: string;
  /** "PCL1600K2, P553", or a listing's title. */
  label: string;
  models: string[];
  asin: string | null;
  source: { label: string; url: string | null } | null;
}

export interface ReviewQuestion {
  id: string;
  kind: ReviewKind;
  /** The bundle the question holds up, when known. */
  bundleId: string | null;
  brand: string;
  model: string;
  title: string | null;
  reason: string;
  sources: SourceLink[];
  /** The latest AI suggestion for this question; a suggestion is never an answer (rule 4). */
  suggestion: StoredSuggestion | null;
  /** W4: reviewSignature of the question as stored now; send it back as ReviewAnswerBody.seen. Absent on eBay questions. */
  seen?: string;
  /** W4: the question in a sentence ("What is inside the RYOBI PCL1600K2-P553?"). */
  prompt?: string;
  /** W4: what the scan stored that bears on it (the bundle's page lines, the listings' titles), each with its source. */
  evidence?: EvidenceQuote[];
  choices?: QuestionChoice[];
  /** W4: what Ask AI costs for this question at the model's published rate; null when no rate is known or no call is made. */
  askCostUsd?: number | null;
  /** W4: the suggestion's quotes, each with the source it was found in (only quotes code found word for word). */
  suggestionQuotes?: EvidenceQuote[];
  /**
   * Step 15: when the suggestion was not verified, why, in one plain sentence for the owner ("Not verified: the page never
   * names DCK240C2. Check the Home Depot page."; core/src/assist/plain.ts). The technical reasons stay on the suggestion
   * for Activity. Absent otherwise.
   */
  suggestionPlain?: string;
  /**
   * Step 16: the three-line summary of the question and its suggestion (core/src/brief): what is asked, the suggestion in plain
   * words, why, and what to check. Always present from the agent; written by a model and checked by code (`writtenBy: 'ai'`) or by
   * the rules (`'rules'`). It never changes the suggestion, its status or what Autopilot may apply.
   */
  brief?: ReviewBrief;
  /**
   * Step 16: while the suggestion waits for Home Depot's page of a model it names, to confirm the model is real ("Waiting
   * for Home Depot's page for DCS334B to confirm the model."). A free read in the owner's Chrome; the answer is checked
   * again when it arrives, with no new AI call. Absent otherwise.
   */
  waitingFor?: string;
  /**
   * Step 16, the follow-up loop: what the app is doing or did about the question before it is the owner's: its Chrome reads
   * (Home Depot searches and pages, each with its link), its code check, and at most two follow-up asks. While `state` is queued
   * or running the question is not counted in "Needs you" (AgentState.counts.reviewWorking). Absent when the loop never ran.
   */
  followUp?: ReviewFollowUp;
  /**
   * Step 16 (round 2): when Home Depot's own pages confirmed some parts of the question's one reading and not others, the
   * models the question is still about (`unsettledParts`) and the confirmed ones with what Home Depot's page says each is and its
   * link (`settledParts`). The brief then names only the unsettled ones. Absent otherwise (the whole reading is asked).
   */
  unsettledParts?: string[];
  settledParts?: { model: string; what: string; url?: string }[];
  /** The question as the scan stored it. */
  item: { kind: 'split' | 'match'; question: ReviewItem } | { kind: 'ebay'; question: EbayQuestion };
}

export type { BriefCheck, BriefReason, BriefState, ReviewBrief } from '../brief/types';
export type { FollowUpTried, ReviewFollowUp } from '../research/followUp';

export interface ReviewResponse {
  at: string | null;
  questions: ReviewQuestion[];
}

/** POST /api/review/:id/answer. W4: `{choiceId}` is QuestionChoice.id, the same as `{choice: index}`. */
export type ReviewAnswer = { choice: number } | { choiceId: string } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' };

export interface ReviewAnswerBody {
  answer: ReviewAnswer;
  /** True when the owner approved the AI suggestion, so its outcome is tracked. */
  fromSuggestion?: boolean;
  /**
   * W4: ReviewQuestion.seen of the question the owner was shown. When given and the question changed since, the answer is
   * refused (409). Omitted: the question as stored now is assumed (send it; a scan may change the choices meanwhile).
   */
  seen?: string;
  /**
   * Answer once (Nov 23): the models of `ReviewQuestion.unsettledParts` he ticked "…and remember this for A986501" for (ticked
   * by default). What his answer says of each is kept per brand and model and applied to every bundle that holds it.
   */
  remember?: string[];
}

/** POST /api/review/approve: apply the AI suggestion of each question named. */
export interface ApproveBody {
  ids: string[];
}

/** Only verified suggestions for the question as it is now are applied; the rest say why not. */
export interface ApproveResponse {
  approved: string[];
  skipped: { id: string; reason: string }[];
}

/** POST /api/review/ask-all: the agent asks in the background. */
export interface QueuedResponse {
  queued: true;
}

/** Step 16: POST /api/review/:id/ask. `force`: ask afresh even when nothing is new since the last answer (it costs an ask). */
export interface AskBody {
  force?: boolean;
}

/**
 * Step 16: POST /api/review/:id/ask never does nothing silently. `queued`: an ask, or the follow-up loop, starts in the
 * background. Otherwise `reason` says why in plain words ("Nothing new to read since the last answer; asking again would cost
 * about $0.07."), and `canForce` is true when `{ force: true }` would start a fresh ask, with `costUsd` its estimate; absent
 * when force changes nothing (no key, the cap reached, a scan running, already working on it).
 */
export interface AskResponse {
  queued: boolean;
  reason?: string;
  canForce?: boolean;
  costUsd?: number;
}

/** W4: POST /api/review/:id/answer. The agent applies the answer itself (core/src/scan/answers.ts). */
export interface AnswerResponse {
  applied: true;
  /**
   * Answer once (Nov 23): what was remembered (`models`), the open questions that settled (`settled`, by id), and the ticked
   * models the answer says nothing general about, each with why. Absent when nothing was ticked.
   */
  remembered?: { models: string[]; settled: string[]; skipped: { model: string; why: string }[] };
  /**
   * Additive: the id of the entry the agent kept so the owner can take this answer back (POST /api/review/:id/undo,
   * with this id). Absent for an answer that cannot be taken back (an eBay yes or no).
   */
  answerId?: string;
}

/** POST /api/review/:id/undo (`:id` is an `OwnerAnswerEntry.id`): the question is open again in Review. */
export interface UndoAnswerResponse {
  reopened: true;
  questionId: string;
}

/** An answer the owner saved himself, as Activity lists it (the newest 50), with whether Undo still works. */
export interface OwnerAnswerEntry {
  id: string;
  questionId: string;
  /** The bundle's title, or its model when it has none. */
  title: string;
  /** What he answered, in plain words ("PCL1600K2, P553", "None of these", an ASIN). */
  answer: string;
  at: string;
  /** False once a later scan or answer changed what this one wrote, or after it was undone. */
  undoable: boolean;
  /** When it was undone, else null or absent. */
  undoneAt?: string | null;
}

// ---------------------------------------------------------------- outcomes: what the owner bought and what became of it

/**
 * One part of a bought deal as the estimate had it at the moment he bought (core/src/outcomes). Every dollar is an estimate
 * from the fee settings of that moment, never the seller's real fees. Frozen: nothing rewrites it afterwards.
 */
export interface OutcomeSnapshotPart {
  /** Stable inside the purchase ("p0", "p1"): the part's outcome is addressed by it. */
  id: string;
  model: string;
  /** Units of this part in one bundle. */
  qty: number;
  /** The estimate counted a price for it. */
  counted: boolean;
  asin: string | null;
  listingTitle: string | null;
  /** The Amazon listing's link, or null with no listing. */
  listingLink: string | null;
  grade: string | null;
  /** Estimated sale price of one unit (Amazon New, or a price the owner confirmed); null when not counted. */
  sellPrice: number | null;
  /** The fees the estimate used for one unit, with the rate they came from; null when not counted. */
  referralRate: number | null;
  referralFee: number | null;
  fulfillmentFee: number | null;
  /** Estimated after-fees amount for one unit; null when not counted. */
  netEach: number | null;
}

export interface OutcomeSnapshot {
  takenAt: string;
  /** The last scan had judged the bundle worth buying now when he bought it. */
  buyNow: boolean;
  bundle: { id: string; itemId: string; brand: string; model: string; title: string; link: string | null; price: number | null; regularPrice: number | null };
  parts: OutcomeSnapshotPart[];
  /** Items with no model number the estimate did not count. */
  uncounted: string[];
  /** The estimate for one bundle; null when the deal had none (a part missing a price). */
  estimate: { profit: number; roi: number; cost: number; partsSellFor: number; afterFees: number } | null;
  /** The fee settings of that moment (a flat fulfillment fee and referral rate are the fallback of a part with none of its own). */
  fees: { referralRate: number; fulfillmentFee: number; minReferral: number; salesTaxRate: number; inboundCost: number };
  /** The basis sentence the estimate showed ("15% referral ..."); always says it is an estimate. */
  basis: string;
}

export type PartOutcomeStatus = 'open' | 'sold' | 'holding' | 'returned';

/** What the owner recorded about one part. Recorded by him, never worked out by the app. */
export interface PartOutcome {
  partId: string;
  status: PartOutcomeStatus;
  /** YYYY-MM-DD the part sold or came back; null for open and holding. */
  date: string | null;
  /** Sold: the price of one unit. */
  salePrice: number | null;
  /** Sold: the net payout he knows for the whole part (all its units); null when he gave only the price. */
  netPayout: number | null;
  /** Returned or not sold: money he got back for the whole part (a refund), or null for none. */
  recovered: number | null;
  updatedAt: string | null;
}

/** POST /api/outcomes: the deal he bought. Every field but `dealId` has a default. */
export interface RecordPurchaseBody {
  dealId: string;
  /** YYYY-MM-DD; default today. */
  boughtAt?: string;
  /** Price paid for one bundle; default the deal's Home Depot price. */
  pricePaid?: number;
  /** Bundles bought; default 1. */
  quantity?: number;
}

/** PATCH /api/outcomes/:id: what he can correct. The snapshot cannot be changed. */
export interface PurchasePatch {
  boughtAt?: string;
  pricePaid?: number;
  quantity?: number;
}

/** POST /api/outcomes/:id/parts/:part. `sold` needs `salePrice` and `date` (default today). */
export interface PartOutcomeBody {
  status: 'sold' | 'holding' | 'returned';
  date?: string;
  salePrice?: number;
  netPayout?: number | null;
  recovered?: number | null;
}

/** A part's result, worked out from what he recorded and the frozen snapshot. */
export interface PartResult {
  partId: string;
  model: string;
  /** Units of the part in the whole purchase (qty times bundles). */
  units: number;
  status: PartOutcomeStatus;
  date: string | null;
  salePrice: number | null;
  /** What came in for the part: the payout he gave, the sale price after the snapshot's fees, or the refund; null while not settled. */
  netReceived: number | null;
  /** payout: he gave the net; fees_estimated: the sale price less the snapshot's fees; refund: money back; none: returned for nothing. */
  netFrom: 'payout' | 'fees_estimated' | 'refund' | 'none' | null;
  /** What the estimate expected for the part, all its units; null when it was not counted. */
  estimatedNet: number | null;
  /** The part's share of what he paid, in proportion to its estimated net; null while not settled. */
  costShare: number | null;
  /** netReceived less costShare; null while not settled. */
  profit: number | null;
}

export interface PurchaseResult {
  /** What the purchase cost: price paid and the snapshot's tax and inbound settings, times the bundles. */
  cost: number;
  /** The snapshot's estimated profit times the bundles; null when the deal had no estimate. */
  estimatedProfit: number | null;
  partsTotal: number;
  /** Parts sold or returned. */
  partsSettled: number;
  partsSold: number;
  partsHolding: number;
  parts: PartResult[];
  /** Every part is sold or returned: the deal is complete. */
  complete: boolean;
  /** Net received for settled parts less their cost shares; null with nothing settled. */
  realisedProfit: number | null;
  /** Only when complete. */
  actualProfit: number | null;
  /** Only when complete and the deal had an estimate: diff is actual less estimated. */
  accuracy: { estimated: number; actual: number; diff: number; diffPercent: number | null } | null;
  /** Some net came from the sale price and the snapshot's fees, not from a payout he gave. */
  feesEstimated: boolean;
}

export interface Purchase {
  id: string;
  dealId: string;
  boughtAt: string;
  pricePaid: number;
  quantity: number;
  createdAt: string;
  updatedAt: string;
  snapshot: OutcomeSnapshot;
  parts: PartOutcome[];
}

export interface PurchaseView extends Purchase {
  result: PurchaseResult;
}

/** One sentence per change, with Undo while it still applies (as Activity lists it). */
export interface OutcomeEntry {
  id: string;
  at: string;
  purchaseId: string;
  sentence: string;
  undoable: boolean;
  undoneAt: string | null;
}

/** What the owner's records say (never what the app expects): this month and overall. All of it is recorded by him. */
export interface OutcomeScorecard {
  /** YYYY-MM of the month the realised figures are for. */
  month: string;
  purchases: number;
  boughtThisMonth: number;
  /** Bought deals the last scan had flagged Buy now when he bought them. */
  flaggedWhenBought: number;
  /** Null when no part was sold or returned this month. */
  realised: { profit: number; partsSettled: number; partsSold: number; partsOfThoseDeals: number; deals: number; feesEstimated: boolean } | null;
  /** Null when no deal is complete with an estimate. */
  accuracy: { deals: number; estimated: number; actual: number; diff: number; diffPercent: number | null; perDeal: { purchaseId: string; title: string; estimated: number; actual: number; diff: number; diffPercent: number | null }[] } | null;
}

export interface OutcomesResponse {
  purchases: PurchaseView[];
  scorecard: OutcomeScorecard;
  /** The newest changes first, at most 50. */
  entries: OutcomeEntry[];
}

export interface PurchaseResponse {
  purchase: PurchaseView;
  /** The entry Undo takes. */
  entryId: string;
}

export interface OutcomeUndoResponse {
  undone: true;
  purchaseId: string;
}

// ---------------------------------------------------------------- activity

export interface RunRecord {
  id: string;
  kind: 'scan' | 'ask' | 'lookup' | 'verify';
  startedAt: string;
  finishedAt: string | null;
  status: string;
  searchesUsed: number;
  keepaTokensUsed: number;
  aiCostUsd: number;
  summary: string;
  /** W4: who started the run. */
  trigger?: 'scheduled' | 'manual';
  /** W4: why the scan ended early ("user", "budget", ...), or null. */
  stopReason?: string | null;
  /** W4: what went wrong, in one plain sentence, or null. Never holds a key. */
  error?: string | null;
  /** W4: the scan's stages at its end (core's pipeline view). */
  steps?: { label: string; state: string; figure: string }[];
  /** W4: of aiCostUsd, what the eBay listing judge cost (counted once in the month's AI spend). */
  judgeCostUsd?: number;
  /** W4: Review questions the AI was asked about, and answers Autopilot applied, after the scan. */
  questionsAsked?: number;
  autopilotApplied?: number;
  /**
   * Free scan, fix round 2: each Home Depot bundle list the scan read in Chrome (its total, pages read, products found), and
   * for a list that came back empty, a slim sample of what its state held (scripts/record-listing-sample.ts makes a fixture).
   */
  bundleLists?: {
    brand: string; query: string | null; total: number | null; pages: number; found: number; added: number; empty: boolean; pagedOn?: string; sample?: ListingSample;
    /** Fix round 3: a Bundle filter list or the plain keyword search, and whether a page limit cut it. */
    source?: 'bundle' | 'search'; cut?: boolean;
  }[];
}

export interface AutopilotEntry {
  id: string;
  at: string;
  questionId: string;
  /** What was applied, in plain words. */
  applied: string;
  /** The code checks the suggestion passed (rule 4: evidence-checked by code). */
  verifiedBy: string[];
  undoneAt: string | null;
  /** W4: the question's stored answer Autopilot wrote (the parts joined by ","). */
  answer?: string;
  /** W4: the model that made the suggestion. */
  provider?: string;
  model?: string;
  /** W4: the bundle the question was about. */
  bundleId?: string | null;
  /** W4: false once the owner changed the answer since, so Undo would undo the owner's answer. */
  undoable?: boolean;
}

/** W4: something that went wrong, in one sentence, and what Retry does (POST /api/activity/errors/:id/retry). */
export interface ActivityError {
  id: string;
  at: string;
  sentence: string;
  retry: { label: string; searches: number; usd: number } | null;
}

export interface ActivityResponse {
  runs: RunRecord[];
  spend: { serpSearches: number; keepaTokens: number; aiUsd: number; since: string };
  autopilot: AutopilotEntry[];
  /** W4: open errors, newest first. */
  errors?: ActivityError[];
  /** Additive: the answers the owner saved himself, newest first, at most 50. */
  answers?: OwnerAnswerEntry[];
  /** Outcomes: what he recorded about purchases and sales, one sentence each, newest first, at most 50 (POST /api/outcomes/entries/:id/undo). */
  outcomes?: OutcomeEntry[];
}

// ---------------------------------------------------------------- settings

/**
 * W4: one AI pipeline's model. `trusted` says the model was measured (judge:eval / assist:eval / research:eval) well
 * enough for Autopilot to apply its verified suggestions without the owner; Claude starts trusted, any other model not.
 * `apiKeyRef` names a key the agent holds: "anthropic" or "openai".
 */
export interface AiPipelineSetting extends PipelineAiSettings {
  trusted: boolean;
}

export interface AiAgentSettings {
  judge: AiPipelineSetting;
  assist: AiPipelineSetting;
  research: AiPipelineSetting;
  /**
   * Step 16: the model that writes the plain brief above a Review question (core/src/brief). Cheap by default (Claude Haiku);
   * never trusted (`trusted` is always false): it explains a suggestion and cannot change it. Absent in a store older than it.
   */
  brief?: AiPipelineSetting;
  /** Dollars the AI may cost in a calendar month (judge, assist and research together). 0 turns the AI off. */
  monthlyCapUsd: number;
  /**
   * Step 16, the follow-up loop (it took over lever 2's setting): after the app's own free reads for a question the AI could not
   * settle (research/followUp.ts), ask the research model once more with what was read, at most twice a question, only on new
   * evidence, under the monthly cap. The reads and the code's check run whatever this says; an owner's Ask AI press asks
   * whatever this says. Absent or false: off (the default until `research:eval --follow-up` measures it at zero wrong).
   */
  reaskOnNewEvidence?: boolean;
  /**
   * The listing ladder, rung 3 (core/src/listingJudge): an AI judge for a listing rungs 0 to 2 left unconfirmed, every quote
   * checked by code. Absent or `enabled: false`: off (the default until `listing-judge:eval` measures it at zero wrong).
   * Even on, its 'ai_checked' never confirms a listing for a buy by itself (docs/decisions.md).
   */
  listingJudge?: { enabled: boolean; model: string };
}

/** D2: how the app looks. Stored by the agent; the UI applies it. */
export interface AppearanceSettings {
  theme: 'system' | 'light' | 'dark';
  accent: 'system' | 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'graphite';
  density: 'regular' | 'compact';
}

export const NOTIFY_KINDS = ['review', 'deal', 'autopilot', 'scan', 'error'] as const;

/** D2: which messages reach the owner and when. Times are local "HH:MM". */
export interface NotificationSettings {
  /** A kind turned off emits no notify event of that kind. */
  kinds: Record<(typeof NOTIFY_KINDS)[number], boolean>;
  /** The shell plays the default sound with a native notification. */
  sound: boolean;
  /** In quiet hours notifications are held and sent as one digest when they end; 'scan' ones are dropped. */
  quietHours: { enabled: boolean; from: string; to: string };
  /** 'each-run' sends the run's digest at once; 'morning' holds deal/review/autopilot lines until morningAt; 'off' sends none (Telegram too). */
  digest: 'each-run' | 'morning' | 'off';
  morningAt: string;
}

/** D2: the desktop shell's own switches (src-tauri applies them). */
export interface ShellSettings {
  menuBarIcon: boolean;
  dockIcon: boolean;
  launchAtLogin: boolean;
  /** The agent holds the computer awake while a scan or Look up all runs (agent/keepAwake.ts). Default on. */
  keepAwakeDuringScan: boolean;
}

/**
 * Every setting the owner can change; keys are not here (see KeyValues). W4 removed the extension-era `appPrimaryUi`,
 * `compactHelperPanel`, `askAfterScan` (the AI pass runs after every run, held by `ai.monthlyCapUsd`) and
 * `settings.agentBridgeAfterScan` (nothing posts to the agent after a scan any more).
 */
export interface AppSettings {
  /** Decision 5: apply verified AI suggestions without the owner, with Undo. */
  autopilot: boolean;
  ebaySettings: EbaySettings;
  settings: {
    schedule: Schedule;
    searchesPerScan: number;
    reserve: number;
    keepaTokensPerScan: number;
    keepaReserve: number;
    fees: FeeSettings;
    brands: string[];
    pagesPerBrand: number;
    /** W4: Keepa's discovery/tracking split (core/src/keepa/plan.ts), as the extension's settings have them. */
    discoveryMode: DiscoveryMode;
    keepaDiscoveryShare: number;
    trackingDepth: TrackingDepth;
    amazonRefreshViaKeepa: boolean;
  };
  /** W4: when a deal is worth a message (profit and ROI are estimates), and whether open questions are. */
  alerts: AlertSettings;
  /** W4: the AI pipelines' models and the month's cap. */
  ai: AiAgentSettings;
  /**
   * Step 15: `drip`: look up waiting parts with Keepa between scans as its tokens refill (default on). The listing ladder
   * (Nov 23): `autoVerify`: read a listing still not confirmed on SerpApi's product page when a buy waits on it or its
   * deal is within reach (default on); `verifySearchesPerDay`: at most this many searches a day for it, null (default)
   * for automatic: what the month above the reserve leaves per remaining day, at most 5.
   */
  lookups?: { drip: boolean; autoVerify?: boolean; verifySearchesPerDay?: number | null };
  /**
   * Free scan (Nov 23): where a scan finds Home Depot's bundles (core/src/scan/listingSource.ts). `listingSource` 'auto'
   * (default): Home Depot's Bundle lists read in Chrome when the helper is connected, SerpApi only when it is not and the
   * budget allows; 'chrome': never a search for them; 'serpapi': SerpApi's listing pages as before. `serpWhenChromeClosed`
   * (default off): a scheduled scan with Chrome closed searches SerpApi instead of waiting for Chrome. Absent: the defaults.
   */
  scan?: { listingSource: ListingSourceSetting; serpWhenChromeClosed: boolean };
  /**
   * Suggested prices (Nov 23): `autoAcceptSuggestions` exists and is always false. It is not offered in the UI and no PATCH
   * changes it: the PO ruled that a price counts when he confirms it (docs/decisions.md).
   */
  prices?: { autoAcceptSuggestions: false };
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  shell: ShellSettings;
}

/** GET /api/settings and the answer to PATCH /api/settings (whose body is a SettingsPatch). */
export interface SettingsResponse {
  updatedAt: string;
  settings: AppSettings;
  keys: KeysPresence;
}

export type SettingsPatch = Partial<Omit<AppSettings, 'settings' | 'ebaySettings' | 'alerts' | 'ai' | 'appearance' | 'notifications' | 'shell' | 'scan' | 'prices'>> & {
  settings?: Partial<AppSettings['settings']>;
  scan?: Partial<NonNullable<AppSettings['scan']>>;
  ebaySettings?: Partial<EbaySettings>;
  alerts?: Partial<AlertSettings>;
  appearance?: Partial<AppearanceSettings>;
  notifications?: Partial<Omit<NotificationSettings, 'kinds' | 'quietHours'>> & {
    kinds?: Partial<NotificationSettings['kinds']>;
    quietHours?: Partial<NotificationSettings['quietHours']>;
  };
  shell?: Partial<ShellSettings>;
  ai?: Partial<Omit<AiAgentSettings, 'judge' | 'assist' | 'research' | 'brief'>> & {
    judge?: Partial<AiPipelineSetting>;
    assist?: Partial<AiPipelineSetting>;
    research?: Partial<AiPipelineSetting>;
    brief?: Partial<AiPipelineSetting>;
  };
};

// ---------------------------------------------------------------- agent control

/** POST /api/agent/pause and /api/agent/resume answer with the new state. */
export interface PauseResponse {
  paused: boolean;
}

// ---------------------------------------------------------------- scan

export interface ScanStartResponse {
  id: string;
  requestedAt: string;
}

// ---------------------------------------------------------------- pairing

/** POST /api/pair/request (no token; Origin must be chrome-extension://<extensionId>). */
export interface PairRequestBody {
  extensionId: string;
}

export interface PairRequestResponse {
  requestId: string;
  /** Shown in both the extension and the app so the owner can see they match. */
  code: string;
  /** Proves the claim comes from the requester; kept by the extension, never shown. */
  claimSecret: string;
  expiresAt: string;
}

/** GET /api/pair/requests (UI): pending requests the owner may allow. */
export interface PendingPairRequest {
  requestId: string;
  extensionId: string;
  code: string;
  requestedAt: string;
  expiresAt: string;
}

/** POST /api/pair/approve and /api/pair/deny (UI). */
export interface PairDecisionBody {
  requestId: string;
}

/** POST /api/pair/claim (no token). */
export interface PairClaimBody {
  requestId: string;
  claimSecret: string;
}

export type PairClaimResponse =
  | { status: 'pending' }
  | { status: 'approved'; token: string; extensionId: string }
  | { status: 'denied' };

export interface PairedExtension {
  extensionId: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

// ---------------------------------------------------------------- browser helper folder

/**
 * POST /api/setup/install-extension (UI, no body): unpacks the bundled extension zip into `extensionDir` and checks the
 * manifest. A failure is an error body (`unavailable` when the zip is not bundled, `bad_request` otherwise), not this.
 */
export interface InstallExtensionResponse {
  ok: true;
  extensionDir: string;
  extensionReady: boolean;
  extensionMessage: string;
  zipAvailable: boolean;
  lane: 'D';
}

// ---------------------------------------------------------------- worker jobs

/** Home Depot reads only the owner's Chrome can make (Decision 4). */
export interface WorkerJobInputs {
  /** Read product pages; the result is the extension's ReadPages outcomes. */
  page: { itemIds: string[] };
  /** Read a kit's own page for its contents. */
  kitPage: { itemId: string; model: string };
  /** Read one part's Home Depot price. W4: `brand`, so the worker can check the page names it. */
  partPrice: { itemId: string; model: string; brand?: string };
  /** A Home Depot search results page (the research agent's searchHomeDepot; `page` is 1). */
  search: { query: string; page: number };
  /**
   * W4: one product page as text sections, for the research agent's readHomeDepotPage (not run by the W5 extension yet:
   * its runJob needs a case calling researchTools.forQuestion().readHomeDepotPage({ itemId })).
   */
  researchPage: { itemId: string };
  /**
   * BOGO: one page of a brand's Featured BOGO listing, by its path (core/src/tracking/bogoPairs.ts bogoListingPath; the
   * worker reads only a path isBogoListingPath accepts).
   */
  bogoListing: { path: string };
  /**
   * Free scan (Nov 23): one page of a brand's Bundle listing, by its path (core/src/scan/listingSource.ts bundleListingPath;
   * the agent and the worker accept only a path isBundleListingPath accepts).
   */
  bundleListing: { path: string };
  /** BOGO: product pages with their price, was-price and BOGO promotions (hdPage.ts parsePromoPage). */
  promoPage: { itemIds: string[] };
  /**
   * Nov 23: the helper reloads itself (chrome.runtime.reload(); an unpacked install loads the files in its folder again).
   * Queued once by the agent when it sees an outdated helper, and by POST /api/helper/reload. No input.
   */
  reload: Record<string, never>;
}

/**
 * W4: what each job's `result` must be (POST /api/worker/result). The agent checks the shape; anything else counts as a
 * failed read, never as data.
 */
export interface WorkerJobResults {
  /** One outcome per item id asked, in any order (core/src/scan/types.ts PageOutcome). */
  page: PageOutcome[];
  /** The kit page's outcome. */
  kitPage: PageOutcome;
  partPrice: PartPriceReading;
  /** As extension/lib/researchTools.ts searchHomeDepot returns it; a refusal is a ToolError, never an empty list. */
  search: HomeDepotSearch | ToolError;
  /** As extension/lib/researchTools.ts readHomeDepotPage returns it. */
  researchPage: HomeDepotPage | ToolError;
  /** The listing page's products in page order (its base-searchNav entries); a refusal is a ToolError. */
  bogoListing: { products: ListedItem[] } | ToolError;
  /** As bogoListing: the Bundle listing page's products in page order; a refusal is a ToolError. */
  bundleListing: { products: ListedItem[]; note?: string; finalPath?: string; total?: number; sample?: ListingSample } | ToolError;
  /** One outcome per item id asked, as `page`'s. */
  promoPage: PromoPageOutcome[];
  /** Posted just before the helper reloads. */
  reload: { reloading: true };
}

export type WorkerJobKind = keyof WorkerJobInputs;
export const WORKER_JOB_KINDS: readonly WorkerJobKind[] = ['page', 'kitPage', 'partPrice', 'search', 'researchPage', 'bogoListing', 'bundleListing', 'promoPage', 'reload'];

/**
 * Nov 23: the sentence a helper answers a job kind it does not know with. A helper built before `outdated` existed says only
 * this, so the agent reads it as `outdated` too (never as a Home Depot failure).
 */
export const UNKNOWN_JOB_KIND = 'This browser does not know that kind of job.';

export type WorkerJobStatus = 'queued' | 'leased' | 'done' | 'failed';

export interface WorkerJob<K extends WorkerJobKind = WorkerJobKind> {
  id: string;
  kind: K;
  input: WorkerJobInputs[K];
  status: WorkerJobStatus;
  /** Times handed to a worker; a job is handed out at most twice (one retry). */
  attempts: number;
  createdAt: string;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
}

/** GET /api/worker/next: 200 with a job, or 204 when none came within the long poll. */
export interface WorkerNextResponse {
  job: { id: string; kind: WorkerJobKind; input: WorkerJobInputs[WorkerJobKind]; attempt: number };
}

/** POST /api/worker/result. */
export type WorkerResultBody =
  | { id: string; ok: true; result: unknown }
  /** Nov 23 `outdated`: the helper does not know this kind of job (it is an older build); the job fails at once, not retried. */
  | { id: string; ok: false; error: string; outdated?: boolean };

/** POST /api/worker/heartbeat: `jobId` names the job the helper is running, so the agent extends its lease (additive; omitted when idle). */
export interface WorkerHeartbeatBody {
  jobId?: string;
  /**
   * Nov 23: the helper's build, its manifest's version_name ("0.1.0+3c92cc7": the version and the build id baked in at
   * build time). Sent when its job loop starts and with every heartbeat during a job.
   */
  version?: string;
}

/** Nov 23, POST /api/helper/reload (UI, no body): a `reload` job is queued for the helper. */
export interface HelperReloadResponse {
  queued: true;
}

export interface WorkerResultResponse {
  status: WorkerJobStatus;
}

// ---------------------------------------------------------------- events (GET /api/events)

/** POST /api/notify/test-telegram: one test message to the saved bot and chat. `problem` is Telegram's refusal in plain words, never a key. */
export interface TelegramTestResponse {
  ok: boolean;
  problem?: string;
}

/** The shell turns this into a native notification (src-tauri/src/events.rs reads title, body, kind, count). */
export interface NotifyEvent {
  id: string;
  kind: 'review' | 'deal' | 'autopilot' | 'scan' | 'error';
  title: string;
  body: string;
  /** How many things the message is about, when it counts them. */
  count?: number;
  /** Where the app should open on a click, e.g. "/review". */
  route?: string;
}

/**
 * Server-sent events: `event: <name>` with `data: <json>`. The shell turns `notify` into a native notification. W4: each
 * `data:` object also carries `type: <name>` beside its fields, and the `state` event also carries the whole state as `state`.
 */
export interface AgentEvents {
  state: AgentState;
  deals: { at: string | null; count: number };
  /** `counts.review` matches AgentState so the shell can update its badge from either event. */
  review: { at: string | null; open: number; counts: { review: number; reviewWorking?: number } };
  activity: { at: string };
  notify: NotifyEvent;
}

export type AgentEventName = keyof AgentEvents;

// ---------------------------------------------------------------- re-exports used by clients

export type { DealSortKey, PaidAction, ReportSection, UnpricedState };
