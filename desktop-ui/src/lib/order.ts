// One rule for ordering by estimated profit or ROI, used by Today, the Deals table heads and the popover. An estimate that
// leaves out Amazon's fulfillment fee for some part (`beforeFulfillment`) is a higher figure than the truth, so it never
// outranks a full estimate of the same sign and is never "best" or "worth buying" (docs/decisions.md, Signals round 3).

import type { DealRow } from '../api/types';

type Figures = Pick<DealRow, 'profit' | 'roi' | 'beforeFulfillment' | 'needsAnswer'>;

/** True when the estimate counts no fulfillment fee for one or more parts. */
export const isBeforeFulfillment = (r: Pick<DealRow, 'beforeFulfillment'>): boolean => (r.beforeFulfillment?.parts ?? 0) > 0;

/**
 * One number to sort by, larger is better: the tier first (a figure at or above zero beats a loss; within the same sign a
 * full estimate beats one before fulfillment), then the figure itself. Null when the row has no estimate or needs an answer,
 * so the table's "no value sorts last" rule keeps those rows at the foot. Sorting it ascending is the exact mirror.
 */
export function estimateRank(r: Figures, key: 'profit' | 'roi'): number | null {
  const v = key === 'profit' ? r.profit : r.roi;
  if (v === null || r.needsAnswer) return null;
  const tier = (v >= 0 ? 2 : 0) + (isBeforeFulfillment(r) ? 0 : 1);
  return tier * 1e9 + v;
}

/** The hover text on a row whose estimate counts no fulfillment fee for some parts. */
export const beforeFulfillmentTip = (b: { parts: number; of: number }): string => `Amazon's fulfillment fee is not counted for ${b.parts} of ${b.of} parts yet; Keepa is asked next.`;

/** Best first by estimated profit: the comparator Today and the popover use. */
export function byBestProfit(a: Figures, b: Figures): number {
  return (estimateRank(b, 'profit') ?? -Infinity) - (estimateRank(a, 'profit') ?? -Infinity);
}
