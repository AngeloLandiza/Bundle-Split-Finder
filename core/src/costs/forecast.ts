// The month-end forecast of one service (step 18): statistics on the owner's own use, stated as a range. Pure, seeded.
//
//   month end = used so far + (scheduled scans left this month × what a scan uses) + (days left × the use of a day
//               between scheduled scans)
//
// With enough history (MIN_HISTORY_DAYS complete days, and MIN_HISTORY_RUNS scans when scheduled scans are left) the two
// amounts are resampled from his own scans and days (a bootstrap over RESAMPLES replays of the rest of the month, drawn with
// a small seeded generator so the same data always gives the same figures): the median is `expected`, the 10th and 90th
// percentiles `low` and `high`. With less, the forecast is the most his settings allow (the per-scan cap for each
// scheduled scan, the daily allowance for each day, his limit where the blocker holds it) and the method says it is a
// bound. docs/decisions.md, "Costs: the forecast", says why this and not a fitted model.

import type { CostForecast, CostUnit } from './types';
import { addDays, daysInMonth, monthOf, shortDay } from './time';
import { plural, range } from './words';

/** Complete days of history below which the forecast is the settings' bound. */
export const MIN_HISTORY_DAYS = 7;
/** Scans of history below which scheduled scans left are not resampled (the forecast is the settings' bound). */
export const MIN_HISTORY_RUNS = 5;
/** Replays of the rest of the month. */
export const RESAMPLES = 2000;
/** History older than this is not resampled: the owner's use in a season long gone says little about this month. */
export const HISTORY_WINDOW_DAYS = 60;

/** A small, fast, seeded generator (mulberry32): the same seed gives the same draws, so tests are exact. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from text (FNV-1a), so each service and month has its own fixed draws. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** What the owner's settings allow, for the forecast without enough history. A null amount is not bounded by a setting. */
export interface SettingsBound {
  /** At most per scheduled scan (the per-scan cap). */
  perRun: number | null;
  /** At most per day besides scheduled scans (a daily allowance, a refill). */
  perDay: number | null;
  /** A limit nothing passes (the AI limit; another limit while the blocker holds it). */
  cap: number | null;
  /** The settings in words, after "the most your settings allow: ". */
  words: string;
}

export interface ForecastInput {
  unit: CostUnit;
  used: number;
  /** Of `used`, today's use besides scheduled scans so far. */
  todayUsed: number;
  limit: number | null;
  /** Local "YYYY-MM-DD". */
  today: string;
  /** What each scan in the history window used. */
  runSamples: readonly number[];
  /** What each complete day in the history window used besides scheduled scans (days with none included). */
  daySamples: readonly number[];
  /** The local dates of the scheduled scans left this month, one entry a scan (today's still to come included). */
  runsLeft: readonly string[];
  bound: SettingsBound | null;
  seed: number;
  resamples?: number;
}

const roundTo = (n: number, unit: CostUnit): number => (unit === 'usd' ? Math.round(n * 100) / 100 : Math.round(n));
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const percentile = (sorted: readonly number[], p: number): number => sorted[Math.round(p * (sorted.length - 1))]!;

/** Whether the history is enough to resample. */
export function historyEnough(days: number, runs: number, runsLeft: number): boolean {
  return days >= MIN_HISTORY_DAYS && (runsLeft === 0 || runs >= MIN_HISTORY_RUNS);
}

export function forecastService(input: ForecastInput): CostForecast {
  const { unit, used, today } = input;
  const month = monthOf(today);
  const daysAfter = daysInMonth(month) - Number(today.slice(8, 10));
  const days = input.daySamples.length;
  const runs = input.runSamples.length;
  const left = input.runsLeft.length;
  const flat = (basis: CostForecast['basis'], method: string): CostForecast => ({
    expected: roundTo(used, unit), low: roundTo(used, unit), high: roundTo(used, unit), basis, days, runs, limitReachedOn: null, method,
  });

  const quiet = used === 0 && left === 0 && input.daySamples.every((x) => x === 0) && input.runSamples.every((x) => x === 0);

  if (historyEnough(days, runs, left)) {
    if (quiet) return flat('none', `Nothing was used in your ${plural(days, 'day', 'days')} of history and no scan is scheduled, so nothing more is expected this month.`);
    const random = seededRandom(input.seed);
    const n = Math.max(100, input.resamples ?? RESAMPLES);
    const pick = (xs: readonly number[]): number => xs[Math.floor(random() * xs.length)]!;
    const totals: number[] = [];
    for (let b = 0; b < n; b++) {
      let total = used + Math.max(0, pick(input.daySamples) - input.todayUsed);
      for (let d = 0; d < daysAfter; d++) total += pick(input.daySamples);
      for (let r = 0; r < left; r++) total += pick(input.runSamples);
      totals.push(total);
    }
    totals.sort((a, b) => a - b);
    const median = percentile(totals, 0.5);
    const scans = left > 0 ? `, each scan ${range(Math.min(...input.runSamples), Math.max(...input.runSamples), unit)}` : '';
    const method = `From your ${plural(days, 'day', 'days')}${left > 0 ? ` and ${plural(runs, 'scan', 'scans')}` : ''} of history: a day used `
      + `${range(Math.min(...input.daySamples), Math.max(...input.daySamples), unit)}${scans}; `
      + `${plural(daysAfter, 'day', 'days')}${left > 0 ? ` and ${plural(left, 'scheduled scan', 'scheduled scans')}` : ''} ${daysAfter === 1 && left === 0 ? 'is' : 'are'} left, `
      + `and 8 in 10 of ${n.toLocaleString('en-US')} replays of the rest of the month end in the range shown.`;
    return {
      expected: roundTo(median, unit), low: roundTo(percentile(totals, 0.1), unit), high: roundTo(percentile(totals, 0.9), unit),
      basis: 'history', days, runs, limitReachedOn: reachedOn(input, median, daysAfter), method,
    };
  }

  const b = input.bound;
  const thin = `Only ${plural(days, 'day', 'days')} of history (${MIN_HISTORY_DAYS} are needed${left > 0 ? `, and ${MIN_HISTORY_RUNS} scans` : ''} to forecast from it)`;
  if (!b) return flat('none', `${thin}, and no setting bounds it, so this is only what was used so far.`);
  const unbounded = (b.perRun === null && left > 0) || b.perDay === null;
  let most = unbounded ? Number.POSITIVE_INFINITY : used + left * (b.perRun ?? 0) + (daysAfter + 1) * (b.perDay ?? 0);
  if (b.cap !== null) most = Math.min(most, Math.max(used, b.cap));
  if (!Number.isFinite(most)) return flat('none', `${thin}, and no setting bounds it, so this is only what was used so far.`);
  if (quiet && most === 0) return flat('none', 'Nothing was used this month and nothing is scheduled.');
  const bound = roundTo(most, unit);
  return {
    expected: bound, low: roundTo(used, unit), high: bound, basis: 'settings', days, runs, limitReachedOn: null,
    method: `${thin}, so this is the most your settings allow by month's end: ${b.words}.`,
  };
}

/** The day the median path reaches the limit: the forecast spread over the days left as the average scan and day fall. */
function reachedOn(input: ForecastInput, median: number, daysAfter: number): string | null {
  const { limit, used, today } = input;
  if (limit === null) return null;
  if (used >= limit) return today;
  if (median < limit) return null;
  const perDay = mean(input.daySamples);
  const perRun = mean(input.runSamples);
  const scansOn = (d: string): number => input.runsLeft.filter((x) => x === d).length;
  const dates = [today, ...Array.from({ length: daysAfter }, (_, i) => addDays(today, i + 1))];
  const parts = dates.map((d, i) => (i === 0 ? Math.max(0, perDay - input.todayUsed) : perDay) + perRun * scansOn(d));
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  const scale = (median - used) / sum;
  let cum = used;
  for (let i = 0; i < dates.length; i++) {
    cum += parts[i]! * scale;
    if (cum >= limit - 1e-9) return dates[i]!;
  }
  return dates[dates.length - 1]!;
}

/** "Expected to reach your limit on Nov 28" and the like, for a forecast that names a day. */
export const reachWords = (date: string): string => `Expected to reach your limit on ${shortDay(date)}`;

