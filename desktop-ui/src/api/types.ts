// What the screens read. The agent's contract (core/src/api/contract.ts) is the source of truth: every
// type that is the same on the wire is re-exported from it here, and the few shapes a screen wants in
// another form (a flatter row, a labelled price line, the pipeline in words) are defined below and
// built from the contract in one place, map.ts. Nothing here is mirrored by hand.

import type {
  ActivityError, OutcomeEntry, BogoGroup, BogoTag, BogoView, DealHistoryPoint, DealIncomplete, DealIncompleteEstimate, DealSignals, FbaEstimate, KeyCheckRecord, KeyName, ReportSection, ReviewKind, WatchState,
} from '@core/api/contract';
import type { ConfirmState } from '@core/scan/confirmed';
import type { PartFactView } from '@core/scan/types';
import type { PipelineView as CorePipelineView } from '@core/scan/pipeline';

export type {
  ActivityError,
  AppSettings,
  OutcomeEntry,
  OutcomeScorecard,
  OutcomesResponse,
  PartOutcomeBody,
  PartResult,
  PurchaseResponse,
  PurchasePatch,
  PurchaseView,
  RecordPurchaseBody,
  BogoBody as BogoRequest,
  BogoChoice,
  BogoGroup,
  BogoTag,
  BogoView,
  DealHistoryPoint,
  DealIncomplete,
  DealIncompleteEstimate,
  DealSignals,
  DealUnpricedPart,
  FbaEstimate,
  FreeItem,
  FreeItemBody,
  OptionSignals,
  Signal,
  Velocity,
  WatchState,
  KeyCheck,
  KeyCheckRecord,
  KeyName,
  KeysPresence,
  PairedExtension,
  PendingPairRequest,
  ReviewAnswer,
  SettingsPatch,
} from '@core/api/contract';
export type { ConfirmState } from '@core/scan/confirmed';
export type { Schedule } from '@core/schedule';
export type { FeeSource } from '@core/money';

/** One scan step as the agent now says it: a mark, a label, its figure, and its own count when it has one. */
export interface PipelineStepView {
  label: string;
  state: 'done' | 'now' | 'next' | 'skipped' | 'failed';
  /** "13 read", "est. $0.03"; for a skipped or failed step, why. */
  figure: string;
  done?: number;
  total?: number;
}

/** The scan's stages (core/src/scan/pipeline.ts) with the failed state and per-step counts. `estimateText` is '' when unknown. */
export type PipelineView = Omit<CorePipelineView, 'steps'> & { steps: PipelineStepView[] };

export type DealSection = ReportSection;
export type QuestionKind = ReviewKind;

// ------------------------------------------------------------------ GET /api/state

export type ScanResult = 'finished' | 'stopped' | 'limit' | 'failed';

export interface LastScan {
  at: string;
  result: ScanResult;
  newDeals: number;
  searches: number;
  /** One sentence for stopped, limit and failed. */
  message: string | null;
  /** Home Depot pages the scan could not read; their parts are not known yet. Absent from an older agent. */
  pagesUnread?: number;
  /** Whether "Read pages again" can start now (a free retry of just those pages). Absent from an older agent. */
  canReadPagesAgain?: boolean;
  /** True when the owner pressed Stop: a stop he asked for is not a problem to show. Set by map.ts. */
  userStopped?: boolean;
  /** Parts still waiting for an Amazon lookup when the scan ended. Absent from an older agent. */
  waitingLookups?: number;
  /** What the scan's lookups went through: Keepa tokens, SerpApi searches. */
  lookupsDone?: { keepa: number; serpapi: number };
  /** Why lookups still wait, when they do. */
  lookupsBlockedBy?: LookupBlock | null;
}

/** POST /api/lookups/run: whether it started, why not, and how many lookups go through Keepa and through SerpApi. */
export interface LookupsRun {
  started: boolean;
  reason?: string;
  viaKeepa: number;
  viaSerpapi: number;
}

export type LookupBlock = 'keepa_tokens' | 'search_cap' | 'reserve' | 'hourly_limit';

/** Lookups between scans: Keepa refills and the agent looks up the next part by itself (no SerpApi). */
export interface Drip {
  active: boolean;
  waiting: number;
  nextAt: string | null;
  lastLookupAt: string | null;
  /** Keepa fee pulls waiting (Amazon's fulfillment fee for parts of bundles with an estimate); absent when none. */
  feesWaiting?: number;
}

export interface AgentView {
  /** 'asking': the agent is busy with the AI pass on Review questions. */
  status: 'idle' | 'scanning' | 'asking' | 'stopping' | 'paused' | 'error';
  /** The scan's stages as core says them ("Checking eBay listings · 23 of 60", "about 4 min"); null when nothing runs. */
  pipeline: PipelineView | null;
  /** The agent's own one-line step, when it reports one without the stages. */
  step: string | null;
  nextScanAt: string | null;
  lastScan: LastScan | null;
  /** The background lookups; absent from an older agent. */
  drip?: Drip;
}

export interface HelperState {
  paired: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  /** Home Depot read jobs waiting for Chrome. */
  jobsWaiting: number;
  /** The Chrome helper is older than the app, so it may not read pages the way this version expects. Absent from an older agent. */
  outdated?: boolean;
  /** The helper's own version, when it said one. */
  version?: string;
}

export interface BudgetState {
  /** Null until the agent has checked the SerpApi account once. */
  serpLeft: number | null;
  serpMonthly: number | null;
  serpReserve: number;
  serpPerScan: number;
  keepaTokens: number | null;
  /** Tokens the Keepa account refills each minute, when the agent knows it. */
  keepaRefillPerMin?: number | null;
  aiSpentUsd: number;
  aiCapUsd: number | null;
}

export interface AppState {
  agent: AgentView;
  helper: HelperState;
  budget: BudgetState;
  /** `review` counts the questions that need him; `reviewWorking` the ones the app is still checking itself (not in `review`). Absent from an older agent. */
  counts: { review: number; autopilotApplied: number; newDeals: number; reviewWorking?: number };
  keys: Record<KeyName, boolean>;
  /** True until the first scan has finished; drives the one-time first-run flow. */
  firstRun: boolean;
  /** Why a saved key does not work, in the agent's words, by key; absent when none is rejected. */
  keyProblems?: KeyProblems;
  /** When each saved key last got a verdict from its own service; absent for a key not yet checked. */
  keyChecks?: KeyChecks;
}

export type KeyProblems = Partial<Record<KeyName, string>>;
export type KeyChecks = Partial<Record<KeyName, KeyCheckRecord>>;

// ------------------------------------------------------------------ GET /api/deals

export type DealSort = 'profit' | 'roi' | 'off' | 'price' | 'updated' | 'title';

export interface RoiRange {
  low: number;
  high: number;
}

export interface DealRow {
  id: string;
  title: string;
  brand: string;
  model: string;
  /** A Home Depot set (no model number): how many items Home Depot lists in it; the row says "Set · 5 items". */
  setItems?: number;
  /** Home Depot's item number, when the agent has one (a search finds a deal by it). */
  itemId: string | null;
  /** The bundle's Home Depot page, or null. */
  link: string | null;
  /** On the watchlist: by itself when confirmed and discounted, or by his Watch. */
  watched: boolean;
  /** The last scan said a way to sell is worth buying now (only a watched bundle is judged). */
  buyNow: boolean;
  /** The agent's one-line verdict on a watched bundle ("Not worth buying now: est. profit $6.63 is below your $20."); null when not judged. */
  signalNote?: string | null;
  /** The estimate counts no fulfillment fee for `parts` of its `of` parts (never a buy; the agent sorts it after full estimates). */
  beforeFulfillment?: { parts: number; of: number } | null;
  /** A BOGO promotion he entered: 'choose' until he picks the free tool. */
  bogo: 'choose' | 'chosen' | null;
  /** BOGO found by the agent: this bundle is a starter + free tool pair Home Depot lists at the starter's price. */
  bogoPair: BogoTag | null;
  /** The automatic BOGO group this bundle is a choice of (or starts): its label, size and best pair. */
  bogoChoices: { label: string; count: number; bestId: string | null; best: boolean } | null;
  section: DealSection;
  price: number | null;
  /** Whole percent off, or null. */
  off: number | null;
  /** The agent's own sentence on how far the parts are matched ("2 parts to verify"), or null. */
  matchState: string | null;
  profit: number | null;
  roi: number | null;
  /** Only when both ends are known. */
  roiRange: RoiRange | null;
  needsAnswer: boolean;
  /** 'waiting_page': the bundle's own Home Depot page could not be read, so its parts are not known yet (not a question for him). */
  matchKind?: 'waiting_page' | 'waiting_parts' | null;
  /** Home Depot's pace, on a 'waiting_page' row: how many Home Depot pages wait in all and when they are read (the agent's words). */
  pageWait?: string;
  updatedAt: string;
  /** Parts still to look up, and what a lookup of them would cost in searches (the row has no button; the inspector's menu does). */
  lookup: { searches: number } | null;
  /**
   * Nov 23: some model part has no counted price, so there is no profit or ROI: how many are priced, what they bring, and
   * the break-even (the agent's figures, estimates from the fee settings). Absent or null for a complete estimate.
   */
  incomplete?: DealIncomplete | null;
}

export interface DealsView {
  rows: DealRow[];
  /** When the deals were last stored. */
  at: string | null;
  /** One sentence when a scan skipped its eBay step; not an error. */
  ebayNotice: string | null;
  /** The limit notice when the last scan stopped at one: a title and a sentence. */
  limitNotice: { title: string; text: string } | null;
  /** Days since the oldest price was seen, when the list is stale. */
  staleDays: number | null;
}

// ------------------------------------------------------------------ GET /api/deals/:id

export interface Source {
  label: string;
  /** http(s) only; null when there is nothing to open. */
  url: string | null;
}

export interface PriceLine {
  /** "Amazon · New", "Buy Box · Acme Tools", "List price", "Home Depot", "eBay · New". */
  label: string;
  amount: number | null;
  /** eBay's range, when it has one. */
  range: { low: number; high: number } | null;
  /** Counted in the estimate; reference prices say "not counted". */
  counted: boolean;
  note: string | null;
  /** When the figure was seen (ISO), or null. */
  seenAt: string | null;
  sources: Source[];
  /** The owner's own confirmed price: Remove is offered on it. */
  confirmed?: boolean;
}

export interface SplitEvidence {
  kind: 'hd_part_page' | 'bogo_pair' | 'page_quote' | 'owner_fact' | 'hd_set';
  text: string;
  url?: string;
  /** owner_fact: the model his answer is about ("Change" forgets it). */
  model?: string;
}

export type Grade = 'verified' | 'title_match' | 'needs_answer' | 'inactive' | 'missing' | 'not_looked_up';

export interface DealPart {
  model: string;
  qty: number;
  title: string | null;
  grade: Grade;
  asin: string | null;
  /** The counted Amazon New price, or null. */
  price: number | null;
  /** That price after fees. */
  net: number | null;
  prices: PriceLine[];
  /** Searches a Verify costs, when the grade is title_match. */
  verifySearches: number | null;
  /** A kit's item with no model number (a charger, a bag): never looked up, priced only by a price he confirms. */
  unnamed: boolean;
  /** What he may do about this part's sell price (core/src/scan/confirmed.ts rules). */
  confirm: PartConfirm;
  /** Answer once (Nov 23): what he settled about this model, applied in every bundle that holds it. */
  fact?: PartFactView;
}

/** A part's price form: whether it is open, the stored eBay listings he may choose, and the price he confirmed. */
export interface PartConfirm {
  state: ConfirmState;
  /** The part's stored eBay listings that carry their own price and a link. */
  ebay: { url: string; price: number }[];
  confirmed: { price: number; link: string; note: string | null } | null;
  /** True when the Amazon listing is not for sale: the form says a confirmed price counts until it is again. */
  inactive: boolean;
}

/** The body of the confirm-price call, as the form builds it (`url` is the listing's link). */
export type ConfirmPriceRequest =
  | { kind: 'ebay-listing'; url: string; note?: string }
  | { kind: 'typed'; price: number; url: string; note?: string }
  /** Suggested prices (Nov 23): the part's suggestion as shown; the agent checks it against the one it holds now. */
  | { kind: 'suggested'; suggestion: { kind: 'amazon_average' | 'ebay_median'; price: number } };

export interface WayToSell {
  id: string;
  label: string;
  primary: boolean;
  profit: number | null;
  roi: number | null;
  roiRange: RoiRange | null;
  /** What this way leaves unsold. Empty when nothing. */
  leaves: string[];
  /** Nov 23: while a part of this way has no counted price: how many are priced and the break-even after fees. */
  incomplete?: { priced: number; total: number; breakEvenNet: number };
  /** Nov 23: when this way sells a kit as its parts: "Sold as PCL1600K2's 19 parts". */
  soldAs?: string;
}

export interface Estimate {
  profit: number;
  roi: number;
  roiRange: RoiRange | null;
  /** Bundle price with tax and inbound cost. */
  cost: number;
  /** The counted part prices before fees. */
  partsSellFor: number;
  /** What those parts net after referral and fulfillment. */
  afterFees: number;
  /** The fee settings in words; the agent's sentence, which also says it is an estimate. */
  basis: string;
  /** Items with no model number not counted (at $0) until he confirms a price. Never a model part (Nov 23). */
  countedAtZero: string[];
}

export interface DealDetail {
  id: string;
  title: string;
  brand: string;
  model: string;
  section: DealSection;
  price: number | null;
  off: number | null;
  seenAt: string | null;
  link: string | null;
  estimate: Estimate | null;
  /** The row's one-sentence verdict, in full (every row with an estimate carries one). */
  signalNote?: string | null;
  /** The estimate counts no fulfillment fee for `parts` of its `of` parts. */
  beforeFulfillment?: { parts: number; of: number } | null;
  /** Nov 23: in place of `estimate` while some model part has no counted price; null otherwise. */
  incomplete?: DealIncompleteEstimate | null;
  /** Why there is no estimate, in one sentence, when estimate is null. */
  noEstimate: string | null;
  ways: WayToSell[];
  parts: DealPart[];
  /** The open Review question on this bundle, if any. */
  questionId: string | null;
  asins: string[];
  lookup: { searches: number } | null;
  /** Whether the bundle is watched, by whom and since when; null when it never was. */
  watch: WatchState | null;
  /** The last scan's judgement of a watched bundle (core/src/tracking/signals.ts); null when not watched or before a scan. */
  signals: DealSignals | null;
  /** The stored scan points, oldest first. Nothing is filled in between them. */
  history: DealHistoryPoint[];
  /** The BOGO promotion he entered, with its estimate; null when none. */
  bogo: BogoView | null;
  /** BOGO found by the agent: the starter's pairs, ranked by each pair's estimate; null when the deal is in none. */
  bogoGroup: BogoGroup | null;
  /** How the split is known, each with its source: Home Depot part pages, the BOGO pair rule, a quote from the page. */
  splitEvidence?: SplitEvidence[];
  /** The estimate with Amazon's FBA fee estimate from Keepa, beside the main one; null when no part has a Keepa fee. */
  fbaEstimate: FbaEstimate | null;
}

// ------------------------------------------------------------------ GET /api/review

export interface Quote {
  text: string;
  source: Source;
}

export interface Choice {
  id: string;
  label: string;
  models: string[];
  asin: string | null;
  source: Source | null;
}

/**
 * verified: the code found the quotes and the answer names an offered choice.
 * unverified: the AI names an offered choice the code could not confirm (preselected, labelled Not verified).
 * unmatched: the AI's answer is none of the offered choices (none fits, or parts it typed in); nothing is preselected.
 * cannot_tell: the AI said the evidence does not settle it.
 */
export type SuggestionStatus = 'verified' | 'unverified' | 'unmatched' | 'cannot_tell';

export interface AiSuggestion {
  status: SuggestionStatus;
  /** The choice it proposes, when that is one of the choices. */
  choiceId: string | null;
  /** What it proposes in words ("PCL206 + PCL235"), or the listing. */
  answer: string;
  /** The AI's own reason: why it chose that, or why it could not tell. */
  reason: string | null;
  /** Why the code could not confirm it, in the code's words; null when verified. */
  notVerified?: string | null;
  /** Why it is not verified in plain words (the agent's suggestionPlain), when it says one. */
  plain?: string | null;
  quotes: Quote[];
  costUsd: number;
}

/**
 * The decision card's text, written once (by the AI when it can, by rules otherwise: `writtenBy`) so the pane shows a
 * fixed schema instead of a page of evidence. Optional: an older agent sends none and `briefFromQuestion` derives one.
 */
export interface ReviewBrief {
  /** What is asked, one short line: "What is inside this bundle?" */
  ask: string;
  /** The suggested answer in plain words: "PCL1600K2 kit + PBP2003 battery"; null when there is none. */
  suggestion: string | null;
  state: 'verified' | 'not_verified' | 'cannot_tell' | 'none';
  /** At most three short lines, each with the source it rests on when it has one. */
  reasons: { text: string; quote?: string; sourceLabel?: string; url?: string }[];
  /**
   * The one thing left to check, and where. `who: 'app'` is a step the app carries out itself (read a page, look up a
   * model): the card never shows it as an instruction. Only `who: 'owner'`, a call that needs a person's judgement, is
   * shown ("Next"). Absent from an older agent: `checkWho` decides from the words.
   */
  check: { text: string; url?: string; linkLabel?: string; who?: 'app' | 'owner' } | null;
  writtenBy: 'ai' | 'rules';
}

/** One thing the app did on its own while it worked on a question: what it did and what came of it. */
export interface FollowUpStep {
  /** "Searched Home Depot for RYOBI A21701" */
  what: string;
  /** "found: 15-Piece Router Bit Set" */
  result: string;
  url?: string;
}

/**
 * The app's own second look at a question, before it asks the owner (the agent carries out the steps a card used to
 * tell him to do). queued/running: the app is still working; done/gave_up: it finished, and `tried` is what it did.
 */
export interface FollowUp {
  state: 'queued' | 'running' | 'done' | 'gave_up';
  /** What it is doing now: "Reading Home Depot's page for A21701". */
  doing?: string;
  tried: FollowUpStep[];
  roundsLeft: number;
}

/** Whether the app is still on a question: it is not the owner's yet. */
export const isWorking = (f: FollowUp | undefined): boolean => f?.state === 'queued' || f?.state === 'running';

export interface ReviewQuestion {
  id: string;
  kind: QuestionKind;
  /** `id` is null when the question is not tied to a bundle the deals hold. */
  bundle: { id: string | null; title: string; brand: string; model: string; link: string | null };
  /** The model the question is about (a part, for match and eBay). */
  subject: string;
  prompt: string;
  reason: string;
  evidence: Quote[];
  choices: Choice[];
  allowNone: boolean;
  allowTyped: boolean;
  suggestion: AiSuggestion | null;
  /** What Ask AI costs here; null when no model call would be made. */
  askCostUsd: number | null;
  openedAt: string;
  /** The agent's signature of the question as shown; sent back with the answer so a changed question is refused. */
  seen: string | null;
  /** The decision card's text from the agent; absent from an older one (`briefFromQuestion` derives it). */
  brief?: ReviewBrief;
  /** What the app did on its own about this question; absent when it did nothing (or from an older agent). */
  followUp?: FollowUp;
  /** Parts of the one reading Home Depot's own pages confirmed, with what each is. Absent unless some were. */
  settledParts?: SettledPart[];
  /** The models the question is still about when some parts were confirmed. Absent unless some were. */
  unsettledParts?: string[];
}

/** A part Home Depot's page confirmed: its model, what the page says it is, and the page's link when there is one. */
export interface SettledPart {
  model: string;
  what: string;
  url?: string;
}

/** The agent's answer to Ask AI (POST /api/review/:id/ask): queued, or why nothing was started. */
export interface AskAiResult {
  queued: boolean;
  reason?: string;
  /** When nothing was queued: asking anyway (`force`) would start. Absent from an older agent (the words decide then). */
  canForce?: boolean;
  /** What asking anyway costs, in dollars, when the agent says. */
  costUsd?: number;
}

export interface ReviewView {
  questions: ReviewQuestion[];
}

// ------------------------------------------------------------------ GET /api/activity

export interface Run {
  id: string;
  kind: 'scan' | 'ask' | 'lookup' | 'verify';
  byYou: boolean;
  startedAt: string;
  finishedAt: string | null;
  searches: number;
  keepaTokens: number;
  aiUsd: number;
  result: ScanResult | 'running';
  summary: string;
  /** What went wrong, in one sentence, or null. */
  error: string | null;
  /** The scan's stages at its end. */
  steps: { label: string; state: string; figure: string }[];
}

export interface AutopilotEntry {
  id: string;
  at: string;
  bundleId: string | null;
  /** The bundle's title when the deals still hold it; else the model, else the question. */
  title: string;
  model: string | null;
  kind: QuestionKind;
  /** What it applied, in plain words. */
  applied: string;
  /** The checks the code ran on the suggestion before applying it. */
  verifiedBy: string[];
  /** The model that suggested it, "claude-haiku-4-5". */
  by: string | null;
  undone: boolean;
  /** False once the owner changed the answer since: Undo would undo the owner's answer. */
  undoable: boolean;
}

/** An answer the owner saved himself, kept so Undo can reopen the question (the newest 50). */
export interface OwnerAnswer {
  id: string;
  questionId: string;
  /** The bundle's title. */
  title: string;
  /** What he answered, in plain words. */
  answer: string;
  at: string;
  undone: boolean;
  /** False once a later scan or answer changed what it saved, or after it was undone. */
  undoable: boolean;
}

export interface ActivityView {
  runs: Run[];
  autopilot: AutopilotEntry[];
  /** The answers he saved, newest first. */
  answers: OwnerAnswer[];
  errors: ActivityError[];
  /** What he recorded about purchases and sales, one sentence each, newest first, with Undo while it applies. */
  outcomes: OutcomeEntry[];
  /** This month's spend, from the agent's own count. */
  month: { searches: number; keepaTokens: number; aiUsd: number };
}

// ------------------------------------------------------------------ GET /api/events

export type AgentEvent =
  | { type: 'state'; state: AppState }
  | { type: 'deals' }
  | { type: 'review' }
  | { type: 'activity' }
  | { type: 'notify'; title: string; body: string };

/** The connection to the event stream: 'live' while it delivers, 'down' while it retries. */
export type StreamStatus = 'live' | 'down';

// ------------------------------------------------------------------ errors

/** Every failed call becomes one of these, with a sentence that says what to do. */
export type ApiErrorKind = 'offline' | 'unauthorized' | 'refused' | 'server';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
