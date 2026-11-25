// What the Deals list shows, worked out from the report: the match state of a row, the order within a
// section, the sections themselves. No React here, so the rules can be tested on their own.

import type { BundleResult } from '@core/money';
import { ebayLabel } from '@core/ebay/value';
import { matchState } from '@core/scan/matchState';
import { partKey, type BundleRow, type PartRow, type PriceOption, type PriceRange, type ReportSection, type ScanJob } from '@core/scan/types';

export { matchState };
import { roi, roiSigned } from '../../lib/format';
import type { SortKey } from './sort';

export const SECTION_ORDER: readonly ReportSection[] = ['confirmed', 'waiting', 'inactive_listing', 'missing_listing', 'split', 'other_brands'];

export const SECTION_LABEL: Record<ReportSection, string> = {
  confirmed: 'CONFIRMED',
  waiting: 'WAITING FOR AN AMAZON LOOKUP',
  inactive_listing: 'REVIEW: INACTIVE LISTING',
  missing_listing: 'REVIEW: MISSING LISTING',
  split: 'CONTENTS NOT KNOWN',
  other_brands: 'NOT ESTIMATED: OTHER BRANDS',
};

export { waitingOf, waitingKeys, lookupsWaiting, waitingParts } from '@core/deals/waiting';

const metric = (row: BundleRow, sort: SortKey): number | null => {
  if (sort === 'discount') return row.percentOff;
  if (!row.estimate) return null;
  if (sort === 'roiLowest') return row.range.lowest?.roi ?? null;
  if (sort === 'roiHighest') return row.range.highest?.roi ?? null;
  return sort === 'roi' ? row.estimate.roi : row.estimate.profit;
};

/** Highest first; rows with no figure last; ties keep the report's order. */
export function sortRows(rows: BundleRow[], sort: SortKey): BundleRow[] {
  return rows
    .map((row, i) => ({ row, i, v: metric(row, sort) }))
    .sort((a, b) => (a.v === null ? (b.v === null ? 0 : 1) : b.v === null ? -1 : b.v - a.v) || a.i - b.i)
    .map((x) => x.row);
}

export interface Section {
  id: ReportSection;
  label: string;
  rows: BundleRow[];
}

export function sections(bundles: BundleRow[], sort: SortKey): Section[] {
  return SECTION_ORDER.map((id) => ({ id, label: SECTION_LABEL[id], rows: sortRows(bundles.filter((b) => b.section === id), sort) })).filter(
    (s) => s.rows.length > 0,
  );
}

export { staleBundleDays as staleDays } from '@core/deals/freshness';

/**
 * The two ends of an estimate's range, when they read differently as a whole percent ROI: both results, lowest and
 * highest. Null with no estimate, no range, or ends that read the same (the headline is then the one figure).
 */
export function spread(estimate: BundleResult | null, range: PriceRange): { lowest: BundleResult; highest: BundleResult } | null {
  const { lowest, highest } = range;
  if (!estimate || !lowest || !highest || roi(lowest.roi) === roi(highest.roi)) return null;
  return { lowest, highest };
}

/** "ROI −6% to +12%": the range's ends as the Deals row and a way to sell say them; null when `spread` is. */
export function roiRangeText(estimate: BundleResult | null, range: PriceRange): string | null {
  const ends = spread(estimate, range);
  return ends ? `ROI ${roiSigned(ends.lowest.roi)} to ${roiSigned(ends.highest.roi)}` : null;
}

/** What the range's ends stand for, for a hover or a line of help. */
export const RANGE_MEANING = 'Estimated ROI from the lowest to the highest counted price of its parts, from your fee settings. Reference prices are not counted.';

/**
 * A price's label as the panel writes it. The panel groups the prices (counted, then "Reference · not counted"), so no
 * label says "reference". The Buy Box says no "New": the counted group is New only and the Buy Box is a New price from the
 * listing's page. `bulk`: the part's listing is New in bulk packaging (PartRow.packaging), said on that listing's prices.
 * "Amazon · New", "Amazon · New · bulk packaging", "Last Amazon price", "Amazon · Buy Box · sold by X, ships from Amazon",
 * "Amazon · only offer · sold by X", "Amazon · Buy Box (older) · sold by X", "Amazon list price",
 * "Home Depot · sold alone", "Home Depot · sold alone as PCL206B".
 */
export function priceLabel(o: PriceOption, bulk = false): string {
  const packaging = bulk ? ['bulk packaging'] : [];
  switch (o.kind) {
    case 'amazon_new':
      // The tag already says Listing inactive. This label is only what the number is.
      return [...(o.reference ? ['Last Amazon price'] : ['Amazon · New']), ...packaging].join(' · ');
    case 'amazon_buybox': {
      if (o.singleOffer) return ['Amazon', 'only offer', ...packaging, ...(o.seller ? [`sold by ${o.seller}`] : [])].join(' · ');
      const who = [o.seller ? `sold by ${o.seller}` : null, o.shipsFrom ? `ships from ${o.shipsFrom}` : null].filter((x) => x !== null);
      // An older Buy Box is shown for reference: it can have changed since the featured price was seen.
      return ['Amazon', o.reference ? 'Buy Box (older)' : 'Buy Box', ...packaging, ...(who.length > 0 ? [who.join(', ')] : [])].join(' · ');
    }
    case 'amazon_list':
      return 'Amazon list price';
    case 'confirmed':
      return 'Confirmed by you';
    case 'homedepot':
      return `Home Depot · sold alone${o.soldAs ? ` as ${o.soldAs}` : ''}`;
    case 'ebay_sold_new':
      // "eBay · New · $38.50–$54.99 · 3 listings, 41 sold": what units of the part sold for there, over the listings a model checked.
      return o.ebay ? ebayLabel(o.ebay) : 'eBay · New';
  }
}
