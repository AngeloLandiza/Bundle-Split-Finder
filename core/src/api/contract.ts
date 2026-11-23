// The agent's HTTP contract (step 13, Decision 3): one set of types for the agent, the desktop UI and
// the extension. Pure TypeScript; nothing here touches the network or chrome.*.
//
// Every /api request carries `Authorization: Bearer <token>` (see docs/decisions.md, step 13), except
// the two pairing calls an unpaired extension makes (POST /api/pair/request, POST /api/pair/claim).
// The app's token is in <app-data>/agent-token (UI_TOKEN_FILE); the shell injects it into the webview
// as window.__SPLIT_FINDER_TOKEN__. A paired extension gets its own token from POST /api/pair/claim.
// A failed request answers with an HTTP status and an ApiErrorBody. No response ever holds a key.

import type { PipelineAiSettings } from '../ai/factory';
import type { StoredSuggestion } from '../assist/stored';
import type { HomeDepotPage, HomeDepotSearch, ToolError } from '../research/types';
import type { DealSortKey } from '../deals/sort';
import type { FeeSettings } from '../money';
import type { Schedule } from '../schedule';
import type { PipelineView } from '../scan/pipeline';
import type { AlertSettings, DiscoveryMode, EbaySettings, TrackingDepth } from '../settings';
import type { BundleRow, EbayQuestion, PageOutcome, PaidAction, PartPriceReading, ReportSection, ReviewItem } from '../scan/types';

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

/** Body of PUT /api/keys/:name, per key. Answered by KeysPresence; DELETE /api/keys/:name removes it. */
export interface KeyValues {
  serpapi: { key: string };
  keepa: { key: string };
  anthropic: { key: string };
  openai: { key: string };
  ebay: { appId: string; certId: string };
  telegram: { botToken: string; chatId: string };
}

export type KeysPresence = Record<KeyName, boolean>;

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
}

/** GET /api/state, and the payload of the `state` event. */
export interface AgentState {
  agent: {
    status: AgentStatus;
    step?: string;
    progress?: { done: number; total: number };
    nextScanAt: string | null;
    lastScan: LastScanSummary | null;
    /** W4: the running scan's stages as core's pipeline view says them (absent when nothing runs). */
    pipeline?: PipelineView;
    /** W4: what the agent is busy with: a scan, or the AI pass on Review questions. */
    busy?: 'scan' | 'ask' | null;
  };
  /** The paired Chrome extension, the worker that reads Home Depot pages. `jobsWaiting`: reads waiting for it (W4). */
  helper: { paired: boolean; connected: boolean; lastSeenAt: string | null; jobsWaiting?: number };
  budget: {
    serpLeft: number | null;
    /** W4: the plan's searches a month, from the last account check; null before one. */
    serpMonthly?: number | null;
    /** W4: searches one scan may use (Settings). */
    serpPerScan?: number;
    serpReserve: number;
    keepaTokens: number | null;
    aiSpentUsd: number;
    aiCapUsd: number | null;
  };
  counts: { review: number; autopilotApplied: number; newDeals: number; jobsWaiting: number };
  keys: KeysPresence;
  /** W4: true until the first scan has finished (the one-time first-run flow). */
  firstRun?: boolean;
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
  bundle: { brand: string; model: string; title: string; itemId: string | null; link: string | null };
  section: ReportSection;
  price: number | null;
  regularPrice: number | null;
  /** Percent off Home Depot's regular price. */
  off: number | null;
  /** One line on how far the parts are matched ("2 of 3 parts matched"), or null. */
  matchState: string | null;
  profit: number | null;
  roi: number | null;
  roiRange: { low: number | null; high: number | null };
  needsAnswer: boolean;
  /** When Home Depot's price was seen (ISO), or when the row was stored. */
  updatedAt: string;
  /** W4: searches a Look up of the bundle's unmatched parts would spend now; null when every part is looked up. */
  lookup?: { searches: number } | null;
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
  /** Parts no priced listing covers, counted at $0 (the liquidation rate is 0). */
  countedAtZero: string[];
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
}

/** W4: GET /api/deals/:id/lookup (the quote shown before the click) and the answer to POST /api/deals/:id/lookup and /verify. */
export interface PaidResponse {
  searches: number;
}

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
  /** The question as the scan stored it. */
  item: { kind: 'split' | 'match'; question: ReviewItem } | { kind: 'ebay'; question: EbayQuestion };
}

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

/** POST /api/review/ask-all and /api/review/:id/ask: the agent asks in the background. */
export interface QueuedResponse {
  queued: true;
}

/** W4: POST /api/review/:id/answer. The agent applies the answer itself (core/src/scan/answers.ts). */
export interface AnswerResponse {
  applied: true;
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
  /** Dollars the AI may cost in a calendar month (judge, assist and research together). 0 turns the AI off. */
  monthlyCapUsd: number;
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
}

/** GET /api/settings and the answer to PATCH /api/settings (whose body is a SettingsPatch). */
export interface SettingsResponse {
  updatedAt: string;
  settings: AppSettings;
  keys: KeysPresence;
}

export type SettingsPatch = Partial<Omit<AppSettings, 'settings' | 'ebaySettings' | 'alerts' | 'ai'>> & {
  settings?: Partial<AppSettings['settings']>;
  ebaySettings?: Partial<EbaySettings>;
  alerts?: Partial<AlertSettings>;
  ai?: Partial<Omit<AiAgentSettings, 'judge' | 'assist' | 'research'>> & {
    judge?: Partial<AiPipelineSetting>;
    assist?: Partial<AiPipelineSetting>;
    research?: Partial<AiPipelineSetting>;
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
}

export type WorkerJobKind = keyof WorkerJobInputs;
export const WORKER_JOB_KINDS: readonly WorkerJobKind[] = ['page', 'kitPage', 'partPrice', 'search', 'researchPage'];

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
export type WorkerResultBody = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/** POST /api/worker/heartbeat: `jobId` names the job the helper is running, so the agent extends its lease (additive; omitted when idle). */
export interface WorkerHeartbeatBody {
  jobId?: string;
}

export interface WorkerResultResponse {
  status: WorkerJobStatus;
}

// ---------------------------------------------------------------- events (GET /api/events)

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
  review: { at: string | null; open: number; counts: { review: number } };
  activity: { at: string };
  notify: NotifyEvent;
}

export type AgentEventName = keyof AgentEvents;

// ---------------------------------------------------------------- re-exports used by clients

export type { DealSortKey, PaidAction, ReportSection };
