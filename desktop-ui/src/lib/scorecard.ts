// Today's scorecard, in words (docs/decisions.md, "Outcomes"). Pure: the screen gives it what the agent said and it says what the
// records back. A figure with no record behind it is never shown: with no purchases it says so and what to do, not $0.
// What he recorded is labelled so; an estimate is labelled an estimate (CLAUDE.md rule 5).

import type { OutcomesResponse } from '@core/api/contract';
import type { DealRow } from '../api/types';
import { MINUS, money, plural, profit, usdSpend } from './format';

export interface ScoreLine {
  id: string;
  label: string;
  /** The figure or sentence at the right. */
  value: string;
  /** Quieter lines under it. */
  sub: string[];
}

export type ScoreRecorded = { kind: 'empty'; title: string; cause: string } | { kind: 'lines'; lines: ScoreLine[] };

export interface Scorecard {
  recorded: ScoreRecorded;
  /** Under the one disclosure: per-deal accuracy, open questions, how many estimates are complete, this month's cost. */
  details: ScoreLine[];
}

export interface ScorecardInputs {
  outcomes: OutcomesResponse;
  /** The deals as the list has them; null while they load. */
  rows: readonly DealRow[] | null;
  /** Questions that need him now, and those the app is still checking; null while unknown. */
  questions: { open: number; working: number } | null;
  /** This month's searches and AI dollars from the agent's own count; null while unknown. */
  month: { searches: number; aiUsd: number } | null;
  aiCapUsd: number | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ym: string): string => MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym;

/** −236% or +12%, one decimal only when it is not whole. */
export function signedPercent(p: number): string {
  const r = Math.round(p * 10) / 10;
  return `${r < 0 ? MINUS : r > 0 ? '+' : ''}${Math.abs(r)}%`;
}

/** "$15.63 below the estimate (−236%)", or "on the estimate". */
export function diffWords(diff: number, percent: number | null): string {
  if (Math.round(Math.abs(diff) * 100) === 0) return 'Exactly on the estimate';
  return `${money(Math.abs(diff))} ${diff < 0 ? 'below' : 'above'} the estimate${percent === null ? '' : ` (${signedPercent(percent)})`}`;
}

export const EMPTY_SCORECARD = {
  title: 'No purchases recorded yet',
  cause: 'When you buy a deal, open it and press I bought this. Record each part as it sells, and this compares what you made with the estimate.',
} as const;

export function scorecard(i: ScorecardInputs): Scorecard {
  const { scorecard: card, purchases } = i.outcomes;
  const month = monthName(card.month);
  const details: ScoreLine[] = [];

  let recorded: ScoreRecorded;
  if (purchases.length === 0) {
    recorded = { kind: 'empty', ...EMPTY_SCORECARD };
  } else {
    const lines: ScoreLine[] = [];
    // Profit realised this month: sold parts only.
    if (card.realised) {
      const r = card.realised;
      const sub = ['Recorded by you, from the parts you marked sold or returned.'];
      const partial = r.partsSettled < r.partsOfThoseDeals;
      sub.unshift(partial ? `${r.partsSettled} of ${r.partsOfThoseDeals} parts ${r.partsSold === r.partsSettled ? 'sold' : 'sold or returned'}${r.deals > 1 ? ` across ${r.deals} deals` : ''}` : `All ${r.partsOfThoseDeals} parts sold or returned${r.deals > 1 ? ` across ${r.deals} deals` : ''}`);
      if (r.feesEstimated) sub.push('Some net amounts are the sale price less your fee settings at purchase (fees estimated). Add a net payout to replace them.');
      lines.push({ id: 'realised', label: `Profit realised in ${month}`, value: profit(r.profit), sub });
    } else {
      lines.push({ id: 'realised', label: `Profit realised in ${month}`, value: `Nothing sold yet in ${month}`, sub: [`${plural(purchases.length, 'purchase', 'purchases')} recorded. Mark each part sold, still holding or returned as it happens.`] });
    }
    // Estimate accuracy on completed deals only.
    if (card.accuracy) {
      const a = card.accuracy;
      lines.push({
        id: 'accuracy',
        label: 'Estimate accuracy',
        value: diffWords(a.diff, a.diffPercent),
        sub: [`${plural(a.deals, 'completed deal', 'completed deals')}: made ${profit(a.actual)} (recorded by you) against ${profit(a.estimated)} estimated.`],
      });
      for (const d of a.perDeal) {
        details.push({ id: `deal-${d.purchaseId}`, label: d.title, value: diffWords(d.diff, d.diffPercent), sub: [`Made ${profit(d.actual)} (recorded) against ${profit(d.estimated)} estimated.`] });
      }
    } else {
      lines.push({ id: 'accuracy', label: 'Estimate accuracy', value: 'No completed deal yet', sub: ['A deal is complete when every part is sold or returned. Then this compares what you made with the estimate.'] });
    }
    // Flagged Buy now against bought.
    const flaggedNow = i.rows ? i.rows.filter((r) => r.buyNow).length : null;
    lines.push({
      id: 'flagged',
      label: 'Flagged Buy now and bought',
      value: `${flaggedNow === null ? '' : `${flaggedNow} flagged now · `}${purchases.length} bought`,
      sub: [`${card.flaggedWhenBought} of the ${purchases.length} bought ${purchases.length === 1 ? 'was' : 'were'} flagged Buy now when you bought ${purchases.length === 1 ? 'it' : 'them'}.`],
    });
    recorded = { kind: 'lines', lines };
  }

  // The rest are the app's own records, shown whether or not he has bought anything.
  if (i.questions) {
    const { open, working } = i.questions;
    details.push({ id: 'questions', label: 'Open questions now', value: open === 0 ? 'None' : String(open), sub: working > 0 ? [`${plural(working, 'more is', 'more are')} being checked by the app.`] : [] });
  }
  if (i.rows) {
    const total = i.rows.length;
    const complete = i.rows.filter((r) => r.profit !== null).length;
    details.push({
      id: 'complete',
      label: 'Bundles with a complete estimate',
      value: total === 0 ? 'No bundles found yet' : `${complete} of ${total} (${Math.round((complete / total) * 100)}%)`,
      sub: total === 0 ? [] : ['An estimate is complete when every part has a counted price.'],
    });
  }
  if (i.month) {
    details.push({
      id: 'cost',
      label: `Running cost, ${month}`,
      value: `${plural(i.month.searches, 'search', 'searches')} · ${usdSpend(i.month.aiUsd)} AI`,
      sub: i.aiCapUsd ? [`AI cap ${money(i.aiCapUsd)} a month.`] : [],
    });
  }
  return { recorded, details };
}
