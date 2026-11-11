// The service worker's logic, with everything Chrome-specific passed in (see background.ts).
// It holds the SerpApi key, checks the account (free), builds each scan's budget from the
// owner's settings, runs scans one at a time, and answers the pages. Chrome may stop the
// worker at any moment, so nothing here relies on memory surviving: the one-minute alarm
// calls onTick, and every tick either continues an interrupted scan or starts one that is due.
// "Rule n" refers to the step 3 plan, Task 5 ("The service worker").

import { AnswerRefused, applyReviewAnswer, reopenReviewAnswer } from '@core/scan/answers';
import { PaidProblem, quotePaid, refusalFor, requestProblem, runPaid, savedAnswers } from '@core/scan/paid';
import { runScan } from '@core/scan/runner';
import type { BudgetView, BundleRow, PaidAction, Quote, ReadPages, ReviewAnswer, ScanJob, ScanStore } from '@core/scan/types';
import { type AccountInfo, SearchBudget } from '@core/serpapi/budget';
import { type Cache, type LedgerEntry, SerpApiClient, SerpApiError } from '@core/serpapi/client';
import {
  budgetPolicyFor, dealsToNotify, DEFAULT_SETTINGS, type ExtensionSettings, type ScanTrigger, type SettingsField, toScanSettings, validateSettings,
} from '@core/settings';
import { runCsv } from '@core/scan/csv';
import { buildReport } from '@core/scan/report';
import { nextRun, type Schedule } from '@core/schedule';
import type { AppState, Packaging, PanelReport, Reply, Request } from './messages';
import type { ActiveScan, StoredAccount } from './prefs';

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
  getPackaging(): Promise<Record<string, Packaging>>;
  savePackaging(v: Record<string, Packaging>): Promise<void>;
  getAccount(): Promise<StoredAccount | null>;
  setAccount(v: StoredAccount | null): Promise<void>;
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
  /** Tells every open page the new state. */
  broadcast: (state: AppState) => void;
  /** Default https://serpapi.com, for the Account API and for searches. */
  baseUrl?: string;
  /** Reads bundle pages in the owner's browser; without it no page is read. */
  readPages?: ReadPages;
}

export interface Worker {
  onMessage(request: Request): Promise<Reply>;
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
const GAVE_UP = 'The scan could not be saved, so it was stopped. Check that Chrome has free storage, then scan again.';
const STOPPED = 'The scan was stopped before it began.';
const BAD_PACKAGING = 'Choose retail boxed or loose.';
const NO_MODEL = 'Name the bundle model.';
const ANSWER_LATER = 'A scan is running. Answer again when it has finished.';
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

const FIELDS: readonly SettingsField[] = ['schedule', 'searchesPerScan', 'reserve', 'brands', 'pagesPerBrand', 'fees', 'alerts'];
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
      return { value: { enabled: v.enabled, minProfit: v.minProfit, minRoiPercent: v.minRoiPercent } };
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
const progressOf = (job: ScanJob): string => `${job.searchesUsed}:${job.phase}:${job.queue.length}`;

// ---------------------------------------------------------------- the worker

export function createWorker(env: WorkerEnv): Worker {
  const { prefs, store } = env;
  const baseUrl = env.baseUrl ?? 'https://serpapi.com';
  const accountOf = (key: string) => SerpApiClient.account(key, env.fetchFn, baseUrl);

  /** One plain sentence when the last account check or scan start failed. Lost with the worker. */
  let problem: string | null = null;
  /** The scan this worker is running, from its start to the end of its broadcast. */
  let scan: Promise<void> | null = null;
  /** Set by stopScan (and forgetKey) while a scan runs; cleared when it ends. runScan asks before every paid step. */
  let stopRequested = false;
  /** The key the running scan holds, so it is kept out of replies even after it was forgotten. */
  let scanKey: string | null = null;
  /** True while a start is between its first read and the scan's claim (or its refusal). */
  let starting = false;
  /** The Verify or Look up this worker is running, from its claim until it has ended; cleared before the broadcast that follows. */
  let paid: Promise<Reply<null>> | null = null;
  /** The key the running paid action holds. */
  let paidKey: string | null = null;
  /** Set by forgetKey, and by checkKey saving a different key, while a paid action runs. runPaid asks it before every search. */
  let paidStop = false;

  const settings = async () => trusted(await prefs.getSettings());

  /**
   * The value with every copy of the key replaced. Error text from a failed search (a job's
   * stopMessage) is the only way the key could get in; this is the last door before a page.
   */
  async function scrubbed<T>(value: T): Promise<T> {
    const keys = [await prefs.getKey(), scanKey].filter((k): k is string => k !== null && k !== '');
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
      account: account?.info ?? null,
      accountCheckedAt: account?.at ?? null,
      problem,
      settings: s,
      scanRunning: scan !== null,
      lastJob: (await store.listScans())[0] ?? null,
      nextRunAt: next === null ? null : next.getTime(),
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
      if (scan === null) stopRequested = false;
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

    scanKey = key;
    scan = (async () => {
      try {
        await runScan({ client, budget, store: saving, settings: scanSettings, now: env.now, labelPrefix: 'scan', shouldStop: () => stopRequested, readPages: env.readPages });
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
        stopRequested = false;
        scanKey = null;
        endProgress();
        void broadcast();
      });
    await broadcast();
    return ok(null);
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
    const notified = await prefs.getNotified();
    const deals = dealsToNotify(await buildReport(store, toScanSettings(s)), s.alerts, notified).slice(0, MAX_NOTIFIED);
    if (deals.length === 0) return;
    await env.notify(deals);
    await prefs.setNotified([...notified, ...deals.map((d) => d.key)]);
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
      started = await serial(async () => {
        // Rule 3: a tick while a scan is active does nothing; nor while a Verify or Look up runs.
        if (scan !== null || paid !== null) return null;
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
  }

  /** Rule 3. A job left running is continued with the trigger it was saved with. */
  const scanNow = (): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(RUNNING);
      if (paid !== null) return refuse(PAID_RUNNING);
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
    if (scan !== null || starting) stopRequested = true;
    if (paid !== null) paidStop = true;
    // The account shown belonged to that key.
    await prefs.setAccount(null);
    await broadcast();
    return ok(null);
  }

  /**
   * Rule 5. A running scan keeps the budget it started with. Saving never starts a scan: a
   * changed schedule counts from now, written before the settings so that no tick in between
   * sees the new schedule with the old reference time. Taken through the start gate as well.
   */
  const saveSettings = (given: ExtensionSettings): Promise<Reply<null>> =>
    serial(async () => {
      const { clean, problems } = checkSettings(given);
      if (problems.length > 0) return refuse(problems[0]!);
      if (!sameSchedule((await settings()).schedule, clean.schedule)) await prefs.setLastScheduledRunAt(env.now());
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

  async function getReport(): Promise<Reply<PanelReport>> {
    const report = await buildReport(store, toScanSettings(await settings()));
    // Validated on read, like settings: prefs drops entries that are not a known answer.
    const packaging: Record<string, Packaging> = {};
    for (const [m, a] of Object.entries(await prefs.getPackaging())) if (a === 'retail_boxed' || a === 'loose') packaging[m] = a;
    return ok({ ...report, packaging });
  }

  /**
   * The owner's answer to a review question (answers.ts). Taken through the start gate, so no
   * scan starts while it is written, and refused while a scan runs: the scan reads and rewrites
   * splits, matches and questions, and could write over an answer saved in the middle of it. Also
   * refused while a Look up or Verify runs, which reads and writes the parts' matches and questions.
   * The request is untrusted: applyReviewAnswer checks its shape (an id, a choice, none or typed parts, and the
   * `seen` signature of the question shown) and refuses anything else with a plain sentence.
   */
  const answerReview = (id: string, answer: ReviewAnswer): Promise<Reply<null>> =>
    serial(async () => {
      if (scan !== null) return refuse(ANSWER_LATER);
      if (paid !== null) return refuse(ANSWER_AFTER_SEARCH);
      try {
        await applyReviewAnswer(store, id, answer, env.now());
      } catch (err) {
        if (err instanceof AnswerRefused) return refuse(err.message);
        throw err;
      }
      await broadcast();
      return ok(null);
    });

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
    let refusal: string | null = scan !== null || starting ? SCAN_RUNNING : paid !== null ? PAID_RUNNING : null;
    let budget: BudgetView = CLOSED;
    if (refusal === null && key === null) refusal = NO_KEY;
    else if (refusal === null && key !== null) {
      const account = await accountForQuote(key);
      if (typeof account === 'string') refusal = account;
      else budget = new SearchBudget(account, budgetPolicyFor(await settings(), 'manual', 0));
    }
    refusal ??= await refusalFor(store, action);
    const q = quotePaid(action, await savedAnswers(store), budget);
    return ok({ searches: q.searches, refusal: refusal ?? q.refusal });
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
      try {
        await runPaid({ client, budget, store, now: env.now, settings: toScanSettings(s), shouldStop: () => (paidStop ? PAID_STOPPED : null) }, action);
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

  async function handle(request: Request): Promise<Reply> {
    switch (request.type) {
      case 'getState':
        return ok(await getState());
      case 'checkKey':
        return checkKey(request.apiKey);
      case 'forgetKey':
        return forgetKey();
      case 'scanNow':
        return scanNow();
      case 'saveSettings':
        return saveSettings(request.settings);
      case 'exportDeals':
        return exportDeals();
      case 'exportMatches':
        return exportMatches();
      case 'stopScan':
        if (scan !== null || starting) stopRequested = true;
        return ok(null);
      case 'clearSavedSearches':
        await env.cache.clear();
        return ok(null);
      case 'getReport':
        return getReport();
      case 'setPackaging':
        return setPackaging(request.model, request.packaging);
      case 'answerReview':
        return answerReview(request.id, request.answer);
      case 'reopenReview':
        return reopenReview(request.id);
      case 'quote':
        return quote(request.action);
      case 'runPaid':
        return runPaidAction(request.action);
      default:
        return refuse(FAILED);
    }
  }

  return {
    async onMessage(request) {
      try {
        return await scrubbed(await handle(request));
      } catch {
        // A storage error: the page still gets an answer.
        return refuse(FAILED);
      }
    },
    onTick: tick,
    onStart: tick,
  };
}
