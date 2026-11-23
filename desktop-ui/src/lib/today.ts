// Which bundles Today lists (docs/design.md, Desktop app > Screens > Today). Pure, so the rule is tested once.

import type { DealRow } from '../api/types';

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
