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

import type { AppSettings, EvidenceQuote, NotifyEvent, RunRecord, ScanStartResponse } from '../core/src/api/contract';
import { gatherEvidence } from '../core/src/assist/evidence';
import { afterLead, pipelinesFrom } from '../core/src/ai/factory';
import { liveSuggestion, agreedWith, type StoredSuggestion } from '../core/src/assist/stored';
import { approvalOf } from '../core/src/assist/approve';
import { EbayClient } from '../core/src/ebay/client';
import { partPriceDropMessage } from '../core/src/keepa/alerts';
import { TokenBudget } from '../core/src/keepa/budget';
import { KeepaClient } from '../core/src/keepa/client';
import { keepaLookupSearchResult, keepaProductSearchResult } from '../core/src/keepa/fetchStep';
import { readPartTrend, writePartTrend, type PartTrend } from '../core/src/keepa/trends';
import { nextRun } from '../core/src/schedule';
import { AnswerRefused, applyReviewAnswer, reviewSignature } from '../core/src/scan/answers';
import { applyEbayAnswer } from '../core/src/scan/ebayAnswers';
import { EBAY_ITEM_READS_MAX, EBAY_SEARCHES_MAX, type EbayStep } from '../core/src/scan/ebayPass';
import { PaidProblem, lookupsNeeded, quotePaid, runPaid, savedAnswers } from '../core/src/scan/paid';
import { addSamples, pipelineOf, pipelineView, samplesOf, type PipelineView } from '../core/src/scan/pipeline';
import { postScanWork } from '../core/src/scan/postScan';
import { buildReport, partRowsFor } from '../core/src/scan/report';
import { bogoFromBody, bogoView, freeParts, type BogoView } from '../core/src/tracking/bogo';
import {
  bogoDigestLines, bogoGroups, mergeBogoPairs, pairBundleRecord, pairFacts, pairsBehindBest, readBogoPass, todayOf, type BogoBrandResult, type BogoGroup,
} from '../core/src/tracking/bogoPairs';
import { fbaEstimateOf, type FbaEstimate } from '../core/src/tracking/fba';
import type { TrendLookup } from '../core/src/tracking/signals';
import { freshSignals, trackReport } from '../core/src/tracking/state';
import { pageRead, runScan, withdrawUnreadSplitQuestions } from '../core/src/scan/runner';
import type { ConfirmedPrice, PaidAction, ReviewAnswer, ScanJob, ScanReport, ScanStore } from '../core/src/scan/types';
import { type AccountInfo, SearchBudget } from '../core/src/serpapi/budget';
import { type LedgerEntry, SerpApiClient, SerpApiError } from '../core/src/serpapi/client';
import {
  BRAND_QUERIES, budgetPolicyFor, estimatedJudgeCost, type ExtensionSettings, type ScanTrigger, toScanSettings, validateSettings,
} from '../core/src/settings';
import { runAiPass, askOneWith, type AiPassResult } from './aiPass';
import { buildDigest, sendPending } from './alerts';
import { NotifyPolicy } from './notifyPolicy';
import { applyAutopilot, autopilotDecision, undoAutopilot } from './autopilot';
import { remoteReaders, type ReaderTimeouts, type RemoteReaders } from './remoteReaders';
import { DirCache, FileScanStore } from './scanStore';
import type { ActivityErrorRecord, Store, StoredAutopilotEntry, StoredKeys } from './store';
import { aiSpentThisMonth } from './views';
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
}

export interface LiveState {
  busy: 'scan' | 'ask' | 'paid' | null;
  stopping: boolean;
  pipeline: PipelineView | null;
  searchesUsed: number;
}

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
function secretsOf(keys: StoredKeys): string[] {
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

export class AgentWork {
  readonly scanStore: ScanStore;
  readonly cache: DirCache;
  private readonly d: WorkDeps;
  /** D2: the kinds, quiet hours and digest timing the owner set. */
  readonly policy: NotifyPolicy;
  private readonly live: LiveState = { busy: null, stopping: false, pipeline: null, searchesUsed: 0 };
  private stopCtl = new AbortController();
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
  }

  // ------------------------------------------------------------------ state and the schedule

  state(): LiveState {
    return { ...this.live };
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
    this.timer = setInterval(() => {
      void this.tick();
      void this.flushMessages();
    }, TICK_MS);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopCtl.abort();
  }

  /** Resolves when whatever runs now has ended (tests, and shutdown). */
  async idle(): Promise<void> {
    while (this.current) await this.current;
  }

  /** The scheduler: a due scan starts unless the agent is paused or busy. Returns whether one started. */
  tick(): boolean {
    if (this.live.busy || this.answering > 0 || this.d.store.get('agent').paused) return false;
    const next = this.nextScanAt();
    if (next === null || Date.parse(next) > this.d.now()) return false;
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
    void this.track(work()).catch(() => {});
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

  /** A store that tells the app how the scan is going, at most once a second. */
  private watched(store: ScanStore): ScanStore {
    const self = this;
    return new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== 'putScan') return Reflect.get(target, prop, receiver);
        return async (job: ScanJob) => {
          await target.putScan(job);
          self.live.searchesUsed = job.searchesUsed;
          const now = self.d.now();
          if (now - self.progressAt >= PROGRESS_MS || job.status !== 'running') {
            self.progressAt = now;
            self.live.pipeline = pipelineView(job, self.d.store.get('runtime').rates, now);
            self.d.changed();
          }
        };
      },
    });
  }

  /** `again`: Read again (readPagesAgain), with the searches the last scan used. */
  private async scan(trigger: ScanTrigger, again?: { usedBefore: number }): Promise<void> {
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
      job = await this.runTheScan(trigger, keys, notes, again);
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
      run.steps = pipelineView(job, store.get('runtime').rates, this.d.now()).steps;
      const judge = pipelineOf(job).find((p) => p.id === 'judge');
      run.judgeCostUsd = judge?.costSoFar ?? 0;
      const j = job;
      store.update('runtime', (r) => ({
        ...r, rates: addSamples(r.rates, samplesOf(j)),
        lastJob: { status: j.status, stopReason: j.stopReason, stopMessage: j.stopMessage ? scrub(j.stopMessage, keys) : null, searchesUsed: j.searchesUsed, finishedAt: j.finishedAt, deferred: j.deferred, ebayNotice: j.ebayNotice ?? null },
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
    } else if (report && !this.stopCtl.signal.aborted) {
      ai = await this.aiPass();
      if (ai.problem) notes.push(ai.problem);
      if (ai.waitingForChrome > 0) notes.push(`${ai.waitingForChrome} split ${ai.waitingForChrome === 1 ? 'question waits' : 'questions wait'} for Chrome.`);
      applied = await this.autopilot();
      if (applied > 0 || ai.asked > 0) report = await buildReport(this.scanStore, toScanSettings(extensionSettingsOf(store.get('settings'))));
      await this.publish(report);
      await this.trackScan(report);
      const tg = await this.message(report, job, applied);
      if (tg) notes.push(tg);
    }

    run.aiCostUsd = Math.round(((run.judgeCostUsd ?? 0) + (ai?.costUsd ?? 0)) * 10_000) / 10_000;
    run.questionsAsked = ai?.asked ?? 0;
    run.autopilotApplied = applied;
    run.finishedAt = new Date(this.d.now()).toISOString();
    // Nov 23: the bundles whose own Home Depot page is still not read, for Read again.
    const pagesUnread = (await this.scanStore.listBundles().catch(() => [])).filter((b) => !pageRead(b)).length;
    run.summary = this.summaryOf(report, run, notes, again !== undefined);
    this.record(run);
    const open = report ? report.review.length + (report.ebayQuestions?.length ?? 0) : 0;
    store.update('activity', (a) => ({
      ...a,
      lastScan: {
        at: run.finishedAt!, status: run.status, stopMessage: run.error ?? null,
        // Read again spends from what the scan before it left, so the two count as one scan against the limit.
        searchesUsed: (again?.usedBefore ?? 0) + run.searchesUsed, keepaTokensUsed: run.keepaTokensUsed,
        newDeals: report ? report.bundles.filter((b) => b.section === 'confirmed').length : 0, reviewOpen: open, pagesUnread,
      },
    }));
  }

  /** Nov 23: the run's outcome first ("Found 16 bundles; 0 estimated because ..."), then what it spent, then the problems. */
  private summaryOf(report: ScanReport | null, run: RunRecord, notes: string[], again = false): string {
    const parts: string[] = [];
    if (again) parts.push('Read again.');
    if (report) parts.push(outcomeSentence(report));
    if (run.searchesUsed > 0 || run.status !== 'failed') parts.push(`${run.searchesUsed} ${run.searchesUsed === 1 ? 'search' : 'searches'}.`);
    if (run.questionsAsked) parts.push(`AI asked about ${run.questionsAsked}.`);
    if (run.autopilotApplied) parts.push(`Autopilot applied ${run.autopilotApplied}.`);
    if (run.error) parts.push(run.error);
    return [...parts, ...notes].join(' ');
  }

  private async runTheScan(trigger: ScanTrigger, keys: StoredKeys, notes: string[], again?: { usedBefore: number }): Promise<ScanJob> {
    const { store } = this.d;
    const app = store.get('settings');
    const ext = extensionSettingsOf(app);
    // Read again: no listing page and no Amazon brand page; the lookups get what the last scan left of the limit.
    const scanSettings = again ? { ...toScanSettings(ext), queries: [], catalogPagesPerScan: 0 } : toScanSettings(ext);
    const problems = Object.values(validateSettings(ext));
    if (problems.length > 0) throw new WorkRefused(`A setting needs fixing before a scan: ${problems[0]}`);
    if (!keys.serpapi) throw new WorkRefused('Add your SerpApi key in Settings.');
    let account: AccountInfo;
    try {
      account = await SerpApiClient.account(keys.serpapi, this.d.fetchFn, this.d.serpBaseUrl);
    } catch (err) {
      throw new WorkRefused(err instanceof SerpApiError ? err.message : 'Something went wrong while checking your SerpApi account.');
    }
    const at = new Date(this.d.now()).toISOString();
    store.update('runtime', (r) => ({ ...r, serp: { left: account.totalSearchesLeft, perMonth: account.searchesPerMonth, rateLimitPerHour: account.rateLimitPerHour, at } }));

    const newest = (await this.scanStore.listScans())[0];
    const continued = newest?.status === 'running' ? newest : undefined;
    const budget = new SearchBudget(account, budgetPolicyFor(ext, trigger, again ? again.usedBefore + (continued?.searchesUsed ?? 0) : continued?.searchesUsed ?? 0));
    const serpLedger = this.ledger('serpapi-ledger.jsonl');
    const client = new SerpApiClient({
      apiKey: keys.serpapi, budget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now, baseUrl: this.d.serpBaseUrl,
      onSpend: (e: LedgerEntry) => serpLedger(e),
    });
    const keepa = this.keepaDeps(ext, keys);
    const connected = this.d.helperConnected();
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal });
    if (!connected) notes.push('Chrome is closed, so Home Depot pages wait for the next scan.');
    // BOGO found by itself, free, before the scan: the pairs it finds are bundles the scan then reads, splits and matches.
    else await this.bogoPass(ext, readers, notes);
    const ebay = this.ebayStep(app, keys, notes);
    const scan = this.d.runScan ?? runScan;
    // BOGO pairs are looked up after every other bundle, a few per group a scan (core's pairLookupOrder).
    const bogoPairs = Object.fromEntries(Object.values(store.get('tracking').bogoPairs ?? {}).map((p) => [p.key, `${p.promotionId}:${p.starterItemId}`]));
    return scan({
      bogoPairs,
      // Nov 23: a bundle whose own page is not read waits for it (waiting_page); it is never a question before then.
      waitForPages: true,
      client, budget, store: this.watched(this.scanStore), settings: scanSettings, now: this.d.now, labelPrefix: 'agent',
      shouldStop: () => this.stopCtl.signal.aborted,
      ...(connected ? { readPages: readers.readPages, readPartPrices: readers.readPartPrices } : { noReaderReason: 'Chrome closed' }),
      ...(ebay ? { ebay } : {}),
      ...keepa,
      cache: this.cache,
      ...(keepa.keepaProduct ? { trendWriter: (t) => writePartTrend(this.cache, t) } : {}),
    });
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

  /** Keepa inside the scan, as the extension builds it (worker.ts buildKeepaDeps): discovery and tracking are core's plan. */
  private keepaDeps(s: ExtensionSettings, keys: StoredKeys) {
    if (!keys.keepa || !s.amazonRefreshViaKeepa || s.keepaTokensPerScan <= 0) return {};
    const acct = this.d.store.get('runtime').keepa;
    const keepaBudget = new TokenBudget({ reserve: s.keepaReserve, maxPerRun: s.keepaTokensPerScan }, acct?.tokensLeft ?? null);
    const ledger = this.ledger('keepa-ledger.jsonl');
    const keepa = new KeepaClient({
      apiKey: keys.keepa, budget: keepaBudget, cache: this.cache, fetchFn: this.d.fetchFn, now: this.d.now,
      onSpend: (entry) => {
        ledger(entry);
        this.d.store.update('runtime', (r) => ({ ...r, keepa: { tokensLeft: entry.tokensLeft, refillIn: entry.refillIn, at: new Date(this.d.now()).toISOString() } }));
      },
    });
    return {
      keepaBudget,
      keepaProduct: (asin: string, label: string, maxAgeMs?: number) => keepaProductSearchResult(keepa, asin, { label, maxAgeMs, trackingDepth: s.trackingDepth }),
      keepaLookup: (brand: string, model: string, label: string) => keepaLookupSearchResult(keepa, `${brand} ${model}`, { label }),
      keepaScale: {
        tokensPerRun: s.keepaTokensPerScan, discoveryShare: s.keepaDiscoveryShare, reserve: s.keepaReserve, mode: s.discoveryMode,
        tokensLeft: acct?.tokensLeft ?? null, trackingDepth: s.trackingDepth,
      },
    };
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
    this.d.store.update('review', () => ({ at, questions: report.review, ebayQuestions: report.ebayQuestions ?? [], evidence }));
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
    this.d.store.update('tracking', (t) => ({ ...t, ...trackReport(t, report, trend, alerts, now) }));
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

  private async aiPass(only?: string[]): Promise<AiPassResult> {
    const { store } = this.d;
    const app = store.get('settings');
    const pipelines = pipelinesFrom(app.ai, { resolveKey: (ref) => this.keyFor(ref), fetchFn: this.d.fetchFn });
    const readers = remoteReaders({ jobs: this.d.jobs, timeouts: this.d.readerTimeouts, signal: () => this.stopCtl.signal });
    const askOne = askOneWith({
      store: this.scanStore,
      assist: pipelines.assist.ok ? pipelines.assist.value : null,
      research: pipelines.research.ok ? pipelines.research.value : null,
      tools: () => readers.researchTools(this.scanStore),
      now: this.d.now,
    });
    const model = (p: typeof pipelines.assist | typeof pipelines.research) => (p.ok ? { ok: true as const, model: p.value.model } : { ok: false as const, error: p.error });
    return runAiPass({
      store: this.scanStore,
      suggestions: () => store.get('suggestions'),
      keep: (r) => store.update('suggestions', (all) => [...all.filter((x) => x.key !== r.key), r]),
      models: { assist: model(pipelines.assist), research: model(pipelines.research) },
      askOne,
      chromeConnected: this.d.helperConnected,
      spentUsd: aiSpentThisMonth({ suggestions: store.get('suggestions'), runs: store.get('activity').runs }, this.d.now()),
      capUsd: app.ai.monthlyCapUsd,
      signal: this.stopCtl.signal,
      now: this.d.now,
      ...(only ? { only } : {}),
    });
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
      const undone = store.get('autopilot').some((e) => e.questionId === item.id && e.undoneAt !== null);
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

  /** The report rebuilt from the scan's store, for the app (after an answer, an undo, a Look up). */
  async refresh(): Promise<void> {
    await this.publish(await buildReport(this.scanStore, toScanSettings(extensionSettingsOf(this.d.store.get('settings')))));
  }

  /** Ask AI now, about one question or every open one (the app's buttons). Runs in the background. */
  askNow(only?: string[]): void {
    this.begin('ask', async () => {
      const startedAt = this.d.now();
      const run: RunRecord = { id: `run-${startedAt}`, kind: 'ask', startedAt: new Date(startedAt).toISOString(), finishedAt: null, status: 'running', searchesUsed: 0, keepaTokensUsed: 0, aiCostUsd: 0, summary: 'Asking the AI.', trigger: 'manual' };
      this.record(run);
      const r = await this.aiPass(only);
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
  answer(id: string, answer: { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' }, seen: string | undefined, fromSuggestion: boolean): Promise<void> {
    return this.serialAnswer('A scan or a search is running. Answer again when it has finished.', () => this.answerNow(id, answer, seen, fromSuggestion));
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

  private async answerNow(id: string, answer: { choice: number } | { none: true } | { parts: string[] } | { ebay: 'yes' | 'no' }, seen: string | undefined, fromSuggestion: boolean): Promise<void> {
    const now = this.d.now();
    if ('ebay' in answer) {
      const q = this.d.store.get('review').ebayQuestions.find((x) => x.id === id);
      if (!q) throw new AnswerRefused('That question was not found.');
      await applyEbayAnswer(this.scanStore, { key: q.key, itemId: q.itemId, answer: answer.ebay }, now);
      await this.refresh();
      return;
    }
    const item = await this.scanStore.getReview(id);
    if (!item) throw new AnswerRefused('That question was not found.');
    const signed: ReviewAnswer = { ...answer, seen: seen ?? reviewSignature(item) } as ReviewAnswer;
    await applyReviewAnswer(this.scanStore, id, signed, now);
    if (fromSuggestion) {
      const shown = liveSuggestion(this.d.store.get('suggestions'), item);
      const after = await this.scanStore.getReview(id);
      if (shown && after) {
        this.d.store.update('suggestions', (all) => all.map((s) => (s.key === shown.key ? { ...s, outcome: { answeredAt: now, answer: after.answer ?? '', agreed: agreedWith(s.suggestion, after) } } : s)));
      }
    }
    await this.refresh();
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
    return this.track(this.paidClaimed(bundleKey, kind, model));
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
      report, alerts: app.alerts, notifiedDeals: runtime.notifiedDeals, notifiedQuestions: runtime.notifiedQuestions, autopilotApplied: applied,
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
