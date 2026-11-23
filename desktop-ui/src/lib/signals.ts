// What the inspector says about a watched bundle's last scan (docs/design.md, Desktop app > Deal inspector > Signals).
// The agent's own judgement is the source of truth (core/src/tracking/signals.ts decides buyNow); this module only words
// it for the screen, from the numbers the agent sent: a verdict, then one line each for the margin, the sales and the
// events. It never works a verdict out itself (CLAUDE.md rule 4) and every dollar it writes is an estimate.

import type { DealSignals, OptionSignals, Signal, Velocity } from '../api/types';
import { MINUS, count, money } from './format';

/** The way to sell the verdict is about: the one worth buying now, else the primary one (the first the agent lists). */
export function focusOption(s: DealSignals): OptionSignals | null {
  const id = s.buyNow?.optionId ?? null;
  return (id ? s.options.find((o) => o.optionId === id) : undefined) ?? s.options[0] ?? null;
}

/** "Sells about 120 a month (Keepa)": the slowest part's figure; or the words for a part Keepa gave none for. */
export function velocityWords(v: Velocity): { text: string; sub: string | null; tone: 'quiet' | 'attention' } {
  if (v.status === 'no_data') {
    const missing = v.parts.filter((p) => p.monthlySold === null).map((p) => p.model);
    return {
      text: 'No sales data — Keepa leaves it out for slow sellers.',
      sub: missing.length > 0 ? `No figure for ${list(missing)}.` : 'This way to sell has no parts yet.',
      tone: 'quiet',
    };
  }
  const n = v.slowest!.monthlySold;
  const multi = v.parts.length > 1;
  const sub = `${multi ? `The slowest part is ${v.slowest!.model}. ` : ''}Your minimum is ${count(v.minMonthlySold)} a month.`;
  return v.status === 'pass'
    ? { text: `Sells about ${count(n)} a month (Keepa).`, sub, tone: 'quiet' }
    : { text: `Sells about ${count(n)} a month (Keepa), under your minimum.`, sub, tone: 'attention' };
}

const list = (xs: string[]): string => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** A whole percent with a real minus (the agent sends percents, not fractions). */
const pct = (n: number): string => `${n < 0 && Math.round(n) !== 0 ? MINUS : ''}${Math.abs(Math.round(n))}%`;

/**
 * How the way to sell's estimate compares with the last scan and the 7-day average, and with the owner's numbers when a
 * signal carries them. One sentence; every figure comes from the agent.
 */
export function marginWords(o: OptionSignals, thresholds: { minProfit: number; minRoiPercent: number } | null): string | null {
  if (o.profit === null || o.roiPercent === null) return null;
  const parts: string[] = [`Estimated profit is ${money(o.profit)} (${pct(o.roiPercent)} ROI)`];
  const last = o.baseline.last?.profit ?? null;
  if (last !== null) {
    const d = o.profit - last;
    parts.push(Math.abs(d) < 0.005 ? `unchanged from the last scan (${money(last)})` : `${d > 0 ? 'up' : 'down'} ${money(Math.abs(d))} from the last scan (${money(last)})`);
  }
  const avg = o.baseline.rolling7d;
  if (avg) {
    const d = o.profit - avg.profit;
    parts.push(Math.abs(d) < 0.005 ? `level with its 7-day average (${money(avg.profit)}, ${avg.points} ${avg.points === 1 ? 'scan' : 'scans'})` : `${money(Math.abs(d))} ${d > 0 ? 'above' : 'below'} its 7-day average of ${money(avg.profit)} (${avg.points} ${avg.points === 1 ? 'scan' : 'scans'})`);
  }
  let text = parts.length === 1 ? parts[0]! : `${parts[0]}, ${parts.slice(1).join(' and ')}`;
  if (thresholds) text += `. Your numbers: ${money(thresholds.minProfit)} and ${pct(thresholds.minRoiPercent)}`;
  return `${text}.`;
}

export interface Reason {
  /** The row's label: Margin, Sales, Review, Confirmed, Margin fell. */
  label: string;
  text: string;
  sub?: string | null;
  tone: 'quiet' | 'attention';
  /** A labelled link to where the figure came from (rule: verify from source). */
  asin?: { asin: string; model: string } | null;
}

export interface Verdict {
  buyNow: boolean;
  /** "Worth buying now" or "Not worth buying now". */
  headline: string;
  /** The one sentence: what the verdict is about, or why not. */
  sentence: string;
  /** The way to sell it is about; null when the bundle has none with an estimate. */
  way: string | null;
  reasons: Reason[];
}

/** A signal's reason with a real minus in place of the agent's ASCII hyphen before a dollar sign. */
const typo = (s: string): string => s.replace(/(^|[\s(])-\$/g, '$1−$');

const of = (s: DealSignals, kind: Signal['kind']): Signal[] => s.signals.filter((x) => x.kind === kind);

export function verdictOf(s: DealSignals): Verdict {
  const o = focusOption(s);
  const buy = s.buyNow !== null;
  const reasons: Reason[] = [];
  const multi = s.options.length > 1;
  const way = o ? o.label : null;

  const own = o ? s.signals.find((x) => x.optionId === o.optionId) : undefined;
  const thresholds = own ? { minProfit: own.numbers.minProfit, minRoiPercent: own.numbers.minRoiPercent } : null;

  if (o) {
    const margin = marginWords(o, thresholds);
    if (margin) reasons.push({ label: 'Margin', text: margin, tone: 'quiet' });
    const v = velocityWords(o.velocity);
    const slow = o.velocity.slowest ? o.velocity.parts.find((p) => p.model === o.velocity.slowest!.model && p.asin) : undefined;
    reasons.push({ label: 'Sales', text: v.text, sub: v.sub, tone: v.tone, asin: slow?.asin ? { asin: slow.asin, model: slow.model } : null });
  }
  for (const e of of(s, 'reviewCleared')) reasons.push({ label: 'Review', text: typo(e.reason), tone: 'quiet' });
  for (const e of of(s, 'discoveryDone')) reasons.push({ label: 'Confirmed', text: typo(e.reason), tone: 'quiet' });
  for (const e of of(s, 'marginDown')) reasons.push({ label: 'Margin fell', text: typo(e.reason), tone: 'attention' });

  let sentence: string;
  if (buy && o) {
    sentence = `${o.profit !== null && o.roiPercent !== null ? `An estimated ${money(o.profit)} profit (${pct(o.roiPercent)} ROI)` : 'This way to sell'}${multi ? ` selling as “${o.label}”` : ''} clears your numbers, sells fast enough and has improved.`;
  } else if (o?.notBuyNow) {
    sentence = typo(o.notBuyNow);
  } else {
    sentence = 'No way to sell has an estimate yet, so there is nothing to judge.';
  }
  return { buyNow: buy, headline: buy ? 'Worth buying now' : 'Not worth buying now', sentence, way, reasons };
}
