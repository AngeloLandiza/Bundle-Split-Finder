// Amazon listings the tool has seen, saved so a part can later be matched without a search.
//
// Model numbers are read from titles only to index the saved listings. Whether a listing
// is the part is still decided by pick() and grade() in match.ts, with hasModelToken as
// the test for "same model" (titleHasModel, which adds RYOBI's tool-only B): nothing here makes a
// match on weaker evidence.

import { amazonPicture } from '../links/pictures';
import { type Candidate, MODEL_PATTERNS, modelForms, modelTokenTest } from '../match';
import type { ListingRecord, ScanStore } from './types';

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
    // A row with no picture keeps the one saved before; only Amazon's image host is kept (links/pictures.ts).
    image: amazonPicture(c.image) ?? old?.image ?? null,
    // A row with no price keeps the last price seen, and when it was seen.
    price: price ?? old?.price ?? null,
    reviews: c.reviews ?? null,
    seenAt: price === null ? (old?.seenAt ?? null) : now,
    checkedAt: now,
    // Step 9: the row's own list price, or none; a row never carries a Buy Box, so the page's is kept.
    ...(typeof c.listPrice === 'number' ? { listPrice: c.listPrice } : {}),
    ...(old?.buyBox !== undefined ? { buyBox: old.buyBox } : {}),
  };
}

/**
 * Saved listings of this brand whose title carries this model as a whole token, as candidates for
 * pick(): for RYOBI, either form of it (Ruling 70, titleHasModel), as a lookup's results are graded.
 */
export function candidatesFor(brand: string, model: string, listings: ListingRecord[]): Candidate[] {
  const want = upper(brand);
  // titleHasModel(want, l.title, model) for each listing, with the forms and their tests built once per call, not
  // once per listing, and each title upper-cased once (core/test/candidates-for-equivalence.test.ts).
  const tests = modelForms(want, model).map(modelTokenTest);
  return listings
    .filter((l) => {
      if (upper(l.brand) !== want) return false;
      const title = l.title.toUpperCase();
      return tests.some((has) => has(title));
    })
    .map((l) => ({ asin: l.asin, title: l.title, brand: l.brand, price: l.price, reviews: l.reviews, image: l.image }));
}

/**
 * Nov 25: a Keepa product pull's picture (keepa/parse.ts keepaPicture) kept on the stored listing of `asin` when that listing
 * has none. A listing not stored is not created (what is stored as a listing is what the matcher reads), and a stored
 * picture is never replaced. True when one was filled.
 */
export async function keepListingPicture(store: Pick<ScanStore, 'getListing' | 'putListing'>, asin: string, image: string | null | undefined): Promise<boolean> {
  const url = amazonPicture(image);
  if (url === null) return false;
  const l = await store.getListing(asin);
  if (!l || l.image) return false;
  await store.putListing({ ...l, image: url });
  return true;
}
