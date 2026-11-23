// The agent does the work (step 13, W4, Decisions 1 and 5): the schedule, the scan (core's runScan with the owner's
// keys from the store, the budget ledger and reserve in the data folder, the per-scan cap from Settings), the Home Depot
// reads through the paired Chrome (remoteReaders.ts), Keepa inside the scan (core plans discovery vs tracking per
// run), then without the owner: the eBay step (inside the scan), the AI pass on open Review questions, Autopilot, the
// digest and Telegram, and the run's record in Activity. One thing at a time: a scan, an AI pass or a Look up/Verify.
//
// Every paid call goes through core's clients: SerpAPI through SerpApiClient + SearchBudget (rule 1: a scheduled scan
// never touches the reserve; Scan now may, as in the extension), Keepa through KeepaClient + TokenBudget, models through
// pipelinesFrom. Keys come from the store and are never in a sentence this file writes (scrub).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AppSettings, AskResponse, DripState, EvidenceQuote, KeyName, LookupsRunResponse, NotifyEvent, RunRecord, ScanStartResponse } from '../core/src/api/contract';
import { keepaTokensForScan, routeAmazonWork, type KeepaRoom, type SerpRoom } from '../core/src/keepa/route';
import { lookupsSentence } from '../core/src/deals/lookupCopy';
import { gatherEvidence } from '../core/src/assist/evidence';
import { afterLead, pipelinesFrom } from '../core/src/ai/factory';
import { liveSuggestion, agreedWith, type StoredSuggestion } from '../core/src/assist/stored';
import { approvalOf } from '../core/src/assist/approve';
import { EbayClient } from '../core/src/ebay/client';
import { partPriceDropMessage } from '../core/src/keepa/alerts';
import { TokenBudget } from '../core/src/keepa/budget';
import { KeepaClient, KeepaError } from '../core/src/keepa/client';
import { keepaLookupSearchResult, keepaProductSearchResult } from '../core/src/keepa/fetchStep';
import { readPartTrend, readTrends, writePartTrend, type PartTrend } from '../core/src/keepa/trends';
import { nextRun } from '../core/src/schedule';
import { AnswerRefused, applyReviewAnswer, reviewSignature } from '../core/src/scan/answers';
import { applyEbayAnswer } from '../core/src/scan/ebayAnswers';
import { EBAY_ITEM_READS_MAX, EBAY_SEARCHES_MAX, type EbayStep, NOTICE as EBAY_NOTICE } from '../core/src/scan/ebayPass';
import { PaidProblem, lookupsNeeded, quotePaid, runPaid, savedAnswers } from '../core/src/scan/paid';
import { addSamples, pipelineOf, pipelineView, samplesOf, type PipelineView } from '../core/src/scan/pipeline';
import { postScanWork } from '../core/src/scan/postScan';
import { partRowsFor } from '../core/src/scan/report';
import { bogoFromBody, bogoView, freeParts, type BogoView } from '../core/src/tracking/bogo';
import {
  bogoDigestLines, bogoGroups, mergeBogoPairs, pairBundleRecord, pairFacts, pairsBehindBest, readBogoPass, todayOf, type BogoBrandResult, type BogoGroup,
} from '../core/src/tracking/bogoPairs';
import { fbaEstimateOf, type FbaEstimate } from '../core/src/tracking/fba';
import type { TrendLookup } from '../core/src/tracking/signals';
import { freshSignals, trackReport } from '../core/src/tracking/state';
import {
  keepaLookupOne, type LookupStep, pageRead, PART_PRICE_MS, plannedWork, readKitPagesFor, readPartPricesFor, runScan, settleWaitingSplits, withdrawUnreadSplitQuestions,
} from '../core/src/scan/runner';
import { knownModels } from '../core/src/scan/split';
import { KEEPA_LOOKUP_TOKEN_ESTIMATE, KEEPA_SEARCH_TOKEN_ESTIMATE } from '../core/src/keepa/estimates';
import type { ConfirmedPrice, PaidAction, ReviewAnswer, ReviewItem, ScanJob, ScanReport, ScanStore } from '../core/src/scan/types';
import { type AccountInfo, SearchBudget } from '../core/src/serpapi/budget';
import { type LedgerEntry, SerpApiClient, SerpApiError } from '../core/src/serpapi/client';
import {
  BRAND_QUERIES, budgetPolicyFor, estimatedJudgeCost, type ExtensionSettings, type ScanTrigger, toScanSettings, validateSettings,
} from '../core/src/settings';
import { runAiPass, askOneWith, type AiPassResult } from './aiPass';
import { backfillBriefs, type BriefCtx, briefAfterKeep } from './brief';
import { catalogSentence } from '../core/src/scan/catalogCheck';
import { buyWaitsOn, checksWaiting, checksWanted, repickUnconfirmed, verifyMatchesWithKeepa } from './verifyMatches';
import { autoConfirmWanted, confirmationQueue, keepaCanPull, repickTargets, rung2CanRun, runAutoConfirm, unconfirmableOf, type AutoConfirmDone } from './autoConfirm';
import { evaluateSignals, pullKeepingTrends, pullSales, pullsWanted, reportWithTrends, type SignalsDeps } from './signalsPass';
import { averagePullsWanted, pullAverages } from './suggestPrices';
import { forgetFact, markNotSold, rememberAnswer, type Remembered } from '../core/src/facts/apply';
import type { FactField } from '../core/src/facts/fact';
import { freshFollowUp } from '../core/src/research/followUp';
import { askPlan, followUpPass } from './followUp';
import { reverifyPass, wantedReads, withEvidenceKey } from './reverify';
import { buildDigest, sendPending } from './alerts';
import { scrubKeyText } from './keyChecks';
import { NotifyPolicy } from './notifyPolicy';
import { applyAutopilot, autopilotDecision, undoAutopilot } from './autopilot';
import { answerText, footprintOf, type Footprint, KEEP_OWNER_ANSWERS, restorable, undoOwnerAnswer } from './ownerAnswers';
import { remoteReaders, type ReaderTimeouts, type RemoteReaders } from './remoteReaders';
import { bundleListsOf, discoveryFor, discoveryNote, scheduledScanWaits } from './scanSource';
import { DirCache, FileScanStore } from './scanStore';
import type { ActivityErrorRecord, Store, StoredAutopilotEntry, StoredKeys, StoredOwnerAnswer } from './store';
import { aiSpentThisMonth, asksAboutEbay } from './views';
import type { WorkerJobs } from './workerJobs';

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
 * read — Read again (free)." when every bundle without an estimate waits for its page; else how many wait.
 */
export function outcomeSentence(report: ScanReport): string {
  const n = report.bundles.length;
  const estimated = report.bundles.filter((b) => b.estimate !== null).length;
  const waiting = report.bundles.filter((b) => b.waitingPage === true).length;
  const found = `Found ${n} ${n === 1 ? 'bundle' : 'bundles'}; ${estimated} estimated`;
  if (waiting === 0) return `${found}.`;
  if (waiting === n - estimated) return `${found} because ${waiting === 1 ? 'its Home Depot page was' : 'their Home Depot pages were'} not read — Read again (free).`;
  return `${found}; ${waiting} ${waiting === 1 ? 'waits for its' : 'wait for their'} Home Depot ${waiting === 1 ? 'page' : 'pages'} — Read again (free).`;
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
  return [keys.serpapi, keys.keepa, keys.anthropic, keys.openai, keys.ebay?.appId, keys.ebay?.certId, keys.telegram?.botToken].filter(
    (k): k is string => typeof k === 'string' && k.length >= 4,
  );
}

export function scrub(text: string, keys: StoredKeys): string {
  let out = text;
  for (const k of secretsOf(keys)) out = out.split(k).join('[key]');
  return out;
}

const sentenceOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'Something went wrong.');

/** Step 15: Look up all's search cap: the per-scan cap, or `maxSearches` when that is lower. */
function lookupsCap(ext: ExtensionSettings, maxSearches: number | undefined): ExtensionSettings {
  return maxSearches === undefined ? ext : { ...ext, searchesPerScan: Math.min(ext.searchesPerScan, Math.max(0, Math.floor(maxSearches))) };
}

export class AgentWork {
  readonly scanStore: ScanStore;
  readonly cache: DirCache;
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

  constructor(deps: WorkDeps) {
    this.d = deps;
    this.policy = new NotifyPolicy({ settings: () => deps.store.get('settings').notifications, now: deps.now, emit: deps.notify });
    mkdirSync(deps.dataDir, { recursive: true });
    this.scanStore = new FileScanStore(join(deps.dataDir, 'scan'));
    this.cache = new DirCache(join(deps.dataDir, 'cache'));
    this.dealsAtStart = deps.store.get('deals').bundles.length > 0;
  }

  // ------------------------------------------------------------------ signals round 2: buy signals between scans

  /** Whether the store held deals when the agent started: only then does the start rebuild them and judge their signals. */
  private readonly dealsAtStart: boolean;

  private signalsDeps(): SignalsDeps {
    return {
      store: this.d.store, cache: this.cache, now: this.d.now, policy: this.policy,
      telegram: async (text) => {
        await this.sendTelegram(text);
      },
      keepa: () => {
        const app = this.d.store.get('settings');
        return Boolean(this.d.store.get('keys').keepa) && app.settings.amazonRefreshViaKeepa && app.lookups?.drip !== false;
      },
      flatFee: () => this.d.store.get('settings').settings.fees.fulfillmentFee,
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
  private async afterChange(report: ScanReport, extra?: { text: string; count: number }): Promise<void> {
    if (this.live.busy === 'scan') return;
    try {
      await evaluateSignals(this.signalsDeps(), report, extra);
    } catch (err) {
      this.addError(`Buy signals could not be judged: ${scrub(sentenceOf(err), this.d.store.get('keys'))}`, null);
    }
  }

  /**
   * Signals round 2, at start: the deals rebuilt with what is stored now (the fee settings, Keepa's FBA fees) and their
   * signals judged, so an estimate made after the last scan (by the drip, before a restart) is judged too. Nothing is
   * fetched. Only when the store held deals at start.
   */
  async signalsAtStart(): Promise<void> {
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
    this.timer = setInterval(() => {
      void this.tick();
      void this.flushMessages();
    }, TICK_MS);
    this.timer.unref?.();
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
    if (this.live.busy || this.answering > 0 || this.d.store.get('agent').paused) return false;
    const next = this.nextScanAt();
    if (next === null || Date.parse(next) > this.d.now()) {
      // Step 15: nothing else runs, so the drip may look up a waiting part with Keepa.
      void this.drip().catch(() => {});
      return false;
    }
    // Free scan: with Chrome closed a scheduled scan waits for it (unless the owner let SerpApi find the bundles then).
    if (scheduledScanWaits(this.d.store.get('settings'), this.d.helperConnected())) {
      void this.drip().catch(() => {});
      return false;
    }
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
    this.live.searchesUsed = 0;
    this.stopCtl = new AbortController();
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
  private dripRun: { record: RunRecord; startedAt: number; looked: number; matched: number; none: number; review: number; verified: number; removed: number; sales: number } | null = null;

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
    if (this.dripping || !this.dripAllowed()) return;
    if (this.dripNextAt !== null && this.d.now() < this.dripNextAt) return;
    this.dripCtl = new AbortController();
    // The listing ladder, rung 2: after the round's catalog check, the listings it left unconfirmed (agent/autoConfirm.ts).
    this.dripping = this.dripRound().then(() => this.autoConfirmPass('drip')).then(() => this.noteConfirmQueue()).finally(() => {
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
    let prices = await this.dripPartPrices(settings);
    // Nov 23: then the pages of the kits with no Amazon listing for sale, so their items join the lookups below.
    prices += await this.dripKitPages();
    if (prices > 0) {
      const settled = await settleWaitingSplits(this.scanStore, this.d.now());
      prices += settled.resolved + settled.opened + (await this.recheck());
    }
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
    if ((work.lookups.length === 0 && checks === 0 && sales === 0 && repicks.length === 0) || !keys.keepa) {
      if (prices > 0) await this.refresh();
      return;
    }
    const budget = new TokenBudget({ reserve: ext.keepaReserve, maxPerRun: Number.POSITIVE_INFINITY });
    const keepa = this.keepaClient(keys.keepa, budget);
    store.update('runtime', (r) => ({ ...r, drip: { checkedAt: now, lastLookupAt: r.drip?.lastLookupAt ?? null } }));
    const status = await this.keepaStatus(keepa);
    if (status === null) {
      if (prices > 0) await this.refresh();
      return;
    }
    const before = this.estimatedKeys();
    const catalog = (await knownModels(this.scanStore)).catalog;
    const done = { looked: 0, matched: 0, none: 0, review: 0, tokens: 0, verified: 0, removed: 0, sales: 0 };
    // Signals round 2: every product pull keeps its Keepa trend (sales, FBA fee), as a scan's refresh does.
    const product = pullKeepingTrends(this.cache, (asin, label, maxAgeMs) => keepaProductSearchResult(keepa, asin, { label, maxAgeMs, trackingDepth: ext.trackingDepth }));
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
          keepaLookup: (brand, model, label) => keepaLookupSearchResult(keepa, `${brand} ${model}`, { label }),
          keepaProduct: product,
        }, step);
      } catch (err) {
        // A refusal or a network error: the part keeps waiting; the next look is after DRIP_POLL_MS.
        if (err instanceof KeepaError && err.status === 401) this.keyProblem('keepa', err.message);
        break;
      }
      if (out.status === 'refused') break;
      done.looked += 1;
      done.tokens += out.tokens;
      done.verified += out.verified ?? 0;
      done.removed += out.removed ?? 0;
      if (out.status === 'matched') done.matched += 1;
      else if (out.status === 'review') done.review += 1;
      else done.none += 1;
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
    if (done.looked === 0 && done.verified === 0 && done.removed === 0 && done.sales === 0) {
      if (prices > 0 || done.tokens > 0) await this.refresh();
      return;
    }
    const report = await this.rebuild();
    this.dripFeesWaiting = (await this.feesWanted(settings.freshnessMs)).length;
    this.dripRecord(done);
    const fresh = [...this.estimatedKeys()].filter((k) => !before.has(k)).length;
    const text = `Keepa lookups between scans gave ${fresh} new ${fresh === 1 ? 'estimate' : 'estimates'} (from your fee settings, not your real fees).`;
    // Signals round 2: the new estimates' buy signals go in the same message.
    await this.afterChange(report, fresh > 0 ? { text, count: fresh } : undefined);
  }

  /** Step 15: the free Home Depot part prices a scan left, read in the paired Chrome while nothing else runs. Returns how many were saved. */
  private async dripPartPrices(settings: ReturnType<typeof toScanSettings>): Promise<number> {
    if (!this.d.helperConnected()) return 0;
    const signal = this.dripCtl.signal;
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => signal });
    try {
      const out = await readPartPricesFor({
        store: this.scanStore, settings, readPartPrices: readers.readPartPrices, now: this.d.now, maxMs: PART_PRICE_MS, waiting: true,
        extra: await wantedReads(this.scanStore, this.d.store.get('suggestions')),
        shouldStop: () => signal.aborted || !this.dripAllowed(),
      });
      return out.saved;
    } catch {
      // A read Chrome could not make: the parts are asked for again next time.
      return 0;
    }
  }

  /** Nov 23: the free Home Depot pages of kits that do not sell whole (runner.ts readKitPagesFor). Returns how many were saved. */
  private async dripKitPages(): Promise<number> {
    if (!this.d.helperConnected()) return 0;
    const signal = this.dripCtl.signal;
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => signal });
    try {
      return await readKitPagesFor({ store: this.scanStore, readPages: readers.readPages, now: this.d.now, shouldStop: () => signal.aborted || !this.dripAllowed() });
    } catch {
      // A page Chrome could not read: asked for again next time.
      return 0;
    }
  }

  /** The deals with an estimate now, by key. */
  private estimatedKeys(): Set<string> {
    return new Set(this.d.store.get('deals').bundles.filter((b) => b.estimate !== null).map((b) => b.key));
  }

  /**
   * One Activity run an hour of drip: "Looked up 6 parts with Keepa: 4 matched, 2 no Amazon listing." and, from the catalog
   * check, "Verified 6 listings from Amazon's catalog; 1 did not match and was removed."
   */
  private dripRecord(done: { looked: number; matched: number; none: number; review: number; tokens: number; verified: number; removed: number; sales: number }): void {
    const now = this.d.now();
    if (!this.dripRun || now - this.dripRun.startedAt >= DRIP_RUN_MS) {
      const record: RunRecord = {
        id: `run-${now}-drip`, kind: 'lookup', startedAt: new Date(now).toISOString(), finishedAt: null, status: 'finished', searchesUsed: 0, keepaTokensUsed: 0,
        aiCostUsd: 0, summary: '', trigger: 'scheduled',
      };
      this.dripRun = { record, startedAt: now, looked: 0, matched: 0, none: 0, review: 0, verified: 0, removed: 0, sales: 0 };
    }
    const r = this.dripRun;
    r.looked += done.looked;
    r.matched += done.matched;
    r.none += done.none;
    r.review += done.review;
    r.verified += done.verified;
    r.removed += done.removed;
    r.sales += done.sales;
    r.record.keepaTokensUsed += done.tokens;
    r.record.finishedAt = new Date(now).toISOString();
    const parts = [`${r.matched} matched`, ...(r.none > 0 ? [`${r.none} no Amazon listing`] : []), ...(r.review > 0 ? [`${r.review} to review`] : [])];
    const looked = r.looked > 0 ? `Looked up ${r.looked} ${r.looked === 1 ? 'part' : 'parts'} with Keepa: ${parts.join(', ')}.` : null;
    const sales = r.sales > 0 ? `Read sales figures for ${r.sales} ${r.sales === 1 ? 'listing' : 'listings'} from Keepa.` : null;
    r.record.summary = [looked, catalogSentence(r.verified, r.removed), sales].filter(Boolean).join(' ');
    this.record({ ...r.record });
  }

  // ------------------------------------------------------------------ the run

  private record(run: RunRecord): void {
    this.d.store.update('activity', (a) => ({ ...a, runs: [...a.runs.filter((r) => r.id !== run.id), run].slice(-KEEP_RUNS) }));
  }

  private addError(sentence: string, retry: ActivityErrorRecord['retry']): void {
    const at = new Date(this.d.now()).toISOString();
    const rec: ActivityErrorRecord = { id: `err-${this.d.now()}-${Math.random().toString(36).slice(2, 8)}`, at, sentence, retry, resolvedAt: null };
    this.d.store.update('activity', (a) => ({ ...a, errors: [...(a.errors ?? []), rec].slice(-KEEP_ERRORS) }));
  }

  private ledger(file: string) {
    return (entry: unknown) => {
      try {
        appendFileSync(join(this.d.dataDir, file), `${JSON.stringify(entry)}\n`);
      } catch {
        // The account check is the budget's truth; the ledger is the record.
      }
    };
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
          self.live.pipeline = pipelineView(job, self.d.store.get('runtime').rates, now, { unknown: '' });
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
  async lookUpAll(maxSearches?: number): Promise<LookupsRunResponse> {
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
      serp = new SearchBudget(account, budgetPolicyFor(lookupsCap(ext, maxSearches), 'manual', 0));
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
    try {
      this.begin('scan', () => this.scan('manual', undefined, { maxSearches }));
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
  private async scan(trigger: ScanTrigger, again?: { usedBefore: number }, lookups?: { maxSearches?: number }): Promise<void> {
    const { store } = this.d;
    const startedAt = this.d.now();
    const run: RunRecord = {
      id: `run-${startedAt}`, kind: 'scan', startedAt: new Date(startedAt).toISOString(), finishedAt: null, status: 'running',
      searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: 'Scanning.', trigger, stopReason: null, error: null,
    };
    this.record(run);
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
      run.steps = pipelineView(job, store.get('runtime').rates, this.d.now(), { unknown: '' }).steps;
      // Free scan: each bundle list read in Chrome, with an empty one's sample of its state, in the run's details.
      const lists = bundleListsOf(job);
      if (lists.length > 0) run.bundleLists = lists;
      const judge = pipelineOf(job).find((p) => p.id === 'judge');
      run.judgeCostUsd = judge?.costSoFar ?? 0;
      this.notedEbayKeys(job);
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
      report = (await postScanWork({ store: this.scanStore, settings: toScanSettings(extensionSettingsOf(settings)), cache: this.cache, now: this.d.now })).report;
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
      const tg = await this.resendPending();
      if (tg) notes.push(tg);
    } else if (report && lookups) {
      // Look up all spends no AI: the new matches are published and the digest says what is new.
      await this.publish(report);
      await this.trackScan(report);
      const tg = await this.message(report, job, 0);
      if (tg) notes.push(tg);
    } else if (report && !this.stopCtl.signal.aborted) {
      ai = await this.aiPass();
      if (ai.problem) notes.push(ai.problem);
      if (ai.waitingForChrome > 0) notes.push(`${ai.waitingForChrome} split ${ai.waitingForChrome === 1 ? 'question waits' : 'questions wait'} for Chrome.`);
      applied = await this.autopilot();
      if (applied > 0 || ai.asked > 0) report = await reportWithTrends(this.scanStore, toScanSettings(extensionSettingsOf(store.get('settings'))), this.cache);
      await this.publish(report);
      await this.trackScan(report);
      // The listing ladder, rung 2: within what the scan's cap leaves, the listings its catalog check left unconfirmed.
      const auto = await this.autoConfirmPass('scan', (again?.usedBefore ?? 0) + run.searchesUsed);
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
    }

    run.aiCostUsd = Math.round(((run.judgeCostUsd ?? 0) + (ai?.costUsd ?? 0)) * 10_000) / 10_000;
    run.questionsAsked = ai?.asked ?? 0;
    run.autopilotApplied = applied;
    run.finishedAt = new Date(this.d.now()).toISOString();
    // Nov 23: the bundles whose own Home Depot page is still not read, for Read again.
    const pagesUnread = (await this.scanStore.listBundles().catch(() => [])).filter((b) => !pageRead(b)).length;
    run.summary = `${lookups ? 'Look up all. ' : ''}${this.summaryOf(report, run, notes, again !== undefined, job)}`;
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
  private summaryOf(report: ScanReport | null, run: RunRecord, notes: string[], again = false, job: ScanJob | null = null): string {
    const parts: string[] = [];
    if (again) parts.push('Read again.');
    if (report) parts.push(outcomeSentence(report));
    // Step 15: what the lookups did and the real cause of any that wait ("12 Amazon lookups wait for Keepa tokens ...").
    if (job?.lookupsVia) {
      const via = job.lookupsVia;
      const sentence = lookupsSentence({
        waiting: job.lookupsWaiting ?? 0, keepa: via.keepa, serpapi: via.serpapi, blockedBy: job.lookupsBlockedBy, refillPerMin: this.d.store.get('runtime').keepa?.refillRate ?? null,
      });
      if (sentence) parts.push(sentence);
    }
    const verified = job ? catalogSentence(job.matchesVerified ?? 0, job.matchesRemoved ?? 0) : null;
    if (verified) parts.push(verified);
    if (run.searchesUsed > 0 || run.status !== 'failed') parts.push(`${run.searchesUsed} ${run.searchesUsed === 1 ? 'search' : 'searches'}.`);
    if (run.questionsAsked) parts.push(`AI asked about ${run.questionsAsked}.`);
    if (run.autopilotApplied) parts.push(`Autopilot applied ${run.autopilotApplied}.`);
    if (run.error) parts.push(run.error);
    return [...parts, ...notes].join(' ');
  }

  private async runTheScan(trigger: ScanTrigger, keys: StoredKeys, notes: string[], again?: { usedBefore: number }, lookups?: { maxSearches?: number }): Promise<ScanJob> {
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
    const at = new Date(this.d.now()).toISOString();
    store.update('runtime', (r) => ({ ...r, serp: { left: account.totalSearchesLeft, perMonth: account.searchesPerMonth, rateLimitPerHour: account.rateLimitPerHour, at } }));

    const newest = (await this.scanStore.listScans())[0];
    const continued = newest?.status === 'running' ? newest : undefined;
    const budget = new SearchBudget(account, budgetPolicyFor(lookups ? lookupsCap(ext, lookups.maxSearches) : ext, trigger, again ? again.usedBefore + (continued?.searchesUsed ?? 0) : continued?.searchesUsed ?? 0));
    const serpLedger = this.ledger('serpapi-ledger.jsonl');
    const client = new SerpApiClient({
      apiKey: keys.serpapi, budget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now, baseUrl: this.d.serpBaseUrl,
      onSpend: (e: LedgerEntry) => serpLedger(e),
    });
    const keepa = await this.keepaDeps(ext, keys, notes);
    const connected = !lookups && this.d.helperConnected();
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal });
    if (lookups) {
      // Look up all reads nothing in Chrome.
    } else if (!connected) notes.push('Chrome is closed, so Home Depot pages wait for the next scan.');
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
      app, trigger, chromeConnected: connected, serpCanPay: budget.blockReason(1) === null,
      keepaCanLookUp: Boolean(keepa.keepaLookup) && keepa.keepaScale?.tokensLeft != null, settings: scanSettings, readers,
    });
    if (discovery?.note) notes.push(discovery.note);
    const job = await scan({
      bogoPairs, partPricesExtra, catalogFirst: [...buyWaitsOn(store.get('tracking'))],
      // Nov 23: a bundle whose own page is not read waits for it (waiting_page); it is never a question before then.
      waitForPages: true,
      client, budget, store: this.watched(this.scanStore), settings: discovery?.settings ?? scanSettings, now: this.d.now, labelPrefix: 'agent',
      ...(discovery?.chromeListing ? { chromeListing: discovery.chromeListing } : {}),
      shouldStop: () => this.stopCtl.signal.aborted,
      ...(connected ? { readPages: readers.readPages, readPartPrices: readers.readPartPrices } : { noReaderReason: lookups ? 'not in this run' : 'Chrome closed' }),
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
    const short = results.filter((r) => !r.complete && r.problem !== 'stopped');
    if (short.length > 0) notes.push(`BOGO: ${short.map((r) => r.brand).join(' and ')} not read in full (${short[0]!.problem}); the pairs found before are kept.`);
  }

  /** Step 15: a Keepa client on the owner's key whose every answer keeps the balance and refill in runtime.keepa. */
  private keepaClient(key: string, budget: TokenBudget): KeepaClient {
    const ledger = this.ledger('keepa-ledger.jsonl');
    return new KeepaClient({
      apiKey: key, budget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now,
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
    const keepaBudget = new TokenBudget({ reserve: s.keepaReserve, maxPerRun: s.keepaTokensPerScan > 0 ? s.keepaTokensPerScan : Number.POSITIVE_INFINITY });
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
      keepaLookup: (brand: string, model: string, label: string) => keepaLookupSearchResult(keepa, `${brand} ${model}`, { label }),
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
    if (spent + estimate > app.ai.monthlyCapUsd) {
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
    this.d.store.update('tracking', (t) => ({ ...t, ...trackReport(t, report, trend, alerts, now, { keepa: opts.keepa(), flatFee: opts.flatFee!() }) }));
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

  private async aiPass(only?: string[], force?: string[]): Promise<AiPassResult> {
    const { store } = this.d;
    const app = store.get('settings');
    const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn });
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal });
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
    const pass = await runAiPass({
      store: this.scanStore,
      suggestions: () => store.get('suggestions'),
      keep: (r) => store.update('suggestions', (all) => [...all.filter((x) => x.key !== r.key), r]),
      afterKeep: briefAfterKeep(this.briefCtx()),
      models: { assist: model(pipelines.assist), research: model(pipelines.research) },
      askOne,
      chromeConnected: this.d.helperConnected,
      spentUsd: aiSpentThisMonth({ suggestions: store.get('suggestions'), runs: store.get('activity').runs }, this.d.now()),
      capUsd: app.ai.monthlyCapUsd,
      signal: this.stopCtl.signal,
      now: this.d.now,
      ...(only ? { only } : {}),
      ...(force && force.length > 0 ? { force } : {}),
    });
    // Step 16: the follow-up loop (agent/followUp.ts; it took over lever 2's re-ask) for the answers still not settled: the free
    // reads and the code's check always, follow-up asks only when the owner's setting allows them. Not after the owner's own ask.
    if (only || this.stopCtl.signal.aborted) return pass;
    const f = await this.followUps(app.ai.reaskOnNewEvidence === true);
    return { ...pass, asked: pass.asked + f.asked, verified: pass.verified + f.verified, costUsd: pass.costUsd + f.costUsd, problem: pass.problem ?? (f.ran > 0 ? f.problem : null) };
  }

  /** Step 16: the follow-up loop over the open questions (or `only`), with the Chrome tools and the research model. */
  private async followUps(allowAsk: boolean, only?: string[]) {
    const { store } = this.d;
    const app = store.get('settings');
    const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn });
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal });
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
        capUsd: app.ai.monthlyCapUsd,
        signal: this.stopCtl.signal,
        now: this.d.now,
        afterKeep: briefAfterKeep(this.briefCtx()),
        // Step 16 (round 2): a question the AI has not answered gets its free reads too; their state is kept in Review.
        questionState: {
          get: (id) => store.get('review').followUps?.[id],
          put: (id, seen, state) => store.update('review', (r) => ({ ...r, followUps: { ...(r.followUps ?? {}), [id]: { seen, state } } })),
        },
        ...(only ? { only } : {}),
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
    return { store: this.d.store, scanStore: this.scanStore, keyFor: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn, now: this.d.now, signal: this.stopCtl.signal };
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
    if (ids.length > 0) await this.refresh();
    return ids.length;
  }

  /**
   * The report rebuilt from the scan's store, for the app (after an answer, an undo, a Look up), with the stored Keepa
   * trends (each part's FBA fee). Signals round 2: then the signals judged again, with `extra` in the same message.
   */
  async refresh(extra?: { text: string; count: number }): Promise<void> {
    await this.afterChange(await this.rebuild(), extra);
  }

  /** The report rebuilt and published, without judging signals. */
  private async rebuild(): Promise<ScanReport> {
    const report = await reportWithTrends(this.scanStore, toScanSettings(extensionSettingsOf(this.d.store.get('settings'))), this.cache);
    await this.publish(report);
    return report;
  }

  /** Ask AI now, about one question or every open one (the app's buttons). Runs in the background. */
  askNow(only?: string[], force?: string[]): void {
    this.begin('ask', async () => {
      const startedAt = this.d.now();
      const run: RunRecord = { id: `run-${startedAt}`, kind: 'ask', startedAt: new Date(startedAt).toISOString(), finishedAt: null, status: 'running', searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: 'Asking the AI.', trigger: 'manual' };
      this.record(run);
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
  private async autoConfirmPass(mode: 'scan' | 'drip', usedThisScan = 0): Promise<AutoConfirmDone | null> {
    const { store } = this.d;
    const app = store.get('settings');
    const keys = store.get('keys');
    const now = this.d.now();
    const ext = extensionSettingsOf(app);
    // Round 2: no free account check, and no wake, while rung 2 cannot read today.
    if (!rung2CanRun({
      enabled: app.lookups?.autoVerify !== false, hasKey: Boolean(keys.serpapi), paused: store.get('agent').paused, serp: store.get('runtime').serp,
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
    const ledger = this.ledger('serpapi-ledger.jsonl');
    const startedAt = this.d.now();
    const stop = (): boolean => (mode === 'drip' ? !this.dripAllowed() || this.dripCtl.signal.aborted : this.stopCtl.signal.aborted);
    let done: AutoConfirmDone;
    try {
      done = await runAutoConfirm({
        ...base, ext, perDay: app.lookups?.verifySearchesPerDay ?? null, mode, usedThisScan, now: this.d.now,
        saveState: (st) => store.update('runtime', (r) => ({ ...r, autoConfirm: { ...st, queue: r.autoConfirm?.queue ?? [], nextAt: r.autoConfirm?.nextAt ?? null } })),
        account: async () => {
          const a = await SerpApiClient.account(keys.serpapi!, this.d.fetchFn, this.d.serpBaseUrl);
          // Round 2: the last known account decides, without a call, whether rung 2 can read (rung2CanRun).
          store.update('runtime', (r) => ({ ...r, serp: { left: a.totalSearchesLeft, perMonth: a.searchesPerMonth, rateLimitPerHour: a.rateLimitPerHour, at: new Date(this.d.now()).toISOString() } }));
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
      enabled: app.lookups?.autoVerify !== false, hasKey: Boolean(keys.serpapi), paused: store.get('agent').paused, serp: runtime.serp,
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
  paid(bundleKey: string, kind: 'lookUp' | 'verify', model?: string): Promise<{ searchesUsed: number }> {
    // The slot is taken before the first await; a refusal below frees it (track).
    this.claim('paid');
    return this.track(this.afterDrip(() => this.paidClaimed(bundleKey, kind, model)));
  }

  private async paidClaimed(bundleKey: string, kind: 'lookUp' | 'verify', model?: string): Promise<{ searchesUsed: number }> {
    const keys = this.d.store.get('keys');
    if (!keys.serpapi) throw new WorkRefused('Add your SerpApi key in Settings.');
    const { action } = await this.paidPlan(bundleKey, kind, model);
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
    const ledger = this.ledger('serpapi-ledger.jsonl');
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
    const fresh = app.alerts.enabled ? freshSignals(tracking, kinds, now) : { lines: [], notified: tracking.notified };
    // BOGO: the best choice of each promotion once a day; a pair behind its group's best is not named on its own.
    const groups = Object.values(tracking.derived.groups ?? {});
    const behind = pairsBehindBest(groups);
    const bogo = app.alerts.enabled ? bogoDigestLines(groups, app.alerts, fresh.notified, now) : { lines: [], keys: [], pairKeys: [] };
    const digest = buildDigest({
      // Nov 23: eBay identity questions are no Review question unless the owner asks for them.
      report: asksAboutEbay(app) ? report : { ...report, ebayQuestions: [] }, alerts: app.alerts, notifiedDeals: runtime.notifiedDeals, notifiedQuestions: runtime.notifiedQuestions, autopilotApplied: applied,
      verifiedWaiting: await this.verifiedWaiting(), trendLines,
      buyNow: fresh.lines.filter((l) => l.signal.kind === 'buyNow' && !behind.has(l.bundleKey)), marginDown: fresh.lines.filter((l) => l.signal.kind === 'marginDown'),
      bogoLines: bogo.lines,
    });
    store.update('runtime', (r) => ({ ...r, notifiedDeals: digest.notifiedDeals, notifiedQuestions: digest.notifiedQuestions }));
    store.update('tracking', (t) => ({ ...t, notified: [...fresh.notified, ...bogo.keys].slice(-2000) }));
    // Through the notification policy (its kinds, quiet hours and the morning digest): a deal line goes as kind 'deal'.
    const text = digest.event && digest.text ? this.policy.digest(digest.event, digest.text) : null;
    return this.sendTelegram(text);
  }

  /** Quiet hours ended or the morning came: the held notifications go out, and the morning digest to Telegram. */
  async flushMessages(): Promise<void> {
    const text = this.policy.flush();
    if (text) await this.sendTelegram(text);
  }

  /** The waiting Telegram messages and `text` (when there is one), in order. Returns a sentence when Telegram failed. */
  private async sendTelegram(text: string | null): Promise<string | null> {
    const { store } = this.d;
    const tg = store.get('keys').telegram;
    const pending = store.get('runtime').telegram.pending;
    if (!tg || (!text && pending.length === 0)) return null;
    const sent = await sendPending(this.d.fetchFn, tg, pending, text ? { text, at: new Date(this.d.now()).toISOString() } : null);
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
    if (!tg || pending.length === 0) return null;
    const sent = await sendPending(this.d.fetchFn, tg, pending, null);
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
      if (!tg) throw new WorkRefused('Add the Telegram bot token and chat id in Settings.');
      const sent = await sendPending(this.d.fetchFn, tg, this.d.store.get('runtime').telegram.pending, null);
      this.d.store.update('runtime', (r) => ({ ...r, telegram: { pending: sent.pending, lastSentAt: sent.sent > 0 ? new Date(this.d.now()).toISOString() : r.telegram.lastSentAt, lastError: sent.error } }));
      if (sent.error) throw new WorkRefused(`Telegram: ${sent.error}`);
    }
    const at = new Date(this.d.now()).toISOString();
    this.d.store.update('activity', (a) => ({ ...a, errors: (a.errors ?? []).map((e) => (e.id === errorId ? { ...e, resolvedAt: at } : e)) }));
  }
}
