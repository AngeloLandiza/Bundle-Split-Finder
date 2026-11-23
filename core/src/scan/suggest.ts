// Suggested prices (Nov 23): for a part with no counted price, at most one price the agent prepares with its evidence, for
// the owner to confirm in one click. A suggestion is never counted: the PO's rule (Nov 20, "A price counts when he confirms
// it") stands, and confirming one stores an ordinary confirmed price with what it rested on (confirmed.ts, kind 'suggested').
//
//   (a) Its Amazon listing is not for sale now: Keepa's recent average New price for that listing (90 days, else 30), from
//       the trend a pull stored (keepa/trends.ts). Nothing here pulls; the agent's drip asks Keepa for it (1 token).
//   (b) It has no Amazon listing: the middle of the stored eBay listings (New, Buy It Now: the search's own filters) the
//       judge or the owner marked the same product, with their count and range; at least MIN_EBAY_LISTINGS, or none.
//   (c) Home Depot's own price for the part sold alone is his cost side, not a sell price: never a suggestion, at most a
//       context line under one.
//
// Pure: reads only what it is given. Rule 4: a figure comes from one source, labelled, or there is no suggestion.

import type { PartTrend } from '../keepa/trends';
import { effectiveVerdict, type EbayValueRecord, type PartPriceRecord, type PartRow, type PriceSuggestion } from './types';

/** Fewer stored eBay listings than this make no suggestion: one or two prices are not a market. */
export const MIN_EBAY_LISTINGS = 3;
/** At most this many eBay listings are quoted under a suggestion, nearest the middle first. */
const EBAY_EVIDENCE_MAX = 6;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 23" in UTC, the day a figure was read. */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
/** "$66" for whole dollars, else "$65.50": the label's short form. */
const usd = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

export interface SuggestInputs {
  amazonDomain: string;
  /** The stored Keepa trend of the part's listing (its averages), when one is stored. */
  trend?: Pick<PartTrend, 'newAvg90' | 'newAvg30'> & Partial<Pick<PartTrend, 'pulledAt'>>;
  /** The part's stored eBay record (its judged listings), when one is stored. */
  ebay?: EbayValueRecord;
  /** Home Depot's reading of the part sold alone: context only. */
  hd?: PartPriceRecord;
}

/** A counted price: an active Amazon New price, or a confirmed price still counting. */
const hasCountedPrice = (p: Pick<PartRow, 'availability' | 'prices'>): boolean =>
  p.prices.some((o) => !o.reference && ((o.kind === 'amazon_new' && p.availability === 'active') || o.kind === 'confirmed'));

/** Home Depot's own price as a context line: "Home Depot sells it alone for $X: your cost side, not a sell price." */
function hdContext(hd: PartPriceRecord | undefined): { text: string; url?: string }[] {
  if (!hd || hd.price === null || hd.seenAt === null) return [];
  return [{ text: `Context: Home Depot sells it alone for $${hd.price.toFixed(2)}. That is your cost side, not a sell price.`, ...(hd.link ? { url: hd.link } : {}) }];
}

/** The middle of sorted prices: the middle one, or the mean of the two middle ones, to the cent. */
export function middleOf(sorted: readonly number[]): number {
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : round2((sorted[n / 2 - 1]! + sorted[n / 2]!) / 2);
}

/** (a) An inactive listing's Keepa average, 90 days first. Null without a stored average above $0. */
function amazonAverage(part: Pick<PartRow, 'asin'>, inputs: SuggestInputs): PriceSuggestion | null {
  const t = inputs.trend;
  const days = typeof t?.newAvg90 === 'number' && t.newAvg90 > 0 ? 90 : typeof t?.newAvg30 === 'number' && t.newAvg30 > 0 ? 30 : null;
  if (days === null || part.asin === null) return null;
  const price = round2(days === 90 ? t!.newAvg90! : t!.newAvg30!);
  const url = `https://www.${inputs.amazonDomain}/dp/${encodeURIComponent(part.asin)}`;
  const read = typeof t?.pulledAt === 'number' ? `, read ${dayOf(t.pulledAt)}` : '';
  return {
    price, kind: 'amazon_average', fulfillment: 'fba',
    label: `Amazon listing not for sale now; its ${days}-day average was $${price.toFixed(2)} (Keepa)`,
    evidence: [{ text: `Keepa: the average New price of Amazon listing ${part.asin} over the last ${days} days was $${price.toFixed(2)}${read}.`, url }],
  };
}

/** (b) The middle of the stored eBay listings marked the same product. Null with fewer than MIN_EBAY_LISTINGS. */
function ebayMedian(inputs: SuggestInputs): PriceSuggestion | null {
  const same = (inputs.ebay?.listings ?? [])
    .filter((l) => effectiveVerdict(l) === 'match' && l.currency === 'USD' && typeof l.price === 'number' && l.price > 0)
    .sort((a, b) => a.price! - b.price! || (a.itemId < b.itemId ? -1 : 1));
  if (same.length < MIN_EBAY_LISTINGS) return null;
  const prices = same.map((l) => l.price!);
  const price = middleOf(prices);
  const low = prices[0]!;
  const high = prices[prices.length - 1]!;
  const range = low === high ? usd(low) : `${usd(low)}–${usd(high)}`;
  const byDistance = [...same].sort((a, b) => Math.abs(a.price! - price) - Math.abs(b.price! - price));
  // The summary links the listing nearest the middle: the link a confirmed price keeps (confirmed.ts planSuggested).
  const middleUrl = byDistance.find((l) => l.url !== '')?.url;
  const nearest = byDistance.slice(0, EBAY_EVIDENCE_MAX).sort((a, b) => a.price! - b.price!);
  const read = inputs.ebay ? `, read ${dayOf(inputs.ebay.checkedAt)}` : '';
  return {
    price, kind: 'ebay_median', fulfillment: 'none',
    label: `${same.length} eBay listings, ${range}, middle ${usd(price)}`,
    evidence: [
      { text: `eBay: ${same.length} New Buy It Now listings marked the same product${read}; the middle price is $${price.toFixed(2)}.`, ...(middleUrl ? { url: middleUrl } : {}) },
      ...nearest.map((l) => ({ text: `eBay listing at $${l.price!.toFixed(2)}: ${l.title}`, ...(l.url ? { url: l.url } : {}) })),
    ],
  };
}

/**
 * The one suggestion for a part, or null. Only for a part with no counted price whose state lets the owner confirm one
 * (confirmed.ts confirmState 'open': looked up, not in Review): an inactive listing gets (a), no listing gets (b).
 */
export function suggestPrice(
  part: Pick<PartRow, 'status' | 'availability' | 'asin' | 'prices'>, inputs: SuggestInputs,
): PriceSuggestion | null {
  if (hasCountedPrice(part)) return null;
  if (part.status === 'review' || part.status === 'waiting' || part.status === 'unmatched') return null;
  let s: PriceSuggestion | null = null;
  if (part.availability === 'inactive') s = amazonAverage(part, inputs);
  else if (part.availability === 'missing') s = ebayMedian(inputs);
  return s ? { ...s, evidence: [...s.evidence, ...hdContext(inputs.hd)] } : null;
}

/** "Confirm $66 (eBay middle of 6)", "Confirm $48.15 (Keepa 90-day average)": the part row's one primary action. */
export function suggestionButton(s: Pick<PriceSuggestion, 'price' | 'kind' | 'label'>): string {
  if (s.kind === 'ebay_median') {
    const n = /^(\d+) eBay listings/.exec(s.label)?.[1];
    return `Confirm ${usd(s.price)} (eBay middle${n ? ` of ${n}` : ''})`;
  }
  const days = /its (\d+)-day average/.exec(s.label)?.[1] ?? '90';
  return `Confirm ${usd(s.price)} (Keepa ${days}-day average)`;
}
