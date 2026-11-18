// Amazon listings the tool has seen, saved so a part can later be matched without a search.
//
// Model numbers are read from titles only to index the saved listings. Whether a listing
// is the part is still decided by pick() and grade() in match.ts, with hasModelToken as
// the test for "same model" (titleHasModel, which adds RYOBI's tool-only B): nothing here makes a
// match on weaker evidence.

import { type Candidate, MODEL_PATTERNS, titleHasModel } from '../match';
import type { ListingRecord } from './types';

const upper = (s: string): string => s.trim().toUpperCase();

/** Model numbers in a title, as whole tokens, upper case, in order, without repeats. */
export function modelsInTitle(brand: string, title: string): string[] {
  const pattern = MODEL_PATTERNS[upper(brand)];
  if (!pattern) return [];
  return [...new Set(Array.from(title.toUpperCase().matchAll(pattern), (m) => m[0]))];
}

/** The record to save for a search row, or null when its brand is not one of `brands`. `old` is the stored record, if any. */
export function listingFrom(c: Candidate, brands: string[], now: number, old?: ListingRecord): ListingRecord | null {
  if (!c.brand) return null;
  const brand = upper(c.brand);
  if (!brand || !brands.some((b) => upper(b) === brand)) return null;
  const price = c.price ?? null;
  return {
    asin: c.asin,
    brand,
    title: c.title,
    models: modelsInTitle(brand, c.title),
    // A row with no picture keeps the one saved before.
    image: c.image ?? old?.image ?? null,
    // A row with no price keeps the last price seen, and when it was seen.
    price: price ?? old?.price ?? null,
    reviews: c.reviews ?? null,
    seenAt: price === null ? (old?.seenAt ?? null) : now,
    checkedAt: now,
  };
}

/**
 * Saved listings of this brand whose title carries this model as a whole token, as candidates for
 * pick(): for RYOBI, either form of it (Ruling 70, titleHasModel), as a lookup's results are graded.
 */
export function candidatesFor(brand: string, model: string, listings: ListingRecord[]): Candidate[] {
  const want = upper(brand);
  return listings
    .filter((l) => upper(l.brand) === want && titleHasModel(want, l.title, model))
    .map((l) => ({ asin: l.asin, title: l.title, brand: l.brand, price: l.price, reviews: l.reviews, image: l.image }));
}
