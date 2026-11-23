// The one line under a deal's title (docs/ux-checklist.md item 1: the row shows the estimate and a one-line reason),
// and the waiting states a row can be in.

import type { DealRow } from '../api/types';
import { matchWords } from './matchWords';
import { incompleteLine } from './incomplete';
import { WAITING_PAGE_LABEL } from './scanProblem';

export const WAITING_AMAZON_LABEL = 'Waiting for an Amazon lookup';
export const WAITING_PARTS_LABEL = 'Waiting for Home Depot’s part pages';

/** The row's neutral waiting state, or null when it does not wait. A page not read comes first: nothing else can happen before it. */
export function waitingState(r: Pick<DealRow, 'matchKind' | 'lookup'>): string | null {
  if (r.matchKind === 'waiting_page') return WAITING_PAGE_LABEL;
  if (r.matchKind === 'waiting_parts') return WAITING_PARTS_LABEL;
  if (r.lookup) return WAITING_AMAZON_LABEL;
  return null;
}

/** Below this table width the Match column is hidden (Table's `hideBelow: 720`). */
export const MATCH_HIDDEN_BELOW = 720;

/** Whether the Match column shows in a table this wide (its container query hides it at 720px and under). */
export const matchColumnShown = (tableWidth: number): boolean => tableWidth > MATCH_HIDDEN_BELOW;

/**
 * The line under a deal's model, only when it tells the owner something the row's other columns do not. The Match column
 * already says "3 parts matched", "Needs your answer" or what the bundle waits for, and Estimated profit has the figure;
 * repeating either is the clutter a third line adds to every row. So the line is:
 * - what the Match column would have said, while that column is hidden (a narrow window or a wide inspector);
 * - the BOGO group's own sentence (best pair and its estimate), which no column shows;
 * - Nov 23: for a bundle missing a price, how many parts are priced and the break-even ("2 of 3 parts priced ·
 *   DCK200D1P1 needs about $186.76 to break even"), which no column shows: its profit and ROI are "—";
 * and nothing otherwise: the row stays two lines (docs/ux-checklist.md item 1 asks for the reason, not for filler).
 * Built only from what the row already has; nothing is looked up or worked out here.
 */
export function dealReason(r: DealRow, o: { matchShown: boolean }): string | null {
  const parts: string[] = [];
  if (!o.matchShown) {
    const waiting = waitingState(r);
    // A question is already the "Needs answer" tag that moves into the profit cell when Match hides: not said twice.
    if (waiting) parts.push(waiting);
    else if (!r.needsAnswer && r.matchState) parts.push(matchWords(r.matchState) ?? r.matchState);
  }
  if (r.incomplete && r.profit === null) parts.push(incompleteLine(r.incomplete));
  // The group's sentence once, on its best choice: the first real scan showed the same line under all eleven pairs of a
  // promotion. The other pairs carry the BOGO tag, and the inspector lists every choice.
  if (r.bogoChoices?.label && r.bogoChoices.best) parts.push(r.bogoChoices.label);
  return parts.length ? parts.join(' · ') : null;
}
