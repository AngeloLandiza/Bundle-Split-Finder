// What the screens read. The agent's contract (core/src/api/contract.ts) is the source of truth: every
// type that is the same on the wire is re-exported from it here, and the few shapes a screen wants in
// another form (a flatter row, a labelled price line, the pipeline in words) are defined below and
// built from the contract in one place, map.ts. Nothing here is mirrored by hand.

import type { ActivityError, KeyName, ReportSection, ReviewKind } from '@core/api/contract';
import type { PipelineView } from '@core/scan/pipeline';

export type {
  ActivityError,
  AppSettings,
  KeyName,
  KeysPresence,
  PairedExtension,
  PendingPairRequest,
  ReviewAnswer,
  SettingsPatch,
} from '@core/api/contract';
export type { Schedule } from '@core/schedule';
export type { PipelineView } from '@core/scan/pipeline';

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
}

export interface HelperState {
  paired: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  /** Home Depot read jobs waiting for Chrome. */
  jobsWaiting: number;
}

export interface BudgetState {
  /** Null until the agent has checked the SerpApi account once. */
  serpLeft: number | null;
  serpMonthly: number | null;
  serpReserve: number;
  serpPerScan: number;
  keepaTokens: number | null;
  aiSpentUsd: number;
  aiCapUsd: number | null;
}

export interface AppState {
  agent: AgentView;
  helper: HelperState;
  budget: BudgetState;
  counts: { review: number; autopilotApplied: number; newDeals: number };
  keys: Record<KeyName, boolean>;
  /** True until the first scan has finished; drives the one-time first-run flow. */
  firstRun: boolean;
}

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
  updatedAt: string;
  /** Parts still to look up and what that costs, for "Look up · 2 searches". */
  lookup: { searches: number } | null;
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
}

export interface WayToSell {
  id: string;
  label: string;
  primary: boolean;
  profit: number | null;
  roi: number | null;
  roiRange: RoiRange | null;
  /** What this way leaves unsold. Empty when nothing. */
  leaves: string[];
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
  /** Parts counted at $0: no priced listing chosen. */
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
  /** Why there is no estimate, in one sentence, when estimate is null. */
  noEstimate: string | null;
  ways: WayToSell[];
  parts: DealPart[];
  /** The open Review question on this bundle, if any. */
  questionId: string | null;
  asins: string[];
  lookup: { searches: number } | null;
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

export type SuggestionStatus = 'verified' | 'unverified' | 'cannot_tell';

export interface AiSuggestion {
  status: SuggestionStatus;
  /** The choice it proposes, when that is one of the choices. */
  choiceId: string | null;
  /** What it proposes in words ("PCL206 + PCL235"), or the listing. */
  answer: string;
  /** Why it could not tell, or why the code could not confirm it. */
  reason: string | null;
  quotes: Quote[];
  costUsd: number;
}

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

export interface ActivityView {
  runs: Run[];
  autopilot: AutopilotEntry[];
  errors: ActivityError[];
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
