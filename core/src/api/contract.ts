// The agent's HTTP contract (step 13, Decision 3): one set of types for the agent, the desktop UI and
// the extension. Pure TypeScript; nothing here touches the network or chrome.*.
//
// Every /api request carries `Authorization: Bearer <token>` (see docs/decisions.md, step 13), except
// the two pairing calls an unpaired extension makes (POST /api/pair/request, POST /api/pair/claim).
// The app's token is in <app-data>/agent-token (UI_TOKEN_FILE); the shell injects it into the webview
// as window.__SPLIT_FINDER_TOKEN__. A paired extension gets its own token from POST /api/pair/claim.
// A failed request answers with an HTTP status and an ApiErrorBody. No response ever holds a key.

import type { StoredSuggestion } from '../assist/stored';
import type { DealSortKey } from '../deals/sort';
import type { FeeSettings } from '../money';
import type { Schedule } from '../schedule';
import type { EbaySettings } from '../settings';
import type { BundleRow, EbayQuestion, PaidAction, ReportSection, ReviewItem } from '../scan/types';

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
  };
  /** The paired Chrome extension, the worker that reads Home Depot pages. */
  helper: { paired: boolean; connected: boolean; lastSeenAt: string | null };
  budget: {
    serpLeft: number | null;
    serpReserve: number;
    keepaTokens: number | null;
    aiSpentUsd: number;
    aiCapUsd: number | null;
  };
  counts: { review: number; autopilotApplied: number; newDeals: number; jobsWaiting: number };
  keys: KeysPresence;
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

/** GET /api/deals/:id. `bundle` holds the parts with every labelled price and the ways to sell. */
export interface DealDetail {
  row: DealRow;
  bundle: BundleRow;
  sources: SourceLink[];
  /** Always says it is an estimate (CLAUDE.md rule 5). */
  estimateBasis: string;
}

// ---------------------------------------------------------------- review

export type ReviewKind = 'split' | 'match' | 'ebay';

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
  /** The question as the scan stored it. */
  item: { kind: 'split' | 'match'; question: ReviewItem } | { kind: 'ebay'; question: EbayQuestion };
}

export interface ReviewResponse {
  at: string | null;
  questions: ReviewQuestion[];
}

/** POST /api/review/:id/answer. */
export type ReviewAnswer = { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' };

export interface ReviewAnswerBody {
  answer: ReviewAnswer;
  /** True when the owner approved the AI suggestion, so its outcome is tracked. */
  fromSuggestion?: boolean;
}

/** POST /api/review/approve: apply the AI suggestion of each question named. */
export interface ApproveBody {
  ids: string[];
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
}

export interface ActivityResponse {
  runs: RunRecord[];
  spend: { serpSearches: number; keepaTokens: number; aiUsd: number; since: string };
  autopilot: AutopilotEntry[];
}

// ---------------------------------------------------------------- settings

/** Every setting the owner can change; keys are not here (see KeyValues). */
export interface AppSettings {
  /** When true, the extension takes settings and scan requests from the app. */
  appPrimaryUi: boolean;
  compactHelperPanel: boolean;
  askAfterScan: boolean;
  /** Decision 5: apply verified AI suggestions without the owner, with Undo. */
  autopilot: boolean;
  ebaySettings: EbaySettings;
  settings: {
    schedule: Schedule;
    searchesPerScan: number;
    reserve: number;
    agentBridgeAfterScan: boolean;
    keepaTokensPerScan: number;
    keepaReserve: number;
    fees: FeeSettings;
    brands: string[];
    pagesPerBrand: number;
  };
}

/** GET /api/settings and the answer to PATCH /api/settings (whose body is a SettingsPatch). */
export interface SettingsResponse {
  updatedAt: string;
  settings: AppSettings;
  keys: KeysPresence;
}

export type SettingsPatch = Partial<Omit<AppSettings, 'settings' | 'ebaySettings'>> & {
  settings?: Partial<AppSettings['settings']>;
  ebaySettings?: Partial<EbaySettings>;
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
  /** Read one part's Home Depot price. */
  partPrice: { itemId: string; model: string };
  /** A Home Depot search results page. */
  search: { query: string; page: number };
}

export type WorkerJobKind = keyof WorkerJobInputs;
export const WORKER_JOB_KINDS: readonly WorkerJobKind[] = ['page', 'kitPage', 'partPrice', 'search'];

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

/** Server-sent events: `event: <name>` with `data: <json>`. The shell turns `notify` into a native notification. */
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
