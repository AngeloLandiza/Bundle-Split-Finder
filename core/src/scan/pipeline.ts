// Step 11 (Track P, P1): what a scan is doing now, as data. The runner keeps a record of its stages on the job
// (`ScanJob.pipeline`), the extension keeps how long a unit of each kind took (`UnitRates`), and `pipelineView`
// turns the two into the exact words of docs/design.md, "Scan progress (step 11)". Pure: no clock of its own, no
// chrome.*, no storage. The progress row (P2) only draws what `pipelineView` returns.
//
// Two rules the numbers keep:
//  - Nothing here is a promise. The estimate is labelled ("about", "at least", "under a minute", "estimating") and
//    is worked out from the job alone, so it changes when a step's units change and never by the second.
//  - Nothing here spends or decides anything. A helper that finds no `job.pipeline` does nothing, so a job from an
//    older build, or a test that builds a bare job, runs as it always did.

import { costOf, PRICE_TABLE } from '../judge/eval';
import type { ScanJob } from './types';

// ---------------------------------------------------------------- the record on the job

/**
 * The stages, in the order a scan runs them (runScan). Step 15, decision 3: the Amazon lookups, which produce the
 * estimates, run as soon as the splits and kit pages are known, before Home Depot's part prices and eBay (both free,
 * slow, and not needed for an estimate). The step list the owner reads is in this order.
 */
export const STEP_IDS = ['hdPages', 'bundlePages', 'kitPages', 'amazon', 'partPrices', 'ebay', 'judge', 'finish'] as const;
export type StepId = (typeof STEP_IDS)[number];
/** Step 15: `failed`: the step ran and its reader or service failed; the reason is `skippedReason`. */
export type StepState = 'next' | 'now' | 'done' | 'skipped' | 'failed';

export interface PipelineStep {
  id: StepId;
  state: StepState;
  /** Units finished. Counted from the job's own counts where it has them, so it is right after a worker eviction. */
  unitsDone: number;
  /** Units the step will have in all, or null while that is not known. It moves as the plan does (a page dropped, a part found). */
  unitsTotal: number | null;
  startedAt?: number;
  endedAt?: number;
  /** Four words or fewer, why the step did not run (skipped) or what went wrong (failed). */
  skippedReason?: string;
  /** Step 15: the done figure, when the runner says more than the count (the Amazon step: "4 Keepa, 14 searches, 2 wait"). */
  note?: string;
  /** The listing check: dollars spent so far, from the tokens the eBay pass counts and the model's price. */
  costSoFar?: number;
  /** The listing check: dollars the cap would cost at most, before it starts. An estimate. */
  costEstimate?: number;
  /** The listing check: the model, which is the unit kind's name and the price's key. */
  model?: string;
  /** Time spent in the units that were measured, in ms; and how many units that covers. A cached answer is not measured. */
  activeMs?: number;
  unitsMeasured?: number;
}

/** The longest a skipped step's reason may be, in words. */
export const REASON_WORDS = 4;

const trimReason = (reason: string): string => reason.trim().split(/\s+/).slice(0, REASON_WORDS).join(' ');

/** A fresh record: hdPages knows its pages, the rest wait. */
export function newPipeline(hdPagesTotal: number | null): PipelineStep[] {
  return STEP_IDS.map((id) => ({
    id, state: 'next' as StepState, unitsDone: 0,
    unitsTotal: id === 'hdPages' ? hdPagesTotal : id === 'finish' ? 1 : null,
  }));
}

/**
 * The record a job without one would have had, from its phase and counts: how a job from an older build, or one
 * continued after the worker was evicted before any save, is shown. Nothing is measured on it. Not stored.
 */
export function derivePipeline(job: ScanJob): PipelineStep[] {
  const c = job.counts;
  const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const queued = job.queue.length;
  const listing = job.phase === 'listing';
  const finished = job.phase === 'finish';
  const done = (id: StepId, units: number): PipelineStep => ({ id, state: 'done', unitsDone: units, unitsTotal: units });
  const hdDone = n(c.pagesFetched) + n(c.catalogPages);
  const steps: PipelineStep[] = newPipeline(null);
  const set = (id: StepId, step: PipelineStep): void => void (steps[STEP_IDS.indexOf(id)] = step);
  if (listing) {
    set('hdPages', { id: 'hdPages', state: queued > 0 ? 'now' : 'done', unitsDone: hdDone, unitsTotal: hdDone + queued });
    return steps;
  }
  set('hdPages', done('hdPages', hdDone));
  set('bundlePages', done('bundlePages', n(c.pagesRead)));
  set('kitPages', done('kitPages', 0));
  set('partPrices', done('partPrices', n(c.partPricesRead)));
  set('ebay', done('ebay', n(c.ebaySearches) + n(c.ebayItemReads)));
  set('judge', done('judge', n(c.listingsJudged)));
  const lookups = n(c.lookupsDone) + n(c.refreshesDone);
  set('amazon', finished ? done('amazon', lookups) : { id: 'amazon', state: queued > 0 ? 'now' : 'done', unitsDone: lookups, unitsTotal: lookups + queued });
  if (finished) set('finish', done('finish', 1));
  return steps;
}

/** The job's record, or what it would have been. */
export const pipelineOf = (job: ScanJob): PipelineStep[] => job.pipeline ?? derivePipeline(job);

/** Gives the job a record if it has none (a job from an older build, or a continued one); returns it. */
export function ensurePipeline(job: ScanJob): PipelineStep[] {
  job.pipeline ??= derivePipeline(job);
  return job.pipeline;
}

function stepOf(job: ScanJob, id: StepId): PipelineStep | undefined {
  return job.pipeline?.find((s) => s.id === id);
}

export interface StartOptions {
  /** Units still to do when the step starts. The total is what is already done plus this. null: not known. */
  remaining: number | null;
  now: number;
  /** Units already done, when the job's counts say so (a continued job). Default: what the record has. */
  done?: number;
}

/**
 * The step starts, or starts again after the worker was evicted in it: what it had done stays done, and the
 * total is that plus what is left, so the figures are the same as if it had never stopped. A step that was
 * skipped is left alone.
 */
export function startStep(job: ScanJob, id: StepId, o: StartOptions): void {
  const s = stepOf(job, id);
  if (!s || s.state === 'skipped') return;
  s.unitsDone = o.done ?? s.unitsDone;
  s.unitsTotal = o.remaining === null ? null : s.unitsDone + Math.max(0, o.remaining);
  s.state = 'now';
  s.startedAt ??= o.now;
  delete s.endedAt;
}

/** Units done, and the total when it is given, without leaving the step's state alone otherwise. */
export function moveUnits(job: ScanJob, id: StepId, o: { done?: number; total?: number | null; remaining?: number | null }): void {
  const s = stepOf(job, id);
  if (!s || s.state === 'skipped') return;
  if (o.done !== undefined) s.unitsDone = o.done;
  if (o.total !== undefined) s.unitsTotal = o.total;
  if (o.remaining !== undefined) s.unitsTotal = o.remaining === null ? null : s.unitsDone + Math.max(0, o.remaining);
}

/**
 * One unit finished: counted, timed when `ms` is given (a search the network answered; a cached one is free and is
 * not timed), and the total made what is done plus `remaining`.
 */
export function finishUnit(job: ScanJob, id: StepId, o: { ms: number | null; remaining: number }): void {
  const s = stepOf(job, id);
  if (!s || s.state === 'skipped') return;
  s.unitsDone += 1;
  if (o.ms !== null) measure(job, id, o.ms);
  s.unitsTotal = s.unitsDone + Math.max(0, o.remaining);
}

/** The listing check's model, and what its cap would cost at most (an estimate; null when the model has no price). */
export function setJudge(job: ScanJob, model: string, costEstimate: number | null): void {
  const s = stepOf(job, 'judge');
  if (!s) return;
  s.model = model;
  if (costEstimate === null) delete s.costEstimate;
  else s.costEstimate = costEstimate;
}

/** Time spent in `units` units that took `ms` in all (a cached answer is never passed here). */
export function measure(job: ScanJob, id: StepId, ms: number, units = 1): void {
  const s = stepOf(job, id);
  if (!s || !(units > 0) || !Number.isFinite(ms)) return;
  s.activeMs = (s.activeMs ?? 0) + Math.max(0, ms);
  s.unitsMeasured = (s.unitsMeasured ?? 0) + units;
}

/** The listing check's dollars so far, from the job's tokens and the model's price; nothing for a model with no price. */
export function noteCost(job: ScanJob): void {
  const s = stepOf(job, 'judge');
  const rates = s?.model ? PRICE_TABLE[s.model] : undefined;
  if (!s || !rates) return;
  s.costSoFar = costOf({ inputTokens: job.counts.judgeTokensIn ?? 0, outputTokens: job.counts.judgeTokensOut ?? 0 }, rates);
}

export function endStep(job: ScanJob, id: StepId, now: number): void {
  const s = stepOf(job, id);
  if (!s || s.state === 'skipped' || s.state === 'failed') return;
  s.state = 'done';
  s.startedAt ??= now;
  s.endedAt = now;
  // A step that ends has no more units than it did: a stop, a halt or a plan that shrank.
  s.unitsTotal = s.unitsDone;
}

/** Step 15: the step ran and failed (its reader threw), for a reason of four words or fewer. What it did stays counted. */
export function failStep(job: ScanJob, id: StepId, reason: string, now: number): void {
  const s = stepOf(job, id);
  if (!s || s.state === 'skipped') return;
  s.state = 'failed';
  s.skippedReason = trimReason(reason);
  s.startedAt ??= now;
  s.endedAt = now;
  s.unitsTotal = s.unitsDone;
}

/** The step will not run in this scan, for a reason of four words or fewer. A step that has run is not changed. */
export function skipStep(job: ScanJob, id: StepId, reason: string): void {
  const s = stepOf(job, id);
  if (!s || s.state === 'done' || s.state === 'failed') return;
  s.state = 'skipped';
  s.skippedReason = trimReason(reason);
  s.unitsTotal = null;
  delete s.startedAt;
  delete s.endedAt;
}

/** At the end of a run: a step still going has ended, and one that never began did not run, for `reason`. */
export function closeRest(job: ScanJob, reason: string, now: number): void {
  for (const s of job.pipeline ?? []) {
    if (s.state === 'now') endStep(job, s.id, now);
    else if (s.state === 'next' && s.id !== 'finish') skipStep(job, s.id, reason);
  }
}

// ---------------------------------------------------------------- rates

/** What a unit is, for timing: a SerpApi search, a Home Depot page read, an eBay call, or a model call (by model). */
export type UnitKind = string;

/**
 * The last measured seconds-per-unit of each kind, oldest first, at most RATE_WINDOW each. The rate is their median.
 * Plain data: the extension keeps it in chrome.storage.local as it is.
 */
export type UnitRates = Partial<Record<UnitKind, number[]>>;
export const RATE_WINDOW = 20;

/**
 * Seeds: guesses used until a kind has been measured, not measurements. They come from the step 10 runs (a judged
 * listing on Haiku about 2.5 s and on Opus about 7 s) and a few scans' timings (a search about 3 s, a page read about
 * 3 s including the reader's own pause, an eBay call about 0.6 s). The first scan replaces them.
 */
export const SEED_SECONDS: Readonly<Record<UnitKind, number>> = {
  serpapiSearch: 3,
  hdPageRead: 3,
  ebayCall: 0.6,
  'judgeCall:claude-haiku-5-5': 2.5,
  'judgeCall:claude-opus-5-5': 7,
  // Step 12: one question asked of the owner's model, read from the evidence or researched. A guess until the first run measures it.
  askAi: 8,
};

/** What kind of unit a step counts; null for the step that has none. */
export function unitKindOf(s: Pick<PipelineStep, 'id' | 'model'>): UnitKind | null {
  switch (s.id) {
    case 'hdPages':
    case 'amazon':
      return 'serpapiSearch';
    case 'bundlePages':
    case 'kitPages':
    case 'partPrices':
      return 'hdPageRead';
    case 'ebay':
      return 'ebayCall';
    case 'judge':
      return `judgeCall:${s.model ?? 'unknown'}`;
    case 'finish':
      return null;
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Stored rates are untrusted: anything but a list of finite positive numbers, per kind, is dropped. */
export function trustedRates(stored: unknown): UnitRates {
  const out: UnitRates = {};
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return out;
  for (const [kind, v] of Object.entries(stored)) {
    if (!Array.isArray(v)) continue;
    const xs = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0).slice(-RATE_WINDOW);
    if (xs.length > 0) out[kind] = xs;
  }
  return out;
}

/** Seconds a unit of `kind` takes: the median of what was measured, else the seed, else null. */
export function secondsPerUnit(rates: UnitRates, kind: UnitKind): { seconds: number; measured: boolean } | null {
  const xs = Object.hasOwn(rates, kind) ? rates[kind] : undefined;
  if (xs && xs.length > 0) return { seconds: median(xs), measured: true };
  const seed = Object.hasOwn(SEED_SECONDS, kind) ? SEED_SECONDS[kind] : undefined;
  return seed === undefined ? null : { seconds: seed, measured: false };
}

/** One measured seconds-per-unit per step of the job that timed any unit. */
export function samplesOf(job: Pick<ScanJob, 'pipeline'>): { kind: UnitKind; seconds: number }[] {
  const out: { kind: UnitKind; seconds: number }[] = [];
  for (const s of job.pipeline ?? []) {
    const kind = unitKindOf(s);
    if (kind === null || !s.unitsMeasured || s.activeMs === undefined) continue;
    const seconds = s.activeMs / 1000 / s.unitsMeasured;
    // A step that took no time (a test clock, a cached answer) says nothing about how long a unit takes.
    if (seconds > 0 && Number.isFinite(seconds)) out.push({ kind, seconds });
  }
  return out;
}

/** The rates with the samples added, each kind keeping its last RATE_WINDOW. A new object. */
export function addSamples(rates: UnitRates, samples: { kind: UnitKind; seconds: number }[]): UnitRates {
  const out: UnitRates = { ...trustedRates(rates) };
  for (const { kind, seconds } of samples) out[kind] = [...(out[kind] ?? []), seconds].slice(-RATE_WINDOW);
  return out;
}

// ---------------------------------------------------------------- the estimate

export interface Estimate {
  kind: 'estimating' | 'about' | 'atLeast' | 'underMinute';
  /** The sum of what is left, in seconds, before rounding. 0 when kind is 'estimating'. */
  seconds: number;
}

/** Step 15: units of a kind this scan must have timed before its own rate is used (fewer are noise). */
export const MIN_TIMED_UNITS = 3;

/**
 * What a unit of this step's kind costs in time right now: this scan's own measurement of that kind once it has timed
 * MIN_TIMED_UNITS (it is the freshest), else the median of earlier scans, else the seed.
 */
function stepSeconds(steps: PipelineStep[], step: PipelineStep, rates: UnitRates): number | null {
  const kind = unitKindOf(step);
  if (kind === null) return 0;
  let ms = 0;
  let units = 0;
  for (const s of steps) {
    if (unitKindOf(s) === kind && s.unitsMeasured && s.activeMs !== undefined) {
      ms += s.activeMs;
      units += s.unitsMeasured;
    }
  }
  if (units >= MIN_TIMED_UNITS && ms > 0) return ms / 1000 / units;
  return secondsPerUnit(rates, kind)?.seconds ?? null;
}

/**
 * What is left of the scan: the units each step has left times the seconds a unit takes.
 * - `atLeast`: some step that will run has no total yet (the parts are not known until the bundles are split, and
 *   the lookups are not planned until the free steps are done), so what is added up is a lower bound.
 * - `estimating`: a step with units left has no rate, measured or seeded; or only a lower bound under a minute.
 * - `underMinute` / `about`: the sum is known.
 * Deterministic in the job: it changes when units change and not as time passes, so `now` is not used. It is in the
 * signature so a caller that wants to measure a step in flight can, and so the row passes the one clock it has.
 */
export function estimate(job: ScanJob, rates: UnitRates, _now?: number): Estimate {
  const steps = pipelineOf(job);
  let seconds = 0;
  let unknownTotal = false;
  for (const step of steps) {
    if (step.state === 'done' || step.state === 'skipped' || step.state === 'failed') continue;
    if (step.unitsTotal === null) {
      unknownTotal = true;
      continue;
    }
    const left = Math.max(0, step.unitsTotal - step.unitsDone);
    if (left === 0) continue;
    const each = stepSeconds(steps, step, rates);
    if (each === null) return { kind: 'estimating', seconds: 0 };
    seconds += left * each;
  }
  if (unknownTotal) return seconds < 60 ? { kind: 'estimating', seconds: 0 } : { kind: 'atLeast', seconds };
  return seconds < 60 ? { kind: 'underMinute', seconds } : { kind: 'about', seconds };
}

// ---------------------------------------------------------------- the words

/** A step's name in the step list. */
export const STEP_NAMES: Readonly<Record<StepId, string>> = {
  hdPages: 'Home Depot deals pages',
  bundlePages: 'Bundle pages',
  kitPages: 'Kit pages',
  partPrices: 'Home Depot part prices',
  ebay: 'eBay listings',
  judge: 'Listing check (Claude)',
  amazon: 'Amazon lookups',
  finish: 'Finish',
};

/**
 * What the row's first line says while the step is the current one. Short, so that at 360px the label sits whole beside
 * its count and Details (UI review of P2); the step list names each step in full.
 */
export const CURRENT_LABELS: Readonly<Record<StepId, string>> = {
  hdPages: 'Fetching deals pages',
  bundlePages: 'Reading bundle pages',
  kitPages: 'Reading kit pages',
  partPrices: 'Reading part prices',
  ebay: 'Checking eBay listings',
  judge: 'Checking listings',
  amazon: 'Looking up parts',
  finish: 'Finishing up',
};

export interface PipelineView {
  /** The row's first line: `${label} · ${count}`; count is empty when the step has nothing to count yet. */
  current: { label: string; count: string };
  /** "about 4 min", "under a minute", "at least 3 min" or "estimating". */
  estimateText: string;
  /** Steps finished (done or skipped) and steps in all. */
  stepsDone: number;
  stepsTotal: number;
  /** 0 to 1, for the 2px bar. */
  fraction: number;
  /** The bar's aria-valuetext. */
  ariaValueText: string;
  /** Step 15: `done` and `total` are the step's units, while it runs or once it ran (absent while not known). */
  steps: { label: string; state: StepState; figure: string; done?: number; total?: number }[];
  /** The words the row's bar and list are named by, for a screen reader. Absent: the scan's own ("Scan progress", "Scan steps"). */
  labels?: { bar: string; steps: string };
}

const dollars = (n: number): string => `$${n.toFixed(2)}`;
const minutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** "23 of 60", or the count alone while the total is not known; empty before anything is done. */
function countOf(s: PipelineStep): string {
  if (s.unitsTotal !== null) return `${s.unitsDone} of ${s.unitsTotal}`;
  return s.unitsDone > 0 ? String(s.unitsDone) : '';
}

/** The figure at the right of a step's line. */
function figureOf(s: PipelineStep): string {
  if (s.state === 'skipped' || s.state === 'failed') return s.skippedReason ?? '';
  switch (s.id) {
    case 'amazon':
      if (s.state === 'done' && s.note) return s.note;
      return s.state === 'now' ? countOf(s) : s.state === 'done' ? plural(s.unitsDone, 'lookup', 'lookups') : '';
    case 'hdPages':
      return s.state === 'now' ? countOf(s) : s.state === 'done' ? plural(s.unitsMeasured ?? 0, 'search', 'searches') : '';
    case 'bundlePages':
    case 'kitPages':
    case 'partPrices':
      return s.state === 'now' ? countOf(s) : s.state === 'done' ? `${s.unitsDone} read` : '';
    case 'ebay':
      return s.state === 'now' ? countOf(s) : s.state === 'done' ? plural(s.unitsDone, 'call', 'calls') : '';
    case 'judge':
      if (s.state === 'next') return s.costEstimate === undefined ? '' : `est. ${dollars(s.costEstimate)}`;
      if (s.costSoFar === undefined) return s.state === 'now' ? countOf(s) : '';
      return s.state === 'now' ? `${dollars(s.costSoFar)} so far` : dollars(s.costSoFar);
    case 'finish':
      return '';
  }
}

/**
 * The bar. Weighted by the time each step is expected to take, when every step that will run has a known size and a
 * rate; otherwise steps done over steps in all (a step skipped counts as done). A step weighs its units times its
 * seconds a unit; a step of no weight (the finish) moves the bar only through the count.
 */
function fractionOf(steps: PipelineStep[], rates: UnitRates): number {
  const live = steps.filter((s) => s.state !== 'skipped');
  const byCount = steps.length === 0 ? 0 : steps.filter((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'failed').length / steps.length;
  let total = 0;
  let got = 0;
  for (const s of live) {
    if (s.state === 'done' || s.state === 'failed') {
      const each = stepSeconds(steps, s, rates);
      if (each === null) return byCount;
      total += s.unitsDone * each;
      got += s.unitsDone * each;
      continue;
    }
    if (s.unitsTotal === null) return byCount;
    const each = stepSeconds(steps, s, rates);
    if (each === null) return byCount;
    total += s.unitsTotal * each;
    got += Math.min(s.unitsDone, s.unitsTotal) * each;
  }
  if (!(total > 0)) return byCount;
  return Math.max(0, Math.min(1, got / total));
}

/**
 * Everything the progress row says, from the job, the rates and the clock. Pure. `unknown`: the estimate's text while
 * it is not known: the extension's row says "estimating"; the desktop app passes '' and shows the counts only (step 15).
 */
export function pipelineView(job: ScanJob, rates: UnitRates, now: number, opts: { unknown?: string } = {}): PipelineView {
  const steps = pipelineOf(job);
  const at = steps.findIndex((s) => s.state === 'now');
  const index = at >= 0 ? at : Math.max(0, steps.findIndex((s) => s.state === 'next') >= 0 ? steps.findIndex((s) => s.state === 'next') : steps.length - 1);
  const cur = steps[index]!;
  const est = estimate(job, rates, now);
  const m = minutes(est.seconds);
  const unknown = opts.unknown ?? 'estimating';
  const estimateText = est.kind === 'estimating' ? unknown : est.kind === 'underMinute' ? 'under a minute' : est.kind === 'about' ? `about ${m} min` : `at least ${m} min`;
  const left = est.kind === 'estimating' ? (unknown === '' ? 'time left not known yet' : 'estimating time left')
    : est.kind === 'underMinute' ? 'less than a minute left'
    : `${est.kind === 'about' ? 'about' : 'at least'} ${plural(m, 'minute', 'minutes')} left`;
  const label = CURRENT_LABELS[cur.id];
  return {
    current: { label, count: cur.state === 'now' ? countOf(cur) : '' },
    estimateText,
    stepsDone: steps.filter((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'failed').length,
    stepsTotal: steps.length,
    fraction: fractionOf(steps, rates),
    ariaValueText: `Step ${index + 1} of ${steps.length}, ${lowerFirst(label)}, ${left}`,
    steps: steps.map((s) => ({
      label: STEP_NAMES[s.id], state: s.state, figure: figureOf(s),
      ...(s.state === 'now' || s.state === 'done' || s.state === 'failed' ? { done: s.unitsDone } : {}),
      ...((s.state === 'now' || s.state === 'done' || s.state === 'failed') && s.unitsTotal !== null ? { total: s.unitsTotal } : {}),
    })),
  };
}

// ---------------------------------------------------------------- step 12: Ask AI about all

/**
 * The queue "Ask AI about all" runs in the background: not a scan and not kept on a job, so the worker holds it and
 * sends it in AppState. `costUsd` is what the questions asked so far cost at the model's rates; `estimateUsd` what the
 * whole queue was estimated to cost when it began.
 */
export interface AskAllProgress {
  done: number;
  total: number;
  costUsd: number;
  estimateUsd: number | null;
  /** Stop was pressed: the question in flight is being cancelled. */
  stopping?: boolean;
}

/** What the progress row says while the queue runs: the same shape as a scan's, drawn by the same row. Pure. */
export function askAllView(p: AskAllProgress, rates: UnitRates): PipelineView {
  const left = Math.max(0, p.total - p.done);
  const each = secondsPerUnit(rates, 'askAi')?.seconds ?? SEED_SECONDS.askAi!;
  const seconds = left * each;
  const m = minutes(seconds);
  const estimateText = seconds < 60 ? 'under a minute' : `about ${m} min`;
  const timeLeft = seconds < 60 ? 'less than a minute left' : `about ${plural(m, 'minute', 'minutes')} left`;
  const count = `${p.done} of ${p.total}`;
  return {
    current: { label: 'Asking AI', count },
    estimateText,
    stepsDone: 0,
    stepsTotal: 1,
    fraction: p.total > 0 ? Math.max(0, Math.min(1, p.done / p.total)) : 0,
    ariaValueText: `Asking AI, ${count}, ${timeLeft}`,
    steps: [{ label: 'Asking AI', state: 'now', figure: `${dollars(p.costUsd)} so far` }],
    labels: { bar: 'Asking AI progress', steps: 'Asking AI steps' },
  };
}
