// The agent does the work (step 13, W4, Decisions 1 and 5): the schedule, the scan (core's runScan with the owner's
// keys from the store, the budget ledger and reserve in the data folder, the per-scan cap from Settings), the Home Depot
// reads through the paired Chrome (remoteReaders.ts), Keepa inside the scan (core plans discovery vs tracking per
// run), then without the owner: the eBay step (inside the scan), the AI pass on open Review questions, Autopilot, the
// digest and Telegram, and the run's record in Activity. One thing at a time: a scan, an AI pass or a Look up/Verify.
//
// Every paid call goes through core's clients: SerpAPI through SerpApiClient + SearchBudget (rule 1: a scheduled scan
// never touches the reserve; Scan now may, as in the extension), Keepa through KeepaClient + TokenBudget, models through
// pipelinesFrom. Keys come from the store and are never in a sentence this file writes (scrub).

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings, AskResponse, DripState, EvidenceQuote, KeyName, LookupsRunResponse, NotifyEvent, RunRecord, ScanStartResponse } from '../core/src/api/contract';
import { profitQualifier } from '../core/src/estimateNote';
import { keepaTokensForScan, routeAmazonWork, type KeepaRoom, type SerpRoom } from '../core/src/keepa/route';
import { lookupsSentence, lookupWaysSentence, type LookupWays, sumWays } from '../core/src/deals/lookupCopy';
import { gatherEvidence } from '../core/src/assist/evidence';
import { afterLead, pipelinesFrom } from '../core/src/ai/factory';
import { liveSuggestion, agreedWith, type StoredSuggestion } from '../core/src/assist/stored';
import { approvalOf } from '../core/src/assist/approve';
import { EbayClient } from '../core/src/ebay/client';
import { partPriceDropMessage } from '../core/src/keepa/alerts';
import { TokenBudget } from '../core/src/keepa/budget';
import { KeepaClient, KeepaError } from '../core/src/keepa/client';
import { type KeepaLookupAsk, keepaPartLookup, keepaProductSearchResult } from '../core/src/keepa/fetchStep';
import { keepCodeSample } from '../core/src/keepa/barcode';
import { readPartTrend, readTrends, writePartTrend, type PartTrend } from '../core/src/keepa/trends';
import { nextRun } from '../core/src/schedule';
import { AnswerRefused, applyReviewAnswer, reviewSignature } from '../core/src/scan/answers';
import { withBuying, withoutBuying } from '../core/src/scan/buying';
import { applyEbayAnswer } from '../core/src/scan/ebayAnswers';
import { EBAY_ITEM_READS_MAX, EBAY_SEARCHES_MAX, type EbayStep, NOTICE as EBAY_NOTICE } from '../core/src/scan/ebayPass';
import { PaidProblem, lookupsNeeded, quotePaid, runPaid, savedAnswers } from '../core/src/scan/paid';
import {
  addSamples, DESKTOP_STEP_WORDS, endStep, finishUnit, moveUnits, newTailSteps, type PipelineStep, pipelineOf, pipelineViewOf, samplesOf, skippedPagesSentence, skipStep, startStep, type PipelineView, type StepState,
} from '../core/src/scan/pipeline';
import { postScanWork } from '../core/src/scan/postScan';
import { applyPriceGuard } from '../core/src/scan/priceGuard';
import { rechecksWaiting, runRechecks, withdrawListing } from '../core/src/scan/recheck';
import { partRowsFor } from '../core/src/scan/report';
import { bogoFromBody, bogoView, freeParts, type BogoView } from '../core/src/tracking/bogo';
import {
  bogoDigestLines, bogoGroups, mergeBogoPairs, pairBundleRecord, pairFacts, pairsBehindBest, readBogoPass, todayOf, type BogoBrandResult, type BogoGroup,
} from '../core/src/tracking/bogoPairs';
import { priceEndsMessages } from '../core/src/tracking/buying';
import { fbaEstimateOf, type FbaEstimate } from '../core/src/tracking/fba';
import type { TrendLookup } from '../core/src/tracking/signals';
import { announcedAfter, dayOf, freshSignals, trackReport } from '../core/src/tracking/state';
import {
  barcodeLookupsWanted, keepaBarcodeOne, keepaLookupOne, kitPagesWanted, type LookupStep, pageRead, partPagesWanted, partPricesWanted, plannedWork, rejudgePackQuestions, readKitPagesFor, readPartPricesFor, readSetItemsFor, runScan, settleWaitingSplits, splitOne, withdrawUnreadSplitQuestions,
} from '../core/src/scan/runner';
import { knownModels } from '../core/src/scan/split';
import { KEEPA_LOOKUP_TOKEN_ESTIMATE, KEEPA_SEARCH_TOKEN_ESTIMATE } from '../core/src/keepa/estimates';
import type { ConfirmedPrice, PaidAction, ReviewAnswer, ReviewItem, ScanJob, ScanReport, ScanStore } from '../core/src/scan/types';
import { partKey } from '../core/src/scan/types';
import { parseLedger, searchesLeftNow } from '../core/src/serpapi/balance';
import { type AccountInfo, SearchBudget } from '../core/src/serpapi/budget';
import { type LedgerEntry, SerpApiClient, SerpApiError } from '../core/src/serpapi/client';
import {
  BRAND_QUERIES, budgetPolicyFor, estimatedJudgeCost, type ExtensionSettings, type ScanTrigger, toScanSettings, validateSettings,
} from '../core/src/settings';
import { runAiPass, askOneWith, type AiPassResult, type StepProgress } from './aiPass';
import { backfillBriefs, type BriefCtx, briefAfterKeep } from './brief';
import { catalogSentence } from '../core/src/scan/catalogCheck';
import { buyWaitsOn, checksWaiting, checksWanted, repickUnconfirmed, verifyMatchesWithKeepa } from './verifyMatches';
import { autoConfirmWanted, confirmationQueue, keepaCanPull, repickTargets, rung2CanRun, runAutoConfirm, unconfirmableOf, type AutoConfirmDone } from './autoConfirm';
import { checkOwnWork, evaluateSignals, pullKeepingTrends, pullSales, pullsWanted, reportWithTrends, sanityHolds, type SignalsDeps, trendsOfReport, withoutStale } from './signalsPass';
import { SellerAccount } from './seller';
import { dealSnapshots, keepaKeeps, keptNow, pullDue, readOneDue, staleBuyKeys, tokenShareOf, used } from './keepCurrent';
import { backfillMarkets, cachedMarkets, MARKET_BACKFILL } from './marketBackfill';
import { amazonDue, failingOf, hdDue, keepUsageOf, snapshotOf, verdictChanges, type DealSnapshot } from '../core/src/tracking/keepCurrent';
import type { TrackingState } from '../core/src/tracking/state';
import { productTokenEstimate } from '../core/src/keepa/estimates';
import { averagePullsWanted, pullAverages } from './suggestPrices';
import { dripPull, selfCorrect } from './recheck';
import { forgetFact, markNotSold, rememberAnswer, type Remembered } from '../core/src/facts/apply';
import type { FactField } from '../core/src/facts/fact';
import { freshFollowUp } from '../core/src/research/followUp';
import { askPlan, followUpPass } from './followUp';
import { reverifyPass, wantedReads, withEvidenceKey } from './reverify';
import { buildDigest, sendPending, type OutgoingTelegram } from './alerts';
import { scrubKeyText } from './keyChecks';
import { NotifyPolicy } from './notifyPolicy';
import { applyAutopilot, autopilotDecision, undoAutopilot } from './autopilot';
import { answerText, footprintOf, type Footprint, KEEP_OWNER_ANSWERS, restorable, undoOwnerAnswer } from './ownerAnswers';
import { remoteReaders, type ReadGate, type ReaderTimeouts, type RemoteReaders } from './remoteReaders';
import { backlogSentence, fullPerHour, HD_LIST_REREAD_MS, HdPace, type HdMode, paceStateOf, pausedSentence } from '../core/src/scan/hdPace';
import { backlogOf, pagesWanted } from '../core/src/scan/hdOrder';
import { bundleListsOf, discoveryFor, discoveryNote, scheduledScanWaits } from './scanSource';
import { DirCache, FileScanStore } from './scanStore';
import type { ActivityErrorRecord, PendingMessage, Store, StoredAutopilotEntry, StoredKeys, StoredOwnerAnswer, TelegramAbout } from './store';
import { aiSpentThisMonth, asksAboutEbay } from './views';
import { CostBook, scanHistory } from './costs';
import type { CostStep } from '../core/src/costs/decide';
import { localDate } from '../core/src/costs/time';
import type { CostDecision, CostService } from '../core/src/costs/types';
import { estimatedQuestionCost } from '../core/src/assist/cost';
import { askQueueOf } from '../core/src/assist/askAll';
import type { WorkerJobs } from './workerJobs';
import { catchUpSentence, slotOf } from '../core/src/selfRun/catchUp';
import { nextScanNeeds } from '../core/src/selfRun/words';
import type { WeeklySummary } from '../core/src/selfRun/weekly';
import type { ChromeControl } from './openChrome';
import { SelfRun } from './selfRun';

/** How often the scheduler looks whether a scan is due. */
export const TICK_MS = 30_000;
/** Runs kept in Activity. */
const KEEP_RUNS = 200;
const KEEP_ERRORS = 50;
/** Progress reaches the app at most this often. */
const PROGRESS_MS = 1_000;
/** One eBay or model call in the scan's eBay step. */
const CALL_TIMEOUT_MS = 30_000;
/** Evidence lines shown per question. */
const EVIDENCE_LINES = 40;

export class WorkRefused extends Error {}

/**
 * Nov 23: what the run found, leading the summary. "Found 16 bundles; 0 estimated because their Home Depot pages were not
 * read — Read again (free)." when every bundle without an estimate waits for its page; else how many wait. Home Depot's
 * pace: with `backlog` (backlogSentence: how many pages wait and at what pace they are read), that sentence follows in
 * place of the Read again hint.
 */
export function outcomeSentence(report: ScanReport, backlog?: string | null): string {
  const n = report.bundles.length;
  const estimated = report.bundles.filter((b) => b.estimate !== null).length;
  const waiting = report.bundles.filter((b) => b.waitingPage === true).length;
  const found = `Found ${n} ${n === 1 ? 'bundle' : 'bundles'}; ${estimated} estimated`;
  if (waiting === 0) return backlog ? `${found}. ${backlog}` : `${found}.`;
  const tail = backlog ? `. ${backlog}` : ' — Read again (free).';
  if (waiting === n - estimated) return `${found} because ${waiting === 1 ? 'its Home Depot page was' : 'their Home Depot pages were'} not read${tail}`;
  return `${found}; ${waiting} ${waiting === 1 ? 'waits for its' : 'wait for their'} Home Depot ${waiting === 1 ? 'page' : 'pages'}${tail}`;
}

export interface WorkDeps {
  store: Store;
  jobs: WorkerJobs;
  dataDir: string;
  now: () => number;
  /** Every call to SerpApi, Keepa, eBay, a model and Telegram goes through this. Tests pass fakes. */
  fetchFn: typeof fetch;
  helperConnected: () => boolean;
  notify: (n: Omit<NotifyEvent, 'id'>) => NotifyEvent;
  /** Something the state shows changed (the app publishes a `state` event). */
  changed: () => void;
  readerTimeouts?: Partial<ReaderTimeouts>;
  serpBaseUrl?: string;
  /** Tests replace the scan itself. */
  runScan?: typeof runScan;
  /** Holds the computer awake while a scan or Look up all runs (agent/keepAwake.ts). Absent: nothing is held (tests). */
  keepAwake?: { hold(): () => void };
  /** Starts (and may quit) the owner's Chrome for a scheduled scan (agent/openChrome.ts). Absent: never (tests give a fake). */
  chrome?: ChromeControl;
  /**
   * Home Depot's pace (core/src/scan/hdPace.ts): how it waits for the gap (default a real timer that a Stop ends) and its
   * jitter draw (default Math.random). Tests pass a sleep that moves their clock.
   */
  hdSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  hdRandom?: () => number;
  /** Nov 25, tests: the seller API's two addresses and its wait (agent/seller.ts). */
  spUrls?: { tokenUrl: string; baseUrl: string };
  spSleep?: (ms: number) => Promise<void>;
}

/** A real wait of `ms` that `signal` ends early (rejecting). */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('stopped'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('stopped'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface LiveState {
  busy: 'scan' | 'ask' | 'paid' | null;
  stopping: boolean;
  pipeline: PipelineView | null;
  searchesUsed: number;
  /** Step 15: the drip of Keepa lookups between scans; absent while it is off (setting, no Keepa key). */
  drip?: DripState;
}

/**
 * Step 15, decision 2: the drip looks at Keepa's free token status at most this often. The account refills 1 token a
 * minute (recorded), so a lookup's 11 tokens come back in 11 minutes; looking every 5 is enough and costs nothing.
 */
export const DRIP_POLL_MS = 5 * 60_000;
/** The listing ladder, rung 2: its looks in the drip are at least this far apart. */
export const AUTO_CONFIRM_EVERY_MS = 10 * 60_000;
/** Step 15: the drip's lookups are one Activity run per hour. */
export const DRIP_RUN_MS = 60 * 60_000;

/** The extension's settings shape, which core's scan and budget functions take. */
export function extensionSettingsOf(a: AppSettings): ExtensionSettings {
  const s = a.settings;
  return {
    schedule: s.schedule, searchesPerScan: s.searchesPerScan, reserve: s.reserve, brands: s.brands, pagesPerBrand: s.pagesPerBrand, fees: s.fees,
    alerts: a.alerts, keepaTokensPerScan: s.keepaTokensPerScan, keepaReserve: s.keepaReserve, discoveryMode: s.discoveryMode,
    keepaDiscoveryShare: s.keepaDiscoveryShare, trackingDepth: s.trackingDepth, amazonRefreshViaKeepa: s.amazonRefreshViaKeepa,
    // Core's field for the extension's own scans; nothing posts to the agent after an agent scan.
    agentBridgeAfterScan: false,
  };
}

/** Every key the store holds, as text, so no sentence can carry one out. */
export function secretsOf(keys: StoredKeys): string[] {
  const s = keys.amazonSeller;
  return [keys.serpapi, keys.keepa, keys.anthropic, keys.openai, keys.ebay?.appId, keys.ebay?.certId, keys.telegram?.botToken, s?.clientId, s?.clientSecret, s?.refreshToken, s?.sellerId].filter(
    (k): k is string => typeof k === 'string' && k.length >= 4,
  );
}

export function scrub(text: string, keys: StoredKeys): string {
  let out = text;
  for (const k of secretsOf(keys)) out = out.split(k).join('[key]');
  return out;
}

const SERP_LEDGER = 'serpapi-ledger.jsonl';

const sentenceOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'Something went wrong.');

/** Step 15: Look up all's search cap: the per-scan cap, or `maxSearches` when that is lower. */
function lookupsCap(ext: ExtensionSettings, maxSearches: number | undefined): ExtensionSettings {
  return maxSearches === undefined ? ext : { ...ext, searchesPerScan: Math.min(ext.searchesPerScan, Math.max(0, Math.floor(maxSearches))) };
}

/** The policy that spends the owner's reserve is the manual one; every other search keeps it, whoever started the run. */
const reserveTrigger = (explicit: boolean): ScanTrigger => (explicit ? 'manual' : 'scheduled');

/** What one drip round did, for its Activity run (dripRecord). */
interface DripDone {
  looked: number; matched: number; none: number; review: number; tokens: number; verified: number; removed: number; sales: number;
  /** Keeping deals current: Amazon prices of watched deals pulled again. */
  kept?: number;
  /** Nov 25: its Keepa lookups by what found their candidates (barcode or search), and the tokens of each. */
  ways?: LookupWays;
}

/** One Keepa lookup of the drip counted on its round. */
function tallyLookup(done: DripDone, out: { status: string; tokens: number; verified?: number; removed?: number; way?: LookupWays }): void {
  done.looked += 1;
  done.tokens += out.tokens;
  done.verified += out.verified ?? 0;
  done.removed += out.removed ?? 0;
  if (out.status === 'matched') done.matched += 1;
  else if (out.status === 'review') done.review += 1;
  else done.none += 1;
  if (out.way) done.ways = sumWays(done.ways, out.way);
}

export class AgentWork {
  readonly scanStore: ScanStore;
  readonly cache: DirCache;
  /** Home Depot's pace: every Home Depot read, in a scan and between scans, goes through it (gate). */
  readonly pace: HdPace;
  private readonly d: WorkDeps;
  /** D2: the kinds, quiet hours and digest timing the owner set. */
  readonly policy: NotifyPolicy;
  private readonly live: LiveState = { busy: null, stopping: false, pipeline: null, searchesUsed: 0 };
  private stopCtl = new AbortController();
  /** Ends the keep-awake hold the running scan took (claim), or null. */
  private releaseAwake: (() => void) | null = null;
  private current: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private progressAt = 0;
  /** Owner answers (and Undo) being applied, one at a time through answerChain. */
  private answering = 0;
  private answerChain: Promise<void> = Promise.resolve();
  /** Step 18: what the services cost, the cost blocker's answers and the warnings (agent/costs.ts). */
  readonly costs: CostBook;
  /** Step 18: the run a held step belongs to (its message goes once per service per run). */
  private costRun = 'start';
  /** Nov 25: makes each Telegram message as it goes out, with its buttons when the owner acts from Telegram (agent/telegramBot.ts). */
  telegramCompose: ((m: PendingMessage) => OutgoingTelegram[]) | null = null;
  /** Nov 25, running without the owner: Chrome started for a scan, open at login, the weekly summary (agent/selfRun.ts). */
  readonly selfRun: SelfRun;
  /** When this agent started, and when the scheduler last looked: a scan that starts late says whether the app was running or the computer asleep. */
  private readonly startedAt: number;
  private lastTickAt: number | null = null;
  private catchUp: string | null = null;
  /** The key of the scheduled scan that is starting (SelfRun.scanKey, taken before the schedule counts from its start). */
  private scheduledKey: string | null = null;
  /** Nov 25: the owner's Amazon seller account, read-only (agent/seller.ts). */
  readonly seller: SellerAccount;
  /** Why the last seller pass stopped (said once in Activity), or null. */
  private sellerStopped: string | null = null;

  constructor(deps: WorkDeps) {
    this.d = deps;
    this.costs = new CostBook({ store: deps.store, dataDir: deps.dataDir, now: deps.now });
    this.seller = new SellerAccount({
      store: deps.store, fetchFn: deps.fetchFn, now: deps.now, dataDir: deps.dataDir,
      count: (n) => this.costs.count('amazon', n),
      onKeyProblem: (s) => this.keyProblem('amazonSeller', s),
      ...(deps.spUrls ? { spUrls: deps.spUrls } : {}), ...(deps.spSleep ? { sleep: deps.spSleep } : {}),
    });
    this.policy = new NotifyPolicy({ settings: () => deps.store.get('settings').notifications, now: deps.now, emit: deps.notify });
    mkdirSync(deps.dataDir, { recursive: true });
    this.scanStore = new FileScanStore(join(deps.dataDir, 'scan'));
    this.cache = new DirCache(join(deps.dataDir, 'cache'));
    this.dealsAtStart = deps.store.get('deals').bundles.length > 0;
    this.startedAt = deps.now();
    this.selfRun = new SelfRun({
      store: deps.store, now: deps.now, ...(deps.chrome ? { chrome: deps.chrome } : {}), helperConnected: deps.helperConnected,
      nextScanAt: () => this.nextScanAt(), busy: () => this.writing(), jobsWaiting: () => deps.jobs.waitingCount(), hdPausedUntil: () => this.pace.pausedUntil(),
      record: (sentence) => this.noteSentence(sentence), changed: () => deps.changed(), costs: this.costs, announceWeekly: (w) => this.announceWeekly(w),
    });
    this.pace = new HdPace({
      now: deps.now, sleep: deps.hdSleep ?? sleepFor, ...(deps.hdRandom ? { random: deps.hdRandom } : {}),
      load: () => paceStateOf(deps.store.get('runtime').hdPace),
      save: (s) => deps.store.update('runtime', (r) => ({ ...r, hdPace: s })),
    });
  }

  /** Home Depot's pace: the pages the stored bundles wait for (hdOrder.ts), counted now and kept for the state and the rows. */
  async noteBacklog(): Promise<{ pages: number; sets: number; bundles: number }> {
    const b = backlogOf(pagesWanted(await this.scanStore.listBundles()));
    const at = this.d.now();
    this.d.store.update('runtime', (r) => ({ ...r, hdBacklog: { ...b, at } }));
    return b;
  }

  /** Home Depot's pace bound to a kind of run, for the readers (remoteReaders' gate). */
  gate(mode: HdMode): ReadGate {
    return { take: (signal) => this.pace.take(mode, signal) };
  }

  // ------------------------------------------------------------------ signals round 2: buy signals between scans

  /** Whether the store held deals when the agent started: only then does the start rebuild them and judge their signals. */
  private readonly dealsAtStart: boolean;

  private signalsDeps(): SignalsDeps {
    return {
      store: this.d.store, cache: this.cache, now: this.d.now, policy: this.policy,
      telegram: async (text, about) => {
        await this.sendTelegram(text, about);
      },
      keepa: () => {
        const app = this.d.store.get('settings');
        return Boolean(this.d.store.get('keys').keepa) && app.settings.amazonRefreshViaKeepa && app.lookups?.drip !== false;
      },
      flatFee: () => this.d.store.get('settings').settings.fees.fulfillmentFee,
      seller: () => this.seller.lookup(),
      stale: () => staleBuyKeys({ deals: this.d.store.get('deals'), tracking: this.d.store.get('tracking') }, this.d.now()),
    };
  }

  /** Signals round 3: the listings the drip pulls for their Keepa fees and sales after its lookups (signalsPass.pullsWanted). */
  private feesWanted(freshnessMs: number): Promise<{ asin: string; model: string }[]> {
    return pullsWanted({ store: this.d.store, cache: this.cache, now: this.d.now(), freshnessMs });
  }

  /**
   * Signals round 2: a bundle's estimate or completeness may have changed (the report was just rebuilt between scans), so
   * its signals are judged again (agent/signalsPass.ts). A scan judges its own at its end (trackScan).
   */
  private async afterChange(report: ScanReport, extra?: { text: string; count: number }, before?: ReadonlyMap<string, DealSnapshot>): Promise<void> {
    if (this.live.busy === 'scan') return;
    try {
      report = await this.sellerPass(report);
      await evaluateSignals(this.signalsDeps(), report, extra, before ? (t) => this.verdictFlips(before, report, t) : undefined);
    } catch (err) {
      this.addError(`Buy signals could not be judged: ${scrub(sentenceOf(err), this.d.store.get('keys'))}`, null);
    }
  }

  /**
   * Nov 25: the deals' listings checked against the owner's Amazon seller account (agent/seller.ts), before their signals are
   * judged, so a first announcement rests on a fresh check. When Amazon's fee estimates were read, the report is built
   * again so they count. Without an account: nothing, and the report as it is. Never throws.
   */
  private async sellerPass(report: ScanReport): Promise<ScanReport> {
    // Credentials Amazon refused are not tried again until he replaces them or the daily key check finds them working
    // (the Keys pane says why); meanwhile the parts stay "not checked", which holds their deals.
    if (!this.seller.connected() || this.d.store.get('runtime').keyProblems?.amazonSeller) return report;
    try {
      const opts = this.signalsDeps();
      const trend = await trendsOfReport(this.cache, report);
      const r = await this.seller.refresh(report, trend, { keepa: opts.keepa(), flatFee: opts.flatFee!(), held: sanityHolds(this.d.store) });
      // Said once in Activity, not at every pass that stops the same way.
      if (r.stopped && r.stopped !== this.sellerStopped) this.addError(`Checking your Amazon seller account stopped: ${scrub(r.stopped, this.d.store.get('keys'))}`, null);
      this.sellerStopped = r.stopped;
      return r.feesRead > 0 && this.live.busy !== 'scan' ? await this.rebuild() : report;
    } catch (err) {
      this.addError(`Your Amazon seller account could not be checked: ${scrub(sentenceOf(err), this.d.store.get('keys'))}`, null);
      return report;
    }
  }

  /**
   * Each watched deal whose Buy now state changed since `before` (judged by the signals just stored) gets one sentence in
   * Activity with the before and after and its source links; entering and leaving go in the same message as the digest when
   * the owner has alerts on. Nov 25: a deal that stays worth buying while its estimate moved gets at most one quiet line a
   * day in Activity ("… is still worth buying: est. profit $35.67, was $38.79"), never sent.
   */
  private verdictFlips(before: ReadonlyMap<string, DealSnapshot>, report: ScanReport, t: TrackingState): { text: string; count: number } | null {
    const after = report.bundles.filter((b) => before.has(b.key)).map((b) => {
      const buy = t.watch[b.key]?.watched === true && (t.signals[b.key]?.buyNow ?? null) !== null;
      return snapshotOf(b, buy, buy ? null : failingOf(t.signals[b.key]));
    });
    const now = this.d.now();
    const tried = this.keepUsage().tried;
    const flips = verdictChanges(before, after).filter((f) => !f.quiet || tried[`still:${f.key}`] === undefined || dayOf(tried[`still:${f.key}`]!) !== dayOf(now));
    if (flips.length === 0) return null;
    flips.forEach((f, i) => {
      if (f.quiet) this.noteKeep({ tried: `still:${f.key}` });
      this.record({
        id: `run-${now}-keep-${i}`, kind: 'lookup', startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), status: 'finished',
        searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: f.sentence, trigger: 'scheduled',
      });
    });
    const sent = flips.filter((f) => !f.quiet);
    return this.d.store.get('settings').alerts.enabled && sent.length > 0 ? { text: sent.map((f) => f.sentence).join('\n'), count: sent.length } : null;
  }

  /** Keeping deals current: today's usage, from the runtime. */
  private keepUsage() {
    return keepUsageOf(this.d.store.get('runtime').keepCurrent, this.d.now());
  }

  private noteKeep(add: { pages?: number; tokens?: number; tried?: string }): void {
    const now = this.d.now();
    this.d.store.update('runtime', (r) => ({ ...r, keepCurrent: used(keepUsageOf(r.keepCurrent, now), add, now) }));
  }

  /**
   * Signals round 2, at start: the deals rebuilt with what is stored now (the fee settings, Keepa's FBA fees) and their
   * signals judged, so an estimate made after the last scan (by the drip, before a restart) is judged too. Nothing is
   * fetched. Only when the store held deals at start.
   */
  async signalsAtStart(): Promise<void> {
    // The market around a listing (Nov 25): trends stored before it get its figures once from the cached Keepa answers.
    if (!(this.d.store.get('runtime').migrations ?? []).includes(MARKET_BACKFILL)) {
      const filled = await backfillMarkets(this.cache, cachedMarkets(join(this.d.dataDir, 'cache'))).catch(() => 0);
      const log = filled > 0 ? [{ name: MARKET_BACKFILL, at: new Date(this.d.now()).toISOString(), sentence: `Amazon market figures (usual prices, Amazon's own offer, sellers, stock, hazards) read for ${filled} listings from Keepa answers already stored: nothing spent. Deals are judged again with them.` }] : [];
      this.d.store.update('runtime', (r) => ({ ...r, migrations: [...(r.migrations ?? []), MARKET_BACKFILL], ...(log.length ? { migrationLog: [...(r.migrationLog ?? []), ...log] } : {}) }));
    }
    if (!this.dealsAtStart || this.live.busy !== null) return;
    if ((await this.scanStore.listBundles()).length === 0) return;
    await this.refresh();
    // The listing ladder: the deals' words rest on what the rungs will really read, from the start.
    await this.noteConfirmQueue();
  }

  // ------------------------------------------------------------------ state and the schedule

  /** Whether a scan, an ask, an owner answer or a drip round is writing now (Reset scan data refuses while it is). */
  writing(): boolean {
    return this.live.busy !== null || this.dripping !== null || this.answering > 0;
  }

  state(): LiveState {
    const drip = this.dripState();
    return { ...this.live, ...(drip ? { drip } : {}) };
  }

  /** When the next scheduled scan is due (ISO), or null: manual schedule, or paused. */
  nextScanAt(): string | null {
    if (this.d.store.get('agent').paused) return null;
    const { schedule } = this.d.store.get('settings').settings;
    const runtime = this.d.store.get('runtime');
    const anchors = [runtime.lastScheduledRunAt, runtime.scheduleFrom ?? null].filter((t): t is number => t !== null);
    const last = anchors.length ? Math.max(...anchors) : null;
    const due = nextRun(schedule, new Date(this.d.now()), last === null ? null : new Date(last));
    return due === null ? null : due.toISOString();
  }

  /**
   * Nov 25: what the next scheduled scan depends on, in a sentence, for the Agent panel ("Next scan"). Null when nothing is missing
   * (the helper is connected, or no scheduled scan is coming).
   */
  nextScanNote(): string | null {
    const app = this.d.store.get('settings');
    return nextScanNeeds({
      coming: this.nextScanAt() !== null,
      paired: this.d.store.get('pairing').extensions.length > 0,
      connected: this.d.helperConnected(),
      openChrome: app.scan?.openChrome !== false,
      waitsForChrome: scheduledScanWaits(app, false),
    });
  }

  /** The sentence for a scheduled scan that starts well after its slot ("The 7:00 AM scan ran at 9:12 AM because the computer was asleep."). */
  private catchUpOf(previousTickAt: number | null): string | null {
    const { store } = this.d;
    const runtime = store.get('runtime');
    const anchors = [runtime.lastScheduledRunAt, runtime.scheduleFrom ?? null].filter((t): t is number => t !== null);
    const startedAt = this.d.now();
    const slot = slotOf(store.get('settings').settings.schedule, startedAt, anchors.length ? Math.max(...anchors) : null);
    return slot === null ? null : catchUpSentence({ slot, startedAt, agentStartedAt: this.startedAt, previousTickAt, tickMs: TICK_MS });
  }

  /** One sentence in Activity that is not a scan: what the app did on its own (opened Chrome, turned on open at login). */
  private noteSentence(sentence: string): void {
    const at = this.d.now();
    this.record({
      id: `run-${at}-self-${Math.floor(Math.random() * 1e6)}`, kind: 'lookup', startedAt: new Date(at).toISOString(), finishedAt: new Date(at).toISOString(), status: 'finished',
      searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: sentence, trigger: 'scheduled',
    });
  }

  /**
   * Settings were saved. Switching from manual to a schedule does not start a paid scan at the next tick: the first
   * scheduled scan is one interval from now (or the next daily slot), and nextScanAt in the state says when.
   */
  settingsChanged(before: AppSettings, after: AppSettings): void {
    if (before.settings.schedule.mode === 'manual' && after.settings.schedule.mode !== 'manual') {
      const at = this.d.now();
      this.d.store.update('runtime', (r) => ({ ...r, scheduleFrom: at }));
    }
  }

  start(): void {
    if (this.timer) return;
    void backfillBriefs(this.briefCtx()).catch(() => {});
    // Nov 25, supervision: one tick's failure (the scheduler, the held messages) is an Activity error, never the process's end.
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.jobFailed('The scheduler', err);
      }
      void this.flushMessages().catch((err: unknown) => this.jobFailed('Sending the held messages', err));
      void this.announcePriceEnds().catch((err: unknown) => this.jobFailed('Telling you a price is about to end', err));
    }, TICK_MS);
    this.timer.unref?.();
  }

  /** What is running now, for the crash line: "scan: Reading Home Depot pages", "drip", or null. */
  currentStep(): string | null {
    if (this.live.busy) return this.live.pipeline?.current.label ? `${this.live.busy}: ${this.live.pipeline.current.label}` : this.live.busy;
    return this.dripping ? 'drip' : null;
  }

  /**
   * Nov 25, supervision: a background job failed where it runs (a tick, a drip round, a send). One Activity error, scrubbed,
   * and not again while the same sentence is still open, so a job failing every tick is one line, not fifty.
   */
  jobFailed(what: string, err: unknown): void {
    try {
      const sentence = `${what} failed: ${scrub(sentenceOf(err), this.d.store.get('keys'))}`;
      if ((this.d.store.get('activity').errors ?? []).some((e) => e.sentence === sentence && !e.resolvedAt)) return;
      this.addError(sentence, null);
    } catch {
      // the store itself failed: there is nowhere to say it, and the job is already over
    }
  }

  /** A drip round that threw: an Activity error, unless the round was stopped on purpose (a scan claimed the slot). */
  private dripFailed(err: unknown): void {
    if (!this.dripCtl.signal.aborted) this.jobFailed('A background lookup', err);
  }

  /** Nov 25, supervision: a problem the owner should hear of (the restart after a crash). The "error" kind switch decides both channels. */
  async announceProblem(text: string): Promise<void> {
    if (this.d.store.get('settings').notifications.kinds.error === false) return;
    this.policy.send({ kind: 'error', title: 'Split Finder', body: text, route: '/activity' });
    await this.sendTelegram(text);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    this.stopCtl.abort();
    this.releaseAwake?.();
    this.releaseAwake = null;
  }

  /** Resolves when whatever runs now has ended (tests, and shutdown). */
  async idle(): Promise<void> {
    while (this.current || this.dripping) await (this.current ?? this.dripping!.catch(() => {}));
  }

  /** The scheduler: a due scan starts unless the agent is paused or busy. Returns whether one started. */
  tick(): boolean {
    const before = this.lastTickAt;
    this.lastTickAt = this.d.now();
    // Nov 25: Chrome for the next scan, open at login, the weekly summary. Its own steps decide whether anything is due.
    void this.selfRun.tick();
    if (this.live.busy || this.answering > 0 || this.d.store.get('agent').paused) return false;
    const next = this.nextScanAt();
    if (next === null || Date.parse(next) > this.d.now()) {
      // Step 15: nothing else runs, so the drip may look up a waiting part with Keepa.
      void this.drip().catch((err: unknown) => this.dripFailed(err));
      return false;
    }
    // Free scan: with Chrome closed a scheduled scan waits for it (unless the owner let SerpApi find the bundles then).
    // Nov 25: unless the app opened Chrome for this scan and the wait is over: then the scan does what it can without it.
    if (scheduledScanWaits(this.d.store.get('settings'), this.d.helperConnected()) && !this.selfRun.mayScanWithoutChrome()) {
      void this.drip().catch((err: unknown) => this.dripFailed(err));
      return false;
    }
    this.catchUp = this.catchUpOf(before);
    this.scheduledKey = this.selfRun.scanKey();
    this.begin('scan', () => this.scan('scheduled'));
    return true;
  }

  /** Scan now (the owner's button). A scan the owner starts may spend the reserve, as in the extension. */
  scanNow(): ScanStartResponse {
    const at = this.d.now();
    this.begin('scan', () => this.scan('manual'));
    return { id: `scan-${at}`, requestedAt: new Date(at).toISOString() };
  }

  /**
   * Nov 23, Read again (POST /api/scan/read-pages): the free Chrome steps once more (the BOGO listings, the bundle pages,
   * the kit pages and the part prices) for the bundles the last scan stored, with no listing page and no Amazon brand
   * page searched; then the Amazon lookups only for what is now settled, within what the last scan left of the per-scan
   * cap (none when it used it all). Refused, with the reason, while something runs, with Chrome closed, or when every
   * page is read. `reason` also says, when it starts, how many searches it may spend.
   */
  readPagesAgain(): { started: boolean; reason?: string } {
    const why = this.readAgainRefusal();
    if (why) return { started: false, reason: why };
    const last = this.d.store.get('activity').lastScan!;
    const usedBefore = Math.max(0, last.searchesUsed);
    const left = Math.max(0, Math.floor(this.d.store.get('settings').settings.searchesPerScan) - usedBefore);
    this.begin('scan', () => this.scan('manual', { usedBefore }));
    return {
      started: true,
      reason: left > 0
        ? `Reading the Home Depot pages again (free); then at most ${left} Amazon ${left === 1 ? 'search' : 'searches'}, what the last scan left of its limit, for the parts now known.`
        : 'Reading the Home Depot pages again (free); no Amazon search, because the last scan used its whole limit.',
    };
  }

  /** Why Read again cannot start now, in one sentence; null when it can. */
  readAgainRefusal(): string | null {
    if (this.live.busy) return this.busySentence('scan');
    if (this.answering > 0) return 'An answer is being applied. Try again in a moment.';
    const last = this.d.store.get('activity').lastScan;
    if (!last) return 'No scan has run yet: Scan now first.';
    if (!last.pagesUnread) return 'Every Home Depot page of the last scan is read.';
    if (!this.d.helperConnected()) return 'Chrome is closed: open Chrome with the Split Finder helper, then read again.';
    // Home Depot's pace: after a refusal nothing is read until the cool-down ends; Read again does not get past it.
    const until = this.pace.pausedUntil();
    if (until !== null) return pausedSentence(until);
    return null;
  }

  /** Stop: the scan ends before its next paid step, the call in flight is aborted, and nothing after the scan runs. */
  stop(): boolean {
    if (!this.live.busy) return false;
    this.live.stopping = true;
    this.stopCtl.abort();
    this.d.changed();
    return true;
  }

  /**
   * Claims the one slot synchronously, before any await, so two clicks or a tick in between cannot start two paid
   * runs (each would get its own SearchBudget and spend the per-scan cap twice). Throws WorkRefused when taken.
   */
  private claim(kind: 'scan' | 'ask' | 'paid'): void {
    if (this.live.busy) throw new WorkRefused(this.busySentence(kind));
    if (kind !== 'ask' && this.answering > 0) throw new WorkRefused('An answer is being applied. Try again in a moment.');
    this.live.busy = kind;
    this.live.stopping = false;
    this.live.pipeline = null;
    this.tail = null;
    this.liveJob = null;
    this.finishState = 'next';
    this.live.searchesUsed = 0;
    this.stopCtl = new AbortController();
    // Home Depot's pace: this run's pages count from 0 (HD_PAGES_PER_SCAN, every kind together).
    this.pace.beginRun();
    // A scan (Look up all is one) keeps the computer awake while it runs, when the owner has not turned that off.
    if (kind === 'scan' && this.d.keepAwake && this.d.store.get('settings').shell.keepAwakeDuringScan !== false) this.releaseAwake = this.d.keepAwake.hold();
    // Step 15: the drip ends before its next part; the claimed work starts once it has (begin, paid).
    this.dripCtl.abort();
    this.d.changed();
  }

  private busySentence(want: 'scan' | 'ask' | 'paid'): string {
    const busy = this.live.busy;
    if (want === 'scan') {
      if (busy === 'scan') return 'A scan is already running.';
      if (busy === 'ask') return 'The AI is asking about Review questions. Stop it first, or wait for it to finish.';
      return 'A Look up or Verify is running. Scan when it has finished.';
    }
    if (want === 'ask') return busy === 'scan' ? 'A scan is running. Ask again when it has finished.' : 'Something is running. Ask again when it has finished.';
    return 'Something is running. Try again when it has finished.';
  }

  /** Runs claimed work in the background; the slot is free again when it ends, however it ends. */
  private track<T>(work: Promise<T>): Promise<T> {
    const done = work
      .then(
        () => undefined,
        () => {
          // Each piece of work records its own failure; nothing escapes here (the caller still sees `work` reject).
        },
      )
      .finally(() => {
        this.releaseAwake?.();
        this.releaseAwake = null;
        this.live.busy = null;
        this.live.stopping = false;
        this.live.pipeline = null;
        this.tail = null;
        this.liveJob = null;
        if (this.current === done) this.current = null;
        this.d.changed();
      });
    this.current = done;
    return work;
  }

  private begin(kind: 'scan' | 'ask' | 'paid', work: () => Promise<void>): void {
    this.claim(kind);
    void this.track(this.afterDrip(work)).catch(() => {});
  }

  /** Step 15: claimed work starts once a drip in flight has finished its part (claim stopped it): never two writers. */
  private async afterDrip<T>(work: () => Promise<T>): Promise<T> {
    if (this.dripping) await this.dripping.catch(() => {});
    return work();
  }

  // ------------------------------------------------------------------ step 15: the drip of Keepa lookups between scans

  private dripping: Promise<void> | null = null;
  private dripCtl = new AbortController();
  private dripActive = false;
  private dripWaiting = 0;
  /** Signals round 3: listings waiting for their Keepa fee pull, as the last round counted them. */
  private dripFeesWaiting = 0;
  private dripNextAt: number | null = null;
  private dripRun: { record: RunRecord; startedAt: number; looked: number; matched: number; none: number; review: number; verified: number; removed: number; sales: number; ways?: LookupWays; kept: number } | null = null;

  /** Whether the drip may run now: its setting on, a Keepa key, Keepa on, not paused, and nothing else running. */
  private dripAllowed(): boolean {
    const app = this.d.store.get('settings');
    return app.lookups?.drip !== false && Boolean(this.d.store.get('keys').keepa) && app.settings.amazonRefreshViaKeepa
      && !this.d.store.get('agent').paused && this.live.busy === null && this.answering === 0;
  }

  private dripState(): DripState | undefined {
    const app = this.d.store.get('settings');
    if (app.lookups?.drip === false || !this.d.store.get('keys').keepa || !app.settings.amazonRefreshViaKeepa) return undefined;
    const last = this.d.store.get('runtime').drip?.lastLookupAt ?? null;
    return {
      active: this.dripActive,
      waiting: this.dripWaiting,
      nextAt: this.dripWaiting + this.dripFeesWaiting + this.confirmWaiting > 0 && this.dripNextAt !== null ? new Date(this.dripNextAt).toISOString() : null,
      lastLookupAt: last === null ? null : new Date(last).toISOString(),
      ...(this.dripFeesWaiting > 0 ? { feesWaiting: this.dripFeesWaiting } : {}),
      // The listing ladder: listings an automatic rung will read (the catalog check, rung 2).
      ...(this.confirmWaiting > 0 ? { confirmWaiting: this.confirmWaiting } : {}),
    };
  }

  /**
   * Step 15, decision 2: while parts wait for a lookup and nothing else runs, look the next ones up with Keepa whenever
   * the account has a lookup's tokens above the reserve; the free token status is asked at most every DRIP_POLL_MS. No
   * SerpApi search. Each match is saved and the deals rebuilt; one Activity run an hour; one digest line when new
   * estimates appear. With Chrome connected, the Home Depot part prices a scan left are read too (free), for at most
   * PART_PRICE_MS. Quiet hours hold only the messages (notifyPolicy), never the work. Resolves when the round ends.
   */
  async drip(): Promise<void> {
    if (this.dripping) return;
    const keepaDue = this.dripAllowed() && (this.dripNextAt === null || this.d.now() >= this.dripNextAt);
    // Home Depot's pace: the slow free read between scans, one page when its gap has passed (hdDripOne).
    const hdDue = this.hdDripDue();
    if (!keepaDue && !hdDue) return;
    this.dripCtl = new AbortController();
    // The listing ladder, rung 2: after the round's catalog check, the listings it left unconfirmed (agent/autoConfirm.ts).
    const round = async (): Promise<void> => {
      if (hdDue) await this.hdDripOne();
      if (!keepaDue || this.dripCtl.signal.aborted) return;
      await this.dripRound();
      await this.autoConfirmPass('drip');
      await this.noteConfirmQueue();
    };
    this.dripping = round().finally(() => {
      this.dripping = null;
      this.dripActive = false;
      this.d.changed();
    });
    return this.dripping;
  }

  private async dripRound(): Promise<void> {
    const { store } = this.d;
    const now = this.d.now();
    const app = store.get('settings');
    const ext = extensionSettingsOf(app);
    const settings = toScanSettings(ext);
    const keys = store.get('keys');
    const pairs = Object.fromEntries(Object.values(store.get('tracking').bogoPairs ?? {}).map((p) => [p.key, `${p.promotionId}:${p.starterItemId}`]));
    this.dripNextAt = now + DRIP_POLL_MS;
    // Step 15: the free part prices first (the parts a waiting split needs come first); a read that saved anything may
    // settle a waiting split, whose parts then join the lookups below. Review is rebuilt with what it opened (refresh).
    // Home Depot's pace: the free Home Depot reads between scans are hdDripOne's, one page at the drip's gap (drip).
    const prices = 0;
    const { work, steps } = await plannedWork(this.scanStore, settings, this.d.now(), pairs);
    this.dripWaiting = work.lookups.length;
    // Catalog check: with no lookup waiting, the drip still runs for title matches and questions Amazon's catalog may settle.
    const first = buyWaitsOn(store.get('tracking'));
    const checks = keys.keepa && (work.lookups.length === 0 || first.size > 0) ? await checksWaiting(this.scanStore) : 0;
    // Signals rounds 2 and 3: and for the Keepa fees and sales of parts whose bundle has an estimate.
    const sales = keys.keepa ? (await this.feesWanted(settings.freshnessMs)).length : 0;
    this.dripFeesWaiting = sales;
    // The listing ladder, round 2: counted listings no rung could confirm, whose part may still be re-picked (agent/verifyMatches.ts).
    const repicks = repickTargets(store.get('runtime').autoConfirm, this.d.now());
    // Nov 25: parts marked "no Amazon listing" whose Home Depot barcode is now known: asked by code once (Keepa only).
    const codes = keys.keepa ? await barcodeLookupsWanted(this.scanStore) : [];
    // The app replaces a wrong listing itself: withdrawn listings' candidates still to read (agent/recheck.ts).
    const rechecks = keys.keepa ? await rechecksWaiting(this.scanStore) : 0;
    // Keeping deals current: the Amazon prices of Buy now and watched deals due for a pull (1 token each, never a search).
    const keepOf = () => ({ deals: store.get('deals'), tracking: store.get('tracking') });
    const keepBefore = dealSnapshots(keepOf());
    const keepDue = keepaKeeps({ keys: store.get('keys'), settings: store.get('settings') }) ? amazonDue(keptNow(keepOf()), now, this.keepUsage().tried).length : 0;
    if ((work.lookups.length === 0 && checks === 0 && sales === 0 && repicks.length === 0 && codes.length === 0 && rechecks === 0 && keepDue === 0) || !keys.keepa) {
      if (prices > 0) await this.refresh();
      return;
    }
    // Step 18: the cost blocker. The drip (its lookups, catalog checks, re-checks, fee and sales pulls and the keep-current
    // price pulls, all on this one budget) runs while its smallest call still fits his Keepa limit: a lookup when one
    // waits, else a 1-token pull. It spends no more than the limit leaves.
    const smallest = work.lookups.length > 0 || codes.length > 0 ? KEEPA_LOOKUP_TOKEN_ESTIMATE : 1;
    if (!this.costGate('keepa', { what: 'Keepa lookups and price refreshes between scans', held: 'were not made', expected: smallest, high: smallest }, `drip:${localDate(now)}`).allow) {
      if (prices > 0) await this.refresh();
      return;
    }
    const budget = new TokenBudget({ reserve: ext.keepaReserve, maxPerRun: this.costs.left('keepa') ?? Number.POSITIVE_INFINITY });
    const keepa = this.keepaClient(keys.keepa, budget);
    store.update('runtime', (r) => ({ ...r, drip: { checkedAt: now, lastLookupAt: r.drip?.lastLookupAt ?? null } }));
    const status = await this.keepaStatus(keepa);
    if (status === null) {
      if (prices > 0) await this.refresh();
      return;
    }
    const before = this.estimatedKeys();
    const catalog = (await knownModels(this.scanStore)).catalog;
    const done: DripDone = { looked: 0, matched: 0, none: 0, review: 0, tokens: 0, verified: 0, removed: 0, sales: 0, kept: 0 };
    let rechecked = false;
    // Signals round 2: every product pull keeps its Keepa trend (sales, FBA fee), as a scan's refresh does.
    const product = pullKeepingTrends(this.cache, (asin, label, maxAgeMs) => keepaProductSearchResult(keepa, asin, { label, maxAgeMs, trackingDepth: ext.trackingDepth }));
    // Keeping deals current: the due Amazon prices, Buy now first (before the lookups), the rest after them; within the
    // day's share of the refill (keepCurrent.ts KEEPA_KEEP_CURRENT_SHARE) and above the reserve (the budget).
    const pullCost = productTokenEstimate(ext.trackingDepth, 1);
    const keepPulls = async (tier: 'buyNow' | 'all'): Promise<void> => {
      if (keepDue === 0 || !this.dripAllowed() || this.dripCtl.signal.aborted) return;
      const kept = keptNow(keepOf());
      try {
        const r = await pullDue({
          store: this.scanStore, keepaBudget: budget, pull: product, cost: pullCost,
          tokensLeft: tokenShareOf(kept, status.refillRate, pullCost) - this.keepUsage().tokens,
          shouldStop: () => !this.dripAllowed() || this.dripCtl.signal.aborted,
          onPull: (asin, tokens) => this.noteKeep({ tokens, tried: `amazon:${asin}` }),
        }, amazonDue(kept, this.d.now(), this.keepUsage().tried), tier);
        done.kept = (done.kept ?? 0) + r.pulled;
        done.tokens += r.tokens;
      } catch (err) {
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
      }
    };
    // Buy safety (Nov 23): the listings a buy waits on are checked first, before the lookups.
    if (first.size > 0 && this.dripAllowed() && !this.dripCtl.signal.aborted) {
      try {
        const v = await verifyMatchesWithKeepa({
          store: this.scanStore, catalog, now: this.d.now, keepaBudget: budget, trackingDepth: ext.trackingDepth,
          keepaProduct: (asin, label, maxAgeMs) => product(asin, label, maxAgeMs), first, onlyFirst: true,
          shouldStop: () => !this.dripAllowed() || this.dripCtl.signal.aborted,
        });
        done.verified += v.verified;
        done.removed += v.removed;
        done.tokens += v.tokens;
      } catch (err) {
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
      }
    }
    // The drip's order (Nov 25): buy-safety checks (above), keeping deals current (Buy now first, then the watched deals,
    // within the day's share), re-checks of withdrawn listings, lookups (by barcode first, then by search), catalog checks,
    // then fees and sales.
    await keepPulls('buyNow');
    await keepPulls('all');
    // The app replaces a wrong listing itself: each withdrawn listing's part, its other stored candidates in order, one Keepa
    // pull each (1 token, above the reserve; the cache first), through the ladder, the price guard and the audit.
    if (rechecks > 0 && this.dripAllowed() && !this.dripCtl.signal.aborted) {
      try {
        const r = await runRechecks({
          store: this.scanStore, catalog, now: this.d.now, pull: dripPull(this.scanStore, budget, product, (t) => { done.tokens += t; }),
          shouldStop: () => !this.dripAllowed() || this.dripCtl.signal.aborted,
        });
        done.verified += r.replaced.length;
        rechecked = r.changed;
      } catch (err) {
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
      }
    }
    // Nov 25: the parts marked "no Amazon listing" whose barcode is now known, by code only (never a search, never
    // SerpApi), before the search lookups (keep current, Nov 25: the drip's order). Same matcher and ladder.
    for (const part of codes) {
      if (!this.dripAllowed() || this.dripCtl.signal.aborted) break;
      this.dripActive = true;
      this.d.changed();
      let out: Awaited<ReturnType<typeof keepaBarcodeOne>>;
      try {
        out = await keepaBarcodeOne({
          store: this.scanStore, settings, now: this.d.now, keepaBudget: budget, catalog, prefix: 'agent:drip',
          keepaLookup: (brand, model, label, ask) => keepaPartLookup(keepa, brand, model, label, ask),
          keepaProduct: product,
        }, part);
      } catch (err) {
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
        break;
      }
      if (out.status === 'refused') break;
      tallyLookup(done, out);
      const at = this.d.now();
      store.update('runtime', (r) => ({ ...r, drip: { checkedAt: r.drip?.checkedAt ?? now, lastLookupAt: at } }));
    }
    for (const key of work.lookups) {
      if (!this.dripAllowed() || this.dripCtl.signal.aborted) break;
      if (budget.blockReason(KEEPA_LOOKUP_TOKEN_ESTIMATE) !== null) break;
      const step = steps.get(key) as LookupStep;
      this.dripActive = true;
      this.d.changed();
      let out: Awaited<ReturnType<typeof keepaLookupOne>>;
      try {
        out = await keepaLookupOne({
          store: this.scanStore, settings, now: this.d.now, keepaBudget: budget, catalog, prefix: 'agent:drip',
          keepaLookup: (brand, model, label, ask) => keepaPartLookup(keepa, brand, model, label, ask),
          keepaProduct: product,
        }, step);
      } catch (err) {
        // A refusal or a network error: the part keeps waiting; the next look is after DRIP_POLL_MS.
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
        break;
      }
      if (out.status === 'refused') break;
      tallyLookup(done, out);
      this.dripWaiting = Math.max(0, this.dripWaiting - 1);
      const at = this.d.now();
      store.update('runtime', (r) => ({ ...r, drip: { checkedAt: r.drip?.checkedAt ?? now, lastLookupAt: at } }));
    }
    // Catalog check: once every waiting part is looked up, the title matches and questions are read against Keepa's fields.
    if (this.dripWaiting === 0 && this.dripAllowed() && !this.dripCtl.signal.aborted) {
      this.dripActive = true;
      this.d.changed();
      try {
        const v = await verifyMatchesWithKeepa({
          store: this.scanStore, catalog, now: this.d.now, keepaBudget: budget, trackingDepth: ext.trackingDepth,
          keepaProduct: (asin, label, maxAgeMs) => product(asin, label, maxAgeMs),
          shouldStop: () => !this.dripAllowed() || this.dripCtl.signal.aborted,
        });
        done.verified += v.verified;
        done.removed += v.removed;
        done.tokens += v.tokens;
        if (v.pulled > 0) store.update('runtime', (r) => ({ ...r, drip: { checkedAt: r.drip?.checkedAt ?? now, lastLookupAt: this.d.now() } }));
      } catch (err) {
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
      }
    }
    // The listing ladder, round 2: before giving up on a listing, the part's other candidates (free), then one Keepa search.
    if (repicks.length > 0 && this.dripWaiting === 0 && this.dripAllowed() && !this.dripCtl.signal.aborted) {
      try {
        const r = await repickUnconfirmed({
          store: this.scanStore, now: this.d.now, keepaBudget: budget,
          keepaSearch: async (term, label) => (await keepa.searchProducts(term, 1, { label, estimate: KEEPA_SEARCH_TOKEN_ESTIMATE })).data.products ?? [],
          keepaProduct: (asin, label) => product(asin, label),
          searchedAt: store.get('runtime').autoConfirm?.searchedAt ?? {},
          saveSearched: (key, at) => store.update('runtime', (rt) => ({ ...rt, autoConfirm: { ...(rt.autoConfirm ?? { day: '', spent: 0, tried: [] }), searchedAt: { ...(rt.autoConfirm?.searchedAt ?? {}), [key]: at } } })),
          shouldStop: () => !this.dripAllowed() || this.dripCtl.signal.aborted,
        }, repicks);
        done.tokens += r.tokens;
        done.verified += r.switched.length;
      } catch (err) {
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
      }
    }
    // Signals rounds 2 and 3: then the fee and sales pulls (1 token each), after the lookups and the catalog check, the
    // bundles with the highest estimate first; a listing pulled within the freshness window is not pulled again.
    if (this.dripWaiting === 0 && this.dripAllowed() && !this.dripCtl.signal.aborted) {
      try {
        const s = await pullSales({
          store: this.scanStore, cache: this.cache, keepaBudget: budget, pull: product, trackingDepth: ext.trackingDepth,
          shouldStop: () => !this.dripAllowed() || this.dripCtl.signal.aborted, freshnessMs: settings.freshnessMs, now: this.d.now,
        }, await this.feesWanted(settings.freshnessMs));
        done.sales += s.pulled;
        done.tokens += s.tokens;
        // Suggested prices (Nov 23): an inactive listing's Keepa average for its suggestion, 1 token each (agent/suggestPrices.ts).
        const bundles = store.get('deals').bundles;
        const wanted = averagePullsWanted(bundles, await readTrends(this.cache, bundles.flatMap((b) => b.parts.flatMap((p) => (p.asin ? [p.asin] : [])))));
        const a = await pullAverages({
          cache: this.cache, keepaBudget: budget, pull: product, trackingDepth: ext.trackingDepth,
          shouldStop: () => !this.dripAllowed() || this.dripCtl.signal.aborted,
        }, wanted);
        done.sales += a.pulled;
        done.tokens += a.tokens;
      } catch (err) {
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
      }
    }
    this.dripActive = false;
    // The next look: when a lookup's tokens will have refilled above the reserve, and never sooner than DRIP_POLL_MS.
    const left = (budget.knownBalance ?? status.tokensLeft) - ext.keepaReserve;
    // Signals round 3: with no lookup waiting, a fee pull needs only its 1 token.
    const short = (this.dripWaiting > 0 ? KEEPA_LOOKUP_TOKEN_ESTIMATE : 1) - left;
    const perMin = status.refillRate > 0 ? status.refillRate : 1;
    this.dripNextAt = this.d.now() + Math.max(DRIP_POLL_MS, short > 0 ? Math.ceil(short / perMin) * 60_000 : 0);
    if (done.looked === 0 && done.verified === 0 && done.removed === 0 && done.sales === 0 && (done.kept ?? 0) === 0) {
      if (prices > 0 || done.tokens > 0 || rechecked) await this.refresh(undefined, keepBefore);
      return;
    }
    const report = await this.rebuild();
    this.dripFeesWaiting = (await this.feesWanted(settings.freshnessMs)).length;
    this.dripRecord(done);
    const fresh = [...this.estimatedKeys()].filter((k) => !before.has(k)).length;
    const text = `Keepa lookups between scans gave ${fresh} new ${fresh === 1 ? 'estimate' : 'estimates'} (from your fee settings, not your real fees).`;
    // Signals round 2: the new estimates' buy signals go in the same message.
    await this.afterChange(report, fresh > 0 ? { text, count: fresh } : undefined, keepBefore);
  }

  // ------------------------------------------------------------------ Home Depot's pace: the slow free read between scans

  /** Home Depot pages the drip read in the current hour's Activity run, and what they finished. */
  private hdRun: { record: RunRecord; startedAt: number; pages: number; sets: number; prices: number; kept: number } | null = null;

  /**
   * Whether the drip's next Home Depot page is due: the helper connected, the agent not paused, nothing else running, Home
   * Depot not paused after a refusal, today's drip pages not used up, and the drip's gap since the last read passed.
   */
  private hdDripDue(): boolean {
    if (!this.d.helperConnected() || this.d.store.get('agent').paused || this.live.busy !== null || this.answering > 0) return false;
    if (this.pace.blocked('drip') !== null) return false;
    const last = this.pace.state().lastEndedAt;
    return last === null || this.d.now() - last >= this.pace.dripGapMs();
  }

  /**
   * Home Depot's pace, between scans: the next waiting Home Depot read, one at a time at the drip's gap, in the scan's order:
   * a part price that completes an estimate (its search and its page), then the pages the bundles wait for (hdOrder.ts: a
   * saving first, biggest percent off first, a set's items together), then a kit's page, then the other part prices. What
   * it settles goes through the scan's own code (the split, the waiting splits, the deals and their signals). Free: no
   * search, no Keepa, no AI. A refusal pauses every read (the pace's cool-down). Returns how many pages it read.
   */
  async hdDripOne(): Promise<number> {
    const signal = this.dripCtl.signal;
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => signal, gate: this.gate('drip') });
    const settings = toScanSettings(extensionSettingsOf(this.d.store.get('settings')));
    const store = this.scanStore;
    const stop = (): boolean => signal.aborted || !this.d.helperConnected() || this.pace.blocked('drip') !== null;
    const now = this.d.now;
    let pages = 0;
    let settled = 0;
    let prices = 0;
    // Keeping deals current: a Buy now or watched deal whose Home Depot price is due comes first (Buy now, then the oldest
    // checked), within the day's share; the pages bundles wait for come after. Only between scans: a scan stops the drip.
    // Home Depot's adaptive ceiling: below the full one, with pages still waiting, only Buy now goes first; a watched
    // deal's refresh gives way to the backlog and is read when no other page waits.
    const low = this.pace.dripPerHour() < fullPerHour(this.pace.limits) && (this.d.store.get('runtime').hdBacklog?.pages ?? 0) > 0;
    const kept = await this.keepHdOne(readers, low ? 'buyNow' : 'all');
    if (kept !== null) return kept;
    try {
      const extra = await wantedReads(store, this.d.store.get('suggestions'));
      const parts = await partPricesWanted(store, settings, now(), true, extra);
      const wants = pagesWanted(await store.listBundles());
      // Nov 24 (settle rule C): a part's own page a waiting split needs is read as a kit page is.
      const pagesToRead = (await kitPagesWanted(store, true)).length + (await partPagesWanted(store)).length;
      if (parts[0]?.completes || (wants.length === 0 && pagesToRead === 0 && parts.length > 0)) {
        // One part's Home Depot price: its search and its page, two reads, each after the drip's gap.
        const out = await readPartPricesFor({ store, settings, readPartPrices: readers.readPartPrices, now, waiting: true, extra, cap: 1, shouldStop: stop });
        pages += out.asked > 0 ? 2 : 0;
        prices += out.saved;
      } else if (wants[0]?.kind === 'item') {
        const out = await readSetItemsFor({ store, read: readers.readPromoPages, itemIds: [wants[0].itemId], now });
        pages += 1;
        if (out.read > 0) settled += await this.splitAgain(out.sets);
      } else if (wants[0]?.kind === 'bundle') {
        const id = wants[0].itemId;
        const key = wants[0].bundle;
        const got = (await readers.readPages([id])).find((o) => o.itemId === id);
        pages += 1;
        const b = await store.getBundle(key);
        if (got?.kind === 'read' && b) {
          await store.putBundle(withBuying({ ...b, page: { ...withoutBuying(got.content), readAt: now() } }, got.content.buying, now()));
          settled += await this.splitAgain([key]);
        }
      } else {
        const read = await readKitPagesFor({ store, readPages: readers.readPages, now, max: 1, shouldStop: stop });
        pages += read > 0 ? 1 : 0;
        prices += read;
      }
    } catch {
      // A read Chrome could not make, or the pace allowing none now: asked for again at the next look.
    }
    if (prices > 0) {
      const s = await settleWaitingSplits(store, now());
      settled += s.resolved + s.opened + (await this.recheck());
    }
    if (pages === 0) return low && !signal.aborted ? ((await this.keepHdOne(readers, 'all')) ?? 0) : 0;
    await this.noteBacklog().catch(() => null);
    this.hdRecord(pages, settled, prices);
    // What a read settled is published, and its signals judged, as after a scan's reads; the Keepa drip looks up its parts.
    if (settled > 0 || prices > 0) await this.refresh();
    else this.d.changed();
    return pages;
  }

  /**
   * Keeping deals current, Home Depot's side: the next due deal's own page, one read in drip mode (the gap, the daily cap,
   * a refusal's cool-down). A changed price goes through the report and the signals, with the verdict's flip said; an
   * unchanged one only moves the deal's "checked" time. Null when no deal is due (the drip's other reads go on).
   */
  private async keepHdOne(readers: RemoteReaders, only: 'buyNow' | 'all'): Promise<number | null> {
    const before = dealSnapshots({ deals: this.d.store.get('deals'), tracking: this.d.store.get('tracking') });
    const kept = keptNow({ deals: this.d.store.get('deals'), tracking: this.d.store.get('tracking') });
    let out;
    try {
      out = await readOneDue({ store: this.scanStore, readPromoPages: readers.readPromoPages, now: this.d.now }, only === 'buyNow' ? kept.filter((d) => d.tier === 'buyNow') : kept, this.keepUsage());
    } catch {
      // Chrome did not answer (not Home Depot): the page was asked for (the pace counted it); asked again at the next look.
      if (hdDue(only === 'buyNow' ? kept.filter((d) => d.tier === 'buyNow') : kept, this.d.now(), this.keepUsage().tried).length > 0) this.noteKeep({ pages: 1 });
      return 1;
    }
    if (out === null) return null;
    if (out.pages === 0) return 0;
    // A refusal is no try: the pace's cool-down pauses every read, and this deal is read first once reading goes on.
    this.noteKeep({ pages: out.pages, ...(out.refused ? {} : { tried: `hd:${out.deal.key}` }) });
    await this.noteBacklog().catch(() => null);
    this.hdRecord(out.pages, 0, 0, out.checked ? 1 : 0);
    // Nov 25: a price that moved, or what the page states about buying it (can be bought now, the limit, the dates), judges again.
    if (out.changed || out.buyingChanged) await this.refresh(undefined, before);
    else if (out.checked || out.buying) {
      // The same price and the same statements, read now: the deal's row says so (no rebuild needed).
      const at = this.d.now();
      this.d.store.update('deals', (d) => ({
        ...d,
        bundles: d.bundles.map((b) => (b.key === out.deal.key ? { ...b, ...(out.checked ? { seenAt: at } : {}), ...(out.buying ? { buying: out.buying } : {}) } : b)),
      }));
      this.d.changed();
    } else this.d.changed();
    return out.pages;
  }

  /** The bundles a page read changed, split again with the scan's own rules (splitOne). Returns how many are settled now. */
  private async splitAgain(keys: readonly string[]): Promise<number> {
    const known = await knownModels(this.scanStore);
    let resolved = 0;
    for (const key of keys) {
      const b = await this.scanStore.getBundle(key);
      if (!b) continue;
      const { split } = await splitOne(this.scanStore, b, known, this.d.now(), true);
      if (split.status === 'resolved') resolved += 1;
    }
    return resolved;
  }

  /** One Activity run an hour of the free Home Depot reads between scans: "Read 38 Home Depot pages between scans; 12 bundles settled." */
  private hdRecord(pages: number, settled: number, prices: number, kept = 0): void {
    const now = this.d.now();
    if (!this.hdRun || now - this.hdRun.startedAt >= DRIP_RUN_MS) {
      const record: RunRecord = {
        id: `run-${now}-hd`, kind: 'lookup', startedAt: new Date(now).toISOString(), finishedAt: null, status: 'finished', searchesUsed: 0, keepaTokensUsed: 0,
        aiCostUsd: 0, summary: '', trigger: 'scheduled',
      };
      this.hdRun = { record, startedAt: now, pages: 0, sets: 0, prices: 0, kept: 0 };
    }
    const r = this.hdRun;
    r.pages += pages;
    r.sets += settled;
    r.prices += prices;
    r.kept += kept;
    r.record.finishedAt = new Date(now).toISOString();
    const backlog = this.d.store.get('runtime').hdBacklog;
    const waits = backlog ? backlogSentence({ ...backlog, pausedUntil: this.pace.pausedUntil(), ceiling: this.pace.ceilingWords() }) : null;
    r.record.summary = [
      `Read ${r.pages} Home Depot ${r.pages === 1 ? 'page' : 'pages'} between scans (free)${r.sets > 0 ? `; ${r.sets} ${r.sets === 1 ? 'bundle' : 'bundles'} settled` : ''}${r.prices > 0 ? `; ${r.prices} part ${r.prices === 1 ? 'price' : 'prices'} read` : ''}${r.kept > 0 ? `; ${r.kept} watched ${r.kept === 1 ? "deal's price" : "deals' prices"} checked` : ''}.`,
      ...(waits ? [waits] : []),
    ].join(' ');
    this.record({ ...r.record });
  }

  /** The deals with an estimate now, by key. */
  private estimatedKeys(): Set<string> {
    return new Set(this.d.store.get('deals').bundles.filter((b) => b.estimate !== null).map((b) => b.key));
  }

  /**
   * One Activity run an hour of drip: "Looked up 6 parts with Keepa: 4 matched, 2 no Amazon listing." and, from the catalog
   * check, "Verified 6 listings from Amazon's catalog; 1 did not match and was removed."
   */
  private dripRecord(done: DripDone): void {
    const now = this.d.now();
    if (!this.dripRun || now - this.dripRun.startedAt >= DRIP_RUN_MS) {
      const record: RunRecord = {
        id: `run-${now}-drip`, kind: 'lookup', startedAt: new Date(now).toISOString(), finishedAt: null, status: 'finished', searchesUsed: 0, keepaTokensUsed: 0,
        aiCostUsd: 0, summary: '', trigger: 'scheduled',
      };
      this.dripRun = { record, startedAt: now, looked: 0, matched: 0, none: 0, review: 0, verified: 0, removed: 0, sales: 0, kept: 0 };
    }
    const r = this.dripRun;
    r.looked += done.looked;
    r.matched += done.matched;
    r.none += done.none;
    r.review += done.review;
    r.verified += done.verified;
    r.removed += done.removed;
    r.sales += done.sales;
    if (done.ways) r.ways = sumWays(r.ways, done.ways);
    r.kept += done.kept ?? 0;
    r.record.keepaTokensUsed += done.tokens;
    r.record.finishedAt = new Date(now).toISOString();
    const parts = [`${r.matched} matched`, ...(r.none > 0 ? [`${r.none} no Amazon listing`] : []), ...(r.review > 0 ? [`${r.review} to review`] : [])];
    const looked = r.looked > 0 ? `Looked up ${r.looked} ${r.looked === 1 ? 'part' : 'parts'} with Keepa: ${parts.join(', ')}.` : null;
    const sales = r.sales > 0 ? `Read sales figures for ${r.sales} ${r.sales === 1 ? 'listing' : 'listings'} from Keepa.` : null;
    // Nov 25: how many the barcode found and how many the search, and what Keepa counted for each.
    const ways = lookupWaysSentence(r.ways);
    const kept = r.kept > 0 ? `Checked ${r.kept} Amazon ${r.kept === 1 ? 'price' : 'prices'} of watched deals with Keepa.` : null;
    r.record.summary = [looked, ways || null, catalogSentence(r.verified, r.removed), sales, kept].filter(Boolean).join(' ');
    this.record({ ...r.record });
  }

  // ------------------------------------------------------------------ the run

  /** One line in Activity that is not a run's summary ("The Chrome helper was updated to match the app."). Free. */
  announceActivity(text: string): void {
    const now = this.d.now();
    const at = new Date(now).toISOString();
    this.record({ id: `run-${now}-note`, kind: 'lookup', startedAt: at, finishedAt: at, status: 'finished', searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: text, trigger: 'scheduled' });
  }

  private record(run: RunRecord): void {
    this.d.store.update('activity', (a) => ({ ...a, runs: [...a.runs.filter((r) => r.id !== run.id), run].slice(-KEEP_RUNS) }));
    // Step 18: a finished run may have moved a service past a warning (once a month each).
    if (run.finishedAt) void this.costWarnings().catch(() => undefined);
  }

  // ------------------------------------------------------------------ step 18: the cost blocker and its warnings

  /**
   * The cost blocker before a step that costs (core/src/costs/decide.ts). When it holds the step: the note for the run, the
   * record in Costs and, once per service per `runKey`, the owner's message. With the blocker off it only warns (the note).
   */
  private costGate(service: CostService, step: CostStep, runKey: string, notes?: string[]): CostDecision {
    const d = this.costs.decide(service, step);
    if (d.reason) notes?.push(d.reason);
    if (!d.allow && d.reason && this.costs.hold(service, step.what, d.reason, runKey)) {
      const label = this.costs.view().services.find((x) => x.service === service)!.label;
      void this.costMessage(`${label}: held back`, d.reason).catch(() => undefined);
    }
    return d;
  }

  /** One cost message: a notification of kind 'costs' (switched off like the others) and, when set up, Telegram. */
  private async costMessage(title: string, body: string): Promise<void> {
    if (this.d.store.get('settings').notifications.kinds.costs === false) return;
    this.policy.send({ kind: 'costs', title, body, route: '/costs' });
    await this.sendTelegram(`${title}. ${body}`, [{ kind: 'costs' }]);
  }

  /** The cost warnings due now (a warn percent, a forecast past a limit, a limit reached), each once a month. */
  private async costWarnings(): Promise<void> {
    for (const w of this.costs.due()) await this.costMessage(w.title, w.body);
  }

  /** What a scan's searches are expected to use: the owner's own scans when there are enough, else the per-scan cap. */
  private serpScanStep(ext: ExtensionSettings, maxSearches?: number): CostStep {
    const cap = Math.min(ext.searchesPerScan, maxSearches ?? Number.POSITIVE_INFINITY);
    const h = scanHistory(this.d.store.get('activity').runs, (r) => r.searchesUsed, this.d.now());
    return { what: "The scan's searches", held: 'were not made', expected: Math.min(h?.expected ?? cap, cap), high: Math.min(h?.high ?? cap, cap) };
  }

  private addError(sentence: string, retry: ActivityErrorRecord['retry']): void {
    const at = new Date(this.d.now()).toISOString();
    const rec: ActivityErrorRecord = { id: `err-${this.d.now()}-${Math.random().toString(36).slice(2, 8)}`, at, sentence, retry, resolvedAt: null };
    this.d.store.update('activity', (a) => ({ ...a, errors: [...(a.errors ?? []), rec].slice(-KEEP_ERRORS) }));
  }

  private ledger(file: string) {
    return (entry: unknown) => {
      // The balance shown counts this row at once; the file is the record that survives a restart.
      if (file === SERP_LEDGER && typeof (entry as { at?: unknown }).at === 'string') this.serpRows().push({ at: (entry as { at: string }).at });
      try {
        appendFileSync(join(this.d.dataDir, file), `${JSON.stringify(entry)}\n`);
      } catch {
        // The account check is the budget's truth; the ledger is the record.
      }
    };
  }

  /** The rows of serpapi-ledger.jsonl, read once and then kept up to date by every spend this agent records. */
  private serpLedgerRows: { at: string }[] | null = null;
  /** Set when a scan's account check found the balance at or below the reserve and no explicit yes: it spends no search. */
  private reserveHeld: { left: number; reserve: number } | null = null;

  private serpRows(): { at: string }[] {
    if (!this.serpLedgerRows) {
      try {
        this.serpLedgerRows = parseLedger(readFileSync(join(this.d.dataDir, SERP_LEDGER), 'utf8'));
      } catch {
        this.serpLedgerRows = [];
      }
    }
    return this.serpLedgerRows;
  }

  /**
   * Searches left now: the last account check less the ledger rows written after it (core/src/serpapi/balance.ts). What
   * the state shows and what the checks that gate spending read; the spend itself is held to a fresh account check.
   */
  serpLeft(): number | null {
    return searchesLeftNow(this.d.store.get('runtime').serp, this.serpRows());
  }

  /** The last account check, kept for the balance (runtime.serp). The rows it already counts are dropped from memory. */
  private noteAccount(a: AccountInfo): void {
    const at = new Date(this.d.now()).toISOString();
    this.d.store.update('runtime', (r) => ({ ...r, serp: { left: a.totalSearchesLeft, perMonth: a.searchesPerMonth, rateLimitPerHour: a.rateLimitPerHour, at, ...(a.planName ? { planName: a.planName } : {}) } }));
    const t = Date.parse(at);
    this.serpLedgerRows = this.serpRows().filter((row) => !(Date.parse(row.at) <= t));
  }

  /** What rung 2's gate reads of the balance: the corrected figure (null before any account check). */
  private gateSerp(): { left: number } | null {
    const left = this.serpLeft();
    return left === null ? null : { left };
  }

  /** The free account check once more (no search is spent), so the balance is the account's own figure again. Never throws. */
  private async refreshAccount(): Promise<void> {
    const key = this.d.store.get('keys').serpapi;
    if (!key) return;
    try {
      this.noteAccount(await SerpApiClient.account(key, this.d.fetchFn, this.d.serpBaseUrl));
    } catch {
      // The ledger-corrected balance stays; the next check tries again.
    }
  }

  // ---- Nov 23, honest progress: the long work after the runner has steps of its own

  /** The steps after the runner (Review cards, Listing confirmation), kept as a job's record so the runner's helpers time them. */
  private tail: ScanJob | null = null;
  /** The last job the runner saved. */
  private liveJob: ScanJob | null = null;
  /** "Finishing up": the short tail only (the digest, the notifications). */
  private finishState: StepState = 'next';

  /** The scan's steps as the owner reads them: the runner's, then the tail's, then "Finishing up". Never a time from a guess. */
  private viewOf(job: ScanJob): PipelineView {
    const core = pipelineOf(job).filter((s) => s.id !== 'finish');
    const tail = this.tail?.pipeline ?? newTailSteps();
    const finish: PipelineStep = { id: 'finish', state: this.finishState, unitsDone: this.finishState === 'done' ? 1 : 0, unitsTotal: 1 };
    return pipelineViewOf([...core, ...tail, finish], this.d.store.get('runtime').rates, this.d.now(), { unknown: '', measuredOnly: true, words: DESKTOP_STEP_WORDS });
  }

  /** The line is redrawn now: the runner has ended, so no save of its job says what the tail is doing. */
  private pushView(): void {
    if (!this.liveJob || this.live.busy === null) return;
    this.live.pipeline = this.viewOf(this.liveJob);
    const now = this.d.now();
    if (now - this.progressAt >= PROGRESS_MS) this.tellProgress(now);
    else this.progressSoon();
  }

  /** Only the short tail is left: the digest and the messages. */
  private finishNow(): void {
    this.finishState = 'now';
    this.pushView();
  }

  private tailStep(id: 'review' | 'confirm'): PipelineStep | undefined {
    return this.tail?.pipeline?.find((s) => s.id === id);
  }

  /** Counts a tail step's items: `add` makes the total larger by n, `item` finishes one (timed when a call was made for it). */
  private tailProgress(id: 'review' | 'confirm'): StepProgress | undefined {
    const tail = this.tail;
    if (!tail) return undefined;
    return {
      add: (n) => {
        const s = this.tailStep(id);
        if (!s || s.state === 'skipped') return;
        if (s.state === 'next') startStep(tail, id, { remaining: n, now: this.d.now() });
        else moveUnits(tail, id, { total: (s.unitsTotal ?? s.unitsDone) + n });
        this.pushView();
      },
      item: (ms) => {
        const s = this.tailStep(id);
        if (!s || s.state === 'skipped') return;
        finishUnit(tail, id, { ms, remaining: Math.max(0, (s.unitsTotal ?? s.unitsDone + 1) - (s.unitsDone + 1)) });
        this.pushView();
      },
    };
  }

  /** A tail step is over: one that ran ends, one that never began did not run, for `why` (four words or fewer). */
  private tailSettle(id: 'review' | 'confirm', why: string): void {
    const tail = this.tail;
    const s = this.tailStep(id);
    if (!tail || !s) return;
    if (s.state === 'now') endStep(tail, id, this.d.now());
    else if (s.state === 'next') skipStep(tail, id, why);
    this.pushView();
  }

  /**
   * A store that tells the app how the scan is going, at most once a second. Step 15: the live view is kept on every
   * save, and a save inside the second is told when the second is up (a trailing call): the real Nov 23 scan saved the
   * part-price step's start 14 ms after the kit pages ended, the save was dropped, and the app showed the step as
   * "next" with no figure for the 9 minutes it ran.
   */
  private watched(store: ScanStore): ScanStore {
    const self = this;
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== 'putScan') return Reflect.get(target, prop, receiver);
        return async (job: ScanJob) => {
          await target.putScan(job);
          self.live.searchesUsed = job.searchesUsed;
          const now = self.d.now();
          self.liveJob = job;
          self.live.pipeline = self.viewOf(job);
          if (now - self.progressAt >= PROGRESS_MS || job.status !== 'running') self.tellProgress(now);
          else self.progressSoon();
        };
      },
    });
  }

  private progressTimer: ReturnType<typeof setTimeout> | null = null;

  private tellProgress(now: number): void {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    this.progressAt = now;
    this.d.changed();
  }

  /** The latest save is told once the second since the last one is up. */
  private progressSoon(): void {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => this.tellProgress(this.d.now()), PROGRESS_MS);
    this.progressTimer.unref?.();
  }

  /** Step 15: the last rejection of a key by its service, in plain words, or null when it was accepted. */
  private keyProblem(name: KeyName, said: string | null): void {
    // Security review M10: whatever sentence arrives, no stored key (nor the eBay Basic credential) stays in it.
    const sentence = said === null ? null : scrubKeyText(said, this.d.store.get('keys'));
    const cur = this.d.store.get('runtime').keyProblems ?? {};
    if ((cur[name] ?? null) === sentence) return;
    this.d.store.update('runtime', (r) => {
      const next = { ...(r.keyProblems ?? {}) };
      if (sentence === null) delete next[name];
      else next[name] = sentence;
      return { ...r, keyProblems: next };
    });
  }

  /**
   * Step 15, POST /api/lookups/run (the owner's "Look up all"): the parts waiting for an Amazon lookup, looked up now as a
   * scan would (Keepa's tokens above its reserve first, then searches within the per-scan cap, or `maxSearches` when
   * lower, and the hourly limit; like Scan now, the owner's click may spend the reserve), with no Home Depot page, no
   * brand page, no Chrome read, no eBay and no AI. Answers before it starts with what it is planned to make on each.
   */
  async lookUpAll(maxSearches?: number, useReserve = false): Promise<LookupsRunResponse> {
    const none = (reason: string): LookupsRunResponse => ({ started: false, reason, viaKeepa: 0, viaSerpapi: 0 });
    if (this.live.busy) return none(this.busySentence('scan'));
    if (this.answering > 0) return none('An answer is being applied. Try again in a moment.');
    if (maxSearches !== undefined && (!Number.isInteger(maxSearches) || maxSearches < 0)) return none('maxSearches must be a whole number of 0 or more.');
    const { store } = this.d;
    const keys = store.get('keys');
    if (!keys.serpapi) return none('Add your SerpApi key in Settings.');
    const ext = extensionSettingsOf(store.get('settings'));
    const pairs = Object.fromEntries(Object.values(store.get('tracking').bogoPairs ?? {}).map((p) => [p.key, `${p.promotionId}:${p.starterItemId}`]));
    const { work } = await plannedWork(this.scanStore, toScanSettings(ext), this.d.now(), pairs);
    if (work.lookups.length === 0) return none('No part waits for an Amazon lookup.');
    let keepa: KeepaRoom | null = null;
    if (keys.keepa && ext.amazonRefreshViaKeepa) {
      const status = await this.keepaStatus(this.keepaClient(keys.keepa, new TokenBudget({ reserve: ext.keepaReserve, maxPerRun: Number.POSITIVE_INFINITY })));
      keepa = { tokens: keepaTokensForScan({ tokensLeft: status?.tokensLeft ?? null, reserve: ext.keepaReserve, tokensPerScan: ext.keepaTokensPerScan }), trackingDepth: ext.trackingDepth };
    }
    let serp: SerpRoom;
    try {
      const account = await SerpApiClient.account(keys.serpapi, this.d.fetchFn, this.d.serpBaseUrl);
      this.keyProblem('serpapi', null);
      this.noteAccount(account);
      serp = new SearchBudget(account, budgetPolicyFor(lookupsCap(ext, maxSearches), reserveTrigger(useReserve), 0));
    } catch (err) {
      if (err instanceof SerpApiError && err.status === 401) this.keyProblem('serpapi', err.message);
      return none(err instanceof SerpApiError ? err.message : 'Something went wrong while checking your SerpApi account.');
    }
    const plan = routeAmazonWork({ lookups: work.lookups }, keepa, serp);
    const viaKeepa = plan.keepaLookups.length;
    const viaSerpapi = plan.serpLookups.length;
    if (viaKeepa + viaSerpapi === 0) {
      return none(`Nothing can pay for a lookup now: ${lookupsSentence({ waiting: work.lookups.length, keepa: 0, serpapi: 0, blockedBy: plan.blockedBy, refillPerMin: store.get('runtime').keepa?.refillRate ?? null })}`);
    }
    // Step 18: the cost blocker on the owner's click: the searches planned, inside his search limit (Keepa's in the scan).
    if (viaSerpapi > 0) {
      const held = this.costs.decide('serpapi', { what: 'These lookups', held: 'were not started', expected: viaSerpapi, high: viaSerpapi });
      if (!held.allow) return none(held.reason!);
    }
    try {
      this.begin('scan', () => this.scan('manual', undefined, { maxSearches, useReserve }));
    } catch (err) {
      if (err instanceof WorkRefused) return none(err.message);
      throw err;
    }
    const n = viaKeepa + viaSerpapi;
    const how = [...(viaKeepa > 0 ? [`${viaKeepa} with Keepa`] : []), ...(viaSerpapi > 0 ? [`${viaSerpapi} with ${viaSerpapi === 1 ? 'a search' : 'searches'}`] : [])].join(' and ');
    const rest = plan.deferredLookups.length;
    return { started: true, viaKeepa, viaSerpapi, reason: `Looking up ${n} ${n === 1 ? 'part' : 'parts'}: ${how}.${rest > 0 ? ` ${rest} more wait.` : ''}` };
  }

  /** `again`: Read again (readPagesAgain), with the searches the last scan used. `lookups`: Look up all (lookUpAll). */
  private async scan(trigger: ScanTrigger, again?: { usedBefore: number }, lookups?: { maxSearches?: number; useReserve?: boolean }): Promise<void> {
    const { store } = this.d;
    const startedAt = this.d.now();
    this.reserveHeld = null;
    const run: RunRecord = {
      id: `run-${startedAt}`, kind: 'scan', startedAt: new Date(startedAt).toISOString(), finishedAt: null, status: 'running',
      searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: 'Scanning.', trigger, stopReason: null, error: null,
    };
    this.record(run);
    this.costRun = run.id;
    // Nov 23: the steps after the runner; Look up all runs none of them.
    this.tail = { pipeline: newTailSteps() } as unknown as ScanJob;
    this.finishState = 'next';
    if (lookups) for (const id of ['review', 'confirm'] as const) skipStep(this.tail, id, 'not in this run');
    // The schedule counts from the start, whatever happens, so a failing scheduled scan does not start again each tick.
    if (trigger === 'scheduled') store.update('runtime', (r) => ({ ...r, lastScheduledRunAt: startedAt }));
    const keys = store.get('keys');
    const notes: string[] = [];
    let job: ScanJob | null = null;
    try {
      job = await this.runTheScan(trigger, keys, notes, again, lookups);
    } catch (err) {
      run.error = scrub(sentenceOf(err), keys);
      run.status = 'failed';
      this.addError(run.error, { kind: 'scan', label: 'Scan again', searches: store.get('settings').settings.searchesPerScan, usd: 0 });
    }
    if (job) {
      run.searchesUsed = job.searchesUsed;
      run.keepaTokensUsed = job.keepaTokensUsed ?? 0;
      run.stopReason = job.stopReason;
      run.status = job.stopReason === 'user' ? 'stopped' : job.stopReason === null ? 'finished' : job.stopReason === 'error' ? 'failed' : 'limit';
      if (job.stopMessage) run.error = scrub(job.stopMessage, keys);
      this.liveJob = job;
      run.steps = this.viewOf(job).steps;
      // Free scan: each bundle list read in Chrome, with an empty one's sample of its state, in the run's details.
      const lists = bundleListsOf(job);
      if (lists.length > 0) run.bundleLists = lists;
      const judge = pipelineOf(job).find((p) => p.id === 'judge');
      run.judgeCostUsd = judge?.costSoFar ?? 0;
      this.notedEbayKeys(job);
      this.costs.count('ebay', (job.counts.ebaySearches ?? 0) + (job.counts.ebayItemReads ?? 0));
      const j = job;
      store.update('runtime', (r) => ({
        ...r, rates: addSamples(r.rates, samplesOf(j)),
        lastJob: {
          status: j.status, stopReason: j.stopReason, stopMessage: j.stopMessage ? scrub(j.stopMessage, keys) : null, searchesUsed: j.searchesUsed, finishedAt: j.finishedAt, deferred: j.deferred, ebayNotice: j.ebayNotice ?? null,
          ...(j.lookupsVia ? { lookupsVia: j.lookupsVia } : {}), ...(j.lookupsWaiting !== undefined ? { lookupsWaiting: j.lookupsWaiting } : {}), lookupsBlockedBy: j.lookupsBlockedBy ?? null,
        },
      }));
    }

    // After the scan: the report, then (unless the owner stopped it) the AI, Autopilot and the messages.
    const settings = store.get('settings');
    let report: ScanReport | null = null;
    try {
      report = (await postScanWork({ store: this.scanStore, settings: toScanSettings(extensionSettingsOf(settings)), cache: this.cache, now: this.d.now, amazonFees: this.seller.amazonFees() })).report;
      // The app replaces a wrong listing itself: what the price guard and the audit withdrew is re-checked before it is asked.
      report = await this.selfCorrected(report);
      await this.publish(report);
    } catch (err) {
      notes.push(`The deals could not be built: ${scrub(sentenceOf(err), keys)}`);
    }
    // The run as it stands is saved before anything after the scan, so a crash from here keeps the eBay step's AI spend
    // (the month's cap counts it from the run).
    this.record({ ...run, status: 'running', aiCostUsd: Math.round((run.judgeCostUsd ?? 0) * 10_000) / 10_000 });
    let ai: AiPassResult | null = null;
    let applied = 0;
    // A failed or stopped scan is followed by nothing: no AI, no Autopilot, no digest. Only a message that is already
    // waiting for Telegram is tried again.
    const scanOk = run.status === 'finished' || run.status === 'limit';
    if (!scanOk) {
      for (const id of ['review', 'confirm'] as const) this.tailSettle(id, 'scan did not finish');
      this.finishNow();
      const tg = await this.resendPending();
      if (tg) notes.push(tg);
    } else if (report && lookups) {
      // Look up all spends no AI: the new matches are published and the digest says what is new.
      this.finishNow();
      await this.publish(report);
      await this.trackScan(report);
      const tg = await this.message(report, job, 0);
      if (tg) notes.push(tg);
    } else if (report && !this.stopCtl.signal.aborted) {
      ai = await this.aiPass(undefined, undefined, this.tailProgress('review'));
      this.tailSettle('review', 'no questions open');
      if (ai.problem) notes.push(ai.problem);
      if (ai.waitingForChrome > 0) notes.push(`${ai.waitingForChrome} split ${ai.waitingForChrome === 1 ? 'question waits' : 'questions wait'} for Chrome.`);
      applied = await this.autopilot();
      if (applied > 0 || ai.asked > 0) report = await reportWithTrends(this.scanStore, toScanSettings(extensionSettingsOf(store.get('settings'))), this.cache, this.seller.amazonFees());
      await this.publish(report);
      await this.trackScan(report);
      // The listing ladder, rung 2: within what the scan's cap leaves, the listings its catalog check left unconfirmed.
      const auto = await this.autoConfirmPass('scan', (again?.usedBefore ?? 0) + run.searchesUsed, this.tailProgress('confirm'));
      this.tailSettle('confirm', 'none to read');
      this.finishNow();
      await this.noteConfirmQueue();
      if (auto && auto.tried.length > 0) {
        run.searchesUsed += auto.searches;
        if (auto.summary) notes.push(auto.summary);
        if (auto.confirmed > 0) {
          report = await this.rebuild();
          await this.trackScan(report);
        }
      }
      const tg = await this.message(report, job, applied);
      if (tg) notes.push(tg);
    } else {
      // No report, or the owner stopped the scan: nothing more is asked or read.
      for (const id of ['review', 'confirm'] as const) this.tailSettle(id, 'scan stopped');
      this.finishNow();
    }
    this.finishState = 'done';
    if (job && this.tail) {
      // What each Review card cost in time stays for the next scan's estimate.
      const t = this.tail;
      store.update('runtime', (r) => ({ ...r, rates: addSamples(r.rates, samplesOf(t)) }));
      run.steps = this.viewOf(job).steps;
    }

    // The scan's searches are in the ledger already; the free account check puts the account's own figure back.
    await this.refreshAccount();
    run.aiCostUsd = Math.round(((run.judgeCostUsd ?? 0) + (ai?.costUsd ?? 0)) * 10_000) / 10_000;
    run.questionsAsked = ai?.asked ?? 0;
    run.autopilotApplied = applied;
    run.finishedAt = new Date(this.d.now()).toISOString();
    // Nov 23: the bundles whose own Home Depot page is still not read, for Read again.
    const pagesUnread = (await this.scanStore.listBundles().catch(() => [])).filter((b) => !pageRead(b)).length;
    // Home Depot's pace: how many pages wait and when they are read, from the pace's own figures (the pause first).
    const backlog = await this.noteBacklog().catch(() => null);
    const waits = backlog ? backlogSentence({ ...backlog, pausedUntil: this.pace.pausedUntil(), ceiling: this.pace.ceilingWords() }) : null;
    const said = waits ? notes.filter((n) => !waits.includes(n)) : notes;
    // Nov 25: a catch-up scan says when it was due and why it ran late.
    const late = trigger === 'scheduled' ? this.catchUp : null;
    this.catchUp = null;
    run.summary = `${late ? `${late} ` : ''}${lookups ? 'Look up all. ' : ''}${this.summaryOf(report, run, said, again !== undefined, job, waits)}`;
    this.record(run);
    const open = report ? report.review.length + (asksAboutEbay(store.get('settings')) ? report.ebayQuestions?.length ?? 0 : 0) : 0;
    store.update('activity', (a) => ({
      ...a,
      lastScan: {
        at: run.finishedAt!, status: run.status, stopMessage: run.error ?? null,
        // Read again spends from what the scan before it left, so the two count as one scan against the limit.
        searchesUsed: (again?.usedBefore ?? 0) + run.searchesUsed, keepaTokensUsed: run.keepaTokensUsed,
        newDeals: report ? report.bundles.filter((b) => b.section === 'confirmed').length : 0, reviewOpen: open, pagesUnread,
        // Step 15: what the lookups did, and why the rest wait.
        ...(job?.lookupsWaiting !== undefined ? { waitingLookups: job.lookupsWaiting } : {}),
        ...(job?.lookupsVia ? { lookupsDone: { ...job.lookupsVia } } : {}),
        ...(job && job.lookupsWaiting !== undefined ? { lookupsBlockedBy: job.lookupsBlockedBy ?? null } : {}),
        // Catalog check: the listings Amazon's catalog verified in this scan.
        ...(job?.matchesVerified !== undefined || job?.matchesRemoved !== undefined ? { matchesVerified: job.matchesVerified ?? 0 } : {}),
      },
    }));
  }

  /** Nov 23: the run's outcome first ("Found 16 bundles; 0 estimated because ..."), then what it spent, then the problems. */
  private summaryOf(report: ScanReport | null, run: RunRecord, notes: string[], again = false, job: ScanJob | null = null, backlog: string | null = null): string {
    const parts: string[] = [];
    if (again) parts.push('Read again.');
    if (report) parts.push(outcomeSentence(report, backlog));
    else if (backlog) parts.push(backlog);
    // Step 15: what the lookups did and the real cause of any that wait ("12 Amazon lookups wait for Keepa tokens ...").
    if (job?.lookupsVia) {
      const via = job.lookupsVia;
      const sentence = lookupsSentence({
        waiting: job.lookupsWaiting ?? 0, keepa: via.keepa, serpapi: via.serpapi, blockedBy: job.lookupsBlockedBy, refillPerMin: this.d.store.get('runtime').keepa?.refillRate ?? null,
      });
      if (sentence) parts.push(sentence);
      // Nov 25: how many Keepa lookups the barcode found and how many the search, and what Keepa counted for each.
      const ways = lookupWaysSentence(job.lookupsBy);
      if (ways) parts.push(ways);
    }
    const held = this.reserveHeld;
    if (held) {
      const waiting = job?.lookupsWaiting ?? 0;
      const ext = extensionSettingsOf(this.d.store.get('settings'));
      const may = Math.min(Math.max(0, Math.floor(ext.searchesPerScan)), waiting, held.left);
      const left = `${held.left} ${held.left === 1 ? 'search' : 'searches'} left, you keep ${held.reserve}`;
      parts.push(waiting > 0 && may > 0
        ? `Searches are at your reserve (${left}), so this scan spent none. To look these up, use searches for them: up to ${may} of your ${held.left} left.`
        : `Searches are at your reserve (${left}), so this scan spent none.`);
    }
    const verified = job ? catalogSentence(job.matchesVerified ?? 0, job.matchesRemoved ?? 0) : null;
    if (verified) parts.push(verified);
    // Nov 25: a page step that read nothing says why (Home Depot's pause or this scan's limit), not "page limit reached" for both.
    const skipped = skippedPagesSentence(job?.pipeline);
    if (skipped) parts.push(skipped);
    if (run.searchesUsed > 0 || run.status !== 'failed') parts.push(`${run.searchesUsed} ${run.searchesUsed === 1 ? 'search' : 'searches'}.`);
    if (run.questionsAsked) parts.push(`AI asked about ${run.questionsAsked}.`);
    if (run.autopilotApplied) parts.push(`Autopilot applied ${run.autopilotApplied}.`);
    if (run.error) parts.push(run.error);
    return [...parts, ...notes].join(' ');
  }

  private async runTheScan(trigger: ScanTrigger, keys: StoredKeys, notes: string[], again?: { usedBefore: number }, lookups?: { maxSearches?: number; useReserve?: boolean }): Promise<ScanJob> {
    const { store } = this.d;
    const app = store.get('settings');
    const ext = extensionSettingsOf(app);
    // Read again: no listing page and no Amazon brand page; the lookups get what the last scan left of the limit.
    // Look up all: the same, and no Chrome read and no eBay either.
    const scanSettings = again || lookups ? { ...toScanSettings(ext), queries: [], catalogPagesPerScan: 0 } : toScanSettings(ext);
    const problems = Object.values(validateSettings(ext));
    if (problems.length > 0) throw new WorkRefused(`A setting needs fixing before a scan: ${problems[0]}`);
    if (!keys.serpapi) throw new WorkRefused('Add your SerpApi key in Settings.');
    let account: AccountInfo;
    try {
      account = await SerpApiClient.account(keys.serpapi, this.d.fetchFn, this.d.serpBaseUrl);
    } catch (err) {
      if (err instanceof SerpApiError && err.status === 401) this.keyProblem('serpapi', err.message);
      throw new WorkRefused(err instanceof SerpApiError ? err.message : 'Something went wrong while checking your SerpApi account.');
    }
    this.keyProblem('serpapi', null);
    this.noteAccount(account);

    const newest = (await this.scanStore.listScans())[0];
    const continued = newest?.status === 'running' ? newest : undefined;
    // Nov 23: the reserve is the owner's, and only the owner's explicit say-so (Look up with "Use searches for these") spends it:
    // a manual scan keeps it like a scheduled one, and says so when the balance is already at or below it.
    this.reserveHeld = !lookups?.useReserve && account.totalSearchesLeft <= ext.reserve ? { left: account.totalSearchesLeft, reserve: ext.reserve } : null;
    // Step 18: the cost blocker. The scan's searches run only when what they may use stays inside his search limit, and
    // never get more than it leaves: a limit only lowers the per-scan cap; the reserve rules below hold as they are.
    const serpOk = this.costGate('serpapi', this.serpScanStep(ext, lookups?.maxSearches), this.costRun, notes).allow;
    const serpLeft = serpOk ? this.costs.left('serpapi') : 0;
    const extHeld = serpLeft === null ? ext : lookupsCap(ext, serpLeft);
    const budget = new SearchBudget(account, budgetPolicyFor(lookups ? lookupsCap(extHeld, lookups.maxSearches) : extHeld, reserveTrigger(lookups?.useReserve === true), again ? again.usedBefore + (continued?.searchesUsed ?? 0) : continued?.searchesUsed ?? 0));
    const serpLedger = this.ledger(SERP_LEDGER);
    const client = new SerpApiClient({
      apiKey: keys.serpapi, budget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now, baseUrl: this.d.serpBaseUrl,
      onSpend: (e: LedgerEntry) => serpLedger(e),
    });
    const keepa = await this.keepaDeps(ext, keys, notes);
    // Home Depot's pace: after a refusal no Home Depot page is read until the cool-down ends (lists, pages, part prices).
    const pausedUntil = lookups ? null : this.pace.pausedUntil();
    const connected = !lookups && this.d.helperConnected() && pausedUntil === null;
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal, gate: this.gate('scan') });
    if (lookups) {
      // Look up all reads nothing in Chrome.
    } else if (pausedUntil !== null) notes.push(pausedSentence(pausedUntil));
    else if (!connected) notes.push((trigger === 'scheduled' && this.scheduledKey ? this.selfRun.closedSentence(this.scheduledKey) : null) ?? 'Chrome is closed, so Home Depot pages wait for the next scan.');
    // BOGO found by itself, free, before the scan: the pairs it finds are bundles the scan then reads, splits and matches.
    else await this.bogoPass(ext, readers, notes);
    const ebay = lookups ? null : this.ebayStep(app, keys, notes);
    const scan = this.d.runScan ?? runScan;
    // BOGO pairs are looked up after every other bundle, a few per group a scan (core's pairLookupOrder).
    const bogoPairs = Object.fromEntries(Object.values(store.get('tracking').bogoPairs ?? {}).map((p) => [p.key, `${p.promotionId}:${p.starterItemId}`]));
    // Step 16: the models unverified AI answers wait for are read with the part prices (free).
    const partPricesExtra = connected ? await wantedReads(this.scanStore, store.get('suggestions')) : [];
    // Free scan: the bundle lists from Chrome when it can, else SerpApi within the budget; no brand page when Keepa looks up.
    const discovery = again || lookups ? null : discoveryFor({
      app, trigger, chromeConnected: connected, ...(pausedUntil !== null ? { hdPaused: true } : {}), serpCanPay: budget.blockReason(1) === null,
      keepaCanLookUp: Boolean(keepa.keepaLookup) && keepa.keepaScale?.tokensLeft != null, settings: scanSettings, readers,
    });
    // Nov 25: after the app tried to open Chrome, its one sentence says it; the scan's own "No new bundles ... Chrome is closed" would repeat it.
    const said = trigger === 'scheduled' && !connected && this.scheduledKey !== null && this.selfRun.closedSentence(this.scheduledKey) !== null;
    if (discovery?.note && !(said && /Chrome is closed/.test(discovery.note))) notes.push(discovery.note);
    const job = await scan({
      bogoPairs, partPricesExtra, catalogFirst: [...buyWaitsOn(store.get('tracking'))],
      // Nov 23: a bundle whose own page is not read waits for it (waiting_page); it is never a question before then.
      waitForPages: true,
      client, budget, store: this.watched(this.scanStore), settings: discovery?.settings ?? scanSettings, now: this.d.now, labelPrefix: 'agent',
      ...(discovery?.chromeListing ? { chromeListing: discovery.chromeListing } : {}),
      shouldStop: () => this.stopCtl.signal.aborted,
      ...(connected
        ? { readPages: readers.readPages, readPartPrices: readers.readPartPrices, readItemPages: readers.readPromoPages, hdPagesLeft: () => this.pace.left('scan'), hdBlock: () => this.pace.blocked('scan') }
        : { noReaderReason: lookups ? 'not in this run' : pausedUntil !== null ? 'Home Depot paused' : 'Chrome closed' }),
      ...(ebay ? { ebay } : {}),
      ...keepa,
      cache: this.cache,
      ...(keepa.keepaProduct ? { trendWriter: (t) => writePartTrend(this.cache, t) } : {}),
    });
    const listed = discoveryNote(job);
    if (listed) notes.push(listed);
    return job;
  }

  /**
   * Each brand's Featured BOGO listing and its items' pages, read in the paired Chrome (free; an item page once a day).
   * The pairs found (core/src/tracking/bogoPairs.ts: starter + joiner + free model, at the starter's price) are stored
   * on the tracking collection and put in the scan store as bundles, with the page the pass read. A brand not read in
   * full keeps the pairs found before. A failure is a note on the run; the scan goes on.
   */
  private async bogoPass(ext: ExtensionSettings, readers: RemoteReaders, notes: string[]): Promise<void> {
    const now = this.d.now();
    // Home Depot's pace: the BOGO listings are a list too: read through once, they are read again a day later.
    const readAt = this.d.store.get('runtime').bogoReadAt;
    if (readAt !== undefined && now >= readAt && now - readAt < HD_LIST_REREAD_MS) return;
    let results: BogoBrandResult[];
    try {
      results = await readBogoPass({
        brands: ext.brands, queries: BRAND_QUERIES, readListing: readers.readBogoListing, readPages: readers.readPromoPages,
        cache: this.cache, now: this.d.now, shouldStop: () => this.stopCtl.signal.aborted,
      });
    } catch (err) {
      notes.push(`BOGO deals were not read: ${sentenceOf(err)}`);
      return;
    }
    if (results.length === 0) return;
    const pairs = mergeBogoPairs(this.d.store.get('tracking').bogoPairs ?? {}, results, todayOf(now));
    const items = new Map(results.flatMap((r) => r.items).map((i) => [i.itemId, i]));
    for (const r of results) {
      for (const p of r.pairs) {
        const known = await this.scanStore.getBundle(p.key);
        await this.scanStore.putBundle(pairBundleRecord(p, items.get(p.itemId), known ?? undefined, now));
      }
    }
    this.d.store.update('tracking', (t) => ({ ...t, bogoPairs: pairs }));
    if (results.every((r) => r.complete)) this.d.store.update('runtime', (r) => ({ ...r, bogoReadAt: now }));
    const short = results.filter((r) => !r.complete && r.problem !== 'stopped');
    if (short.length > 0) notes.push(`BOGO: ${short.map((r) => r.brand).join(' and ')} not read in full (${short[0]!.problem}); the pairs found before are kept.`);
  }

  /** Step 15: a Keepa client on the owner's key whose every answer keeps the balance and refill in runtime.keepa. */
  private keepaClient(key: string, budget: TokenBudget): KeepaClient {
    const ledger = this.ledger('keepa-ledger.jsonl');
    return new KeepaClient({
      apiKey: key, budget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now,
      // Nov 25: a code request's cost as its responses said, kept between runs; its first answers kept as samples.
      codeCost: this.d.store.get('runtime').keepaCodeCost ?? null,
      onCodeAnswer: (sample, learned) => {
        this.d.store.update('runtime', (r) => ({ ...r, keepaCodeCost: learned, keepaCodeSamples: keepCodeSample(r.keepaCodeSamples, sample) }));
      },
      onSpend: (entry) => {
        ledger(entry);
        this.d.store.update('runtime', (r) => ({
          ...r, keepa: { tokensLeft: entry.tokensLeft, refillIn: entry.refillIn, refillRate: entry.refillRate ?? r.keepa?.refillRate, at: new Date(this.d.now()).toISOString() },
        }));
      },
    });
  }

  /**
   * Step 15: Keepa's free token status, kept in runtime.keepa; null when it could not be read (a rejected key is a key
   * problem, said beside the key in Settings). Never spends a token.
   */
  async keepaStatus(client: KeepaClient): Promise<{ tokensLeft: number; refillRate: number } | null> {
    try {
      const st = await client.tokenStatus();
      const at = new Date(this.d.now()).toISOString();
      this.d.store.update('runtime', (r) => ({ ...r, keepa: { tokensLeft: st.tokensLeft, refillIn: st.refillIn, refillRate: st.refillRate, at } }));
      this.keyProblem('keepa', null);
      return st;
    } catch (err) {
      if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
      return null;
    }
  }

  /**
   * Keepa inside the scan (step 15, decision 1): the free token status first, so the plan knows what the account has
   * above the reserve now; `keepaTokensPerScan` 0 is automatic (no cap of its own). Without a status the plan puts no
   * lookup on Keepa (never a guess) and SerpApi takes them within its own limits.
   */
  private async keepaDeps(s: ExtensionSettings, keys: StoredKeys, notes: string[]) {
    if (!keys.keepa || !s.amazonRefreshViaKeepa) return {};
    // Step 18: the cost blocker. Keepa in this scan only when what a scan uses at the high end (his scans, else the per-scan
    // cap, else the tokens above the reserve) stays inside his token limit; never more than the limit leaves.
    const known = this.d.store.get('runtime').keepa?.tokensLeft;
    const cap = s.keepaTokensPerScan > 0 ? s.keepaTokensPerScan : Math.max(KEEPA_LOOKUP_TOKEN_ESTIMATE, (known ?? 0) - s.keepaReserve);
    const h = scanHistory(this.d.store.get('activity').runs, (r) => r.keepaTokensUsed, this.d.now());
    const step: CostStep = { what: "The scan's Keepa lookups", held: 'were not made', expected: Math.min(h?.expected ?? cap, cap), high: Math.min(h?.high ?? cap, cap) };
    if (!this.costGate('keepa', step, this.costRun, notes).allow) return {};
    const keepaLeft = this.costs.left('keepa');
    const perScan = s.keepaTokensPerScan > 0 ? s.keepaTokensPerScan : Number.POSITIVE_INFINITY;
    const keepaBudget = new TokenBudget({ reserve: s.keepaReserve, maxPerRun: keepaLeft === null ? perScan : Math.min(perScan, keepaLeft) });
    const keepa = this.keepaClient(keys.keepa, keepaBudget);
    const status = await this.keepaStatus(keepa);
    if (status === null) {
      const problem = this.d.store.get('runtime').keyProblems?.keepa;
      notes.push(problem ? `Keepa: ${problem}` : "Keepa's token count could not be read, so no lookup went to Keepa this scan.");
      if (problem) return {};
    }
    return {
      keepaBudget,
      keepaProduct: (asin: string, label: string, maxAgeMs?: number) => keepaProductSearchResult(keepa, asin, { label, maxAgeMs, trackingDepth: s.trackingDepth }),
      keepaLookup: (brand: string, model: string, label: string, ask?: KeepaLookupAsk) => keepaPartLookup(keepa, brand, model, label, ask),
      keepaScale: {
        tokensPerRun: s.keepaTokensPerScan, discoveryShare: s.keepaDiscoveryShare, reserve: s.keepaReserve, mode: s.discoveryMode,
        tokensLeft: status?.tokensLeft ?? null, trackingDepth: s.trackingDepth,
      },
    };
  }

  /** Step 15: the eBay step's notice says whether eBay or Claude rejected its key; a step that ran clean clears them. */
  private notedEbayKeys(job: ScanJob): void {
    const notice = job.ebayNotice ?? '';
    const ran = pipelineOf(job).find((p) => p.id === 'ebay')?.state === 'done';
    const at = notice.indexOf(EBAY_NOTICE.ebayKeys);
    if (at >= 0) {
      // eBay's own answer follows the notice's fixed sentence, up to the next notice (each ends in a full stop and a space).
      const said = /^ (eBay (?:answered|gave a token)[^]*?\(HTTP \d+\)\.)/.exec(notice.slice(at + EBAY_NOTICE.ebayKeys.length))?.[1];
      this.keyProblem('ebay', said ? `eBay did not accept the App ID and Cert ID. ${said}` : 'eBay did not accept the App ID and Cert ID.');
    }
    else if (ran) this.keyProblem('ebay', null);
    if (notice.includes(EBAY_NOTICE.claudeKey)) this.keyProblem('anthropic', 'Claude did not accept the Anthropic key.');
    else if (pipelineOf(job).find((p) => p.id === 'judge')?.state === 'done' && (job.counts.listingsJudged ?? 0) > 0) this.keyProblem('anthropic', null);
  }

  /** The scan's eBay step: the keys, the judge pipeline, and room under the month's AI cap. */
  private ebayStep(app: AppSettings, keys: StoredKeys, notes: string[]): EbayStep | null {
    if (!keys.ebay) return { kind: 'skip', notice: 'Add the eBay App ID and Cert ID in Settings to see eBay values.', missing: ['ebay'] };
    const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn });
    if (!pipelines.judge.ok) {
      if (app.ai.judge.provider === 'anthropic') return { kind: 'skip', notice: 'Add your Anthropic key in Settings to check eBay listings.', missing: ['anthropic'] };
      notes.push(`eBay listings were not checked: ${afterLead(pipelines.judge.error)}`);
      return null;
    }
    const judge = pipelines.judge.value;
    const estimate = estimatedJudgeCost(judge.model, app.ebaySettings.listingsJudgedPerScan);
    const spent = aiSpentThisMonth({ suggestions: this.d.store.get('suggestions'), runs: this.d.store.get('activity').runs }, this.d.now());
    if (estimate === null) {
      notes.push(`eBay listings were not checked: no price is known for ${judge.model}, so the monthly AI limit could not hold.`);
      return null;
    }
    // Step 18: the cost blocker (the AI limit and the total budget), then the cap as it always held.
    if (!this.costGate('ai', { what: 'eBay listing checks', held: 'were not made', expected: estimate, high: estimate }, this.costRun, notes).allow) return null;
    if (spent + estimate > this.costs.aiCapUsd(spent)) {
      notes.push(`eBay listings were not checked: this month's AI limit of $${app.ai.monthlyCapUsd.toFixed(2)} would be passed.`);
      return null;
    }
    const stop = this.stopCtl.signal;
    const bounded: typeof fetch = (input, init) => this.d.fetchFn(input, { ...init, signal: AbortSignal.any([stop, AbortSignal.timeout(CALL_TIMEOUT_MS)]) });
    const client = new EbayClient({ appId: keys.ebay.appId, certId: keys.ebay.certId, fetchFn: bounded, now: this.d.now, maxSearches: EBAY_SEARCHES_MAX, maxItemReads: EBAY_ITEM_READS_MAX });
    return { kind: 'run', ebay: client, judge, listingsJudgedPerScan: app.ebaySettings.listingsJudgedPerScan, signal: stop, callTimeoutMs: CALL_TIMEOUT_MS };
  }

  private keyFor(ref: string): string | undefined {
    const keys = this.d.store.get('keys');
    if (ref === 'anthropic') return keys.anthropic;
    if (ref === 'openai') return keys.openai;
    return undefined;
  }

  /** The deals and Review collections the app reads, from the scan's report, with what a Look up of each bundle costs. */
  private async publish(report: ScanReport): Promise<void> {
    const saved = await savedAnswers(this.scanStore);
    const lookups: Record<string, number> = {};
    for (const b of report.bundles) {
      const parts = b.parts.filter((p) => p.status === 'unmatched' || p.status === 'waiting').map((p) => ({ brand: b.brand, model: p.model }));
      if (parts.length > 0) lookups[b.key] = lookupsNeeded(parts, saved);
    }
    // What the scan stored for each open question, line by line with its source, for Review (never fetched here).
    const evidence: Record<string, EvidenceQuote[]> = {};
    for (const q of report.review) {
      const ev = await gatherEvidence(this.scanStore, q);
      evidence[q.id] = ev.sources
        .flatMap((src) => src.lines.filter((l) => !l.suspect).map((l) => ({ text: l.text, source: { label: src.label, url: src.url } })))
        .slice(0, EVIDENCE_LINES);
    }
    const at = new Date(this.d.now()).toISOString();
    this.d.store.update('deals', (d) => ({ ...d, at, bundles: report.bundles, lookups }));
    // Checking the app's own work: the deals just written, checked (a hold keeps a deal from Buy now; signalsPass.ts).
    checkOwnWork(this.d.store, report.bundles);
    // Step 16 (round 2): the free reads made for open questions the AI has not answered are kept across reports.
    this.d.store.update('review', (prev) => {
      const open = new Set(report.review.map((q) => q.id));
      const followUps = Object.fromEntries(Object.entries(prev.followUps ?? {}).filter(([id]) => open.has(id)));
      return { at, questions: report.review, ebayQuestions: report.ebayQuestions ?? [], evidence, ...(Object.keys(followUps).length > 0 ? { followUps } : {}) };
    });
    await this.derive(report);
  }

  // ------------------------------------------------------------------ tracking: watchlist, signals, BOGO

  /** The stored Keepa trend of every part a way to sell holds (keepa:trend:<asin>, written by the scan). Reads only. */
  private async trendsFor(report: ScanReport): Promise<TrendLookup> {
    const asins = new Set(report.bundles.flatMap((b) => b.options.flatMap((o) => o.parts.flatMap((p) => (p.asin ? [p.asin] : [])))));
    const found = new Map<string, PartTrend>();
    for (const asin of asins) {
      const t = await readPartTrend(this.cache, asin);
      if (t) found.set(asin, t);
    }
    return (asin) => found.get(asin);
  }

  /** After a finished scan: the watchlist, each bundle's point and the watched bundles' signals (core/src/tracking). */
  private async trackScan(report: ScanReport): Promise<void> {
    const trend = await this.trendsFor(report);
    const alerts = this.d.store.get('settings').alerts;
    const now = this.d.now();
    const opts = this.signalsDeps();
    // Nov 25: a scan's deals are checked against his seller account before they are judged (its message follows), so a
    // first announcement rests on a fresh check. Amazon's fees read now count from the next rebuild.
    if (this.seller.connected() && !this.d.store.get('runtime').keyProblems?.amazonSeller) {
      const r = await this.seller.refresh(report, trend, { keepa: opts.keepa(), flatFee: opts.flatFee!(), held: sanityHolds(this.d.store) }).catch(() => null);
      if (r?.stopped && r.stopped !== this.sellerStopped) this.addError(`Checking your Amazon seller account stopped: ${scrub(r.stopped, this.d.store.get('keys'))}`, null);
      if (r) this.sellerStopped = r.stopped;
    }
    const seller = this.seller.lookup();
    this.d.store.update('tracking', (t) => ({ ...t, ...trackReport(t, report, trend, alerts, now, { keepa: opts.keepa(), flatFee: opts.flatFee!(), held: sanityHolds(this.d.store), ...(seller ? { seller } : {}) }) }));
  }

  /** What the views show beside each deal: its BOGO promotion's estimate and the FBA-fee estimate, from stored data. */
  private async derive(report: ScanReport): Promise<void> {
    const trend = await this.trendsFor(report);
    const settings = toScanSettings(extensionSettingsOf(this.d.store.get('settings')));
    const promos = this.d.store.get('tracking').bogo;
    const bogo: Record<string, BogoView> = {};
    for (const [key, promo] of Object.entries(promos)) {
      const row = report.bundles.find((b) => b.key === key);
      const parts = promo.chosen.length > 0 ? await partRowsFor(this.scanStore, settings, freeParts(promo)) : [];
      bogo[key] = bogoView(promo, row?.options[0], parts, settings.fees);
    }
    const fba: Record<string, FbaEstimate> = {};
    for (const b of report.bundles) {
      const f = fbaEstimateOf(b.options[0], trend, settings.fees);
      if (f) fba[b.key] = f;
    }
    // BOGO found by itself: each starter's pairs, ranked by each pair's own estimate in this report.
    const groups: Record<string, BogoGroup> = {};
    for (const g of bogoGroups(Object.values(this.d.store.get('tracking').bogoPairs ?? {}), report.bundles)) groups[g.id] = g;
    this.d.store.update('tracking', (t) => ({ ...t, derived: { bogo, fba, groups } }));
  }

  /** The owner's BOGO entry for a deal (POST /api/deals/:id/bogo), or null to remove it. Answers with its view. */
  async saveBogo(bundleKey: string, body: Record<string, unknown> | null): Promise<BogoView | null> {
    const bundle = this.d.store.get('deals').bundles.find((b) => b.key === bundleKey);
    if (!bundle) throw new AnswerRefused('No such deal.');
    const tracking = this.d.store.get('tracking');
    const prior = tracking.bogo[bundleKey];
    // The owner's entry is the fallback for a promotion Home Depot lists no pairs for; a pair already holds its free tool.
    if (body !== null) {
      if (tracking.bogoPairs?.[bundleKey]) throw new WorkRefused('Home Depot lists this bundle as a BOGO pair: its free tool is already in it.');
      const group = Object.values(tracking.derived.groups ?? {}).find((g) => g.starterKey === bundleKey);
      if (group) throw new WorkRefused(`Home Depot lists ${group.choices.length} pairs for this promotion. Choose one of them in BOGO choices.`);
    }
    if (body === null) {
      this.d.store.update('tracking', (t) => {
        const { [bundleKey]: _gone, ...bogo } = t.bogo;
        const { [bundleKey]: _view, ...views } = t.derived.bogo;
        return { ...t, bogo, derived: { ...t.derived, bogo: views } };
      });
      return null;
    }
    const promo = bogoFromBody(body, bundleKey, bundle.brand, prior, this.d.now());
    if (typeof promo === 'string') throw new WorkRefused(promo);
    const settings = toScanSettings(extensionSettingsOf(this.d.store.get('settings')));
    const parts = promo.chosen.length > 0 ? await partRowsFor(this.scanStore, settings, freeParts(promo)) : [];
    const view = bogoView(promo, bundle.options[0], parts, settings.fees);
    this.d.store.update('tracking', (t) => ({ ...t, bogo: { ...t.bogo, [bundleKey]: promo }, derived: { ...t.derived, bogo: { ...t.derived.bogo, [bundleKey]: view } } }));
    return view;
  }

  // ------------------------------------------------------------------ the AI and Autopilot

  private async aiPass(only?: string[], force?: string[], progress?: StepProgress): Promise<AiPassResult> {
    const { store } = this.d;
    const app = store.get('settings');
    const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn });
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal, gate: this.gate('scan') });
    // Step 16: what the scan stored since is checked against the unverified answers first (no AI call), and each
    // research ask is stamped with the evidence it rests on, so lever 2 asks again only on new evidence.
    await this.recheck();
    const askOne = withEvidenceKey(askOneWith({
      store: this.scanStore,
      assist: pipelines.assist.ok ? pipelines.assist.value : null,
      research: pipelines.research.ok ? pipelines.research.value : null,
      tools: () => readers.researchTools(this.scanStore),
      now: this.d.now,
    }), this.scanStore);
    const model = (p: typeof pipelines.assist | typeof pipelines.research) => (p.ok ? { ok: true as const, model: p.value.model } : { ok: false as const, error: p.error });
    const spentUsd = aiSpentThisMonth({ suggestions: store.get('suggestions'), runs: store.get('activity').runs }, this.d.now());
    // Step 18: the cost blocker before the automatic Review cards (not the owner's own Ask AI, held in askQuestion): what
    // they cost in his scans, else each question's estimate, inside the AI limit and the total budget.
    if (!only) {
      const open = (await this.scanStore.listReview()).filter((q) => q.answer === null);
      const queue = askQueueOf(open, store.get('suggestions'));
      const each = queue.map((q) => {
        const m = q.kind === 'split' ? pipelines.research : pipelines.assist;
        return m.ok ? estimatedQuestionCost(q.kind, m.value.model) ?? 0 : 0;
      });
      const sum = each.reduce((a, b) => a + b, 0);
      const h = scanHistory(store.get('activity').runs, (r) => r.aiCostUsd - (r.judgeCostUsd ?? 0), this.d.now());
      if (sum > 0) {
        const d = this.costGate('ai', { what: 'Review cards', held: 'were not written', expected: Math.min(h?.expected ?? sum, sum), high: Math.min(h?.high ?? sum, sum) }, this.costRun);
        if (!d.allow) {
          return { asked: 0, suggested: 0, verified: 0, costUsd: 0, waitingForChrome: 0, problem: d.reason };
        }
      }
    }
    const pass = await runAiPass({
      store: this.scanStore,
      suggestions: () => store.get('suggestions'),
      keep: (r) => store.update('suggestions', (all) => [...all.filter((x) => x.key !== r.key), r]),
      afterKeep: briefAfterKeep(this.briefCtx()),
      models: { assist: model(pipelines.assist), research: model(pipelines.research) },
      askOne,
      chromeConnected: this.d.helperConnected,
      spentUsd,
      // The owner's own ask was weighed against the budget when he pressed it; the AI limit holds either way.
      capUsd: only ? app.ai.monthlyCapUsd : this.costs.aiCapUsd(spentUsd),
      signal: this.stopCtl.signal,
      now: this.d.now,
      ...(only ? { only } : {}),
      ...(force && force.length > 0 ? { force } : {}),
      ...(progress ? { progress } : {}),
    });
    // Step 16: the follow-up loop (agent/followUp.ts; it took over lever 2's re-ask) for the answers still not settled: the free
    // reads and the code's check always, follow-up asks only when the owner's setting allows them. Not after the owner's own ask.
    if (only || this.stopCtl.signal.aborted) return pass;
    const f = await this.followUps(app.ai.reaskOnNewEvidence === true, undefined, progress);
    return { ...pass, asked: pass.asked + f.asked, verified: pass.verified + f.verified, costUsd: pass.costUsd + f.costUsd, problem: pass.problem ?? (f.ran > 0 ? f.problem : null) };
  }

  /** Step 16: the follow-up loop over the open questions (or `only`), with the Chrome tools and the research model. */
  private async followUps(allowAsk: boolean, only?: string[], progress?: StepProgress) {
    const { store } = this.d;
    const app = store.get('settings');
    const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn });
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal, gate: this.gate('scan') });
    try {
      return await followUpPass({
        store: this.scanStore,
        suggestions: () => store.get('suggestions'),
        put: (r) => store.update('suggestions', (all) => (all.some((x) => x.key === r.key) ? all.map((x) => (x.key === r.key ? r : x)) : [...all, r])),
        tools: () => readers.researchTools(this.scanStore),
        research: pipelines.research.ok ? pipelines.research.value : null,
        allowAsk,
        chromeConnected: this.d.helperConnected,
        spentUsd: aiSpentThisMonth({ suggestions: store.get('suggestions'), runs: store.get('activity').runs }, this.d.now()),
        // Step 18: the owner's own ask (`only`) was weighed when he pressed it; the automatic loop keeps to the budget too.
        capUsd: only ? app.ai.monthlyCapUsd : this.costs.aiCapUsd(aiSpentThisMonth({ suggestions: store.get('suggestions'), runs: store.get('activity').runs }, this.d.now())),
        signal: this.stopCtl.signal,
        now: this.d.now,
        afterKeep: briefAfterKeep(this.briefCtx()),
        // Step 16 (round 2): a question the AI has not answered gets its free reads too; their state is kept in Review.
        questionState: {
          get: (id) => store.get('review').followUps?.[id],
          put: (id, seen, state) => store.update('review', (r) => ({ ...r, followUps: { ...(r.followUps ?? {}), [id]: { seen, state } } })),
        },
        ...(only ? { only } : {}),
        ...(progress ? { progress } : {}),
      });
    } catch {
      // A loop that could not run changes nothing it has not kept; the next pass tries again.
      return { ran: 0, verified: 0, asked: 0, costUsd: 0, problem: null };
    }
  }

  /**
   * Step 16: the owner's Ask AI on one question (POST /api/review/:id/ask). Never a silent nothing: an ask, the follow-up loop
   * (when its answer is not settled and something is left to read or ask about), a fresh ask with `force`, or the reason.
   */
  async askQuestion(id: string, force: boolean): Promise<AskResponse> {
    if (this.live.busy) return { queued: false, reason: this.busySentence('ask') };
    const { store } = this.d;
    const item = await this.scanStore.getReview(id);
    if (!item || item.answer !== null) return { queued: false, reason: 'That question is answered already.' };
    const app = store.get('settings');
    const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn });
    const p = item.kind === 'split' ? pipelines.research : pipelines.assist;
    // Step 18: the cost blocker on the owner's click. Past the AI limit it is a hard stop, as the cap always was; past the
    // total budget it says the same sentence and asks him to confirm (`canForce`, then { force: true }).
    const est = p.ok ? estimatedQuestionCost(item.kind, p.value.model) : null;
    if (est !== null) {
      const d = this.costs.decide('ai', { what: 'The AI answer', held: 'was not asked for', expected: est, high: est });
      if (!d.allow && d.reason) {
        const pastLimit = d.limit !== null && d.used + d.high > d.limit;
        if (pastLimit) return { queued: false, reason: d.reason };
        if (!force) return { queued: false, reason: `${d.reason} Ask anyway to spend it.`, canForce: true, costUsd: est };
      }
    }
    const plan = await askPlan({
      store: this.scanStore, suggestions: store.get('suggestions'), item, force,
      model: p.ok ? { ok: true, model: p.value.model } : { ok: false, error: p.error },
      spentUsd: aiSpentThisMonth({ suggestions: store.get('suggestions'), runs: store.get('activity').runs }, this.d.now()),
      capUsd: app.ai.monthlyCapUsd, chromeConnected: this.d.helperConnected(),
    });
    if (plan.action === 'none') {
      const { action: _a, ...rest } = plan;
      return { queued: false, ...rest };
    }
    if (this.live.busy) return { queued: false, reason: this.busySentence('ask') };
    if (plan.action === 'ask') this.askNow([id], plan.force ? [id] : undefined);
    else {
      // Queued at once, so the answer to this press and the counts already say the app has it.
      const live = liveSuggestion(store.get('suggestions'), item);
      if (live) store.update('suggestions', (all) => all.map((x) => (x.key === live.key ? { ...x, followUp: { ...(x.followUp ?? freshFollowUp(this.d.now())), state: 'queued', updatedAt: this.d.now() } } : x)));
      this.followUpNow(id);
    }
    return { queued: true };
  }

  /** Step 16: the follow-up loop for one question the owner pressed Ask AI on: asks allowed (the press is his yes), under the cap. */
  private followUpNow(id: string): void {
    this.begin('ask', async () => {
      const startedAt = this.d.now();
      const run: RunRecord = { id: `run-${startedAt}`, kind: 'ask', startedAt: new Date(startedAt).toISOString(), finishedAt: null, status: 'running', searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: 'Reading the pages a question needs.', trigger: 'manual' };
      this.record(run);
      const f = await this.followUps(true, [id]);
      const applied = await this.autopilot();
      await this.refresh();
      run.finishedAt = new Date(this.d.now()).toISOString();
      run.status = this.stopCtl.signal.aborted ? 'stopped' : 'finished';
      run.aiCostUsd = Math.round(f.costUsd * 10_000) / 10_000;
      run.questionsAsked = f.asked;
      run.autopilotApplied = applied;
      run.summary = [`Followed up on 1 question: ${f.asked === 0 ? 'read its pages' : `read its pages and asked the AI ${f.asked === 1 ? 'once' : `${f.asked} times`}`}, ${f.verified} verified.`, f.problem ?? ''].filter(Boolean).join(' ');
      this.record(run);
    });
  }

  /** Step 16: what the plain brief above a Review question is written with (agent/brief.ts). */
  private briefCtx(): BriefCtx {
    return {
      store: this.d.store, scanStore: this.scanStore, keyFor: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn, now: this.d.now, signal: this.stopCtl.signal,
      // Step 18: the briefs keep to the total budget as well as the AI limit.
      capUsd: (spentUsd) => this.costs.aiCapUsd(spentUsd),
    };
  }

  /** Step 16: unverified AI answers checked again with what the scan stored since (agent/reverify.ts). No AI call. Returns how many verified. */
  private async recheck(): Promise<number> {
    const { store } = this.d;
    try {
      const r = await reverifyPass({
        store: this.scanStore, suggestions: () => store.get('suggestions'), now: this.d.now,
        replace: (rec) => store.update('suggestions', (all) => all.map((x) => (x.key === rec.key ? rec : x))),
      });
      return r.verified.length;
    } catch {
      // A check that could not run changes nothing; the next run checks again.
      return 0;
    }
  }

  /** Applies every verified suggestion Autopilot's rules allow (autopilot.ts). Returns how many. */
  private async autopilot(): Promise<number> {
    const { store } = this.d;
    const app = store.get('settings');
    if (!app.autopilot) return 0;
    let applied = 0;
    for (const item of await this.scanStore.listReview()) {
      if (item.answer !== null || item.kind !== 'split') continue;
      const suggestions = store.get('suggestions');
      const stored = liveSuggestion(suggestions, item);
      // A question Autopilot answered and the owner undid, or one he answered and took back, stays with him.
      const undone = store.get('autopilot').some((e) => e.questionId === item.id && e.undoneAt !== null) || store.get('answers').some((e) => e.questionId === item.id && e.undoneAt !== null);
      const d = autopilotDecision(item, stored, app.ai, undone);
      if (!d.apply || !stored) continue;
      let done: { answer: string; answeredAt: number };
      try {
        done = await applyAutopilot(this.scanStore, item, d, this.d.now());
      } catch (err) {
        if (err instanceof AnswerRefused) continue;
        throw err;
      }
      const answered = await this.scanStore.getReview(item.id);
      store.update('suggestions', (all) =>
        all.map((s) => (s.key === stored.key ? { ...s, outcome: { answeredAt: done.answeredAt, answer: done.answer, agreed: answered ? agreedWith(s.suggestion, answered) : true } } : s)),
      );
      const entry: StoredAutopilotEntry = {
        id: `ap-${done.answeredAt}-${applied}`, at: new Date(done.answeredAt).toISOString(), questionId: item.id, applied: d.applied, verifiedBy: d.verifiedBy,
        undoneAt: null, answer: done.answer, answeredAt: done.answeredAt, suggestionKey: stored.key, provider: stored.suggestion.provider,
        model: stored.suggestion.model, bundleId: item.subject, undoable: true,
      };
      store.update('autopilot', (all) => [...all, entry]);
      applied += 1;
    }
    return applied;
  }

  /** Open split questions whose suggestion the code verified and the owner has not used: what Approve all verified takes. */
  private async verifiedWaiting(): Promise<number> {
    const suggestions = this.d.store.get('suggestions');
    let n = 0;
    for (const item of await this.scanStore.listReview()) {
      if (item.answer !== null) continue;
      const stored = liveSuggestion(suggestions, item);
      if (stored && stored.outcome === undefined && approvalOf(stored.suggestion, item)) n += 1;
    }
    return n;
  }

  /** Undo: the question opens again, the suggestion shows again for the owner, and Autopilot leaves that question alone. */
  undo(entryId: string): Promise<StoredAutopilotEntry> {
    return this.serialAnswer('A scan or a search is running. Undo when it has finished.', () => this.undoNow(entryId));
  }

  private async undoNow(entryId: string): Promise<StoredAutopilotEntry> {
    const { store } = this.d;
    const entry = store.get('autopilot').find((e) => e.id === entryId);
    if (!entry) throw new AnswerRefused('No such Autopilot entry.');
    if (entry.undoneAt !== null) throw new AnswerRefused('That answer was undone already.');
    await undoAutopilot(this.scanStore, entry, this.d.now());
    const undone = { ...entry, undoneAt: new Date(this.d.now()).toISOString(), undoable: false };
    store.update('autopilot', (all) => all.map((e) => (e.id === entryId ? undone : e)));
    store.update('suggestions', (all) => all.map((s) => (s.key === entry.suggestionKey ? (({ outcome: _o, ...rest }) => rest)(s) : s)));
    await this.refresh();
    return undone;
  }

  /**
   * Nov 23, at start: the split questions a scan opened for bundles whose own Home Depot page was never read are withdrawn
   * (core's withdrawUnreadSplitQuestions); those bundles wait for their page. Review is rebuilt when any was. Returns how many.
   * Step 15: first each stored BOGO pair's facts are put on its bundle record (a record written before step 15 has none),
   * then every other open split question is read again under the settle rules, and withdrawn when they settle its split or
   * make it wait for Home Depot's part pages. The owner's answers and the Autopilot and Undo records are not touched.
   */
  async withdrawWaitingQuestions(): Promise<number> {
    for (const p of Object.values(this.d.store.get('tracking').bogoPairs ?? {})) {
      const b = await this.scanStore.getBundle(p.key);
      if (b && !b.bogo && b.model.trim().toUpperCase() === p.model.trim().toUpperCase()) await this.scanStore.putBundle({ ...b, bogo: pairFacts(p) });
    }
    const ids = await withdrawUnreadSplitQuestions(this.scanStore, this.d.now());
    // Nov 24 (rule D): a "Which listing" question asked only for a RYOBI pack size Home Depot's own page now states.
    const packs = await rejudgePackQuestions(this.scanStore, toScanSettings(extensionSettingsOf(this.d.store.get('settings'))), this.d.now);
    if (ids.length + packs.length > 0) await this.refresh();
    return ids.length + packs.length;
  }

  /**
   * The report rebuilt from the scan's store, for the app (after an answer, an undo, a Look up), with the stored Keepa
   * trends (each part's FBA fee). Signals round 2: then the signals judged again, with `extra` in the same message.
   */
  async refresh(extra?: { text: string; count: number }, before?: ReadonlyMap<string, DealSnapshot>): Promise<void> {
    // Nov 25: every refresh says a watched deal's change of Buy now state (left it, once), not only keep-current's.
    const was = before ?? dealSnapshots({ deals: this.d.store.get('deals'), tracking: this.d.store.get('tracking') });
    await this.afterChange(await this.rebuild(), extra, was);
  }

  /** The report rebuilt and published, without judging signals. */
  private async rebuild(): Promise<ScanReport> {
    // The price guard over what is stored (core/src/scan/priceGuard.ts): free, and never beside a scan, whose end runs it.
    if (this.live.busy !== 'scan') await applyPriceGuard(this.scanStore, this.d.now());
    let report = await reportWithTrends(this.scanStore, toScanSettings(extensionSettingsOf(this.d.store.get('settings'))), this.cache, this.seller.amazonFees());
    if (this.live.busy !== 'scan') report = await this.selfCorrected(report);
    await this.publish(report);
    return report;
  }

  /**
   * The app replaces a wrong listing itself (agent/recheck.ts): held questions become re-checks, the audit's certain
   * findings are withdrawn, the re-checks run as far as they can without a pull; the report is built again when anything
   * changed. Free: no search, no Keepa token, no AI (the drip pulls).
   */
  private async selfCorrected(report: ScanReport): Promise<ScanReport> {
    const done = await selfCorrect({
      store: this.scanStore, catalog: (await knownModels(this.scanStore)).catalog, now: this.d.now, keepa: !!this.d.store.get('keys').keepa,
      cleared: this.d.store.get('tracking').sanityCleared ?? [],
    }, report.bundles);
    if (!done.changed) return report;
    return reportWithTrends(this.scanStore, toScanSettings(extensionSettingsOf(this.d.store.get('settings'))), this.cache, this.seller.amazonFees());
  }

  /** Ask AI now, about one question or every open one (the app's buttons). Runs in the background. */
  askNow(only?: string[], force?: string[]): void {
    this.begin('ask', async () => {
      const startedAt = this.d.now();
      const run: RunRecord = { id: `run-${startedAt}`, kind: 'ask', startedAt: new Date(startedAt).toISOString(), finishedAt: null, status: 'running', searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: 'Asking the AI.', trigger: 'manual' };
      this.record(run);
      this.costRun = run.id;
      const r = await this.aiPass(only, force);
      const applied = await this.autopilot();
      await this.refresh();
      run.finishedAt = new Date(this.d.now()).toISOString();
      run.status = this.stopCtl.signal.aborted ? 'stopped' : 'finished';
      run.aiCostUsd = Math.round(r.costUsd * 10_000) / 10_000;
      run.questionsAsked = r.asked;
      run.autopilotApplied = applied;
      run.summary = [`AI asked about ${r.asked}, ${r.verified} verified.`, applied ? `Autopilot applied ${applied}.` : '', r.problem ?? ''].filter(Boolean).join(' ');
      if (r.problem) this.addError(r.problem, { kind: 'ask', label: 'Ask again', searches: 0, usd: 0 });
      this.record(run);
    });
  }

  // ------------------------------------------------------------------ the owner's answers and paid actions

  /** The owner's answer from the app, applied by the agent (core/src/scan/answers.ts). */
  answer(id: string, answer: { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' }, seen: string | undefined, fromSuggestion: boolean): Promise<string | null> {
    return this.answerRemembering(id, answer, seen, fromSuggestion, []).then((r) => r.entryId);
  }

  /**
   * Answer once (Nov 23): the answer, then what he ticked "…and remember this for A986501" for, kept per brand and model
   * (core/src/facts) and applied at once to every open question it settles. `remember` empty: the answer alone.
   */
  answerRemembering(
    id: string, answer: { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' }, seen: string | undefined, fromSuggestion: boolean,
    remember: readonly string[],
  ): Promise<{ entryId: string | null; remembered: Remembered | null }> {
    return this.serialAnswer('A scan or a search is running. Answer again when it has finished.', () => this.answerNow(id, answer, seen, fromSuggestion, remember));
  }

  /** Answer once: "In the box, not sold separately" for a model, or that answer kept after newer evidence; the report follows. */
  markNotSold(brand: string, model: string): Promise<void> {
    return this.serialAnswer('A scan or a search is running. Save this when it has finished.', async () => {
      await markNotSold(this.scanStore, brand, model, this.d.now());
      await this.refresh();
    });
  }

  /**
   * Checking the app's own work: the owner's verdict on one finding (POST /api/deals/:id/needs-look). "This is right"
   * remembers its clearKey, so that listing (or that deal's estimate) is not flagged again. "Wrong listing" withdraws the
   * part's match from that listing as the catalog check withdraws a contradicted one: no listing, the ASIN in
   * rejectedAsins so no later scan chooses it for the part again, the owner's reason as the evidence. Then the deals are
   * rebuilt and judged again; the finding goes with the match.
   */
  settleNeedsLook(bundleKey: string, clearKey: string, verdict: 'right' | 'wrong'): Promise<void> {
    return this.serialAnswer('A scan or a search is running. Save this when it has finished.', async () => {
      const finding = (this.d.store.get('deals').sanity ?? []).find((f) => f.bundleId === bundleKey && f.clearKey === clearKey);
      if (!finding) throw new WorkRefused('This was already settled, or the deal changed. Reload the deal.');
      if (verdict === 'right') {
        this.d.store.update('tracking', (t) => ({ ...t, sanityCleared: [...new Set([...(t.sanityCleared ?? []), clearKey])] }));
      } else {
        const bundle = this.d.store.get('deals').bundles.find((b) => b.key === bundleKey);
        if (!finding.part || !finding.asin || !bundle) throw new WorkRefused('This is about the estimate, not one listing. Open each listing to check it.');
        const m = await this.scanStore.getMatch(partKey(bundle.brand, finding.part));
        if (!m || m.asin !== finding.asin) throw new WorkRefused('The listing for this part changed since. Reload the deal.');
        const now = this.d.now();
        // The app replaces it itself (core/src/scan/recheck.ts): the part's other listings are tried before he is asked.
        const reason = `You marked it the wrong listing (Needs a look: ${finding.sentence})`;
        if (!(await withdrawListing(this.scanStore, { key: m.key, asin: finding.asin, reason, by: 'owner', now }))) {
          const { verifiedBy: _v, ...rest } = m;
          await this.scanStore.putMatch({
            ...rest, status: 'none', asin: null, grade: null, alternatives: [], updatedAt: now, waitingSince: null,
            rejectedAsins: [...new Set([...(m.rejectedAsins ?? []), finding.asin])],
            verifyEvidence: `${reason}: https://www.amazon.com/dp/${encodeURIComponent(finding.asin)}`,
          });
        }
      }
      await this.refresh();
    });
  }

  /** Answer once, "Change": forgets what he settled about a model; the bundles it settled are asked about again. */
  forgetFact(key: string, field: FactField | null): Promise<string[]> {
    return this.serialAnswer('A scan or a search is running. Change this when it has finished.', async () => {
      const reopened = await forgetFact(this.scanStore, key, field, this.d.now());
      await this.refresh();
      return reopened;
    });
  }

  /**
   * The owner's answers (and Undo) one at a time, and never beside a scan or a Look up: refused while one runs, and
   * while an answer is being applied a tick, Scan now or Look up waits (claim, tick).
   */
  private serialAnswer<T>(busySentence: string, fn: () => Promise<T>): Promise<T> {
    if (this.live.busy === 'scan' || this.live.busy === 'paid') throw new WorkRefused(busySentence);
    this.answering += 1;
    const run = this.answerChain.then(fn);
    this.answerChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.answering -= 1;
    });
  }

  /** The id of the entry Undo takes (undoAnswer) when the answer can be taken back; null for an eBay answer. */
  private async answerNow(
    id: string, answer: { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' }, seen: string | undefined, fromSuggestion: boolean,
    remember: readonly string[] = [],
  ): Promise<{ entryId: string | null; remembered: Remembered | null }> {
    const now = this.d.now();
    if ('ebay' in answer) {
      const q = this.d.store.get('review').ebayQuestions.find((x) => x.id === id);
      if (!q) throw new AnswerRefused('That question was not found.');
      await applyEbayAnswer(this.scanStore, { key: q.key, itemId: q.itemId, answer: answer.ebay }, now);
      await this.refresh();
      return { entryId: null, remembered: null };
    }
    const item = await this.scanStore.getReview(id);
    if (!item) throw new AnswerRefused('That question was not found.');
    const signed: ReviewAnswer = { ...answer, seen: seen ?? reviewSignature(item) } as ReviewAnswer;
    const before = await footprintOf(this.scanStore, item);
    await applyReviewAnswer(this.scanStore, id, signed, now);
    const answered = await this.scanStore.getReview(id);
    const shown = fromSuggestion ? liveSuggestion(this.d.store.get('suggestions'), item) : undefined;
    if (shown && answered) {
      this.d.store.update('suggestions', (all) => all.map((s) => (s.key === shown.key ? { ...s, outcome: { answeredAt: now, answer: answered.answer ?? '', agreed: agreedWith(s.suggestion, answered) } } : s)));
    }
    const entryId = answered ? await this.keepOwnerAnswer(item, answered, before, shown?.key ?? null, now) : null;
    // Answer once (Nov 23): what he asked to remember, applied to every open question it settles (core/src/facts/apply.ts).
    const remembered = answered && answered.kind === 'split' && remember.length > 0 ? await rememberAnswer(this.scanStore, answered, remember, now) : null;
    await this.refresh();
    return { entryId, remembered };
  }

  private ownerAnswerSeq = 0;

  /** Keeps what Undo needs for the answer just applied (ownerAnswers.ts); the newest KEEP_OWNER_ANSWERS stay. */
  private async keepOwnerAnswer(item: ReviewItem, answered: ReviewItem, before: Footprint, suggestionKey: string | null, now: number): Promise<string> {
    const after = await footprintOf(this.scanStore, answered);
    const entry: StoredOwnerAnswer = {
      id: `oa-${now}-${this.ownerAnswerSeq++}`, by: 'owner', at: new Date(now).toISOString(), questionId: item.id,
      title: item.title ?? `${item.brand} ${item.model}`, answer: answerText(answered), answeredAt: answered.answeredAt ?? now,
      suggestionKey, undoneAt: null, undoable: restorable(before, after), before, after,
    };
    // An older entry for the same question describes records this answer replaced: it can no longer be undone.
    this.d.store.update('answers', (all) => [...all.map((e) => (e.questionId === item.id && e.undoneAt === null ? { ...e, undoable: false } : e)), entry].slice(-KEEP_OWNER_ANSWERS));
    return entry.id;
  }

  /** Undo: the question opens again as it was (with its AI suggestion), the split or match it set goes back, estimates follow. */
  undoAnswer(entryId: string): Promise<StoredOwnerAnswer> {
    return this.serialAnswer('A scan or a search is running. Undo when it has finished.', async () => {
      const { store } = this.d;
      const entry = store.get('answers').find((e) => e.id === entryId);
      if (!entry) throw new AnswerRefused('That answer is not kept any more, so it cannot be undone.');
      try {
        await undoOwnerAnswer(this.scanStore, entry);
      } catch (err) {
        // Refused because the records changed: the entry says so, so Activity stops offering Undo.
        if (err instanceof AnswerRefused && entry.undoneAt === null && entry.undoable) store.update('answers', (all) => all.map((e) => (e.id === entryId ? { ...e, undoable: false } : e)));
        throw err;
      }
      const undone = { ...entry, undoneAt: new Date(this.d.now()).toISOString(), undoable: false };
      store.update('answers', (all) => all.map((e) => (e.id === entryId ? undone : e)));
      if (entry.suggestionKey) store.update('suggestions', (all) => all.map((s) => (s.key === entry.suggestionKey ? (({ outcome: _o, ...rest }) => rest)(s) : s)));
      await this.refresh();
      return undone;
    });
  }

  /**
   * The owner's confirmed price for one part (already planned by core's planConfirmedPrice) stored in the scan's
   * records, and the report rebuilt so the deal's estimate counts it. One at a time with answers, never beside a scan.
   */
  confirmPrice(record: ConfirmedPrice): Promise<ConfirmedPrice> {
    return this.serialAnswer('A scan or a search is running. Save the price when it has finished.', async () => {
      await this.scanStore.putConfirmedPrice(record);
      await this.refresh();
      return record;
    });
  }

  /**
   * Nov 25: the owner ships this listing himself (or no longer): FBA's answer no longer holds his deals, and Amazon's FBA
   * fee estimate is not used for it. Remembered by ASIN; the report and the signals are judged again. Never beside a scan.
   */
  setSelfShip(asin: string, on: boolean): Promise<void> {
    return this.serialAnswer('A scan or a search is running. Change it when it has finished.', async () => {
      this.seller.setSelfShip(asin, on);
      await this.refresh();
    });
  }

  /** Removes a confirmed price and rebuilds the report; the part counts at its Amazon price, or at $0, again. */
  removeConfirmedPrice(key: string): Promise<void> {
    return this.serialAnswer('A scan or a search is running. Remove the price when it has finished.', async () => {
      await this.scanStore.deleteConfirmedPrice(key);
      await this.refresh();
    });
  }

  /** Approve: the verified suggestion of each question, through the owner's answer path. */
  async approve(ids: string[]): Promise<{ approved: string[]; skipped: { id: string; reason: string }[] }> {
    const out = { approved: [] as string[], skipped: [] as { id: string; reason: string }[] };
    for (const id of ids) {
      const item = await this.scanStore.getReview(id);
      const stored = item ? liveSuggestion(this.d.store.get('suggestions'), item) : undefined;
      const a = item && stored ? approvalOf(stored.suggestion, item) : null;
      if (!item || item.answer !== null) out.skipped.push({ id, reason: 'No open question with this id.' });
      else if (!a) out.skipped.push({ id, reason: 'No verified suggestion for the question as it is now.' });
      else {
        try {
          const { seen, ...rest } = a;
          await this.answer(id, rest as { choice: number }, seen, true);
          out.approved.push(id);
        } catch (err) {
          out.skipped.push({ id, reason: sentenceOf(err) });
        }
      }
    }
    return out;
  }

  /** The listing ladder, rung 2's next look in the drip (epoch ms); null before the first. */
  private autoConfirmNextAt: number | null = null;

  /**
   * The listing ladder, rung 2 (agent/autoConfirm.ts): the owner's Confirm listing click, done by the agent for the
   * listings a buy waits on or a deal within reach rests on, within today's allowance, never the reserve. Records an
   * Activity run when it read anything. Null when off, with no SerpApi key, or (in the drip) before its next look.
   */
  private async autoConfirmPass(mode: 'scan' | 'drip', usedThisScan = 0, progress?: StepProgress): Promise<AutoConfirmDone | null> {
    const { store } = this.d;
    const app = store.get('settings');
    const keys = store.get('keys');
    const now = this.d.now();
    const ext = extensionSettingsOf(app);
    // Round 2: no free account check, and no wake, while rung 2 cannot read today.
    if (!rung2CanRun({
      enabled: app.lookups?.autoVerify !== false, hasKey: Boolean(keys.serpapi), paused: store.get('agent').paused, serp: this.gateSerp(),
      reserve: ext.reserve, perDay: app.lookups?.verifySearchesPerDay, state: store.get('runtime').autoConfirm, now,
    })) return null;
    if (mode === 'drip' && this.autoConfirmNextAt !== null && now < this.autoConfirmNextAt) return null;
    const tracking = store.get('tracking');
    const runtime = store.get('runtime');
    const base = {
      store: this.scanStore, signals: tracking.signals, alerts: app.alerts, bundles: store.get('deals').bundles, state: runtime.autoConfirm,
      keepaReads: Boolean(keys.keepa) && app.settings.amazonRefreshViaKeepa,
    };
    const wanted = await autoConfirmWanted(base);
    this.autoConfirmNextAt = now + AUTO_CONFIRM_EVERY_MS;
    if (wanted.length === 0) return null;
    // Step 18: the cost blocker. The listing check's searches today (at most its daily allowance) inside his search limit.
    const perDay = app.lookups?.verifySearchesPerDay ?? 5;
    const high = Math.max(1, Math.min(wanted.length, perDay));
    if (!this.costGate('serpapi', { what: 'The listing check', held: 'was not made', expected: high, high }, mode === 'scan' ? this.costRun : `drip:${localDate(now)}`).allow) return null;
    const ledger = this.ledger(SERP_LEDGER);
    const startedAt = this.d.now();
    const stop = (): boolean => (mode === 'drip' ? !this.dripAllowed() || this.dripCtl.signal.aborted : this.stopCtl.signal.aborted);
    let done: AutoConfirmDone;
    try {
      done = await runAutoConfirm({
        ...base, ext, perDay: app.lookups?.verifySearchesPerDay ?? null, mode, usedThisScan, now: this.d.now, ...(progress ? { progress } : {}),
        saveState: (st) => store.update('runtime', (r) => ({ ...r, autoConfirm: { ...st, queue: r.autoConfirm?.queue ?? [], nextAt: r.autoConfirm?.nextAt ?? null } })),
        account: async () => {
          const a = await SerpApiClient.account(keys.serpapi!, this.d.fetchFn, this.d.serpBaseUrl);
          // Round 2: the last known account decides, without a call, whether rung 2 can read (rung2CanRun).
          this.noteAccount(a);
          return a;
        },
        verify: (t, budget) => runPaid({
          client: new SerpApiClient({ apiKey: keys.serpapi!, budget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now, baseUrl: this.d.serpBaseUrl, onSpend: (e) => ledger(e) }),
          budget, store: this.scanStore, now: this.d.now, settings: toScanSettings(ext), shouldStop: () => (stop() ? 'Stopped.' : null),
        }, { kind: 'verify', brand: t.brand, model: t.model, asin: t.asin }),
        shouldStop: stop,
      });
    } catch {
      // The account check failed: nothing was spent; the next look tries again.
      return null;
    }
    // In a scan, the scan's own run counts the searches and says the sentence; in the drip, a run of its own.
    if (done.tried.length > 0 && mode === 'drip') {
      this.record({
        id: `run-${startedAt}-confirm`, kind: 'verify', startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(this.d.now()).toISOString(),
        status: 'finished', searchesUsed: done.searches, keepaTokensUsed: 0, aiCostUsd: 0, summary: done.summary ?? '', trigger: 'scheduled',
      });
      await this.refresh();
    }
    return done;
  }

  /** Listings an automatic rung will read (AgentRuntime.autoConfirm.queue), as the last look counted them. */
  private confirmWaiting = 0;

  /**
   * The listing ladder: what the deals' words rest on. The listings the drip's catalog check (rungs 0 and 1) and rung 2
   * will really read, with the earliest next look; none when their rung is off. Saved in AgentRuntime.autoConfirm.
   */
  private async noteConfirmQueue(): Promise<void> {
    const { store } = this.d;
    const app = store.get('settings');
    const keys = store.get('keys');
    const now = this.d.now();
    const runtime = store.get('runtime');
    const ext = extensionSettingsOf(app);
    const dripOn = app.lookups?.drip !== false && Boolean(keys.keepa) && app.settings.amazonRefreshViaKeepa && !store.get('agent').paused
      && keepaCanPull(runtime.keepa, ext.keepaReserve);
    // Round 2: rung 2 is queued only when it can read today (an allowance of 0, off, or no key: not queued).
    const verifyOn = rung2CanRun({
      enabled: app.lookups?.autoVerify !== false, hasKey: Boolean(keys.serpapi), paused: store.get('agent').paused, serp: this.gateSerp(),
      reserve: ext.reserve, perDay: app.lookups?.verifySearchesPerDay, state: runtime.autoConfirm, now,
    });
    const signals = store.get('tracking').signals;
    const verify = verifyOn
      ? (await autoConfirmWanted({
          store: this.scanStore, signals, alerts: app.alerts, bundles: store.get('deals').bundles, state: runtime.autoConfirm,
          keepaReads: Boolean(keys.keepa) && app.settings.amazonRefreshViaKeepa,
        })).map((t) => t.asin)
      : [];
    const q = confirmationQueue({
      catalog: dripOn ? await checksWanted(this.scanStore) : [], dripNextAt: dripOn ? Math.max(now, this.dripNextAt ?? now) : null,
      verify, verifyNextAt: Math.max(now, this.autoConfirmNextAt ?? now), state: runtime.autoConfirm, now,
    });
    const unconfirmable = await unconfirmableOf(this.scanStore, signals, q.queue);
    this.confirmWaiting = q.queue.length;
    store.update('runtime', (r) => ({ ...r, autoConfirm: { ...(r.autoConfirm ?? { day: '', spent: 0, tried: [] }), queue: q.queue, nextAt: q.nextAt, unconfirmable } }));
  }

  /** What a Look up of a deal's unmatched parts, or a Verify of one part, would spend now: the quote the UI shows first. */
  async paidPlan(bundleKey: string, kind: 'lookUp' | 'verify', model?: string): Promise<{ action: PaidAction; searches: number }> {
    const bundle = (await this.scanStore.getBundle(bundleKey)) ?? undefined;
    const row = this.d.store.get('deals').bundles.find((b) => b.key === bundleKey);
    if (!bundle || !row) throw new AnswerRefused('No such deal.');
    if (kind === 'verify') {
      const part = row.parts.find((p) => p.model === model);
      if (!part || !part.asin) throw new AnswerRefused('That part has no listing to verify.');
      return { action: { kind: 'verify', brand: row.brand, model: part.model, asin: part.asin }, searches: 1 };
    }
    const parts = row.parts.filter((p) => p.status === 'unmatched' || p.status === 'waiting').map((p) => ({ brand: row.brand, model: p.model }));
    if (parts.length === 0) throw new AnswerRefused('Every part of this deal is looked up.');
    return { action: { kind: 'lookUp', parts }, searches: lookupsNeeded(parts, await savedAnswers(this.scanStore)) };
  }

  /** Look up or Verify, the owner's click: within the per-scan limit, and like Scan now it may spend the reserve. */
  paid(bundleKey: string, kind: 'lookUp' | 'verify', model?: string, force = false): Promise<{ searchesUsed: number; held?: string }> {
    // The slot is taken before the first await; a refusal below frees it (track).
    this.claim('paid');
    return this.track(this.afterDrip(() => this.paidClaimed(bundleKey, kind, model, force)));
  }

  private async paidClaimed(bundleKey: string, kind: 'lookUp' | 'verify', model?: string, force = false): Promise<{ searchesUsed: number; held?: string }> {
    const keys = this.d.store.get('keys');
    if (!keys.serpapi) throw new WorkRefused('Add your SerpApi key in Settings.');
    const { action, searches } = await this.paidPlan(bundleKey, kind, model);
    // Step 18: the cost blocker on the owner's click says its sentence and asks him to confirm; `force` is his yes.
    if (!force && searches > 0) {
      const d = this.costs.decide('serpapi', { what: kind === 'verify' ? 'Verify' : 'Look up', held: 'was not started', expected: searches, high: searches });
      if (!d.allow) return { searchesUsed: 0, held: `${d.reason} Confirm to spend anyway.` };
    }
    const ext = extensionSettingsOf(this.d.store.get('settings'));
    let account: AccountInfo;
    try {
      account = await SerpApiClient.account(keys.serpapi, this.d.fetchFn, this.d.serpBaseUrl);
    } catch (err) {
      throw new WorkRefused(err instanceof SerpApiError ? err.message : 'Something went wrong while checking your SerpApi account.');
    }
    const budget = new SearchBudget(account, budgetPolicyFor(ext, 'manual', 0));
    const quote = quotePaid(action, await savedAnswers(this.scanStore), budget);
    if (quote.refusal) throw new WorkRefused(quote.refusal);
    const ledger = this.ledger(SERP_LEDGER);
    const client = new SerpApiClient({ apiKey: keys.serpapi, budget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now, baseUrl: this.d.serpBaseUrl, onSpend: (e) => ledger(e) });
    const startedAt = this.d.now();
    const run: RunRecord = { id: `run-${startedAt}`, kind: kind === 'verify' ? 'verify' : 'lookup', startedAt: new Date(startedAt).toISOString(), finishedAt: null, status: 'running', searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: '', trigger: 'manual' };
    try {
      await runPaid({ client, budget, store: this.scanStore, now: this.d.now, settings: toScanSettings(ext), shouldStop: () => (this.stopCtl.signal.aborted ? 'Stopped.' : null) }, action);
      run.status = 'finished';
      run.summary = `${kind === 'verify' ? 'Verify' : 'Look up'}: ${budget.spentThisRun} ${budget.spentThisRun === 1 ? 'search' : 'searches'}.`;
      await this.refresh();
      return { searchesUsed: budget.spentThisRun };
    } catch (err) {
      run.status = 'failed';
      run.error = scrub(err instanceof PaidProblem ? err.message : sentenceOf(err), keys);
      run.summary = run.error;
      throw new WorkRefused(run.error);
    } finally {
      run.searchesUsed = budget.spentThisRun;
      run.finishedAt = new Date(this.d.now()).toISOString();
      this.record(run);
    }
  }

  // ------------------------------------------------------------------ messages

  /** The digest: one notification and, when set up, the same text on Telegram. Returns a sentence when Telegram failed. */
  private async message(report: ScanReport, job: ScanJob | null, applied: number): Promise<string | null> {
    const { store } = this.d;
    const app = store.get('settings');
    const runtime = store.get('runtime');
    const trendLines: string[] = (job?.partPriceDrops ?? []).map((d) => partPriceDropMessage(d.partModel, d.delta));
    // The watched deals worth buying now (and, when the owner asked, those that fell through the floor), each once a day.
    const tracking = store.get('tracking');
    const now = this.d.now();
    const kinds = app.alerts.marginDownDigest ? (['buyNow', 'marginDown'] as const) : (['buyNow'] as const);
    const found = app.alerts.enabled ? freshSignals(tracking, kinds, now) : { lines: [], notified: tracking.notified };
    // Keeping deals current: a Buy now whose prices are older than the stated limit is not announced (its row says so).
    const fresh = withoutStale(found, tracking.notified, staleBuyKeys({ deals: store.get('deals'), tracking }, now), now);
    // BOGO: the best choice of each promotion once a day; a pair behind its group's best is not named on its own.
    const groups = Object.values(tracking.derived.groups ?? {});
    const behind = pairsBehindBest(groups);
    const bogo = app.alerts.enabled ? bogoDigestLines(groups, app.alerts, fresh.notified, now) : { lines: [], keys: [], pairKeys: [] };
    const digest = buildDigest({
      // Nov 23: eBay identity questions are no Review question unless the owner asks for them.
      report: asksAboutEbay(app) ? report : { ...report, ebayQuestions: [] }, alerts: app.alerts, notifiedDeals: runtime.notifiedDeals, notifiedQuestions: runtime.notifiedQuestions, autopilotApplied: applied,
      verifiedWaiting: await this.verifiedWaiting(), trendLines,
      buyNow: fresh.lines.filter((l) => l.signal.kind === 'buyNow' && !behind.has(l.bundleKey)), marginDown: fresh.lines.filter((l) => l.signal.kind === 'marginDown'),
      bogoLines: bogo.lines, profitNote: profitQualifier(app.settings.fees),
    });
    store.update('runtime', (r) => ({ ...r, notifiedDeals: digest.notifiedDeals, notifiedQuestions: digest.notifiedQuestions }));
    store.update('tracking', (t) => ({ ...t, notified: [...fresh.notified, ...bogo.keys].slice(-2000), announced: announcedAfter(t.announced, fresh.lines, now) }));
    // Through the notification policy (its kinds, quiet hours and the morning digest): a deal line goes as kind 'deal'.
    const text = digest.event && digest.text ? this.policy.digest(digest.event, digest.text) : null;
    // Nov 25: what the message is about, for its buttons: the deals it names as worth buying now, the questions new to him, the scan.
    const newQuestions = app.alerts.reviewDigest ? report.review.filter((q) => q.answer === null && !runtime.notifiedQuestions.includes(q.id)).map((q) => q.id) : [];
    const buyKeys = app.alerts.enabled ? fresh.lines.filter((l) => l.signal.kind === 'buyNow' && !behind.has(l.bundleKey)).map((l) => l.bundleKey) : [];
    const about: TelegramAbout[] = [
      ...(buyKeys.length ? [{ kind: 'buyNow' as const, keys: buyKeys }] : []),
      ...(newQuestions.length ? [{ kind: 'questions' as const, ids: newQuestions }] : []),
      { kind: 'scan' },
    ];
    return this.sendTelegram(text, about);
  }

  /**
   * Nov 25: a new version is ready. One message, the same text on each channel the owner has on: the system notification (the
   * policy: its kind switch, and quiet hours hold it) and Telegram when it is set up. The "new version" kind switched off
   * means neither. Telegram's failure is the usual one (a sentence in Activity, sent again after the next run).
   */
  async announceVersion(text: string): Promise<void> {
    if (!this.d.store.get('settings').notifications.kinds.version) return;
    this.policy.send({ kind: 'version', title: 'Split Finder', body: text, route: '/today' });
    await this.sendTelegram(text);
  }

  /** Nov 25: the weekly summary, one message on each channel the owner has on: the notification's short form (its kind switch and quiet hours apply) and Telegram's full text. */
  async announceWeekly(w: WeeklySummary): Promise<void> {
    this.policy.send({ kind: 'weekly', title: 'Split Finder', body: w.short, route: '/today' });
    await this.sendTelegram(w.text);
  }

  /**
   * Nov 25: a Buy now deal whose Home Depot price ends within PRICE_ENDS_WITHIN_DAYS days is said once (per deal and end
   * date), through the same channels as a buy line: the notification policy (kind switch, quiet hours, the morning digest)
   * and Telegram, when the owner has alerts on. A deal whose prices are stale is not said (it waits for its read).
   */
  async announcePriceEnds(): Promise<number> {
    const { store } = this.d;
    if (!store.get('settings').alerts.enabled) return 0;
    const now = this.d.now();
    const data = { deals: store.get('deals'), tracking: store.get('tracking') };
    const stale = staleBuyKeys(data, now);
    const buyNow = data.deals.bundles.filter((b) => data.tracking.watch[b.key]?.watched === true && (data.tracking.signals[b.key]?.buyNow ?? null) !== null && !stale.has(b.key));
    const due = priceEndsMessages(
      buyNow.map((b) => ({ key: b.key, model: b.model || `Set ${b.itemId}`, link: b.link, price: b.price, profit: b.estimate?.profit ?? null, buying: b.buying })),
      now, data.tracking.notified,
    );
    if (due.length === 0) return 0;
    store.update('tracking', (t) => ({ ...t, notified: [...t.notified, ...due.map((m) => m.notifiedKey)].slice(-2000) }));
    due.forEach((m, i) => {
      this.record({
        id: `run-${now}-priceends-${i}`, kind: 'lookup', startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(), status: 'finished',
        searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: m.sentence, trigger: 'scheduled',
      });
    });
    const text = due.map((m) => m.sentence).join('\n');
    const sent = this.policy.digest({ kind: 'deal', title: 'Split Finder', body: text, count: due.length, route: '/' }, text);
    await this.sendTelegram(sent);
    return due.length;
  }

  /** Quiet hours ended or the morning came: the held notifications go out, and the morning digest to Telegram. */
  async flushMessages(): Promise<void> {
    const text = this.policy.flush();
    if (text) await this.sendTelegram(text);
  }

  /** The waiting Telegram messages and `text` (when there is one), in order. Returns a sentence when Telegram failed. */
  private async sendTelegram(text: string | null, about?: TelegramAbout[]): Promise<string | null> {
    const { store } = this.d;
    const tg = store.get('keys').telegram;
    const pending = store.get('runtime').telegram.pending;
    // Nov 25: a bot saved without its chat yet (the app finds it: agent/telegramBot.ts) sends nothing.
    if (!tg?.chatId?.trim() || (!text && pending.length === 0)) return null;
    const next = text ? { text, at: new Date(this.d.now()).toISOString(), ...(about?.length ? { about } : {}) } : null;
    const sent = await sendPending(this.d.fetchFn, tg, pending, next, this.telegramCompose ?? undefined);
    this.costs.count('telegram', sent.sent);
    const at = new Date(this.d.now()).toISOString();
    store.update('runtime', (r) => ({ ...r, telegram: { pending: sent.pending, lastSentAt: sent.sent > 0 ? at : r.telegram.lastSentAt, lastError: sent.error } }));
    if (!sent.error) return null;
    const sentence = `Telegram: ${sent.error} The message is sent again after the next run.`;
    this.addError(sentence, { kind: 'telegram', label: 'Send again', searches: 0, usd: 0 });
    return sentence;
  }

  /** Sends the digests still waiting for Telegram, if any, and nothing new. Returns a sentence when Telegram failed. */
  private async resendPending(): Promise<string | null> {
    const tg = this.d.store.get('keys').telegram;
    const pending = this.d.store.get('runtime').telegram.pending;
    if (!tg?.chatId?.trim() || pending.length === 0) return null;
    const sent = await sendPending(this.d.fetchFn, tg, pending, null, this.telegramCompose ?? undefined);
    this.costs.count('telegram', sent.sent);
    const at = new Date(this.d.now()).toISOString();
    this.d.store.update('runtime', (r) => ({ ...r, telegram: { pending: sent.pending, lastSentAt: sent.sent > 0 ? at : r.telegram.lastSentAt, lastError: sent.error } }));
    return sent.error ? `Telegram: ${sent.error} The message is sent again after the next run.` : null;
  }

  /** Retry from Activity: scan again, ask again, or send the waiting Telegram messages now. */
  async retry(errorId: string): Promise<void> {
    const err = (this.d.store.get('activity').errors ?? []).find((e) => e.id === errorId);
    if (!err || !err.retry) throw new AnswerRefused('Nothing to retry here.');
    if (err.retry.kind === 'scan') this.scanNow();
    else if (err.retry.kind === 'ask') this.askNow();
    else {
      const tg = this.d.store.get('keys').telegram;
      if (!tg?.chatId?.trim()) throw new WorkRefused('Add the Telegram bot token and chat id in Settings.');
      const sent = await sendPending(this.d.fetchFn, tg, this.d.store.get('runtime').telegram.pending, null, this.telegramCompose ?? undefined);
      this.d.store.update('runtime', (r) => ({ ...r, telegram: { pending: sent.pending, lastSentAt: sent.sent > 0 ? new Date(this.d.now()).toISOString() : r.telegram.lastSentAt, lastError: sent.error } }));
      if (sent.error) throw new WorkRefused(`Telegram: ${sent.error}`);
    }
    const at = new Date(this.d.now()).toISOString();
    this.d.store.update('activity', (a) => ({ ...a, errors: (a.errors ?? []).map((e) => (e.id === errorId ? { ...e, resolvedAt: at } : e)) }));
  }
}
