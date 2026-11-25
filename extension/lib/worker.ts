// The service worker's logic, with everything Chrome-specific passed in (see background.ts).
// It holds the SerpApi key, checks the account (free), builds each scan's budget from the
// owner's settings, runs scans one at a time, and answers the pages. Chrome may stop the
// worker at any moment, so nothing here relies on memory surviving: the one-minute alarm
// calls onTick, and every tick either continues an interrupted scan or starts one that is due.
// "Rule n" refers to the step 3 plan, Task 5 ("The service worker").

import { ClaudeAssist } from '@core/assist/claude';
import { gatherEvidence } from '@core/assist/evidence';
import { askQueueOf } from '@core/assist/askAll';
import { askAllShownCost, estimatedQuestionCost } from '@core/assist/cost';
import { PRICE_TABLE } from '@core/judge/eval';
import { ClaudeResearch } from '@core/research/claude';
import { researchCost } from '@core/research/eval';
import { researchQuestion } from '@core/research/loop';
import type { CatalogEntry, ResearchTools } from '@core/research/types';
import { agreedWith, liveSuggestion, MemorySuggestionStore, suggestionCost, suggestionKey, type StoredSuggestion, type SuggestionStore } from '@core/assist/stored';
import { suggestAnswer } from '@core/assist/suggest';
import { AnswerRefused, applyReviewAnswer, reopenReviewAnswer, reviewSignature } from '@core/scan/answers';
import { EbayClient } from '@core/ebay/client';
import { ClaudeJudge } from '@core/judge/claude';
import { applyEbayAnswer, ebayLabelsOf } from '@core/scan/ebayAnswers';
import { EBAY_ITEM_READS_MAX, EBAY_SEARCHES_MAX, type EbayStep, JUDGE_CALL_TIMEOUT_MS } from '@core/scan/ebayPass';
import type { ProductPage } from '@core/hdPage';
import { notePage } from '@core/scan/pageView';
import { PaidProblem, type ProductPage as AmazonProductPage, type QuoteKeepaOpts, quotePaid, refusalFor, requestProblem, runPaid, savedAnswers } from '@core/scan/paid';
import { wantedFor } from '@core/scan/classify';
import { addSamples, samplesOf, type UnitRates } from '@core/scan/pipeline';
import { runScan } from '@core/scan/runner';
import { knownModels } from '@core/scan/split';
import { CONFIRMED_BRAND_MAX, CONFIRMED_MODEL_MAX, parseConfirmedPrice } from '@core/scan/confirmed';
import { kitPageTarget } from '@core/scan/kitPage';
import { partKey, type BudgetView, type BundleRow, type PageOutcome, type PageReading, type PaidAction, type Quote, type ReadPages, type ReadPartPrices, type ReviewAnswer, type ScanJob, type ScanStore } from '@core/scan/types';
import { TokenBudget } from '@core/keepa/budget';
import { KeepaClient } from '@core/keepa/client';
import { type KeepaLookupAsk, keepaPartLookup, keepaProductSearchResult } from '@core/keepa/fetchStep';
import type { KeepaScaleSettings } from '@core/keepa/plan';
import { bundlesNewlyConfirmed, partPriceDropMessage, reviewDigestMessage, trendCrosses } from '@core/keepa/alerts';
import { readAlertBaseline, writeAlertBaseline, writePartTrend } from '@core/keepa/trends';
import { relayPayload } from '@core/relay';
import { type AccountInfo, SearchBudget } from '@core/serpapi/budget';
import { type Cache, type LedgerEntry, SerpApiClient, SerpApiError } from '@core/serpapi/client';
import {
  budgetPolicyFor, dealsToNotify, DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS, estimateRoiPercent, type EbaySettings, ebaySettingsProblem, type ExtensionSettings, type ScanTrigger, type SettingsField, toScanSettings, validateSettings,
} from '@core/settings';
import { runCsv } from '@core/scan/csv';
import { buildReport } from '@core/scan/report';
import { postScanWork } from '@core/scan/postScan';
import { nextRun, type Schedule } from '@core/schedule';
import { cachingTokenFetch, checkEbayKeys, type TokenStore } from './ebayEnv';
import type { AppState, AskAllResult, OpenThisPageReply, Packaging, PageSeenReply, PanelReport, Reply, Request, ThisPage } from './messages';
import type { ActiveScan, CachedEbayToken, EbayKeys, StoredAccount } from './prefs';

/**
 * Step 12: asks the owner's model one Review question and returns what it drafted. It stores nothing and answers nothing: the worker
 * keeps what comes back as a suggestion (never as the question's answer), unless the call was aborted. `signal` is aborted by Stop.
 * Throws for a question that is not there or already answered; a failed call is a `not_suggested` suggestion. Today it is the
 * evidence-only path of step 11; the controller routes split questions to research by passing its own.
 */
export type AskOne = (questionId: string, signal: AbortSignal) => Promise<StoredSuggestion>;

/** The functions of prefs.ts the worker uses, with the same names and signatures. */
export interface Prefs {
  getKey(): Promise<string | null>;
  setKey(key: string): Promise<void>;
  forgetKey(): Promise<void>;
  restrictKeyAccess(): Promise<void>;
  getSettings(): Promise<ExtensionSettings>;
  saveSettings(s: ExtensionSettings): Promise<void>;
  getActiveScan(): Promise<ActiveScan | null>;
  setActiveScan(v: ActiveScan | null): Promise<void>;
  getLastScheduledRunAt(): Promise<number | null>;
  setLastScheduledRunAt(v: number | null): Promise<void>;
  getNotified(): Promise<string[]>;
  setNotified(v: string[]): Promise<void>;
  getDiscoverySections?(): Promise<Record<string, string> | null>;
  setDiscoverySections?(v: Record<string, string>): Promise<void>;
  clearDiscoverySections?(): Promise<void>;
  getRelayConfig?(): Promise<{ url: string; secret: string } | null>;
  setRelayConfig?(cfg: { url: string; secret: string }): Promise<void>;
  forgetRelayConfig?(): Promise<void>;
  getPackaging(): Promise<Record<string, Packaging>>;
  savePackaging(v: Record<string, Packaging>): Promise<void>;
  getAccount(): Promise<StoredAccount | null>;
  setAccount(v: StoredAccount | null): Promise<void>;
  /** Whether the chip shows on Home Depot pages (chrome.storage.local `showChip`); true unless the owner turned it off. */
  getShowChip(): Promise<boolean>;
  /** Step 11: how long a unit of each kind took in recent scans, for the progress estimate. Optional: without it no timing is kept. */
  getRates?(): Promise<UnitRates>;
  setRates?(v: UnitRates): Promise<void>;
  /** Step 12: whether a finished scan is followed by Ask AI about all (off by default). Optional: without it the setting is off. */
  getAskAfterScan?(): Promise<boolean>;
  setAskAfterScan?(v: boolean): Promise<void>;
  /** Step 10: the eBay App ID and Cert ID, the Anthropic key, the judge's settings, and eBay's token (storage.session). */
  getEbayKeys(): Promise<EbayKeys | null>;
  setEbayKeys(keys: EbayKeys): Promise<void>;
  forgetEbayKeys(): Promise<void>;
  getAnthropicKey(): Promise<string | null>;
  setAnthropicKey(key: string): Promise<void>;
  forgetAnthropicKey(): Promise<void>;
  getKeepaKey(): Promise<string | null>;
  setKeepaKey(key: string): Promise<void>;
  forgetKeepaKey(): Promise<void>;
  getKeepaAccount?(): Promise<{ tokensLeft: number; refillIn: number; at: number } | null>;
  setKeepaAccount?(v: { tokensLeft: number; refillIn: number; at: number }): Promise<void>;
  getEbaySettings(): Promise<EbaySettings>;
  saveEbaySettings(s: EbaySettings): Promise<void>;
  getEbayToken(): Promise<CachedEbayToken | null>;
  setEbayToken(t: CachedEbayToken): Promise<void>;
  clearEbayToken(): Promise<void>;
}

/**
 * What the chip's page visits need from Chrome, and what must outlive the worker (chrome.storage.session in the
 * extension). Everything is by tab id.
 */
export interface DeferredPage {
  page: ProductPage;
  /** env.now() at the visit. */
  seenAt: number;
}

export interface PageEnv {
  /**
   * The page of a visit that is not stored yet, kept so that a restarted worker still stores it. One entry for each tab
   * and item id, so the pages a tab showed one after the other during a scan are all kept.
   */
  setDeferred(tabId: number, itemId: string, entry: DeferredPage | null): Promise<void>;
  deferredAll(): Promise<({ tabId: number } & DeferredPage)[]>;
  /** The Home Depot bundle page the tab last showed, or null. */
  load(tabId: number): Promise<ProductPage | null>;
  save(tabId: number, page: ProductPage | null): Promise<void>;
  /** "Show This page" for the tab: set when the chip opened the panel, cleared when the panel takes it. */
  setWanted(tabId: number, on: boolean): Promise<void>;
  wanted(tabId: number): Promise<boolean>;
  /** chrome.sidePanel.open({ tabId }). Called at once from the click's message, which Chrome counts as the user's action. Rejects when Chrome refuses. */
  openPanel(tabId: number): Promise<void>;
  /** Tells every open panel that the chip opened it for this tab. */
  tell(tabId: number): void;
  /** True for the tab the reader opened to read a bundle page for a scan (hdReader's remembered doorway tab). */
  isReaderTab(tabId: number): Promise<boolean>;
  /** The tabs whose content script has sent a page, so a change of the chip setting reaches them. */
  chipTabs(): Promise<number[]>;
  setChipTab(tabId: number, on: boolean): Promise<void>;
  /** chrome.tabs.sendMessage(tabId, { type: 'chipSetting', show }). Rejects when the tab has no content script. */
  sendChipSetting(tabId: number, show: boolean): Promise<void>;
}

/** Pages kept in memory, for a worker with no `pages`: lost with the worker, and the side panel cannot be opened. */
export function memoryPages(): PageEnv {
  const pages = new Map<number, ProductPage>();
  const wanted = new Set<number>();
  const chipTabs = new Set<number>();
  const deferred = new Map<string, { tabId: number } & DeferredPage>();
  return {
    setDeferred: async (tabId, itemId, entry) =>
      void (entry === null ? deferred.delete(`${tabId}:${itemId}`) : deferred.set(`${tabId}:${itemId}`, { tabId, ...entry })),
    deferredAll: async () => [...deferred.values()],
    load: async (tabId) => pages.get(tabId) ?? null,
    save: async (tabId, page) => void (page === null ? pages.delete(tabId) : pages.set(tabId, page)),
    setWanted: async (tabId, on) => void (on ? wanted.add(tabId) : wanted.delete(tabId)),
    wanted: async (tabId) => wanted.has(tabId),
    openPanel: () => Promise.reject(new Error('No side panel here.')),
    tell: () => {},
    isReaderTab: async () => false,
    chipTabs: async () => [...chipTabs],
    setChipTab: async (tabId, on) => void (on ? chipTabs.add(tabId) : chipTabs.delete(tabId)),
    sendChipSetting: () => Promise.reject(new Error('No tabs here.')),
  };
}

export interface WorkerEnv {
  store: ScanStore;
  /** The saved SerpApi responses. clear() empties them and nothing else. */
  cache: Cache & { clear(): Promise<void> };
  prefs: Prefs;
  /** Called once for every search that counted against the quota. */
  ledger: (entry: LedgerEntry) => void | Promise<void>;
  fetchFn: typeof fetch;
  now: () => number;
  /** Shows the deals that cleared the alert numbers, at most three. */
  notify: (rows: BundleRow[]) => void | Promise<void>;
  /** Optional desktop line for scan digests (Review, discovery complete). */
  notifyText?: (message: string) => void | Promise<void>;
  /** Optional signed POST after a scan (plan Phase 4). */
  relayPost?: (url: string, body: string, signature: string) => Promise<void>;
  /** Chrome host permission for a saved relay origin (MV3). */
  requestHostPermission?: (originPattern: string) => Promise<boolean>;
  /** Tells every open page the new state. */
  broadcast: (state: AppState) => void;
  /** Default https://serpapi.com, for the Account API and for searches. */
  baseUrl?: string;
  /** Reads bundle pages in the owner's browser; without it no page is read. */
  readPages?: ReadPages;
  /** Reads Home Depot's own price of parts sold alone in the owner's browser (step 9); without it none is read. */
  readPartPrices?: ReadPartPrices;
  /** Step 10: longest one eBay or model call may take, in ms; default 30 s. A call that runs out is skipped, never a result. */
  callTimeoutMs?: number;
  /** Step 10: where eBay's API is, for the end-to-end build (the replay server). Default https://api.ebay.com. */
  ebayBaseUrl?: string;
  /**
   * Step 10: the fetch the listing judge's calls go through, for the end-to-end build (which sends the Anthropic address
   * to the replay server). Default `fetchFn`. The judge's address is fixed in core, so no setting can send the key elsewhere.
   */
  judgeFetchFn?: typeof fetch;
  /** The chip's page visits (step 7). Without it, pages are kept in memory and the panel cannot be opened from the chip. */
  pages?: PageEnv;
  /**
   * Step 13: true while this browser is paired with the Split Finder app. The app runs scans, AI and answers then, so a
   * scheduled or manual scan here is refused and the tick starts nothing. Absent: never paired (standalone, as before).
   */
  paired?: () => Promise<boolean>;
  /** Step 11: where Ask AI keeps its suggestions, apart from the scan's store. Without it they are kept in memory, lost with the worker. */
  suggestions?: SuggestionStore;
  /** Step 12: how one question is asked, for Ask AI and for Ask AI about all. Default: a split question is researched, any other is asked as in step 11. */
  askOne?: AskOne;
  /**
   * Step 12: the research agent's free tools, run in the owner's browser (extension/lib/researchTools.ts). With them a split question is
   * researched; without them (a test, a page with no tabs) it is asked as in step 11, from the evidence the scan stored.
   */
  researchTools?: { forQuestion(): ResearchTools };
}

/** Who sent a request: the tab, when it came from a content script. */
export interface RequestSender {
  tabId?: number;
}

export interface Worker {
  onMessage(request: Request, sender?: RequestSender): Promise<Reply>;
  /** A tab was closed: what it showed is forgotten. */
  onTabClosed(tabId: number): Promise<void>;
  /** The owner changed the chip setting: every tab that has sent a page is told. */
  onChipSetting(show: boolean): Promise<void>;
  /** The alarm. Resolves when the scan it started or continued has ended. */
  onTick(): Promise<void>;
  /** The worker started. Does what a tick does. */
  onStart(): Promise<void>;
}

const NO_KEY = 'Add your SerpApi key in Settings.';
const ENTER_KEY = 'Enter your SerpApi key.';
const ACCOUNT_FAILED = 'Something went wrong while checking your SerpApi account.';
const FAILED = 'Something went wrong. Try again.';
const RUNNING = 'A scan is already running.';
const PAIRED_SCAN = 'This browser is connected to the Split Finder app, which runs the scans. Scan in the app, or disconnect here.';
const GAVE_UP = 'The scan could not be saved, so it was stopped. Check that Chrome has free storage, then scan again.';
const STOPPED = 'The scan was stopped before it began.';
const BAD_PACKAGING = 'Choose retail boxed or loose.';
const ENTER_EBAY_KEYS = 'Enter the eBay App ID and the Cert ID.';
const ENTER_ANTHROPIC_KEY = 'Enter your Anthropic API key.';
/** The sentence a scan leaves in the job when a key the eBay step needs is not saved. */
function skippedFor(ebay: boolean, anthropic: boolean): string {
  const need = !ebay && !anthropic ? 'your eBay App ID and Cert ID and your Anthropic key' : !ebay ? 'your eBay App ID and Cert ID' : 'your Anthropic key';
  return `eBay reference values were skipped. Add ${need} in Settings to see them.`;
}
const NO_MODEL = 'Name the bundle model.';
const NO_ANTHROPIC_KEY = 'Add your Anthropic key in Settings.';
/** The sentences of askAi. The question ones are answers.ts's own, so a panel that reads either treats them alike. */
const ASK_SCAN = 'A scan is running. Ask again when it has finished.';
const ASK_BUSY = 'Already asking about that question.';
const ASK_CHANGED = 'That question changed while the AI worked. Ask again.';
const ASK_NOT_FOUND = 'That question was not found.';
const ASK_ANSWERED = 'That question was already answered.';
/** Step 12, Ask AI about all. A scan and the queue are never at once: each is refused, in one sentence, while the other runs. */
const ASK_ALL_RUNNING = 'Asking about all questions is running. Ask again when it has finished.';
const ASK_ALL_AGAIN = 'Already asking about all questions.';
const ASK_ALL_NOTHING = 'There is nothing to ask about.';
const SCAN_AFTER_ASK_ALL = 'Asking AI is running. Stop it first, or wait for it to finish.';
const BAD_SETTING = 'Choose on or off.';
/** Calls in a row the provider fails (a refused key, a limit, no answer) before the queue stops and says why. */
const ASK_ALL_MAX_FAILURES = 3;
const ANSWER_LATER = 'A scan is running. Answer again when it has finished.';
const SAVE_PRICE_LATER = 'A scan is running. Save the price when it has finished.';
/** Read kit page. One Home Depot page, in the browser, never a search. */
const READ_LATER = 'A scan is running. Read the page when it has finished.';
const READ_WHILE_PAID = 'A Look up or Verify is running. Read the page when it has finished.';
const READ_WHILE_ASK = 'Asking AI is running. Read the page when it has finished.';
const READ_BUSY = 'A kit page is already being read.';
const READ_NO_BROWSER = 'This browser cannot read a Home Depot page.';
const READ_NONE = 'That kit has no Home Depot page to read.';
const READ_STORED = "That kit's page is already stored.";
const READ_NO_ID = 'The next scan has to find this kit on Home Depot before its page can be read.';
const READ_FAILED = 'Reading the Home Depot page failed. Try again.';
const READ_UNREADABLE = "Home Depot's page could not be read. Try again.";
const DELETE_LATER_SCAN = 'A scan is running. Delete the data when it has finished.';
const DELETE_LATER_PAID = 'A Look up or Verify is running. Delete the data when it has finished.';
const DELETE_LATER_ASK = 'Asking AI is running. Delete the data when it has finished.';
const DELETE_LATER_READ = 'A kit page is being read. Delete the data when it has finished.';
const SCAN_AFTER_KIT = 'A kit page is being read. Scan when it has finished.';
const PAID_AFTER_KIT = 'A kit page is being read. Try again when it has finished.';
const ASK_AFTER_KIT = 'A kit page is being read. Ask again when it has finished.';

/** Home Depot answered with something other than the page. The kit stays unread. */
function refusedPage(status: number | undefined): string {
  if (status === 0) return 'Home Depot refused the page (no answer). Try again later.';
  if (typeof status === 'number' && Number.isInteger(status) && status > 0) return `Home Depot refused the page (HTTP ${status}). Try again later.`;
  return 'Home Depot refused the page. Try again later.';
}
/** An answer or a Change asked for while a Look up or Verify runs, which reads and writes matches and the answer's parts. */
const ANSWER_AFTER_SEARCH = 'A search is running. Answer again when it has finished.';
/** A Verify or Look up asked for while a scan runs. */
const SCAN_RUNNING = 'A scan is running.';
/** A scan, or a second Verify or Look up, asked for while one runs. */
const PAID_RUNNING = 'A Look up or Verify is running.';
const KEY_CHANGED_PAID = 'The SerpApi key changed. Try again.';
/** A Look up or Verify stopped before a search because the key it holds was forgotten or replaced. */
const PAID_STOPPED = 'Stopped: the key was removed or changed.';
/** A quote reads the account saved this recently; an older one is checked again (free). */
const ACCOUNT_FRESH_MS = 5 * 60_000;
/** The budget a quote shows when it is refused before the account is read; the refusal is said instead. */
const CLOSED: BudgetView = { spendable: 0, leftThisRun: 0, leftAboveReserve: 0, hourlyLimit: null, blockReason: () => 'reserve' };
const KEY_CHANGED = 'The SerpApi key changed while the scan was starting. Scan again.';
const NO_TAB = 'This request needs a browser tab.';
/** A job is continued at most this many times in a row without progress. */
const MAX_TRIES = 2;
/** A running scan's saves are broadcast at most this often; the last save of a burst is broadcast once the time is up. */
const PROGRESS_MS = 1_000;
/** Notifications per scan, one per bundle. */
const MAX_NOTIFIED = 3;

/**
 * A SerpApiError's message is one plain sentence and never carries the key; nothing else is shown. An account
 * check that never reached SerpApi is the client's network error, which the panel says as "could not be reached".
 */
const accountSentence = (err: unknown): string => (err instanceof SerpApiError ? err.message : ACCOUNT_FAILED);

const ok = <T>(data: T): Reply<T> => ({ ok: true, data });
const refuse = (error: string): Reply<never> => ({ ok: false, error });

// ---------------------------------------------------------------- settings from storage (rule 5)

const FIELDS: readonly SettingsField[] = [
  'schedule', 'searchesPerScan', 'reserve', 'brands', 'pagesPerBrand', 'fees', 'alerts',
  'keepaTokensPerScan', 'keepaReserve', 'discoveryMode', 'keepaDiscoveryShare', 'trackingDepth', 'amazonRefreshViaKeepa',
  'agentBridgeAfterScan',
];
const UNREADABLE = 'These settings could not be read. Reload this page and try again.';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A clean copy of one field, holding only the properties the settings have, or null when the
 * value has a shape validateSettings cannot read (it would throw, or let it through unread).
 */
function readable(field: SettingsField, v: unknown): { value: unknown } | null {
  switch (field) {
    case 'schedule':
      if (!isRecord(v)) return null;
      if (v.mode === 'manual') return { value: { mode: 'manual' } };
      if (v.mode === 'interval') return { value: { mode: 'interval', hours: v.hours } };
      if (v.mode === 'daily' && typeof v.at === 'string') return { value: { mode: 'daily', at: v.at } };
      return null;
    case 'brands':
      return Array.isArray(v) && v.every((b) => typeof b === 'string') ? { value: [...v] } : null;
    case 'fees':
      if (!isRecord(v)) return null;
      return {
        value: { referralRate: v.referralRate, fulfillmentFee: v.fulfillmentFee, minReferral: v.minReferral, salesTaxRate: v.salesTaxRate, inboundCost: v.inboundCost },
      };
    case 'alerts':
      if (!isRecord(v) || typeof v.enabled !== 'boolean') return null;
      return {
        value: {
          enabled: v.enabled,
          minProfit: v.minProfit,
          minRoiPercent: v.minRoiPercent,
          reviewDigest: v.reviewDigest !== false,
        },
      };
    case 'amazonRefreshViaKeepa':
    case 'agentBridgeAfterScan':
      return typeof v === 'boolean' ? { value: v } : null;
    default:
      // searchesPerScan, reserve, pagesPerBrand: validateSettings reads any value.
      return { value: v };
  }
}

/** Each field of `s` with its problem, in declaration order; a clean copy of what passed. */
function checkSettings(s: unknown): { clean: ExtensionSettings; problems: string[] } {
  const given = isRecord(s) ? s : {};
  const clean = structuredClone(DEFAULT_SETTINGS) as unknown as Record<SettingsField, unknown>;
  const problems: string[] = [];
  for (const field of FIELDS) {
    const r = readable(field, given[field]);
    const problem = r === null ? UNREADABLE : (validateSettings({ ...DEFAULT_SETTINGS, [field]: r.value } as ExtensionSettings)[field] ?? null);
    if (problem === null) clean[field] = r!.value;
    else problems.push(problem);
  }
  return { clean: clean as unknown as ExtensionSettings, problems };
}

/** Rule 5: stored settings are untrusted. A field that fails its check takes its default. */
const trusted = (stored: unknown): ExtensionSettings => checkSettings(stored).clean;

function sameSchedule(a: Schedule, b: Schedule): boolean {
  if (a.mode === 'interval' && b.mode === 'interval') return a.hours === b.hours;
  if (a.mode === 'daily' && b.mode === 'daily') return a.at === b.at;
  return a.mode === b.mode;
}

/**
 * The store, except that every job goes through `prepare`, which must succeed, before it is saved,
 * and `saved` is called once it is.
 */
function onPutScan(store: ScanStore, prepare: (job: ScanJob) => Promise<ScanJob>, saved: () => void): ScanStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'putScan') {
        return async (job: ScanJob) => {
          await target.putScan(await prepare(job));
          saved();
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Error text with the key taken out, and any api_key value in a URL too, whatever key it was.
 * A failed search's message can carry the request URL; the stored job must never hold the key.
 */
export function withoutKey(text: string, key: string): string {
  let out = text;
  for (const k of new Set([key, encodeURIComponent(key)])) if (k !== '') out = out.split(k).join('[key]');
  return out.replace(/api_key=[^&\s"']+/g, 'api_key=[key]');
}

/** What a continuation compares to tell whether the job moved on since the last start. */
export const progressOf = (job: ScanJob): string => {
  const c = job.counts;
  // The eBay step spends no search and changes neither the phase nor the queue: its calls are progress too, or a worker evicted
  // during it would look like one that got nowhere, and a scan would give up because of an optional step.
  return `${job.searchesUsed}:${job.phase}:${job.queue.length}:${c.ebaySearches ?? 0}:${c.ebayItemReads ?? 0}:${c.listingsJudged ?? 0}`;
};

// ---------------------------------------------------------------- the worker

export function createWorker(env: WorkerEnv): Worker {
  const { prefs, store } = env;
  const pages = env.pages ?? memoryPages();
  const suggestions = env.suggestions ?? new MemorySuggestionStore();
  const baseUrl = env.baseUrl ?? 'https://serpapi.com';
  const accountOf = (key: string) => SerpApiClient.account(key, env.fetchFn, baseUrl);

  /** One plain sentence when the last account check or scan start failed. Lost with the worker. */
  let problem: string | null = null;
  /** The scan this worker is running, from its start to the end of its broadcast. */
  let scan: Promise<void> | null = null;
  /** Set by stopScan (and forgetKey) while a scan runs; cleared when it ends. runScan asks before every paid step. */
  let stopRequested = false;
  /** Aborted with stopRequested: an eBay or model call in flight ends at once. A new one is made when the stop is spent. */
  let stopAbort = new AbortController();
  const askStop = (): void => {
    stopRequested = true;
    stopAbort.abort();
  };
  const spentStop = (): void => {
    stopRequested = false;
    stopAbort = new AbortController();
  };
  /** The key the running scan holds, so it is kept out of replies even after it was forgotten. */
  let scanKey: string | null = null;
  /** True while a start is between its first read and the scan's claim (or its refusal). */
  let starting = false;
  /** The Verify or Look up this worker is running, from its claim until it has ended; cleared before the broadcast that follows. */
  let paid: Promise<Reply<null>> | null = null;
  /** One kit page being read for the owner. A scan, a Look up and Ask AI wait: they share the Home Depot tab or the store. */
  let reading: Promise<Reply<null>> | null = null;
  /** The key the running paid action holds. */
  let paidKey: string | null = null;
  /** Set by forgetKey, and by checkKey saving a different key, while a paid action runs. runPaid asks it before every search. */
  let paidStop = false;
  /** Step 12: the Ask AI about all queue this worker is running, from its claim until it has ended. A scan is not started meanwhile. */
  let askAll: AskAllRun | null = null;
  /** How the last queue ended. Lost with the worker. */
  let askAllResult: AskAllResult | null = null;

  const settings = async () => trusted(await prefs.getSettings());

  /** Stored eBay settings are untrusted, like the scan's: one that fails its check is the default. */
  const ebaySettings = async (): Promise<EbaySettings> => {
    const stored = await prefs.getEbaySettings();
    return ebaySettingsProblem(stored) === null ? { judgeModel: stored.judgeModel, listingsJudgedPerScan: stored.listingsJudgedPerScan } : { ...DEFAULT_EBAY_SETTINGS };
  };
  /** Counts every change of an eBay or Anthropic key. A scan's eBay step holds the keys it started with: it goes no further once this moves. */
  let ebayKeyEpoch = 0;
  /** The secrets a running scan's eBay step holds, so they are kept out of replies even after they were forgotten. */
  const ebayKeysHeld: { appId: string | null; certId: string | null; anthropic: string | null } = { appId: null, certId: null, anthropic: null };
  const callTimeoutMs = env.callTimeoutMs ?? JUDGE_CALL_TIMEOUT_MS;
  const tokenStore: TokenStore = { get: () => prefs.getEbayToken(), set: (t) => prefs.setEbayToken(t), clear: () => prefs.clearEbayToken() };

  /**
   * The eBay step of a scan: built from the keys saved now, or the sentence saying which is missing (the scan carries on
   * without it). Caps per scan are core's (EBAY_SEARCHES_MAX, EBAY_ITEM_READS_MAX); the client holds them too.
   */
  async function ebayStepFor(stop: AbortSignal): Promise<EbayStep> {
    const keys = await prefs.getEbayKeys();
    const anthropic = await prefs.getAnthropicKey();
    if (keys === null || anthropic === null) {
      return { kind: 'skip', notice: skippedFor(keys !== null, anthropic !== null), missing: [...(keys === null ? ['ebay' as const] : []), ...(anthropic === null ? ['anthropic' as const] : [])] };
    }
    const es = await ebaySettings();
    const epoch = ebayKeyEpoch;
    ebayKeysHeld.appId = keys.appId;
    ebayKeysHeld.certId = keys.certId;
    ebayKeysHeld.anthropic = anthropic;
    // Every eBay call ends when the scan is stopped, and after the call timeout: a call that runs out is a read skipped, never a result.
    const bounded: typeof fetch = (input, init) => env.fetchFn(input, { ...init, signal: AbortSignal.any([stop, AbortSignal.timeout(callTimeoutMs)]) });
    const ebay = new EbayClient({
      appId: keys.appId, certId: keys.certId, fetchFn: cachingTokenFetch(bounded, tokenStore, keys.appId, env.now), now: env.now,
      maxSearches: EBAY_SEARCHES_MAX, maxItemReads: EBAY_ITEM_READS_MAX, ...(env.ebayBaseUrl ? { baseUrl: env.ebayBaseUrl } : {}),
    });
    const judge = new ClaudeJudge({ apiKey: anthropic, model: es.judgeModel, fetchFn: env.judgeFetchFn ?? env.fetchFn });
    return { kind: 'run', ebay, judge, listingsJudgedPerScan: es.listingsJudgedPerScan, halted: () => ebayKeyEpoch !== epoch, signal: stop, callTimeoutMs };
  }

  type KeepaRunDeps = {
    keepaProduct?: (asin: string, label: string, maxAgeMs?: number) => ReturnType<typeof keepaProductSearchResult>;
    keepaLookup?: (brand: string, model: string, label: string, ask?: KeepaLookupAsk) => ReturnType<typeof keepaPartLookup>;
    keepaBudget?: TokenBudget;
    keepaScale?: KeepaScaleSettings;
    productPage?: AmazonProductPage;
    quoteKeepa?: QuoteKeepaOpts;
  };

  async function buildKeepaDeps(s: ExtensionSettings): Promise<KeepaRunDeps> {
    const keepaKey = await prefs.getKeepaKey?.();
    // Step 15: 0 tokens per scan is automatic (every token above the reserve), not off.
    if (!keepaKey || !s.amazonRefreshViaKeepa) return {};
    const acct = (await prefs.getKeepaAccount?.()) ?? null;
    const keepaBudget = new TokenBudget({ reserve: s.keepaReserve, maxPerRun: s.keepaTokensPerScan > 0 ? s.keepaTokensPerScan : Number.POSITIVE_INFINITY }, acct?.tokensLeft ?? null);
    const keepaAccountTokens = acct?.tokensLeft ?? null;
    const keepa = new KeepaClient({
      apiKey: keepaKey,
      budget: keepaBudget,
      cache: env.cache,
      fetchFn: env.fetchFn,
      now: env.now,
      onSpend: async (entry) => {
        await env.ledger({ at: entry.at, engine: `keepa:${entry.kind}`, key: entry.key, label: entry.label });
        await prefs.setKeepaAccount?.({ tokensLeft: entry.tokensLeft, refillIn: entry.refillIn, at: env.now() });
      },
    });
    const keepaProduct = (asin: string, label: string, maxAgeMs?: number) =>
      keepaProductSearchResult(keepa, asin, { label, maxAgeMs, trackingDepth: s.trackingDepth });
    // Nov 25: barcode first when the part's Home Depot barcode is stored (keepaPartLookup), then the term search.
    const keepaLookup = (brand: string, model: string, label: string, ask?: KeepaLookupAsk) =>
      keepaPartLookup(keepa, brand, model, label, ask);
    return {
      keepaProduct,
      keepaLookup,
      keepaBudget,
      keepaScale: {
        tokensPerRun: s.keepaTokensPerScan,
        discoveryShare: s.keepaDiscoveryShare,
        reserve: s.keepaReserve,
        mode: s.discoveryMode,
        tokensLeft: keepaAccountTokens,
        trackingDepth: s.trackingDepth,
      },
      productPage: keepaProduct,
      quoteKeepa: { verifyUsesKeepa: true, lookupUsesKeepa: true, keepaBudget, trackingDepth: s.trackingDepth },
    };
  }

  /**
   * The value with every copy of the key replaced. Error text from a failed search (a job's
   * stopMessage) is the only way the key could get in; this is the last door before a page.
   */
  async function scrubbed<T>(value: T): Promise<T> {
    const ebayKeys = await prefs.getEbayKeys();
    const relay = (await prefs.getRelayConfig?.()) ?? null;
    const keys = [await prefs.getKey(), scanKey, ebayKeys?.certId ?? null, ebayKeys?.appId ?? null, await prefs.getAnthropicKey(), await prefs.getKeepaKey(), relay?.secret ?? null, ebayKeysHeld.appId, ebayKeysHeld.certId, ebayKeysHeld.anthropic].filter(
      (k): k is string => k !== null && k !== '',
    );
    let text = JSON.stringify(value);
    if (text === undefined || !keys.some((k) => text.includes(k))) return value;
    for (const k of keys) text = text.split(k).join('[key]');
    return JSON.parse(text) as T;
  }

  async function getState(): Promise<AppState> {
    const s = await settings();
    const account = await prefs.getAccount();
    const last = await prefs.getLastScheduledRunAt();
    const now = env.now();
    // Rule 7.
    const next = nextRun(s.schedule, new Date(now), last === null ? null : new Date(last));
    return {
      hasKey: (await prefs.getKey()) !== null,
      ebay: { hasEbayKeys: (await prefs.getEbayKeys()) !== null, hasAnthropicKey: (await prefs.getAnthropicKey()) !== null, ...(await ebaySettings()) },
      keepa: await (async () => {
        const acct = (await prefs.getKeepaAccount?.()) ?? null;
        return {
          hasKeepaKey: (await prefs.getKeepaKey()) !== null,
          tokensPerScan: s.keepaTokensPerScan,
          reserve: s.keepaReserve,
          discoveryMode: s.discoveryMode,
          trackingDepth: s.trackingDepth,
          tokensLeft: acct?.tokensLeft ?? null,
          refillIn: acct?.refillIn ?? null,
        };
      })(),
      relay: { hasRelayConfig: (await prefs.getRelayConfig?.()) !== null },
      account: account?.info ?? null,
      accountCheckedAt: account?.at ?? null,
      problem,
      settings: s,
      scanRunning: scan !== null,
      lastJob: (await store.listScans())[0] ?? null,
      nextRunAt: next === null ? null : next.getTime(),
      ...(prefs.getRates ? { rates: await prefs.getRates() } : {}),
      ...(askAll !== null
        ? { askAll: { done: askAll.done, total: askAll.total, costUsd: askAll.costUsd, estimateUsd: askAll.estimateUsd, ...(askAll.abort.signal.aborted ? { stopping: true } : {}) } }
        : {}),
      ...(askAllResult !== null ? { askAllResult } : {}),
      ...(prefs.getAskAfterScan ? { askAfterScan: await prefs.getAskAfterScan() } : {}),
    };
  }

  async function broadcast(): Promise<void> {
    try {
      env.broadcast(await scrubbed(await getState()));
    } catch {
      // No page may be open, or the state could not be read: the next broadcast tells them.
    }
  }

  /** When the last progress broadcast was sent, by env.now. */
  let progressAt = -Infinity;
  /** The broadcast that carries the last save of a burst, due when its second is up. */
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * A running scan saved its job: the pages hear of it, at most once a second. A save within the
   * second is broadcast when the second is up, with whatever the job holds by then.
   */
  function jobSaved(): void {
    const wait = progressAt + PROGRESS_MS - env.now();
    if (wait > 0) {
      // Never longer than the second, even if the clock was set back.
      progressTimer ??= setTimeout(sendProgress, Math.min(wait, PROGRESS_MS));
      return;
    }
    sendProgress();
  }

  function sendProgress(): void {
    endProgress();
    progressAt = env.now();
    void broadcast();
  }

  /** No progress broadcast is due any more: the scan's last broadcast carries its last save. */
  function endProgress(): void {
    clearTimeout(progressTimer);
    progressTimer = undefined;
  }

  /**
   * Rule 2: starts a scan, or continues the job runScan will continue (the newest, when it
   * is "running"). No key or a failed account check means no scan, and `problem` says why.
   * Resolves once the scan is under way; `scan` then holds the run until it ends. Called
   * only through serial(), with no scan running.
   */
  async function start(trigger: ScanTrigger, resume: ActiveScan | null): Promise<Reply<null>> {
    starting = true;
    try {
      return await startScan(trigger, resume);
    } finally {
      starting = false;
      // A stop sent during a start that did not run was for that start only.
      if (scan === null) spentStop();
    }
  }

  async function startScan(trigger: ScanTrigger, resume: ActiveScan | null): Promise<Reply<null>> {
    const key = await prefs.getKey();
    if (key === null) return fail(NO_KEY);

    // runScan continues the newest job when it is "running".
    const newest = (await store.listScans())[0];
    const continued = newest?.status === 'running' ? newest : undefined;
    // A continuation that finds the job where the last one left it counts as another try.
    // Each try may pay again for a step whose save failed, so the tries are limited.
    const progress = continued ? progressOf(continued) : null;
    const attempts = continued && resume?.jobId === continued.id && resume.progress === progress ? (resume.attempts ?? 0) + 1 : 0;
    if (attempts >= MAX_TRIES) {
      // The schedule counts from now, so it does not start the job again at once. Written
      // before activeScan is cleared, as after a scan.
      await prefs.setLastScheduledRunAt(env.now());
      await prefs.setActiveScan(null);
      return fail(GAVE_UP);
    }

    let account: AccountInfo;
    try {
      account = await accountOf(key);
    } catch (err) {
      return fail(accountSentence(err));
    }
    await prefs.setAccount({ info: account, at: env.now() });
    problem = null;

    const s = await settings();
    const budget = new SearchBudget(account, budgetPolicyFor(s, trigger, continued?.searchesUsed ?? 0));
    const client = new SerpApiClient({ apiKey: key, budget, cache: env.cache, fetchFn: env.fetchFn, onSpend: env.ledger, now: env.now, baseUrl });
    const { keepaProduct, keepaLookup, keepaBudget, keepaScale } = await buildKeepaDeps(s);
    const scanSettings = toScanSettings(s);
    const startedAt = env.now();

    // activeScan names the job before its first search. A new job is first saved before
    // runScan sends anything; a continued one is named here.
    let named = false;
    const name = async (job: ScanJob, tries: number) => {
      if (named) return;
      await prefs.setActiveScan({ jobId: job.id, trigger, attempts: tries, progress: progressOf(job) });
      named = true;
    };
    if (continued) await name(continued, attempts);
    const saving = onPutScan(
      store,
      async (job) => {
        if (job.status === 'running') await name(job, 0);
        return job.stopMessage === null ? job : { ...job, stopMessage: withoutKey(job.stopMessage, key) };
      },
      jobSaved,
    );

    // Asked last before the scan is claimed, so a forgetKey or stopScan sent while the account
    // was being checked is not lost. After the claim, both set stopRequested.
    const keyNow = await prefs.getKey();
    if (keyNow !== key) return fail(keyNow === null ? NO_KEY : KEY_CHANGED);
    if (stopRequested) return refuse(STOPPED);

    const ebay = await ebayStepFor(stopAbort.signal);
    scanKey = key;
    // What the last Ask AI about all said was about the questions as they were: the scan may open, close and change them.
    askAllResult = null;
    // Step 12: set when the scan ended any way but the owner's Stop (finished, out of searches, a failed search: its questions are open
    // all the same), so "Ask AI after each scan" follows it. A scan the owner stopped is a sign they want things quiet.
    let askAfter = false;
    scan = (async () => {
      try {
        const ended = await runScan({
          client, budget, store: saving, settings: scanSettings, now: env.now, labelPrefix: 'scan', shouldStop: () => stopRequested,
          readPages: env.readPages, readPartPrices: env.readPartPrices, ebay, keepaProduct, keepaLookup, keepaBudget,
          keepaScale,
          cache: env.cache,
          trendWriter: keepaProduct ? (t) => writePartTrend(env.cache, t) : undefined,
        });
        await keepRates(ended);
        askAfter = ended.stopReason !== 'user';
      } catch {
        // The job stays "running" and activeScan keeps naming it: the next tick continues it.
        return;
      }
      await finished(trigger, startedAt);
    })()
      .catch(() => {
        // A storage error after the scan: the job itself is saved.
      })
      .finally(() => {
        scan = null;
        spentStop();
        scanKey = null;
        ebayKeysHeld.appId = null;
        ebayKeysHeld.certId = null;
        ebayKeysHeld.anthropic = null;
        endProgress();
        void broadcast();
        settleDeferred();
        if (askAfter) void askAfterScan();
      });
    await broadcast();
    return ok(null);
  }

  /**
   * Step 11: what this scan measured joins the rates the progress estimate uses, once, as the scan ends. Read and written
   * here, so a scan the worker was evicted in still counts whole: the timings are on the job. Never fails the scan.
   */
  async function keepRates(job: ScanJob): Promise<void> {
    if (!prefs.getRates || !prefs.setRates) return;
    try {
      const samples = samplesOf(job);
      if (samples.length > 0) await prefs.setRates(addSamples(await prefs.getRates(), samples));
    } catch {
      // The estimate is only less good without it.
    }
  }

  /** Rule 2, afterwards. */
  async function finished(trigger: ScanTrigger, startedAt: number): Promise<void> {
    // The schedule first: a failure between the two writes leaves a finished job named, which
    // the next tick clears, rather than a due schedule that would start a second scan at once.
    if (trigger === 'scheduled') await prefs.setLastScheduledRunAt(startedAt);
    await prefs.setActiveScan(null);
    const key = await prefs.getKey();
    if (key !== null) {
      try {
        await prefs.setAccount({ info: await accountOf(key), at: env.now() });
        problem = null;
      } catch (err) {
        problem = accountSentence(err);
      }
    }
    // Current settings: alerts the owner turned off during the scan are off.
    const s = await settings();
    const scanSettings = toScanSettings(s);
    const now = env.now();
    const { report } = await postScanWork({ store, settings: scanSettings, cache: env.cache, now: () => now });
    const unanswered = (await store.listReview()).filter((q) => q.answer === null);
    const notified = await prefs.getNotified();
    const deals = dealsToNotify(report, s.alerts, notified).slice(0, MAX_NOTIFIED);
    const dealKeys = new Set(deals.map((d) => d.key));
    if (deals.length > 0) {
      await env.notify(deals);
      await prefs.setNotified([...notified, ...deals.map((d) => d.key)]);
    }
    const reviewDigest =
      s.alerts.reviewDigest
        ? reviewDigestMessage({
            match: unanswered.filter((q) => q.kind === 'match').length,
            split: unanswered.filter((q) => q.kind === 'split').length,
          })
        : null;
    if (reviewDigest && env.notifyText) await env.notifyText(reviewDigest);
    const discoveryComplete: string[] = [];
    if (prefs.getDiscoverySections && prefs.setDiscoverySections) {
      const lastRecord = await prefs.getDiscoverySections();
      const lastSection = new Map(Object.entries(lastRecord ?? {}));
      const sectionsSeeded = lastRecord !== null && Object.keys(lastRecord).length > 0;
      const ready = bundlesNewlyConfirmed(report.bundles, lastSection, sectionsSeeded);
      for (const row of ready) {
        const line = `Discovery complete for ${row.model}.`;
        discoveryComplete.push(line);
        if (env.notifyText) await env.notifyText(line);
      }
      if (report.bundles.length > 0) {
        await prefs.setDiscoverySections(Object.fromEntries(report.bundles.map((b) => [b.key, b.section])));
      }
    }
    const trendAlerts: string[] = [];
    const lastJob = (await store.listScans())[0];
    for (const drop of lastJob?.partPriceDrops ?? []) {
      const msg = partPriceDropMessage(drop.partModel, drop.delta);
      trendAlerts.push(msg);
      if (env.notifyText) await env.notifyText(msg);
    }
    if (s.alerts.enabled) {
      for (const row of report.bundles) {
        if (!row.estimate) continue;
        const roiPct = estimateRoiPercent(row.estimate.roi);
        const baseline = await readAlertBaseline(env.cache, row.key);
        const trendMsg =
          !dealKeys.has(row.key) ? trendCrosses(row.model, row.estimate.profit, roiPct, baseline, s.alerts) : null;
        if (trendMsg) {
          trendAlerts.push(trendMsg);
          if (env.notifyText) await env.notifyText(trendMsg);
        }
        await writeAlertBaseline(env.cache, { bundleKey: row.key, profit: row.estimate.profit, roiPercent: roiPct, notifiedAt: now });
      }
    }
    const relay = await prefs.getRelayConfig?.();
    if (relay && env.relayPost) {
      try {
        const digest = {
          at: new Date(now).toISOString(),
          reviewOpen: unanswered.length,
          roiHits: deals.map((d) => ({ model: d.model, profit: d.estimate?.profit ?? 0 })),
          ...(reviewDigest ? { reviewDigest } : {}),
          ...(discoveryComplete.length > 0 ? { discoveryComplete } : {}),
          ...(trendAlerts.length > 0 ? { trendAlerts } : {}),
        };
        const { body, signature } = await relayPayload(digest, relay.secret);
        await env.relayPost(relay.url, body, signature);
      } catch {
        // Relay failure must not fail the scan.
      }
    }
  }

  async function fail(sentence: string): Promise<Reply<never>> {
    problem = sentence;
    await broadcast();
    return refuse(sentence);
  }

  /**
   * Starts are taken one after another, so no two of them can both find no scan running
   * (rule 3). A start leaves the gate once its scan is under way, not when it ends.
   */
  let gate: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const turn = gate.then(fn);
    gate = turn.catch(() => {});
    return turn;
  }

  /**
   * activeScan, when that job is the one runScan will continue
   * (the newest, and "running"). Otherwise activeScan is cleared and null is returned.
   */
  async function saved(): Promise<ActiveScan | null> {
    const active = await prefs.getActiveScan();
    if (active === null) return null;
    const newest = (await store.listScans())[0];
    if (newest?.id === active.jobId && newest.status === 'running') return active;
    await prefs.setActiveScan(null);
    return null;
  }

  /** Rule 1. */
  async function tick(): Promise<void> {
    try {
      await prefs.restrictKeyAccess();
    } catch {
      // Not every browser has setAccessLevel; scans do not depend on it.
    }
    let started: Promise<void> | null = null;
    try {
      // Step 13: paired, the app runs the scans; this tick starts nothing and continues nothing.
      if (await env.paired?.()) {
        settleDeferred();
        return;
      }
      started = await serial(async () => {
        // Rule 3: a tick while a scan is active does nothing; nor while a Verify, a Look up, or a kit page read runs.
        // Step 12: nor while Ask AI about all runs: the scan waits for its turn, and the next tick tries again.
        if (scan !== null || paid !== null || askAll !== null || singleAsks > 0 || reading !== null) return null;
        const resume = await saved();
        if (resume !== null) return (await start(resume.trigger, resume)).ok ? scan : null;
        const s = await settings();
        const last = await prefs.getLastScheduledRunAt();
        const now = env.now();
        const due = nextRun(s.schedule, new Date(now), last === null ? null : new Date(last));
        if (due === null || due.getTime() > now) return null;
        return (await start('scheduled', null)).ok ? scan : null;
      });
    } catch {
      // A storage error before the scan started: nothing was spent, and the next tick tries again.
    }
    await started;
    // Pages seen while a scan ran that a restarted worker still holds, or whose store failed: stored now, if nothing runs.
    settleDeferred();
  }

  /** Rule 3. A job left running is continued with the trigger it was saved with. */
  const scanNow = (): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(RUNNING);
      if (await env.paired?.()) return refuse(PAIRED_SCAN);
      if (paid !== null) return refuse(PAID_RUNNING);
      if (reading !== null) return refuse(SCAN_AFTER_KIT);
      if (askAll !== null || singleAsks > 0) return refuse(SCAN_AFTER_ASK_ALL);
      const resume = await saved();
      return start(resume?.trigger ?? 'manual', resume);
    });

  // ---------------------------------------------------------------- messages

  async function checkKey(apiKey: string): Promise<Reply<AccountInfo>> {
    const key = apiKey.trim();
    if (key === '') return refuse(ENTER_KEY);
    let account: AccountInfo;
    try {
      account = await accountOf(key);
    } catch (err) {
      // Rule 4: the saved key, if any, is left as it was.
      return refuse(accountSentence(err));
    }
    // A paid action holds the key it started with: a different one stops it before its next search.
    if (paid !== null && key !== paidKey) paidStop = true;
    await prefs.setKey(key);
    await prefs.setAccount({ info: account, at: env.now() });
    problem = null;
    await broadcast();
    return ok(account);
  }

  async function forgetKey(): Promise<Reply<null>> {
    await prefs.forgetKey();
    // A scan or a paid action holds the key in memory: it stops before its next search.
    if (scan !== null || starting) askStop();
    if (paid !== null) paidStop = true;
    // The account shown belonged to that key.
    await prefs.setAccount(null);
    await broadcast();
    return ok(null);
  }

  /** Step 10: eBay's keys are saved only when eBay gives a token for them. A running scan's eBay step stops: it holds the old keys. */
  async function saveEbayKeys(appId: unknown, certId: unknown): Promise<Reply<null>> {
    const a = typeof appId === 'string' ? appId.trim() : '';
    const c = typeof certId === 'string' ? certId.trim() : '';
    if (a === '' || c === '') return refuse(ENTER_EBAY_KEYS);
    const problem = await checkEbayKeys({ appId: a, certId: c, fetchFn: env.fetchFn, store: tokenStore, now: env.now, ...(env.ebayBaseUrl ? { baseUrl: env.ebayBaseUrl } : {}) });
    if (problem !== null) return refuse(problem);
    ebayKeyEpoch += 1;
    await prefs.setEbayKeys({ appId: a, certId: c });
    await broadcast();
    return ok(null);
  }

  async function forgetEbayKeys(): Promise<Reply<null>> {
    ebayKeyEpoch += 1;
    await prefs.forgetEbayKeys();
    await prefs.clearEbayToken();
    await broadcast();
    return ok(null);
  }

  /** The Anthropic key is not checked: a check is a call, and a call costs money. A wrong key shows at the first listing, as a notice. */
  async function saveAnthropicKey(apiKey: unknown): Promise<Reply<null>> {
    const k = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (k === '') return refuse(ENTER_ANTHROPIC_KEY);
    ebayKeyEpoch += 1;
    await prefs.setAnthropicKey(k);
    await broadcast();
    return ok(null);
  }

  async function forgetAnthropicKey(): Promise<Reply<null>> {
    ebayKeyEpoch += 1;
    await prefs.forgetAnthropicKey();
    // The queue holds nothing of the key, but it was started with it: it stops, as a scan's eBay step does.
    askAll?.abort.abort();
    await broadcast();
    return ok(null);
  }

  const ENTER_KEEPA_KEY = 'Enter your Keepa API key.';

  async function saveKeepaKey(apiKey: unknown): Promise<Reply<null>> {
    const k = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (k === '') return refuse(ENTER_KEEPA_KEY);
    await prefs.setKeepaKey(k);
    await broadcast();
    return ok(null);
  }

  async function forgetKeepaKey(): Promise<Reply<null>> {
    await prefs.forgetKeepaKey();
    await broadcast();
    return ok(null);
  }

  async function saveRelayConfig(url: unknown, secret: unknown): Promise<Reply<null>> {
    const u = typeof url === 'string' ? url.trim() : '';
    const s = typeof secret === 'string' ? secret.trim() : '';
    if (u === '' || s === '') return refuse('Enter a relay URL and shared secret.');
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return refuse('Relay URL is not valid.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return refuse('Relay URL must start with http:// or https://');
    if (!prefs.setRelayConfig) return refuse('Relay is not available in this build.');
    const pattern = `${parsed.origin}/*`;
    if (env.requestHostPermission) {
      const granted = await env.requestHostPermission(pattern);
      if (!granted) return refuse('Chrome did not allow posts to that host.');
    }
    await prefs.setRelayConfig({ url: u, secret: s });
    await broadcast();
    return ok(null);
  }

  async function forgetRelayConfig(): Promise<Reply<null>> {
    if (!prefs.forgetRelayConfig) return refuse('Relay is not available in this build.');
    await prefs.forgetRelayConfig();
    await broadcast();
    return ok(null);
  }

  async function saveEbaySettings(judgeModel: unknown, listingsJudgedPerScan: unknown): Promise<Reply<null>> {
    const next = { judgeModel, listingsJudgedPerScan };
    const problem = ebaySettingsProblem(next);
    if (problem !== null) return refuse(problem);
    await prefs.saveEbaySettings({ judgeModel: judgeModel as string, listingsJudgedPerScan: listingsJudgedPerScan as number });
    await broadcast();
    return ok(null);
  }

  /**
   * The owner's Yes or No to an eBay listing question (core/src/scan/ebayAnswers.ts). Taken through the start gate and
   * refused while a scan runs, as a review answer is: the scan rewrites the part's eBay value. The request is untrusted.
   */
  const answerEbay = (request: unknown): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(ANSWER_LATER);
      if (paid !== null) return refuse(ANSWER_AFTER_SEARCH);
      try {
        await applyEbayAnswer(store, request, env.now());
      } catch (err) {
        if (err instanceof AnswerRefused) return refuse(err.message);
        throw err;
      }
      await broadcast();
      return ok(null);
    });

  /**
   * Rule 5. A running scan keeps the budget it started with. Saving never starts a scan: a
   * changed schedule counts from now, written before the settings so that no tick in between
   * sees the new schedule with the old reference time. Taken through the start gate as well.
   */
  const saveSettings = (given: ExtensionSettings): Promise<Reply<null>> =>
    serial(async () => {
      const prev = await settings();
      const { clean, problems } = checkSettings(given);
      if (problems.length > 0) return refuse(problems[0]!);
      if (!sameSchedule(prev.schedule, clean.schedule)) await prefs.setLastScheduledRunAt(env.now());
      await prefs.saveSettings(clean);
      await broadcast();
      return ok(null);
    });

  /** Rule 6. */
  async function exportDeals(): Promise<Reply<string>> {
    return ok(runCsv(await buildReport(store, toScanSettings(await settings()))));
  }

  async function exportMatches(): Promise<Reply<string>> {
    const matches = await store.listMatches();
    const answers = (await store.listReview()).filter((r) => r.answer !== null);
    return ok(JSON.stringify({ matches, answers }, null, 2));
  }

  async function exportAudit(): Promise<Reply<string>> {
    const report = await buildReport(store, toScanSettings(await settings()));
    // The catalog the scan's own lookups use (knownModels), so isKit is what wantedFor asks.
    const { catalog } = await knownModels(store);
    const bundles = [];
    for (const row of report.bundles) {
      const record = await store.getBundle(row.key);
      const parts = [];
      for (const p of row.parts) {
        const match = await store.getMatch(partKey(row.brand, p.model));
        parts.push({ brand: row.brand, model: p.model, qty: p.qty, asin: p.asin, grade: p.grade, source: match?.source ?? null, isKit: wantedFor(row.brand, p.model, catalog).isKit === true });
      }
      bundles.push({
        key: row.key, itemId: row.itemId, brand: row.brand, model: row.model, title: row.title, section: row.section,
        split: record?.split?.status === 'resolved' ? [...record.split.components] : null,
        parts,
      });
    }
    const review = await store.listReview();
    const answers = review.filter((r) => r.answer !== null);
    // Open questions carry candidates the scan never saved as listings (a row with an empty brand field).
    const questions = review.filter((r) => r.answer === null);
    const audit = {
      kind: 'split-finder-audit', version: 1, exportedAt: env.now(),
      bundles, listings: await store.listListings(), matches: await store.listMatches(), answers, questions,
      // Step 10: the owner's answers to eBay listing questions, as labels for the judge (fixtures/ebay/labels.json shape),
      // and the questions still open. Listings' titles and pages only: no seller or buyer data is kept.
      ebayAnswers: ebayLabelsOf(await store.listEbayAnswers()), ebayQuestions: report.ebayQuestions ?? [],
      // Step 11: every Ask AI call. `agreed` is true when the owner's answer is the one suggested, false when it is another, and
      // null while it is not answered or when the AI could not tell. Quotes are the code's, found in the page; no key is kept.
      aiSuggestions: (await suggestions.list()).map((r) => ({
        questionId: r.questionId, source: 'ai' as const, suggestion: r.suggestion, agreed: r.outcome?.agreed ?? null,
        askedAt: r.askedAt, answeredAt: r.outcome?.answeredAt ?? null, answer: r.outcome?.answer ?? null,
        model: r.suggestion.model, tokens: r.suggestion.usage ?? null, costUsd: r.costUsd,
      })),
    };
    return ok(JSON.stringify(audit, null, 2));
  }

  async function getReport(): Promise<Reply<PanelReport>> {
    const report = await buildReport(store, toScanSettings(await settings()));
    // Validated on read, like settings: prefs drops entries that are not a known answer.
    const packaging: Record<string, Packaging> = {};
    for (const [m, a] of Object.entries(await prefs.getPackaging())) if (a === 'retail_boxed' || a === 'loose') packaging[m] = a;
    // Step 11: the suggestion to show for each open question, the latest made for the question as it reads now.
    const records = await suggestions.list();
    const aiSuggestions = report.review.flatMap((q) => liveSuggestion(records, q) ?? []);
    return ok({ ...report, packaging, aiSuggestions });
  }

  /**
   * The owner's answer to a review question (answers.ts). Taken through the start gate, so no
   * scan starts while it is written, and refused while a scan runs: the scan reads and rewrites
   * splits, matches and questions, and could write over an answer saved in the middle of it. Also
   * refused while a Look up or Verify runs, which reads and writes the parts' matches and questions.
   * The request is untrusted: applyReviewAnswer checks its shape (an id, a choice, none or typed parts, and the
   * `seen` signature of the question shown) and refuses anything else with a plain sentence.
   */
  const answerReview = (id: string, answer: ReviewAnswer, aiSuggestion = false): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(ANSWER_LATER);
      if (paid !== null) return refuse(ANSWER_AFTER_SEARCH);
      try {
        await applyReviewAnswer(store, id, answer, env.now());
      } catch (err) {
        if (err instanceof AnswerRefused) return refuse(err.message);
        throw err;
      }
      // The answer is saved. Whether it is the one a suggestion on screen proposed is kept for the audit, and never decides the save.
      if (aiSuggestion) await recordOutcome(id, answer.seen);
      await broadcast();
      return ok(null);
    });

  /** Notes, on the suggestion the owner had in front of them, what they answered and whether it was the suggested answer. */
  async function recordOutcome(id: string, seen: unknown): Promise<void> {
    try {
      const item = await store.getReview(id);
      if (!item || item.answer === null || typeof seen !== 'string') return;
      // The question is answered now, which liveSuggestion does not offer a suggestion for: ask it as it was shown.
      const shown = liveSuggestion(await suggestions.list(), { ...item, answer: null });
      if (!shown || shown.seen !== seen) return;
      await suggestions.put({ ...shown, outcome: { answeredAt: env.now(), answer: item.answer, agreed: agreedWith(shown.suggestion, item) } });
    } catch {
      // The answer stands; a suggestion's note is only for the audit.
    }
  }

  /** The questions being asked about now: a second press for the same one is refused. */
  const asking = new Set<string>();

  /** A question that cannot be asked, with the sentence to say. */
  class AskRefused extends Error {}

  /** Asks started and not yet finished, counted at once: a scan is not started while one runs (research reads in the doorway tab). */
  let singleAsks = 0;

  /**
   * The step 11 call: the question's evidence (what the scan stored, nothing fetched) goes to the owner's Anthropic model, which
   * drafts an answer. Returns the record to keep; stores nothing. The call ends when `signal` does or after the call timeout.
   */
  const askEvidenceOnly: AskOne = async (id, signal) => {
    const apiKey = await prefs.getAnthropicKey();
    if (apiKey === null) throw new AskRefused(NO_ANTHROPIC_KEY);
    const question = await store.getReview(id);
    if (!question) throw new AskRefused(ASK_NOT_FOUND);
    if (question.answer !== null) throw new AskRefused(ASK_ANSWERED);
    const model = (await ebaySettings()).judgeModel;
    const assist = new ClaudeAssist({ apiKey, model, fetchFn: env.judgeFetchFn ?? env.fetchFn });
    const suggestion = await suggestAnswer(question, await gatherEvidence(store, question), assist, AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)]));
    const askedAt = env.now();
    return { key: suggestionKey(id, askedAt), questionId: id, seen: suggestion.seen, askedAt, suggestion, costUsd: suggestionCost(model, suggestion.usage) };
  };

  /**
   * Step 12: a split question is researched. The model reads the bundle's page and what else it asks for through the free tools (the
   * owner's browser, never a SerpApi search, never Amazon), the code checks every quote and part against what was read, and the result
   * is a suggestion like any other. What is kept of the trace is each source's name and link, enough to show a quote and its source:
   * not the pages' text, never the key.
   */
  async function askResearch(id: string, signal: AbortSignal, tools: ResearchTools): Promise<StoredSuggestion> {
    const apiKey = await prefs.getAnthropicKey();
    if (apiKey === null) throw new AskRefused(NO_ANTHROPIC_KEY);
    const question = await store.getReview(id);
    if (!question) throw new AskRefused(ASK_NOT_FOUND);
    if (question.answer !== null) throw new AskRefused(ASK_ANSWERED);
    const model = (await ebaySettings()).judgeModel;
    const research = new ClaudeResearch({ apiKey, model, fetchFn: env.judgeFetchFn ?? env.fetchFn });
    const catalog = (await store.listCatalog()).map((c): CatalogEntry => ({ brand: c.brand, model: c.model, title: c.title, kind: c.isKit ? 'kit' : 'part' }));
    const result = await researchQuestion(question, await gatherEvidence(store, question), tools, research, { signal, catalog });
    const { research: trace, ...suggestion } = result;
    const slim = { ...suggestion, research: { ...trace, ledger: trace.ledger.map((e) => ({ id: e.id, kind: e.kind, label: e.label, url: e.url, lines: [], products: [], isBundle: e.isBundle })) } };
    const rates = PRICE_TABLE[model];
    const askedAt = env.now();
    return {
      key: suggestionKey(id, askedAt), questionId: id, seen: result.seen, askedAt, suggestion: slim as typeof suggestion,
      costUsd: rates && result.usage ? researchCost({ ...result.usage, webSearchRequests: trace.usage.webSearchRequests }, rates) : null,
    };
  }

  /** The default AskOne: research for a split question when the tools are there, the evidence-only call for the rest. */
  const askRouted: AskOne = async (id, signal) => {
    const question = typeof id === 'string' ? await store.getReview(id) : undefined;
    return question?.kind === 'split' && env.researchTools ? askResearch(id, signal, env.researchTools.forQuestion()) : askEvidenceOnly(id, signal);
  };
  const askOne: AskOne = env.askOne ?? askRouted;

  /**
   * Keeps what a call drafted, as a suggestion and never as the question's answer (rule 4). The question is read again now: a scan
   * or an answer may have changed it while the model worked. A call that gave nothing and cost nothing leaves no record. One that
   * cost something is kept, for the count of what was spent; when the question changed meanwhile it is kept closed (an outcome with
   * nothing agreed), so it can never come back and preselect an answer should the question be reopened with the same readings.
   * Returns whether the suggestion is for the question as it is now.
   */
  async function keep(record: StoredSuggestion): Promise<boolean> {
    const { suggestion } = record;
    const now = await store.getReview(record.questionId);
    const current = now !== undefined && now.answer === null && reviewSignature(now) === record.seen;
    if (suggestion.status !== 'not_suggested' || suggestion.usage !== undefined) {
      await suggestions.put(current ? record : { ...record, outcome: { answeredAt: env.now(), answer: now?.answer ?? '', agreed: null } });
    }
    return current;
  }

  /**
   * Step 11, Ask AI. The owner's Anthropic model drafts an answer to one Review question (AskOne: today the evidence the scan stored,
   * core/src/assist/, the code's check of every quote). The result is kept as a suggestion, never as the question's answer (rule 4):
   * only the owner's Approve, which is answerReview, saves one. Spends no search. It is not taken through the start gate: a call may
   * take 30 seconds and must not hold a scan back; the question is read again when the model has answered, and a suggestion for a
   * question that changed meanwhile is dropped. Refused while a scan runs, while a kit page is being read
   * (both use the Home Depot tab), and while Ask AI about all does.
   */
  async function askAi(questionId: unknown): Promise<Reply<StoredSuggestion>> {
    if (scan !== null || starting) return refuse(ASK_SCAN);
    if (reading !== null) return refuse(ASK_AFTER_KIT);
    if (askAll !== null) return refuse(ASK_ALL_RUNNING);
    // Counted before the first await, so a scan asked for meanwhile is refused: research reads in the doorway tab.
    singleAsks += 1;
    let id = '';
    try {
      const apiKey = await prefs.getAnthropicKey();
      if (apiKey === null) return refuse(NO_ANTHROPIC_KEY);
      id = typeof questionId === 'string' ? questionId : '';
      const question = id === '' ? undefined : await store.getReview(id);
      if (!question) return refuse(ASK_NOT_FOUND);
      if (question.answer !== null) return refuse(ASK_ANSWERED);
      if (asking.has(id)) return refuse(ASK_BUSY);
      asking.add(id);
      let record: StoredSuggestion;
      try {
        record = await askOne(id, new AbortController().signal);
      } catch (err) {
        return refuse(err instanceof AskRefused ? err.message : FAILED);
      }
      if (!(await keep(record))) return refuse(ASK_CHANGED);
      await broadcast();
      return ok(record);
    } finally {
      singleAsks -= 1;
      if (id !== '') asking.delete(id);
    }
  }

  // ---------------------------------------------------------------- Ask AI about all (step 12)

  /** What the worker holds of a running queue. */
  interface AskAllRun {
    total: number;
    /** Questions finished: asked, skipped (answered or gone meanwhile) or failed. */
    done: number;
    asked: number;
    suggested: number;
    verified: number;
    costUsd: number;
    estimateUsd: number | null;
    /** What the button said it would cost, rounded up as it says it; twice this is the most the queue spends. Null: no known rate, no cap. */
    shownUsd: number | null;
    /** Aborted by Stop, or by the Anthropic key being forgotten. */
    abort: AbortController;
    promise: Promise<void>;
  }

  /** A failed call that says the provider, not this question, is the trouble: asking on would fail the same way. */
  const providerTrouble = (s: StoredSuggestion['suggestion'], stopped: boolean): boolean =>
    s.status === 'not_suggested' &&
    s.notSuggested !== undefined &&
    !(stopped && s.notSuggested.reason === 'aborted') &&
    !['refusal', 'max_tokens', 'bad_response', 'no_answer', 'unexpected_stop', 'bad_request'].includes(s.notSuggested.reason);

  /**
   * The sentence for three failures in a row. A research that ran past its time, tool-call or request limit is not an API failure,
   * but it costs what a call costs and gives nothing, and asking on would do it again: it counts ('limit', core/src/research/loop.ts).
   */
  const troubleSentence = (s: StoredSuggestion['suggestion']): string | null => {
    if (s.status !== 'not_suggested') return null;
    if (s.notSuggested?.reason === 'limit') return 'The research ran past its limits on three questions in a row.';
    if (s.notSuggested?.reason === 'aborted') return 'The AI took too long. Try again later.';
    return s.reason;
  };

  /**
   * Asks about each question in turn, over askOne, and keeps what comes back. Never throws. A question is read again before its
   * turn: one the owner answered meanwhile is skipped. Stop (abort) ends the call in flight, which keeps nothing, and the rest are not
   * asked. Three failed calls in a row end it, with the sentence of the last.
   */
  async function runAskAll(run: AskAllRun, ids: string[]): Promise<void> {
    let problem: string | null = null;
    let overspent = false;
    let failures = 0;
    let timedMs = 0;
    let timed = 0;
    try {
      for (const id of ids) {
        if (run.abort.signal.aborted) break;
        const question = await store.getReview(id);
        if (!question || question.answer !== null) {
          run.done += 1;
          continue;
        }
        const began = env.now();
        let record: StoredSuggestion;
        try {
          record = await askOne(id, run.abort.signal);
        } catch (err) {
          if (run.abort.signal.aborted) break;
          // A key forgotten meanwhile ends the queue; any other refusal or failure is this question's alone.
          if (err instanceof AskRefused && err.message === NO_ANTHROPIC_KEY) break;
          run.done += 1;
          continue;
        }
        const stopped = run.abort.signal.aborted;
        const { suggestion } = record;
        const current = await keep(record);
        if (suggestion.status === 'not_suggested' && stopped) break;
        run.done += 1;
        // Asked: a call was made and it said something or cost something (keep() kept it). A question with nothing to ask, or a call
        // that failed, is passed over: done, not asked.
        if (suggestion.status !== 'not_suggested' || suggestion.usage !== undefined) run.asked += 1;
        run.costUsd += record.costUsd ?? 0;
        if (suggestion.usage !== undefined) {
          timedMs += env.now() - began;
          timed += 1;
        }
        if (suggestion.status !== 'not_suggested' && current) {
          run.suggested += 1;
          if (suggestion.status === 'verified') run.verified += 1;
        }
        if (providerTrouble(suggestion, stopped)) {
          failures += 1;
          if (failures >= ASK_ALL_MAX_FAILURES) {
            problem = troubleSentence(suggestion);
            break;
          }
        } else {
          failures = 0;
        }
        // The spending cap: what the queue has cost passes twice what its button said. What was suggested stays; nothing is applied.
        if (run.shownUsd !== null && run.costUsd > 2 * run.shownUsd) {
          overspent = true;
          break;
        }
        await broadcast();
      }
    } catch {
      // A storage error: what was kept stands, and the queue ends.
    }
    askAllResult = {
      total: run.total, asked: run.asked, suggested: run.suggested, verified: run.verified, costUsd: run.costUsd,
      stopped: run.abort.signal.aborted, problem, overspent,
    };
    // The seconds a call took become the next estimate's rate. Never fails the queue.
    try {
      const seconds = timed > 0 ? timedMs / 1000 / timed : 0;
      if (seconds > 0 && prefs.getRates && prefs.setRates) await prefs.setRates(addSamples(await prefs.getRates(), [{ kind: 'askAi', seconds }]));
    } catch {
      // The estimate is only less good without it.
    }
    askAll = null;
    await broadcast();
  }

  /**
   * Ask AI about all. The questions are the open ones with something to ask and no suggestion (core/src/assist/askAll.ts), oldest
   * first, taken through the start gate so no scan starts between the check and the claim. Replies once the queue is under way;
   * it runs in the background, one question at a time, and the panel stays usable. Nothing is applied: every result is a suggestion.
   */
  const askAiAll = (): Promise<Reply<{ queued: number }>> =>
    serial(async () => {
      if (scan !== null || starting) return refuse(ASK_SCAN);
      if (reading !== null) return refuse(ASK_AFTER_KIT);
      if (askAll !== null) return refuse(ASK_ALL_AGAIN);
      if ((await prefs.getAnthropicKey()) === null) return refuse(NO_ANTHROPIC_KEY);
      const open = (await store.listReview()).filter((q) => q.answer === null).sort((a, b) => a.openedAt - b.openedAt);
      const queue = askQueueOf(open, await suggestions.list()).filter((q) => !asking.has(q.id));
      if (queue.length === 0) return refuse(ASK_ALL_NOTHING);
      const model = (await ebaySettings()).judgeModel;
      const costs = queue.map((q) => estimatedQuestionCost(q.kind, model));
      const run: AskAllRun = {
        total: queue.length, done: 0, asked: 0, suggested: 0, verified: 0, costUsd: 0,
        estimateUsd: costs.every((c) => c !== null) ? costs.reduce<number>((sum, c) => sum + c!, 0) : null,
        shownUsd: askAllShownCost(queue.map((q) => q.kind), model),
        abort: new AbortController(), promise: Promise.resolve(),
      };
      askAll = run;
      askAllResult = null;
      run.promise = runAskAll(run, queue.map((q) => q.id));
      await broadcast();
      return ok({ queued: queue.length });
    });

  /** Stop: the call in flight ends and keeps nothing; the rest are not asked. Nothing running is no error. */
  async function stopAskAll(): Promise<Reply<null>> {
    if (askAll !== null && !askAll.abort.signal.aborted) {
      askAll.abort.abort();
      await broadcast();
    }
    return ok(null);
  }

  /** After a scan that was not stopped by the owner: when the owner asked for it, the queue starts. A refusal (no key, nothing to ask) is not an error. */
  async function askAfterScan(): Promise<void> {
    try {
      if (!prefs.getAskAfterScan || !(await prefs.getAskAfterScan())) return;
      await askAiAll();
    } catch {
      // The scan is done; the owner can ask by hand.
    }
  }

  async function saveAskAfterScan(on: unknown): Promise<Reply<null>> {
    if (typeof on !== 'boolean') return refuse(BAD_SETTING);
    await prefs.setAskAfterScan?.(on);
    await broadcast();
    return ok(null);
  }

  /**
   * Opens again a split question the owner answered (answers.ts, reopenReviewAnswer), so it can be
   * answered again. Gated and refused while a scan or a Look up or Verify runs, for the same reasons
   * as answerReview and with its sentences. The id is untrusted: anything not an answered split question is refused.
   */
  const reopenReview = (id: string): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(ANSWER_LATER);
      if (paid !== null) return refuse(ANSWER_AFTER_SEARCH);
      try {
        await reopenReviewAnswer(store, id, env.now());
      } catch (err) {
        if (err instanceof AnswerRefused) return refuse(err.message);
        throw err;
      }
      await broadcast();
      return ok(null);
    });

  const setPackaging = (model: string, packaging: unknown): Promise<Reply<null>> =>
    serial(async () => {
      if (packaging !== 'retail_boxed' && packaging !== 'loose') return refuse(BAD_PACKAGING);
      const key = typeof model === 'string' ? model.trim().toUpperCase() : '';
      if (key === '') return refuse(NO_MODEL);
      await prefs.savePackaging({ ...(await prefs.getPackaging()), [key]: packaging });
      await broadcast();
      return ok(null);
    });

  const setConfirmedPrice = (brand: unknown, model: unknown, price: unknown, link: unknown): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(SAVE_PRICE_LATER);
      const parsed = parseConfirmedPrice({ brand, model, price, link }, env.now());
      if (typeof parsed === 'string') return refuse(parsed);
      await store.putConfirmedPrice(parsed);
      await broadcast();
      return ok(null);
    });

  const clearConfirmedPrice = (brand: unknown, model: unknown): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(SAVE_PRICE_LATER);
      if (typeof brand !== 'string' || typeof model !== 'string') return refuse('Name the part.');
      const brandUp = brand.trim().toUpperCase();
      const modelUp = model.trim().toUpperCase();
      if (brandUp === '' || brandUp.length > CONFIRMED_BRAND_MAX || modelUp === '' || modelUp.length > CONFIRMED_MODEL_MAX) return refuse('Name the part.');
      await store.deleteConfirmedPrice(partKey(brandUp, modelUp));
      await broadcast();
      return ok(null);
    });

  /**
   * Reads one kit's Home Depot page in the browser and saves it where a scan would (kitPageTarget).
   * Spends no search. Refused while a scan, a Look up, a Verify or Ask AI runs: they share the
   * Home Depot tab or rewrite the same records. A page that comes back unreadable or refused is
   * not stored, so the kit stays "not read".
   */
  function readKitPage(brand: unknown, model: unknown): Promise<Reply<null>> {
    const claim = serial(async (): Promise<Reply<null> | { running: Promise<Reply<null>> }> => {
      if (scan !== null || starting) return refuse(READ_LATER);
      if (paid !== null) return refuse(READ_WHILE_PAID);
      if (askAll !== null || singleAsks > 0) return refuse(READ_WHILE_ASK);
      if (reading !== null) return refuse(READ_BUSY);
      if (!env.readPages) return refuse(READ_NO_BROWSER);
      if (typeof brand !== 'string' || typeof model !== 'string') return refuse('Name the part.');
      const brandUp = brand.trim().toUpperCase();
      const modelUp = model.trim().toUpperCase();
      if (brandUp === '' || brandUp.length > 40) return refuse('Name the brand.');
      if (modelUp === '' || modelUp.length > 40) return refuse('Name the part.');
      const target = kitPageTarget(await store.listBundles(), await store.listCatalog(), brandUp, modelUp);
      if (target.kind === 'stored') return refuse(READ_STORED);
      if (target.kind === 'no-id') return refuse(READ_NO_ID);
      if (target.kind !== 'page') return refuse(READ_NONE);
      // Cleared when this read ends, and only if it is still the one in flight.
      const running = finishKitRead(target).finally(() => {
        if (reading === running) reading = null;
      });
      reading = running;
      return { running };
    });
    return claim.then((result) => ('running' in result ? result.running : result));
  }

  /** The read claimed above. The caller clears `reading` when this settles. */
  async function finishKitRead(target: { where: 'bundle' | 'catalog'; key: string; itemId: string }): Promise<Reply<null>> {
    let outcomes: PageOutcome[];
    try {
      outcomes = await env.readPages!([target.itemId]);
    } catch {
      return refuse(READ_FAILED);
    }
    const outcome = Array.isArray(outcomes) ? outcomes.find((o) => o && o.itemId === target.itemId) : undefined;
    if (!outcome || outcome.kind !== 'read') {
      const status = outcome?.kind === 'refused' ? outcome.status : undefined;
      return refuse(outcome?.kind === 'refused' ? refusedPage(status) : READ_UNREADABLE);
    }
    const bullets = outcome.content.bullets;
    if (!Array.isArray(bullets) || bullets.some((b) => typeof b !== 'string')) return refuse(READ_UNREADABLE);
    const description = outcome.content.description;
    const page: PageReading = { bullets: [...bullets], description: typeof description === 'string' ? description : null, readAt: env.now() };
    if (target.where === 'catalog') {
      const entry = await store.getCatalogEntry(target.key);
      if (!entry || entry.itemId !== target.itemId) return refuse(READ_NONE);
      if (entry.page) {
        await broadcast();
        return refuse(READ_STORED);
      }
      await store.putCatalogEntry({ ...entry, page });
    } else {
      const bundle = await store.getBundle(target.key);
      if (!bundle || bundle.itemId !== target.itemId) return refuse(READ_NONE);
      if (bundle.page) {
        await broadcast();
        return refuse(READ_STORED);
      }
      await store.putBundle({ ...bundle, page });
    }
    await broadcast();
    return ok(null);
  }

  // ---------------------------------------------------------------- Verify and Look up (paid.ts)

  /**
   * The account a quote reads: the one saved in the last five minutes, or a fresh check (free),
   * saved. A saved account can be hours old, and its hour's searches would refuse a click that
   * fits now. A failed check is its one plain sentence.
   */
  async function accountForQuote(key: string): Promise<AccountInfo | string> {
    const stored = await prefs.getAccount();
    // Read again just before the check: a key forgotten or replaced meanwhile is never sent.
    const moved = await keyMoved(key);
    if (moved !== null) return moved;
    if (stored !== null && env.now() - stored.at < ACCOUNT_FRESH_MS) return stored.info;
    try {
      const info = await accountOf(key);
      // And after it: a key forgotten or replaced during the check does not have its account saved.
      const movedSince = await keyMoved(key);
      if (movedSince !== null) return movedSince;
      await prefs.setAccount({ info, at: env.now() });
      return info;
    } catch (err) {
      return accountSentence(err);
    }
  }

  /** Null while `key` is still the saved key; otherwise the sentence for a key forgotten or replaced since it was read. */
  async function keyMoved(key: string): Promise<string | null> {
    const keyNow = await prefs.getKey();
    if (keyNow === key) return null;
    return keyNow === null ? NO_KEY : KEY_CHANGED_PAID;
  }

  /**
   * What a Verify or Look up would spend, shown before the click, and why it may not run now: a
   * scan or another paid action is running, there is no key, the account cannot be checked, the
   * store refuses it (refusalFor), or the manual-trigger budget does not fit it (quotePaid). A
   * request that is not a paid action the panel offers is refused.
   */
  async function quote(action: PaidAction): Promise<Reply<Quote>> {
    const unreadable = requestProblem(action);
    if (unreadable !== null) return refuse(unreadable);
    const key = await prefs.getKey();
    let refusal: string | null = scan !== null || starting ? SCAN_RUNNING : paid !== null ? PAID_RUNNING : reading !== null ? PAID_AFTER_KIT : null;
    let budget: BudgetView = CLOSED;
    if (refusal === null && key === null) refusal = NO_KEY;
    else if (refusal === null && key !== null) {
      const account = await accountForQuote(key);
      if (typeof account === 'string') refusal = account;
      else budget = new SearchBudget(account, budgetPolicyFor(await settings(), 'manual', 0));
    }
    refusal ??= await refusalFor(store, action);
    const s = await settings();
    const keepa = await buildKeepaDeps(s);
    const q = quotePaid(action, await savedAnswers(store), budget, keepa.quoteKeepa);
    // The whole quote, with the parts a Look up leaves for the next press (Ruling 72).
    return ok({ ...q, refusal: refusal ?? q.refusal });
  }

  /**
   * Runs a Verify or Look up. Taken through the start gate and claimed there: refused while a scan
   * runs, and while another paid action runs, so one runs at a time and no scan starts beside it.
   * Replies when the action has ended.
   */
  async function runPaidAction(action: PaidAction): Promise<Reply<null>> {
    const claim = await serial(async (): Promise<Reply<null> | { running: Promise<Reply<null>> }> => {
      const unreadable = requestProblem(action);
      if (unreadable !== null) return refuse(unreadable);
      if (scan !== null) return refuse(SCAN_RUNNING);
      if (paid !== null) return refuse(PAID_RUNNING);
      if (reading !== null) return refuse(PAID_AFTER_KIT);
      const key = await prefs.getKey();
      if (key === null) return refuse(NO_KEY);
      // Claimed before the gate opens again. Wrapped, so the gate does not wait for the action.
      paidKey = key;
      paidStop = false;
      const running = spend(key, action);
      paid = running;
      return { running };
    });
    return 'running' in claim ? claim.running : claim;
  }

  /**
   * The action with the manual-trigger budget (reserve 0, at most searchesPerScan), built from a
   * fresh account check as a scan's is. A refusal or a failed search is replied in one plain
   * sentence with the key taken out; nothing is retried. Afterwards the account is checked again
   * when anything was spent, and the state is broadcast.
   */
  async function spend(key: string, action: PaidAction): Promise<Reply<null>> {
    let spent = false;
    try {
      let account: AccountInfo;
      try {
        account = await accountOf(key);
      } catch (err) {
        // The caller's sentence only: `problem` is a scan's, and the Notice would offer a scan's Retry for it.
        return refuse(accountSentence(err));
      }
      // Asked again before anything is saved or sent, so a forgetKey sent during the check is not lost.
      const moved = await keyMoved(key);
      if (moved !== null) return refuse(moved);
      await prefs.setAccount({ info: account, at: env.now() });
      problem = null;
      const s = await settings();
      const budget = new SearchBudget(account, budgetPolicyFor(s, 'manual', 0));
      const client = new SerpApiClient({ apiKey: key, budget, cache: env.cache, fetchFn: env.fetchFn, onSpend: env.ledger, now: env.now, baseUrl });
      const keepa = await buildKeepaDeps(s);
      try {
        await runPaid({
          client, budget, store, now: env.now, settings: toScanSettings(s), shouldStop: () => (paidStop ? PAID_STOPPED : null),
          productPage: keepa.productPage, keepaBudget: keepa.keepaBudget, keepaLookup: keepa.keepaLookup,
        }, action);
        return ok(null);
      } catch (err) {
        if (err instanceof PaidProblem) return refuse(err.message);
        // A failed search, or a store that could not be written.
        return refuse(withoutKey((err instanceof Error && err.message) || FAILED, key));
      } finally {
        spent = budget.spentThisRun > 0;
      }
    } finally {
      if (spent) await recheckAccount(key);
      paid = null;
      paidKey = null;
      paidStop = false;
      await broadcast();
      settleDeferred();
    }
  }

  /**
   * After a paid action spent: the account of `key` checked again (free) and saved, as after a scan,
   * but only while `key` is still the saved key, before the check and after it. A forgotten key is
   * never sent again, and a new key's account is never overwritten with the old key's.
   */
  async function recheckAccount(key: string): Promise<void> {
    try {
      if ((await prefs.getKey()) !== key) return;
      const info = await accountOf(key);
      if ((await prefs.getKey()) === key) await prefs.setAccount({ info, at: env.now() });
    } catch {
      // The saved account is the one from before; a quote checks again once it is five minutes old.
    }
  }

  // ---------------------------------------------------------------- the chip and This page (step 7)

  /**
   * The page as notePage reads it, and nothing the sender added: it comes from a web page's content script. A price or
   * description a message left out (null is not always kept on the way) is null, as parseProductPage gives it; notePage
   * checks everything else, so a message that is not a page is passed on as it is and read as none.
   */
  function cleanPage(p: ProductPage): ProductPage {
    if (typeof p !== 'object' || p === null) return p;
    return {
      itemId: p.itemId, brand: p.brand, model: p.model, title: p.title, price: p.price ?? null, wasPrice: p.wasPrice ?? null,
      bullets: Array.isArray(p.bullets) ? [...p.bullets] : p.bullets, description: p.description ?? null,
    };
  }

  /**
   * A Home Depot product page the owner opened, sent by the chip's content script. Taken through the start gate, so two
   * writes never interleave. While a scan or a Look up or Verify runs, which write the same records, the view is computed
   * over a layer that is dropped (write: false) and the page is stored when they have ended; the chip never waits for them.
   * A page that is not a bundle (view none) makes the tab show no page. Never a search.
   */
  const pageSeen = (sent: ProductPage, tabId: number | undefined): Promise<Reply<PageSeenReply>> =>
    serial(async () => {
      const page = cleanPage(sent);
      if (tabId === undefined) return refuse(NO_TAB);
      // The tab a scan's reader opened runs the content script too: its pages are the scan's, not the owner's.
      if (await pages.isReaderTab(tabId)) return ok({ kind: 'none' });
      await pages.setChipTab(tabId, true);
      // The chip is turned off: nothing is read or stored, and the tab keeps no page of an earlier visit.
      if (!(await prefs.getShowChip())) {
        // A visit already waiting to be stored happened while the chip was on: it is kept.
        await pages.save(tabId, null);
        return ok({ kind: 'off' });
      }
      const write = scan === null && paid === null;
      const seenAt = env.now();
      const view = await notePage(store, toScanSettings(await settings()), page, seenAt, { write });
      if (view.kind === 'bundle') {
        await pages.save(tabId, page);
        // Not written now: kept with the visit's time, so it is stored as of the visit once the action has ended.
        await pages.setDeferred(tabId, page.itemId, write ? null : { page, seenAt });
      } else {
        await pages.save(tabId, null);
      }
      await broadcast();
      return ok(view);
    });

  /**
   * Stores the pages seen while a scan or a Look up or Verify ran, once none runs, in the order they were seen and as of
   * the time each was seen. Asked again by whichever ends last and by every tick (so after a restart too), and left alone
   * while something runs. A page whose store fails stays deferred, and the others go on.
   */
  function settleDeferred(): void {
    void serial(async () => {
      if (scan !== null || paid !== null) return;
      const due = (await pages.deferredAll()).sort((a, b) => a.seenAt - b.seenAt || a.tabId - b.tabId || a.page.itemId.localeCompare(b.page.itemId));
      if (due.length === 0) return;
      const s = toScanSettings(await settings());
      let stored = false;
      for (const d of due) {
        try {
          await notePage(store, s, d.page, d.seenAt);
          await pages.setDeferred(d.tabId, d.page.itemId, null);
          stored = true;
        } catch {
          // Stays deferred: the next end of an action, or the next tick, tries again.
        }
      }
      if (stored) await broadcast();
    }).catch(() => {
      // The next tick tries again.
    });
  }

  /** The view of the tab's page, rebuilt from the store: never a search and never a write, so it waits for nothing. */
  async function getThisPage(tabId: unknown): Promise<Reply<ThisPage>> {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return refuse(NO_TAB);
    // A page read before the chip was turned off is not shown: the owner has stopped pages being read.
    if (!(await prefs.getShowChip())) return ok({ kind: 'off' });
    const page = await pages.load(tabId);
    if (page === null) return ok({ kind: 'empty' });
    const view = await notePage(store, toScanSettings(await settings()), page, env.now(), { write: false });
    return ok(view.kind === 'bundle' ? view : { kind: 'empty' });
  }

  /**
   * The chip was clicked: the panel opens on This page for that tab. Not taken through the gate: Chrome allows
   * sidePanel.open only in answer to the click, so it is called before anything is awaited. The panel learns it from
   * `wanted` (read when it starts) and from tell() (when it is already open).
   */
  async function openThisPage(tabId: number | undefined): Promise<Reply<OpenThisPageReply>> {
    if (tabId === undefined) return refuse(NO_TAB);
    let opening: Promise<void>;
    try {
      opening = pages.openPanel(tabId);
    } catch (err) {
      opening = Promise.reject(err);
    }
    const opened = opening.then(() => true, () => false);
    await pages.setWanted(tabId, true);
    if (!(await opened)) {
      await pages.setWanted(tabId, false);
      return ok({ opened: false });
    }
    pages.tell(tabId);
    return ok({ opened: true });
  }

  /** True once if the chip opened the panel for this tab; the answer is then consumed. */
  async function takeShowThisPage(tabId: unknown): Promise<Reply<boolean>> {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) return refuse(NO_TAB);
    if (!(await pages.wanted(tabId))) return ok(false);
    await pages.setWanted(tabId, false);
    return ok(true);
  }

  /**
   * Settings › Delete all data. Deals, matches, answers, confirmed prices, suggestions and saved
   * searches go. The key, the settings and the search ledger stay, so the searches already counted
   * still count. A visit waiting to be stored is dropped, or the next tick would write it back.
   */
  async function deleteAllData(): Promise<Reply<null>> {
    if (scan !== null || starting) return refuse(DELETE_LATER_SCAN);
    if (paid !== null) return refuse(DELETE_LATER_PAID);
    if (reading !== null) return refuse(DELETE_LATER_READ);
    if (askAll !== null || singleAsks > 0) return refuse(DELETE_LATER_ASK);
    await store.clearAll();
    await env.cache.clear();
    await prefs.setNotified([]);
    await prefs.clearDiscoverySections?.();
    await suggestions.clear();
    for (const d of await pages.deferredAll()) await pages.setDeferred(d.tabId, d.page.itemId, null);
    await broadcast();
    return ok(null);
  }

  async function handle(request: Request, sender: RequestSender): Promise<Reply> {
    switch (request.type) {
      case 'getState':
        return ok(await getState());
      case 'checkKey':
        return checkKey(request.apiKey);
      case 'forgetKey':
        return forgetKey();
      case 'saveEbayKeys':
        return saveEbayKeys(request.appId, request.certId);
      case 'forgetEbayKeys':
        return forgetEbayKeys();
      case 'saveAnthropicKey':
        return saveAnthropicKey(request.apiKey);
      case 'forgetAnthropicKey':
        return forgetAnthropicKey();
      case 'saveKeepaKey':
        return saveKeepaKey(request.apiKey);
      case 'forgetKeepaKey':
        return forgetKeepaKey();
      case 'saveRelayConfig':
        return saveRelayConfig(request.url, request.secret);
      case 'forgetRelayConfig':
        return forgetRelayConfig();
      case 'saveEbaySettings':
        return saveEbaySettings(request.judgeModel, request.listingsJudgedPerScan);
      case 'answerEbay':
        return answerEbay({ key: request.key, itemId: request.itemId, answer: request.answer });
      case 'scanNow':
        return scanNow();
      case 'saveSettings':
        return saveSettings(request.settings);
      case 'exportDeals':
        return exportDeals();
      case 'exportMatches':
        return exportMatches();
      case 'exportAudit':
        return exportAudit();
      case 'stopScan':
        if (scan !== null || starting) askStop();
        return ok(null);
      case 'clearSavedSearches':
        await env.cache.clear();
        return ok(null);
      case 'deleteAllData':
        return deleteAllData();
      case 'getReport':
        return getReport();
      case 'setPackaging':
        return setPackaging(request.model, request.packaging);
      case 'setConfirmedPrice':
        return setConfirmedPrice(request.brand, request.model, request.price, request.link);
      case 'clearConfirmedPrice':
        return clearConfirmedPrice(request.brand, request.model);
      case 'readKitPage':
        return readKitPage(request.brand, request.model);
      case 'answerReview':
        return answerReview(request.id, request.answer, request.aiSuggestion === true);
      case 'askAi':
        return askAi(request.questionId);
      case 'askAiAll':
        return askAiAll();
      case 'stopAskAll':
        return stopAskAll();
      case 'saveAskAfterScan':
        return saveAskAfterScan(request.on);
      case 'reopenReview':
        return reopenReview(request.id);
      case 'quote':
        return quote(request.action);
      case 'runPaid':
        return runPaidAction(request.action);
      case 'pageSeen':
        return pageSeen(request.page, sender.tabId);
      case 'openThisPage':
        return openThisPage(sender.tabId);
      case 'getThisPage':
        return getThisPage(request.tabId);
      case 'takeShowThisPage':
        return takeShowThisPage(request.tabId);
      default:
        return refuse(FAILED);
    }
  }

  return {
    async onMessage(request, sender = {}) {
      try {
        return await scrubbed(await handle(request, sender));
      } catch {
        // A storage error: the page still gets an answer.
        return refuse(FAILED);
      }
    },
    // Through the gate, so a visit still being stored is not left behind by the tab's closing.
    onTabClosed: (tabId) =>
      serial(async () => {
        try {
          // Its visits waiting to be stored are kept: they happened, and are stored when the scan or search ends.
          await pages.save(tabId, null);
          await pages.setWanted(tabId, false);
          await pages.setChipTab(tabId, false);
        } catch {
          // Session storage may be unavailable; a tab id is not reused within a session.
        }
      }),
    async onChipSetting(show) {
      try {
        const tabs = await pages.chipTabs();
        // A tab that has no content script any more (closed, or navigated off Home Depot) refuses: nothing to do.
        await Promise.allSettled(tabs.map((tabId) => pages.sendChipSetting(tabId, show)));
      } catch {
        // Session storage may be unavailable; a tab picks the setting up on its next page.
      }
      // The panel's This page re-reads on every state change: it says the chip is off, or shows the page, at once.
      await broadcast();
    },
    onTick: tick,
    onStart: tick,
  };
}
