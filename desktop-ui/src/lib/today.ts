// Which bundles Today lists (docs/design.md, Desktop app > Screens > Today). Pure, so the rule is tested once.

import type { DealRow } from '../api/types';
import { waitingState } from './dealReason';
import { matchWords } from './matchWords';
import { byBestProfit, isBeforeFulfillment } from './order';

const open = (r: DealRow): boolean => r.profit !== null && r.profit >= 0 && !r.needsAnswer;

/**
 * Best deals: the highest estimates among bundles with no open question. An estimate below zero is not a deal, so it never
 * appears here (the D1 report found losses listed); it is under Losing money in the sidebar. An estimate before fulfillment
 * is never "best" (it overstates), so it is left out; `estimatesBeforeFulfillment` lists those.
 */
export function bestDeals(rows: readonly DealRow[]): DealRow[] {
  return rows.filter((r) => open(r) && !isBeforeFulfillment(r)).sort(byBestProfit);
}

/** Estimates at or above zero that count no fulfillment fee for some part: shown, labelled so, when no full estimate exists. */
export function estimatesBeforeFulfillment(rows: readonly DealRow[]): DealRow[] {
  return rows.filter((r) => open(r) && isBeforeFulfillment(r)).sort(byBestProfit);
}

/** Worth buying now: the bundles the last scan judged so, highest estimated profit first. The scan decides; this never does. */
export function buyNowDeals(rows: readonly DealRow[]): DealRow[] {
  return rows.filter((r) => r.buyNow && !isBeforeFulfillment(r) && r.profit !== null && !r.needsAnswer).sort(byBestProfit);
}

const LONG_NOTE = 90;

/** The agent's note as one short line: past about 90 characters it ends at its first clause break (", " "; " " — "), else at a word. */
export function oneLine(note: string): string {
  const t = note.trim();
  if (t.length <= LONG_NOTE) return t;
  const m = /(, |; | — | - )/g;
  for (let x = m.exec(t); x; x = m.exec(t)) if (x.index >= 30 && x.index <= LONG_NOTE) return t.slice(0, x.index).trimEnd();
  return `${t.slice(0, t.lastIndexOf(' ', LONG_NOTE))}…`;
}

/**
 * The one line under a deal on Today and in the Deals table: the agent's own note (`signalNote`) when it sent one, as one
 * short line with the whole sentence in `full` for the tooltip, otherwise how far the parts are confirmed on Amazon, in the
 * owner's words (`matchWords`). It is what makes "+$69 est." believable or not, so it is not left blank when the row has a
 * state. Nothing here is worked out from figures; it only reads what the row already says.
 */
export function dealVerdict(r: DealRow): { text: string; fromAgent: boolean; full?: string } | null {
  const note = r.signalNote?.trim();
  if (note) {
    const text = oneLine(note);
    return { text, fromAgent: true, ...(text !== note ? { full: note } : {}) };
  }
  const text = waitingState(r) ?? matchWords(r.matchState);
  return text ? { text, fromAgent: false } : null;
}
