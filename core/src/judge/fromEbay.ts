// The judge's view of a parsed eBay listing. EbayListing holds no seller or buyer field, so nothing
// about an eBay user can reach a prompt from here.

import type { EbayListing } from '../ebay/types';
import type { JudgeListing } from './types';

export function judgeListingFromEbay(listing: EbayListing): JudgeListing {
  return {
    itemId: listing.itemId,
    title: listing.title,
    aspects: listing.aspects.map((a) => ({ name: a.name, value: a.value })),
    descriptionText: listing.descriptionText,
    ...(listing.mpn ? { mpn: listing.mpn } : {}),
    ...(listing.brand ? { brand: listing.brand } : {}),
    conditionId: listing.conditionId,
    price: listing.price,
    currency: listing.currency,
  };
}
