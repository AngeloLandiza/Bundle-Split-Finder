// The one line under a deal's title (docs/ux-checklist.md item 1: the row shows the estimate and a one-line reason).
// Built only from what the row already has; nothing is looked up or worked out here. A row with nothing to explain says nothing.

import type { DealRow } from '../api/types';
import { profit } from './format';
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

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** "+$38.00 est. · all parts matched", "2 of 3 parts matched", "Waiting for an Amazon lookup", or null. */
export function dealReason(r: DealRow): string | null {
  const waiting = waitingState(r);
  if (waiting) return waiting;
  if (r.needsAnswer) return 'What is inside is not settled. Answer in Review.';
  if (r.profit !== null) {
    const match = r.matchState ? lowerFirst(r.matchState) : null;
    return [`${profit(r.profit)} est.`, match].filter(Boolean).join(' · ');
  }
  return r.matchState;
}
