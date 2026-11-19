// The two files the command line writes. Text from retailers is untrusted: a cell that
// starts like a spreadsheet formula is made inert, and separators are quoted.

import type { EbayValue } from '../ebay/types';
import type { BundleRow, PartRow, ReviewItem, ScanReport } from './types';

export const RUN_COLUMNS: readonly string[] = [
  'section', 'brand', 'bundle_model', 'bundle_title', 'hd_item_id', 'hd_price', 'hd_was_price', 'hd_percent_off',
  'parts', 'asins', 'match_grades', 'amazon_prices', 'est_net_revenue', 'est_cost', 'est_profit', 'est_roi',
  'uncovered_parts', 'hd_link', 'sold_as', 'other_options',
  // Step 9: the ROI at each end of the part prices, and what Home Depot charges for the parts sold alone.
  'roi_lowest', 'roi_amazon_new', 'roi_highest', 'hd_price_total',
  // Step 10: what New units of each part sell for on eBay, a reference never counted in an estimate.
  'ebay_ref_low', 'ebay_ref_high', 'ebay_units_sold',
];

export const REVIEW_COLUMNS: readonly string[] = ['kind', 'brand', 'model', 'title', 'reason', 'candidates', 'opened_at'];

function cell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[,"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvLine(cells: (string | number | null)[]): string {
  return cells.map(cell).join(',');
}

const join = (items: string[]): string => items.join(' | ');
const orQ = (v: string | number | null): string => (v === null ? '?' : String(v));
const partName = (p: PartRow): string => (p.qty > 1 ? `${p.model} x${p.qty}` : p.model);

/**
 * The ways to sell beyond the primary, as "label: est_profit" pairs. An option with no estimate yet is left
 * out: a figure is never made up for it. Empty for a bundle with one way to sell.
 */
function otherOptions(b: BundleRow): string {
  return join(b.options.slice(1).filter((o) => o.estimate).map((o) => `${o.label}: ${o.estimate!.profit}`));
}

/**
 * What Home Depot charges for the bundle's parts sold alone: each part's Home Depot price times its quantity,
 * for reference (never counted in an estimate). Null unless every part has one: a sum of some of the parts
 * would read as the total of them all.
 */
function hdPriceTotal(b: BundleRow): number | null {
  if (b.parts.length === 0) return null;
  let cents = 0;
  for (const p of b.parts) {
    const hd = p.prices.find((o) => o.kind === 'homedepot');
    if (!hd) return null;
    cents += Math.round(hd.price * 100) * p.qty;
  }
  return cents / 100;
}

/**
 * Step 10: one figure of each part's eBay value, in part order like `amazon_prices`: the part's own, '?' for a
 * part with no eBay value, and blank when no part has one. Never summed: a total of some of the parts would
 * read as the total of them all.
 */
function ebayColumn(b: BundleRow, pick: (v: EbayValue) => number): string {
  const values = b.parts.map((p) => p.prices.find((o) => o.kind === 'ebay_sold_new')?.ebay);
  return values.every((v) => v === undefined) ? '' : join(values.map((v) => (v === undefined ? '?' : String(pick(v)))));
}

function runRow(b: BundleRow): (string | number | null)[] {
  const head = [b.section, b.brand, b.model, b.title, b.itemId, b.price, b.regularPrice, b.percentOff];
  // sold_as is the primary's label, which the row's figures are; '' when the bundle has one way to sell.
  const tail = [b.link, b.options[0]?.label ?? '', otherOptions(b)];
  if (b.section === 'split') return [...head, '', '', '', '', null, null, null, null, '', ...tail, null, null, null, null, '', '', ''];
  const e = b.estimate;
  // Where the estimate is null, every end of the range is.
  const range = [b.range.lowest?.roi ?? null, b.range.amazonNew?.roi ?? null, b.range.highest?.roi ?? null, hdPriceTotal(b)];
  return [
    ...head,
    join(b.parts.map(partName)),
    join(b.parts.map((p) => orQ(p.asin))),
    join(b.parts.map((p) => orQ(p.grade))),
    join(b.parts.map((p) => orQ(p.price))),
    e ? e.netRevenue : null, e ? e.cost : null, e ? e.profit : null, e ? e.roi : null,
    join(b.uncovered),
    ...tail,
    ...range,
    ebayColumn(b, (v) => v.low), ebayColumn(b, (v) => v.high), ebayColumn(b, (v) => v.unitsSold),
  ];
}

export function runCsv(report: ScanReport): string {
  return bundlesCsv(report.bundles);
}

/** The run file's header and these bundles, with the same columns as runCsv. */
export function bundlesCsv(bundles: BundleRow[]): string {
  return [csvLine([...RUN_COLUMNS]), ...bundles.map((b) => csvLine(runRow(b)))].join('\n') + '\n';
}

function reviewRow(r: ReviewItem): (string | number | null)[] {
  const candidates = r.candidates.map((c) => `${c.asin} ${c.price === null ? '$?' : `$${c.price}`} ${c.title}`);
  return [r.kind, r.brand, r.model, r.title, r.reason, join(candidates), new Date(r.openedAt).toISOString()];
}

export function reviewCsv(report: ScanReport): string {
  return [csvLine([...REVIEW_COLUMNS]), ...report.review.map((r) => csvLine(reviewRow(r)))].join('\n') + '\n';
}
