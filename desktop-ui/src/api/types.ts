// The desktop UI's view of the agent's API, mirrored from the step 13 contract outline
// (docs/superpowers/plans/2026-11-22-step-13-agent-workplace.md). W1 owns the real types in
// core/src/api/; at merge this file re-exports them and the screens keep compiling.
// Where the outline is silent, the shape here is the UI's request to W1, marked "UI asks".

// ------------------------------------------------------------------ GET /api/state

export type KeyName = 'serpapi' | 'keepa' | 'anthropic' | 'openai' | 'ebay' | 'telegram';

export type ScanResult = 'finished' | 'stopped' | 'limit' | 'failed';

export interface ScanStep {
  /** Plain words: "Checking eBay listings". */
  name: string;
  /** 1-based position of this step in the run, and how many steps the run has. */
  index: number;
  of: number;
  /** The step's own count, "23 of 60". */
  done: number | null;
  total: number | null;
}

export interface AgentProgress {
  /** 0..1, for the 2px bar. */
  fraction: number;
  /** Seconds left, or null while estimating. */
  etaSeconds: number | null;
  searchesUsed: number;
  aiSpentUsd: number;
}

export interface LastScan {
  at: string;
  result: ScanResult;
  newDeals: number;
  searches: number;
  /** One sentence for stopped, limit and failed. */
  message: string | null;
}

export interface AgentState {
  /** paused: the owner paused the agent (POST /api/agent/pause); no scheduled scan runs until Resume. */
  status: 'idle' | 'scanning' | 'asking' | 'stopping' | 'paused';
  step: ScanStep | null;
  progress: AgentProgress | null;
  nextScanAt: string | null;
  lastScan: LastScan | null;
}

export interface HelperState {
  paired: boolean;
  connected: boolean;
  lastSeenAt: string | null;
  /** UI asks: Home Depot read jobs waiting for Chrome. */
  jobsWaiting: number;
}

export interface BudgetState {
  serpLeft: number;
  /** UI asks: the plan's monthly searches, for the meter and the forecast. */
  serpMonthly: number;
  serpReserve: number;
  /** UI asks: searches one scan may use, for "Scan now · 5 searches". */
  serpPerScan: number;
  keepaTokens: number | null;
  aiSpentUsd: number;
  aiCapUsd: number | null;
}

export interface AppState {
  agent: AgentState;
  helper: HelperState;
  budget: BudgetState;
  counts: { review: number; autopilotApplied: number; newDeals: number };
  keys: Record<KeyName, boolean>;
  /** UI asks: true until the first scan has finished; drives the one-time first-run flow. */
  firstRun: boolean;
}

// ------------------------------------------------------------------ GET /api/deals

export type DealSection = 'confirmed' | 'waiting' | 'inactive_listing' | 'missing_listing' | 'split';

export type MatchState = 'verified' | 'title_match' | 'needs_answer' | 'waiting' | 'missing' | 'inactive' | 'contents_unknown';

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
  matchState: MatchState;
  profit: number | null;
  roi: number | null;
  roiRange: RoiRange | null;
  needsAnswer: boolean;
  updatedAt: string;
  /** UI asks: parts still to look up and what that costs, for "Look up · 2 searches". */
  lookup: { searches: number } | null;
}

export interface DealsResponse {
  rows: DealRow[];
  /** When the deals were last refreshed. */
  at: string | null;
  /** One sentence when a scan skipped its eBay step; not an error. */
  ebayNotice: string | null;
}

// ------------------------------------------------------------------ GET /api/deals/:id

export interface Source {
  /** "Home Depot page", "Amazon listing", "Keepa", "eBay listing 2", "ryobitools.com". */
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
  /** "3 listings, 41 sold", "seen 2 days ago". */
  note: string | null;
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
  /** What this way leaves unsold: "18V Charger", "Tool bag". Empty when nothing. */
  leaves: string[];
}

export interface Estimate {
  profit: number;
  roi: number;
  roiRange: RoiRange | null;
  /** Bundle price with tax and inbound cost. */
  cost: number;
  /** Sum of counted part prices (Amazon New), before fees. */
  partsSellFor: number;
  /** What those parts net after referral and fulfillment. */
  afterFees: number;
  /** The fee settings the estimate used, in words: "15% referral, $5.50 fulfillment, 8% tax". */
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
  /** The Home Depot product page. */
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

export type QuestionKind = 'split' | 'match' | 'ebay';

export interface Quote {
  text: string;
  source: Source;
}

export interface Choice {
  id: string;
  /** "DCF891B, DCD805B", or a listing title. */
  label: string;
  /** Set in the figure face. */
  models: string[];
  asin: string | null;
  source: Source | null;
}

export type SuggestionStatus = 'verified' | 'unverified' | 'cannot_tell';

export interface AiSuggestion {
  status: SuggestionStatus;
  /** The choice it proposes, when that is one of the choices. */
  choiceId: string | null;
  /** Parts it proposes in words ("PCL206 + PCL235"), or the listing. */
  answer: string;
  /** Why it could not tell, or why the code could not confirm it. */
  reason: string | null;
  quotes: Quote[];
  costUsd: number;
}

export interface ReviewQuestion {
  id: string;
  kind: QuestionKind;
  bundle: { id: string; title: string; brand: string; model: string; link: string | null };
  /** The model the question is about (a part, for match and eBay). */
  subject: string;
  /** "Which impact wrench comes with this kit?" */
  prompt: string;
  /** Why the tool could not decide, one sentence. */
  reason: string;
  evidence: Quote[];
  choices: Choice[];
  allowNone: boolean;
  allowTyped: boolean;
  suggestion: AiSuggestion | null;
  /** What Ask AI costs here; null when no model call would be made. */
  askCostUsd: number | null;
  openedAt: string;
}

export interface ReviewResponse {
  questions: ReviewQuestion[];
  /** The last Ask AI about all, one sentence, or null. */
  lastAsk: string | null;
}

export type ReviewAnswer = { choiceId: string } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' };

// ------------------------------------------------------------------ GET /api/activity

export interface Run {
  id: string;
  kind: 'scan' | 'ask_all' | 'lookup' | 'verify';
  trigger: 'schedule' | 'you';
  startedAt: string;
  finishedAt: string | null;
  searches: number;
  keepaTokens: number;
  aiUsd: number;
  result: ScanResult | 'running';
  /** "12 bundles, 3 new above 20% ROI." */
  summary: string;
}

export interface AutopilotEntry {
  id: string;
  at: string;
  bundle: { id: string; title: string; model: string };
  kind: QuestionKind;
  /** What it applied: "PCL206 + PCL235 + PCL500". */
  answer: string;
  quote: Quote | null;
  undone: boolean;
}

export interface ActivityError {
  id: string;
  at: string;
  /** What happened and what to do, one sentence. */
  sentence: string;
  retry: { label: string; searches: number; usd: number } | null;
}

export interface ActivityResponse {
  runs: Run[];
  autopilot: AutopilotEntry[];
  errors: ActivityError[];
  month: { searches: number; keepaTokens: number; aiUsd: number };
}

// ------------------------------------------------------------------ GET/PATCH /api/settings

export type Schedule = { mode: 'manual' } | { mode: 'interval'; hours: number } | { mode: 'daily'; at: string };

export type Pipeline = 'judge' | 'assist' | 'research';
export type Provider = 'anthropic' | 'openai_compatible';

export interface Settings {
  schedule: Schedule;
  searchesPerScan: number;
  reserve: number;
  brands: string[];
  fees: { referralRate: number; fulfillmentFee: number; minReferral: number; salesTaxRate: number; inboundCost: number };
  ai: {
    pipelines: Record<Pipeline, { provider: Provider; model: string }>;
    autopilot: boolean;
    monthlyCapUsd: number;
    /** OpenAI-compatible base URL (DeepSeek and others). */
    openaiBaseUrl: string;
  };
  alerts: {
    roiThreshold: number;
    profitThreshold: number;
    digest: 'each_scan' | 'daily' | 'off';
    telegramChatId: string;
  };
}
// Launch at login is the shell's, not the agent's: Settings reads and sets it through Tauri's invoke.

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K];
};

// ------------------------------------------------------------------ GET /api/events

export type AgentEvent =
  | { type: 'state'; state: AppState }
  | { type: 'deals' }
  | { type: 'review' }
  | { type: 'activity' }
  | { type: 'notify'; title: string; body: string };

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
