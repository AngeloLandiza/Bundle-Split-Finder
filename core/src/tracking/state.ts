// The watchlist and what each scan adds to it (Keepa plan §3, §6): which bundles are watched, their stored history,
// the signals of the last scan, and which signals were already sent today. Pure: the agent stores the result.

import type { AlertSettings } from '../settings';
import { partKey, type BundleRow, type ScanReport } from '../scan/types';
import type { BogoPromotion } from './bogo';
import type { BogoPair } from './bogoPairs';
import { appendHistory, bundleSignals, HISTORY_DAYS, historyPoint, type BundleSignals, type HistoryPoint, type Signal, type SignalKind, type TrendLookup } from './signals';

/** auto: watched because it was confirmed and discounted; owner: the owner pressed Watch or Unwatch. */
export interface WatchEntry {
  watched: boolean;
  by: 'auto' | 'owner';
  since: number;
}

export interface TrackingState {
  watch: Record<string, WatchEntry>;
  history: Record<string, HistoryPoint[]>;
  /**
   * The last judged signals of each bundle. Signals round 3: of every bundle (the verdict line shows on every row with an
   * estimate), watched or not; only a watched bundle's signals go in a digest (freshSignals).
   */
  signals: Record<string, BundleSignals>;
  /** `${bundleKey}|${signal}|${day}` already sent in a digest, newest last. */
  notified: string[];
  /** The owner's BOGO promotions by bundle key (bogo.ts). */
  bogo: Record<string, BogoPromotion>;
  /** BOGO found by the agent: the starter + free tool pairs Home Depot lists, by the pair's bundle key (bogoPairs.ts). */
  bogoPairs: Record<string, BogoPair>;
}

export const emptyTracking = (): TrackingState => ({ watch: {}, history: {}, signals: {}, notified: [], bogo: {}, bogoPairs: {} });

const KEEP_NOTIFIED = 2000;

/** Watched automatically: confirmed (every part for sale) and discounted on Home Depot. */
export const autoWatch = (row: BundleRow): boolean => row.section === 'confirmed' && (row.percentOff ?? 0) > 0;

export function isWatched(state: TrackingState, key: string): boolean {
  return state.watch[key]?.watched === true;
}

/** The owner's Watch or Unwatch: it stays as the owner set it; a scan no longer changes it. */
export function setWatch(state: TrackingState, key: string, watched: boolean, now: number): TrackingState {
  return { ...state, watch: { ...state.watch, [key]: { watched, by: 'owner', since: now } } };
}

/** Bundle keys a Review question holds up now: a split by its bundle, a match by every bundle with that part in a way to sell. */
export function bundlesWithOpenQuestions(report: Pick<ScanReport, 'bundles' | 'review'>): Set<string> {
  const open = report.review.filter((q) => q.answer === null);
  const out = new Set(open.filter((q) => q.kind === 'split').map((q) => q.subject));
  const parts = new Set(open.filter((q) => q.kind === 'match').map((q) => q.subject));
  for (const b of report.bundles) {
    const models = new Set([...b.parts, ...b.options.flatMap((o) => o.parts)].map((p) => partKey(b.brand, p.model)));
    if ([...models].some((k) => parts.has(k))) out.add(b.key);
  }
  return out;
}

/** What the agent knows beside the report: whether Keepa can be asked, and the owner's flat fulfillment fee. */
export interface SignalOpts {
  keepa?: boolean;
  flatFee?: number;
}

const signalOpts = (o: SignalOpts) => ({ ...(o.keepa !== undefined ? { keepa: o.keepa } : {}), ...(o.flatFee !== undefined ? { flatFee: o.flatFee } : {}) });

/**
 * After a scan: bundles that are now confirmed and discounted become watched (unless the owner unwatched them), every
 * bundle's point is added to its history, and each watched bundle's signals are computed against the history before
 * this scan. History of bundles not seen for HISTORY_DAYS goes.
 */
export function trackReport(
  state: TrackingState,
  report: Pick<ScanReport, 'bundles' | 'review'>,
  trend: TrendLookup,
  alerts: AlertSettings,
  now: number,
  opts: SignalOpts = {},
): TrackingState {
  const open = bundlesWithOpenQuestions(report);
  const watch = { ...state.watch };
  const history: Record<string, HistoryPoint[]> = {};
  const signals: Record<string, BundleSignals> = {};
  for (const row of report.bundles) {
    if (!watch[row.key] && autoWatch(row)) watch[row.key] = { watched: true, by: 'auto', since: now };
    const before = state.history[row.key] ?? [];
    signals[row.key] = bundleSignals({ row, history: judgedBy(before, historyPoint(row, open.has(row.key), trend, now)), reviewOpen: open.has(row.key), trend, alerts, now, ...signalOpts(opts) });
    history[row.key] = appendHistory(before, historyPoint(row, open.has(row.key), trend, now), now);
  }
  // Bundles this report does not hold keep their history until it is too old.
  for (const [key, points] of Object.entries(state.history)) {
    if (history[key]) continue;
    const kept = points.filter((p) => now - p.at <= HISTORY_DAYS * 86_400_000);
    if (kept.length > 0) history[key] = kept;
  }
  return { ...state, watch, history, signals };
}

/**
 * Signals round 2: the history a point is judged against. When the point has every part's sales figure and the points
 * before it did not, those points are left out: the change they saw (newly confirmed, first seen, risen through the
 * numbers) was never judged with sales data, so it is judged now, once the figure has come. Otherwise the history as is.
 */
export function judgedBy(history: readonly HistoryPoint[], point: HistoryPoint): HistoryPoint[] {
  let end = history.length;
  if (point.monthlySold !== null) while (end > 0 && history[end - 1]!.monthlySold === null) end -= 1;
  return history.slice(0, end);
}

/** The figures a point is judged on (not the Keepa velocity fields): equal means no estimate, section or Review change. */
export function sameFigures(a: HistoryPoint, b: HistoryPoint): boolean {
  return (
    a.section === b.section && a.price === b.price && a.amazonNew === b.amazonNew && a.reviewOpen === b.reviewOpen &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => {
      const x = b.options[i]!;
      return o.id === x.id && o.profit === x.profit && o.roiPercent === x.roiPercent && (o.unconfirmed ?? 0) === (x.unconfirmed ?? 0);
    })
  );
}

/** What a verdict rests on, to tell a changed verdict from the same one evaluated again. */
const verdictKey = (s: BundleSignals): string =>
  [s.signals.map((x) => `${x.kind}:${x.optionId ?? ''}`).join(','), s.options.map((o) => `${o.optionId}:${o.velocity.status}:${o.notBuyNow ?? ''}`).join(',')].join('|');

/**
 * Signals round 2: the signals evaluated whenever a bundle's estimate or completeness changes between scans (the drip's
 * lookups and price pulls, the catalog check, an owner's answer, Undo or confirmed price, the agent's start), by the same
 * rules as a scan (bundleSignals). Bundles confirmed and discounted become watched, as at a scan.
 *
 * A bundle whose figures moved since its last stored point is judged against its history and gets a new point (so the next
 * scan's baseline has it). One whose figures did not move is judged again against the history its last point was judged
 * by, with the Keepa figures stored now: a sales figure that arrived since can turn the verdict, and nothing else does.
 * `evaluated`: the bundles whose signals are new or changed (their buy signals may go in a digest, once a day each);
 * a verdict that came out the same keeps its stored signals.
 */
export function retrackReport(
  state: TrackingState,
  report: Pick<ScanReport, 'bundles' | 'review'>,
  trend: TrendLookup,
  alerts: AlertSettings,
  now: number,
  opts: SignalOpts = {},
): { state: TrackingState; evaluated: string[] } {
  const open = bundlesWithOpenQuestions(report);
  const watch = { ...state.watch };
  const history = { ...state.history };
  const signals = { ...state.signals };
  const evaluated: string[] = [];
  for (const row of report.bundles) {
    if (!watch[row.key] && autoWatch(row)) watch[row.key] = { watched: true, by: 'auto', since: now };
    const before = state.history[row.key] ?? [];
    const point = historyPoint(row, open.has(row.key), trend, now);
    const last = before.at(-1);
    const same = last !== undefined && sameFigures(last, point);
    const prior = same ? before.slice(0, -1) : before;
    const next = bundleSignals({ row, history: judgedBy(prior, point), reviewOpen: open.has(row.key), trend, alerts, now, ...signalOpts(opts) });
    const old = state.signals[row.key];
    if (!same || !old || verdictKey(old) !== verdictKey(next) || old.verdict === undefined) {
      signals[row.key] = next;
      evaluated.push(row.key);
    }
    history[row.key] = same ? [...prior, { ...point, at: last!.at }] : appendHistory(before, point, now);
  }
  return { state: { ...state, watch, history, signals }, evaluated };
}

/** The owner's local calendar day, for "once a day" per bundle and signal. */
export function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const notifiedKey = (bundleKey: string, kind: SignalKind, at: number): string => `${bundleKey}|${kind}|${dayOf(at)}`;

export interface SignalLine {
  bundleKey: string;
  brand: string;
  model: string;
  signal: Signal;
}

/**
 * The signals of `kinds` not yet sent today, best estimated profit first, and the notified list with them added. `only`:
 * the bundles to consider (a between-scan evaluation names those it judged again; a scan considers every one).
 */
export function freshSignals(state: TrackingState, kinds: readonly SignalKind[], now: number, only?: ReadonlySet<string>): { lines: SignalLine[]; notified: string[] } {
  const sent = new Set(state.notified);
  const lines: SignalLine[] = [];
  for (const s of Object.values(state.signals)) {
    if (!isWatched(state, s.bundleKey)) continue;
    if (only && !only.has(s.bundleKey)) continue;
    for (const kind of kinds) {
      // One line per bundle and kind: for buyNow the best way to sell, else the first that fired.
      const sig = kind === 'buyNow' ? s.buyNow : s.signals.find((x) => x.kind === kind);
      if (!sig || sent.has(notifiedKey(s.bundleKey, kind, now))) continue;
      lines.push({ bundleKey: s.bundleKey, brand: s.brand, model: s.model, signal: sig });
    }
  }
  lines.sort((a, b) => (b.signal.numbers.profit ?? -Infinity) - (a.signal.numbers.profit ?? -Infinity));
  const notified = [...state.notified, ...lines.map((l) => notifiedKey(l.bundleKey, l.signal.kind, now))].slice(-KEEP_NOTIFIED);
  return { lines, notified };
}
