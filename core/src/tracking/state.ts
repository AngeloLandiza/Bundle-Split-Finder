// The watchlist and what each scan adds to it (Keepa plan §3, §6): which bundles are watched, their stored history,
// the signals of the last scan, and which signals were already sent today. Pure: the agent stores the result.

import type { AlertSettings } from '../settings';
import { partKey, type BundleRow, type ScanReport } from '../scan/types';
import type { BogoPromotion } from './bogo';
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
  /** The last scan's signals of each watched bundle. */
  signals: Record<string, BundleSignals>;
  /** `${bundleKey}|${signal}|${day}` already sent in a digest, newest last. */
  notified: string[];
  /** The owner's BOGO promotions by bundle key (bogo.ts). */
  bogo: Record<string, BogoPromotion>;
}

export const emptyTracking = (): TrackingState => ({ watch: {}, history: {}, signals: {}, notified: [], bogo: {} });

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
): TrackingState {
  const open = bundlesWithOpenQuestions(report);
  const watch = { ...state.watch };
  const history: Record<string, HistoryPoint[]> = {};
  const signals: Record<string, BundleSignals> = {};
  for (const row of report.bundles) {
    if (!watch[row.key] && autoWatch(row)) watch[row.key] = { watched: true, by: 'auto', since: now };
    const before = state.history[row.key] ?? [];
    if (watch[row.key]?.watched) {
      signals[row.key] = bundleSignals({ row, history: before, reviewOpen: open.has(row.key), trend, alerts, now });
    }
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

/** The signals of `kinds` not yet sent today, best estimated profit first, and the notified list with them added. */
export function freshSignals(state: TrackingState, kinds: readonly SignalKind[], now: number): { lines: SignalLine[]; notified: string[] } {
  const sent = new Set(state.notified);
  const lines: SignalLine[] = [];
  for (const s of Object.values(state.signals)) {
    if (!isWatched(state, s.bundleKey)) continue;
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
