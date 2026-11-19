import type { PriceOption } from '../scan/types';
import type { EbayListing, EbayValue, EbayVerdict } from './types';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The eBay reference for a part, from listings the judge called a verified match and that have sold
 * (soldQuantity > 0). The model supplies no figure: price and sold count are eBay's. null when none
 * qualifies, so the part shows no eBay line (never $0).
 */
export function ebayValue(judged: { listing: EbayListing; verdict: EbayVerdict }[]): EbayValue | null {
  const used = judged
    .filter((j) => j.verdict === 'match' && j.listing.currency === 'USD' && j.listing.price !== null && j.listing.price > 0 && (j.listing.soldQuantity ?? 0) > 0)
    .map((j) => ({ price: j.listing.price as number, sold: j.listing.soldQuantity as number, url: j.listing.url }));
  if (used.length === 0) return null;
  const unitsSold = used.reduce((n, u) => n + u.sold, 0);
  const byPrice = [...used].sort((a, b) => a.price - b.price);
  let acc = 0;
  let median = byPrice[byPrice.length - 1]!.price;
  for (const u of byPrice) {
    acc += u.sold;
    if (acc * 2 >= unitsSold) { median = u.price; break; }
  }
  const links = [...used].sort((a, b) => b.sold - a.sold).map((u) => u.url).filter((u) => u !== '').slice(0, 3);
  return { listings: used.length, unitsSold, low: round2(byPrice[0]!.price), high: round2(byPrice[byPrice.length - 1]!.price), medianPrice: round2(median), links };
}

/** "eBay · New · $38.50–$54.99 · 3 listings, 41 sold"; one listing: "eBay · New · $38.50 · 1 listing, 13 sold". */
export function ebayLabel(v: EbayValue): string {
  const range = v.low === v.high ? usd(v.low) : `${usd(v.low)}–${usd(v.high)}`;
  return `eBay · New · ${range} · ${v.listings} ${v.listings === 1 ? 'listing' : 'listings'}, ${v.unitsSold} sold`;
}

/**
 * The value as a labelled price: kind ebay_sold_new, reference only (it enters no ROI). The price is the
 * sold-weighted median; offers is the listings counted; link is the listing with the most units sold.
 * PriceOption has no label field: the label is ebayLabel(v), shown by the screen.
 */
export function ebayPriceOption(v: EbayValue, seenAt: number): PriceOption {
  return {
    kind: 'ebay_sold_new', price: v.medianPrice, condition: 'new', seller: null, shipsFrom: null, offers: v.listings,
    asin: null, link: v.links[0] ?? null, seenAt, reference: true,
  };
}
