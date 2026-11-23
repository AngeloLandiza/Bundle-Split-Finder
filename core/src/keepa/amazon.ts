// Turn Keepa product fields into shapes the existing SerpApi parsers and matcher already read.

import type { Candidate } from '../match';
import { centsToDollars } from './parse';
import type { KeepaProduct } from './types';

/** Minimal SerpApi amazon_product body so parseAmazonProduct() keeps working. */
export function serpApiProductBodyFromKeepa(p: KeepaProduct): Record<string, unknown> {
  const price = centsToDollars(p.amazonPrice ?? null);
  return {
    product_results: {
      asin: p.asin,
      title: p.title ?? '',
      brand: p.brand ?? p.manufacturer ?? null,
      price: price,
      extracted_price: price,
      reviews: null,
    },
    product_details: {
      manufacturer_part_number: p.partNumber ?? undefined,
      part_number: p.partNumber ?? undefined,
    },
  };
}

/** Minimal SerpApi `engine=amazon` body from Keepa search product rows. */
export function serpApiSearchBodyFromKeepa(products: KeepaProduct[]): Record<string, unknown> {
  return {
    organic_results: products
      .filter((p) => p.title)
      .map((p) => {
        const price = centsToDollars(p.amazonPrice ?? null);
        return {
          asin: p.asin,
          title: p.title ?? '',
          brand: p.brand ?? p.manufacturer ?? null,
          extracted_price: price,
          price,
          reviews: null,
        };
      }),
  };
}

export function candidateFromKeepa(p: KeepaProduct): Candidate | null {
  const title = p.title?.trim();
  if (!title) return null;
  const price = centsToDollars(p.amazonPrice ?? null);
  return {
    asin: p.asin,
    title,
    brand: p.brand ?? p.manufacturer ?? null,
    partNumber: p.partNumber?.replace(/^#/, '') ?? null,
    upcs: [],
    price,
    reviews: null,
  };
}