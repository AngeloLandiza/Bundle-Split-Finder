// eBay Browse API listings, as far as Split Finder reads them.
//
// No eBay user data is kept (the account-deletion exemption): there is no seller, buyer or feedback
// field in these types, and the parsers never copy one. A field that is not here cannot leak.

/** What a Browse search result carries: enough to pre-filter, not enough to judge. */
export interface EbayListingSummary {
  itemId: string;
  title: string;
  /** Null when the response has no usable price. */
  price: number | null;
  currency: string;
  /** eBay's condition id as text: "1000" is New. */
  conditionId: string | null;
  /** The listing's category ids, leaf and ancestors. */
  categoryIds: string[];
  epid?: string;
  /** Only an item read carries these; a search result may. */
  brand?: string;
  mpn?: string;
  aspects?: { name: string; value: string }[];
  /** The listing's page, without eBay's tracking parameters. */
  url: string;
}

/** What getItem carries: everything the judge reads. */
export interface EbayListing extends EbayListingSummary {
  aspects: { name: string; value: string }[];
  /** The description with its HTML removed, whitespace collapsed, at most 4000 characters. */
  descriptionText: string;
  /** Units sold by this listing over its life (estimatedSoldQuantity); null when eBay does not say. */
  soldQuantity: number | null;
  /** sellerItemRevision: part of a judgement's cache key. */
  revision?: string;
}

export type EbayVerdict = 'match' | 'not_match' | 'unsure';

export interface EbayValue {
  /** Verified matches counted (each with soldQuantity > 0). */
  listings: number;
  unitsSold: number;
  low: number;
  high: number;
  /** The price at or below which half the units sold went; each listing weighs its soldQuantity. */
  medianPrice: number;
  /** Up to 3 listing pages, those with the most units sold first. */
  links: string[];
  /** The price of each listing in `links`, in the same order. Absent in a value stored before it was added. */
  linkPrices?: number[];
}
