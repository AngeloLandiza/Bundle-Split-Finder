// Which bundles Today lists (docs/design.md, Desktop app > Screens > Today). Pure, so the rule is tested once.

import type { DealRow } from '../api/types';
import { waitingState } from './dealReason';
import { matchWords } from './matchWords';

const byProfit = (a: DealRow, b: DealRow): number => (b.profit ?? 0) - (a.profit ?? 0);

/**
 * Best deals: the highest estimates among bundles with no open question. An estimate below zero is not a deal, so it never
 * appears here (the D1 report found losses listed); it is under Losing money in the sidebar.
 */
export function bestDeals(rows: readonly DealRow[]): DealRow[] {
  return rows.filter((r) => r.profit !== null && r.profit >= 0 && !r.needsAnswer).sort(byProfit);
}

/** Worth buying now: the bundles the last scan judged so, highest estimated profit first. The scan decides; this never does. */
export function buyNowDeals(rows: readonly DealRow[]): DealRow[] {
  return rows.filter((r) => r.buyNow && r.profit !== null && !r.needsAnswer).sort(byProfit);
}

/** The agent may send a one-line verdict on a row (`signalNote`: "Sells about 40 a month, above your floor"); the row's type does not name it yet. */
type WithNote = DealRow & { signalNote?: string | null };

/**
 * The one line under a deal on Today: the agent's own note when it sent one, otherwise how far the parts are confirmed on
 * Amazon, in the owner's words (`matchWords`). It is what makes "+$69 est." believable or not, so it is not left blank when
 * the row has a state. Nothing here is worked out from figures; it only reads what the row already says.
 */
export function dealVerdict(r: DealRow): { text: string; fromAgent: boolean } | null {
  const note = (r as WithNote).signalNote?.trim();
  if (note) return { text: note, fromAgent: true };
  const text = waitingState(r) ?? matchWords(r.matchState);
  return text ? { text, fromAgent: false } : null;
}
