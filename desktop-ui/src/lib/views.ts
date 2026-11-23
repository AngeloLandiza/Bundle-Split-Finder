// The saved Deals views in the sidebar (docs/design.md, Desktop app > Sidebar). A view is a plain
// question about a row's own fields; nothing is guessed: a bundle with no estimate is never "losing".

import type { DealRow } from '../api/types';

export type DealView = 'all' | 'confirmed' | 'needs-answer' | 'waiting' | 'losing';
export const DEAL_VIEWS: readonly DealView[] = ['all', 'confirmed', 'needs-answer', 'waiting', 'losing'];

export const VIEW_LABEL: Record<DealView, string> = {
  all: 'All deals',
  confirmed: 'Confirmed',
  'needs-answer': 'Needs an answer',
  waiting: 'Waiting for a lookup',
  losing: 'Losing money',
};

export function inView(r: DealRow, view: DealView): boolean {
  switch (view) {
    case 'all':
      return true;
    case 'confirmed':
      return r.section === 'confirmed' && !r.needsAnswer;
    case 'needs-answer':
      return r.needsAnswer;
    case 'waiting':
      return r.lookup !== null || r.section === 'waiting';
    case 'losing':
      // Only an estimate below zero; a row that waits for an answer has no estimate to read.
      return !r.needsAnswer && r.profit !== null && r.profit < 0;
  }
}

export function viewCounts(rows: DealRow[]): Record<DealView, number> {
  const out = { all: 0, confirmed: 0, 'needs-answer': 0, waiting: 0, losing: 0 } as Record<DealView, number>;
  for (const r of rows) for (const v of DEAL_VIEWS) if (inView(r, v)) out[v] += 1;
  return out;
}
