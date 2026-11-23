// The saved Deals views in the sidebar (docs/design.md, Desktop app > Sidebar). A view is a plain
// question about a row's own fields; nothing is guessed: a bundle with no estimate is never "losing". Nov 23: a bundle
// missing a price (some part has no counted price) has no estimate: it is under Missing a price, never under Losing money.

import type { DealRow } from '../api/types';

export type DealView = 'buy-now' | 'all' | 'confirmed' | 'needs-answer' | 'waiting' | 'missing-price' | 'losing' | 'watchlist';
/** The sidebar's order: Worth buying now leads the group; the Watchlist closes it. */
export const DEAL_VIEWS: readonly DealView[] = ['buy-now', 'all', 'confirmed', 'needs-answer', 'waiting', 'missing-price', 'losing', 'watchlist'];

export const VIEW_LABEL: Record<DealView, string> = {
  'buy-now': 'Worth buying now',
  all: 'All deals',
  confirmed: 'Confirmed',
  'needs-answer': 'Needs an answer',
  waiting: 'Waiting for a lookup',
  'missing-price': 'Missing a price',
  losing: 'Losing money',
  watchlist: 'Watchlist',
};

export function inView(r: DealRow, view: DealView): boolean {
  switch (view) {
    case 'buy-now':
      // The last scan's own verdict (core/src/tracking/signals.ts); the row never recomputes it.
      return r.buyNow;
    case 'watchlist':
      return r.watched;
    case 'all':
      return true;
    case 'confirmed':
      return r.section === 'confirmed' && !r.needsAnswer && r.matchKind !== 'waiting_page';
    case 'needs-answer':
      return r.needsAnswer;
    case 'waiting':
      // A bundle whose Home Depot page was not read waits too: for the page, not for an answer.
      return r.lookup !== null || r.section === 'waiting' || r.matchKind === 'waiting_page';
    case 'missing-price':
      // Nov 23: a price and a split, and some part with no counted price: no estimate, only the break-even.
      return r.profit === null && (r.incomplete ?? null) !== null;
    case 'losing':
      // Only a complete estimate below zero; a row that waits for an answer, or misses a price, has no estimate to read.
      return !r.needsAnswer && r.profit !== null && r.profit < 0 && !r.incomplete;
  }
}

export function viewCounts(rows: DealRow[]): Record<DealView, number> {
  const out = Object.fromEntries(DEAL_VIEWS.map((v) => [v, 0])) as Record<DealView, number>;
  for (const r of rows) for (const v of DEAL_VIEWS) if (inView(r, v)) out[v] += 1;
  return out;
}
