// The history chart's arithmetic (components/HistoryChart.tsx draws it). Pure: scales, ticks, the path of a line that
// breaks where a scan had no figure, and which scan the pointer is nearest. Nothing here fills a missing figure in:
// a null is a gap in the line and "no figure" in the tooltip, never a guess (CLAUDE.md rule 4).

import type { DealHistoryPoint } from '../api/types';
import { MINUS, count, money, profit } from './format';

export type ChartKind = 'prices' | 'profit' | 'sold' | 'rank';

export const CHART_LABEL: Record<ChartKind, string> = { prices: 'Prices', profit: 'Profit', sold: 'Sold a month', rank: 'Sales rank' };

export interface Series {
  key: string;
  label: string;
  /** The tooltip's shorter name for it. */
  short: string;
  /** One value per scan, in the scans' order; null where the scan had no figure. */
  values: (number | null)[];
  /** Which token colours the line. */
  tone: 'ink' | 'accent' | 'profit';
  dashed?: boolean;
}

export interface ChartData {
  kind: ChartKind;
  /** Scan times, epoch ms, oldest first. */
  times: number[];
  series: Series[];
  /** How a value reads in the tooltip and in the screen reader line. */
  format: (v: number) => string;
  /** How a value reads on the axis (shorter). */
  axis: (v: number) => string;
  /** Said under the chart: what the figures are and that they are estimates where they are. */
  note: string;
}

const dollars = (v: number): string => `${v < 0 ? MINUS : ''}$${count(Math.abs(Math.round(v)))}`;

/** The points in time order; the agent sends them oldest first, but a chart must not depend on it. */
export function sorted(history: readonly DealHistoryPoint[]): DealHistoryPoint[] {
  return [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Which charts the history can draw: a chart needs two scans that have a figure for it. */
export function chartKinds(history: readonly DealHistoryPoint[]): ChartKind[] {
  const has = (f: (p: DealHistoryPoint) => number | null) => history.filter((p) => f(p) !== null).length >= 2;
  const out: ChartKind[] = [];
  if (has((p) => p.price) || has((p) => p.amazonNew)) out.push('prices');
  if (has((p) => p.profit)) out.push('profit');
  if (has((p) => p.monthlySold)) out.push('sold');
  if (has((p) => p.salesRank)) out.push('rank');
  return out;
}

export function chartOf(history: readonly DealHistoryPoint[], kind: ChartKind): ChartData {
  const pts = sorted(history);
  const times = pts.map((p) => Date.parse(p.at));
  switch (kind) {
    case 'prices':
      return {
        kind,
        times,
        series: [
          { key: 'price', label: 'You pay at Home Depot', short: 'Home Depot', values: pts.map((p) => p.price), tone: 'ink', dashed: true },
          { key: 'amazon', label: 'Amazon New, counted parts', short: 'Amazon New', values: pts.map((p) => p.amazonNew), tone: 'accent' },
        ],
        format: money,
        axis: dollars,
        note: 'The bundle’s price at each scan, and what its counted parts sell for on Amazon New before fees.',
      };
    case 'profit':
      return {
        kind,
        times,
        series: [{ key: 'profit', label: 'Estimated profit', short: 'Est. profit', values: pts.map((p) => p.profit), tone: 'profit' }],
        format: profit,
        axis: dollars,
        note: 'Estimated profit at each scan, from your fee settings. An estimate, not your real Amazon fees.',
      };
    case 'sold':
      return {
        kind,
        times,
        series: [{ key: 'sold', label: 'Sold a month, slowest part (Keepa)', short: 'Sold (Keepa)', values: pts.map((p) => p.monthlySold), tone: 'accent' }],
        format: (v) => `${count(v)} a month`,
        axis: (v) => count(v),
        note: 'Keepa’s monthly sales of the slowest part. Keepa gives an estimate, and leaves it out for slow sellers.',
      };
    case 'rank':
      return {
        kind,
        times,
        series: [{ key: 'rank', label: 'Sales rank, slowest part (Keepa)', short: 'Rank (Keepa)', values: pts.map((p) => p.salesRank), tone: 'accent' }],
        format: (v) => `#${count(v)}`,
        axis: (v) => (v >= 10_000 ? `${count(Math.round(v / 1000))}k` : count(v)),
        note: 'Keepa’s sales rank of the part that ranks lowest. A lower number sells more.',
      };
  }
}

/** The smallest and largest figure across the series, or null when there is none. */
export function extent(series: readonly Series[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo === Infinity ? null : [lo, hi];
}

/** A round step (1, 2, 2.5, 5 times a power of ten) that fits about `target` intervals into the span. */
export function niceStep(span: number, target: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/** An axis that holds [lo, hi] with round ticks. A flat series gets a span around its one value. */
export function niceScale(lo: number, hi: number, target = 3): Scale {
  let a = lo;
  let b = hi;
  if (a === b) {
    const pad = Math.max(1, Math.abs(a) * 0.1);
    a -= pad;
    b += pad;
  }
  const step = niceStep(b - a, target);
  const min = Math.floor(a / step) * step;
  const max = Math.ceil(b / step) * step;
  const ticks: number[] = [];
  // Rounding each tick keeps 0.1 + 0.2 from drawing a label at 0.30000000000000004.
  for (let t = min, i = 0; t <= max + step / 1e6 && i < 50; t += step, i++) ticks.push(Math.round(t * 1e6) / 1e6);
  return { min: ticks[0]!, max: ticks.at(-1)!, ticks };
}

/**
 * The SVG path of one line. A null breaks it, so a scan with no figure is a gap and the line never runs across it.
 * An isolated figure (its neighbours are null) has no line to draw; the chart marks it with a dot (`isolated`).
 */
export function linePath(values: readonly (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Indexes whose figure has no neighbour to join: drawn as dots. */
export function isolated(values: readonly (number | null)[]): number[] {
  return values.flatMap((v, i) => (v !== null && values[i - 1] == null && values[i + 1] == null ? [i] : []));
}

/** The scan nearest in time to a position along the axis (a fraction 0..1 of the span). */
export function nearestScan(times: readonly number[], fraction: number): number {
  if (times.length === 0) return -1;
  const first = times[0]!;
  const span = times.at(-1)! - first;
  if (span <= 0) return 0;
  const at = first + Math.min(1, Math.max(0, fraction)) * span;
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs(times[i]! - at) < Math.abs(times[best]! - at)) best = i;
  return best;
}

/** "Nov 16" over a span of days, "2:30 PM" inside two days. */
export function axisTime(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs < 2 * 86_400_000) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The full moment for the tooltip: "Nov 22, 2:30 PM". */
export function tipTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** One line for a screen reader (and the tooltip's text): the moment, then each figure or "no figure". */
export function readout(data: ChartData, i: number): string {
  const parts = data.series.map((s) => `${s.label} ${s.values[i] === null || s.values[i] === undefined ? 'no figure' : data.format(s.values[i] as number)}`);
  return `${tipTime(data.times[i]!)}: ${parts.join('; ')}`;
}
