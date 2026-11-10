// Grade Amazon listings for one component.
//
// A lookup returns candidates, not an answer: the same tool can have a retail
// listing, a renewed listing, a kit listing and a 2-pack. Each candidate is graded:
//
//   exact     barcode matches, single unit, same brand           -> used automatically
//   strong    manufacturer part number matches exactly           -> used automatically
//   probable  brand confirmed and the model number is a whole
//             word in the title (all a search result can show)   -> used, labelled "verify"
//   review    model number in the title, brand not confirmed     -> a person decides once
//   reject    renewed, other brand, aftermarket, wrong pack size,
//             or a kit variant of a single tool                  -> never used
//
// A "probable" match becomes "exact" by loading the listing's detail page
// (1 search), which carries the barcode.

import { toUpc12 } from './identifiers';

const RENEWED = /\b(renewed|refurbished|reconditioned|used|pre-owned|open box)\b/i;
const AFTERMARKET = /\b(replacement for|compatible with|for use with|fits|aftermarket)\b/i;
const BULK = /(bulk packaged|non-retail packag|no retail packag)/i;
const MULTI = /\b(\d+)\s*-?\s*pack\b|\bpack of (\d+)\b|\bset of (\d+)\b/i;
const KIT_WORDS = /\b(kit|combo|bundle|with battery|with charger|w\/ battery|and charger)\b/i;

export type Grade = 'exact' | 'strong' | 'probable' | 'review' | 'reject';

export interface Candidate {
  asin: string;
  title: string;
  /** Present on detail pages; search results usually omit it. */
  brand?: string | null;
  partNumber?: string | null;
  upcs?: string[];
  packageQty?: number | null;
  price?: number | null;
  reviews?: number | null;
  sponsored?: boolean;
}

export interface Graded {
  asin: string;
  grade: Grade;
  /** "bulk" when the listing itself says non-retail packaging. */
  packaging: 'retail' | 'bulk';
  reasons: string[];
}

export interface Wanted {
  brand: string;
  model: string;
  upc?: string | null;
  isKit?: boolean;
  packQty?: number;
}

const clean = (model: string): string => model.toUpperCase().replace(/[^A-Z0-9-]/g, '');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-token match: PBLRC25B must not match inside PBLRC2501SB or PBLRC25BK. */
export function hasModelToken(text: string, model: string): boolean {
  return new RegExp(`(?<![A-Z0-9])${escapeRe(model.toUpperCase())}(?![A-Z0-9])`).test(text.toUpperCase());
}

export function grade(want: Wanted, cand: Candidate): Graded {
  const packaging = BULK.test(cand.title) ? 'bulk' : 'retail';
  const out = (g: Grade, ...reasons: string[]): Graded => ({ asin: cand.asin, grade: g, packaging, reasons });
  const brand = want.brand.trim().toUpperCase();

  if (cand.brand && cand.brand.trim().toUpperCase() !== brand) return out('reject', 'different brand');
  if (AFTERMARKET.test(cand.title)) return out('reject', 'aftermarket or compatible part');
  if (RENEWED.test(cand.title)) return out('reject', 'renewed or used listing');

  let qty = cand.packageQty ?? null;
  const multi = MULTI.exec(cand.title);
  if (multi) qty = Number(multi[1] ?? multi[2] ?? multi[3]);
  const wantQty = want.packQty ?? 1;
  if (qty && qty !== wantQty) return out('reject', `pack of ${qty}, component is a pack of ${wantQty}`);

  const partOk = !!cand.partNumber && clean(cand.partNumber) === clean(want.model);
  const titleOk = hasModelToken(cand.title, want.model);
  const wantUpc = toUpc12(want.upc);
  const upcOk = wantUpc !== null && (cand.upcs ?? []).some((u) => toUpc12(u) === wantUpc);

  if (!want.isKit && KIT_WORDS.test(cand.title) && !partOk) {
    return out('reject', 'listing is a kit, component is a single item');
  }

  if (upcOk) return out('exact', 'barcode match', ...(partOk || titleOk ? ['model number match'] : []));
  if (partOk) return out('strong', 'manufacturer part number match');
  if (titleOk) {
    const brandConfirmed =
      (!!cand.brand && cand.brand.trim().toUpperCase() === brand) ||
      cand.title.trim().toUpperCase().startsWith(brand);
    return brandConfirmed
      ? out('probable', 'brand and model number in the title; barcode not checked yet')
      : out('review', 'model number in the title, brand not confirmed');
  }
  return out('reject', 'no identifier matches');
}

const RANK: Record<Grade, number> = { exact: 0, strong: 1, probable: 2, review: 3, reject: 4 };

export interface Picked {
  /** The listing to use, or null when nothing is good enough. */
  chosen: Graded | null;
  /** Other usable listings of the same grade (for example a second seller's page). */
  alternatives: Graded[];
  /** Listings a person should look at. */
  review: Graded[];
}

/** Choose one listing per component: best grade first, then most reviews, organic before sponsored. */
export function pick(want: Wanted, candidates: Candidate[]): Picked {
  const byAsin = new Map(candidates.map((c) => [c.asin, c]));
  const graded = candidates.map((c) => grade(want, c));
  const usable = graded
    .filter((g) => g.packaging === 'retail' && RANK[g.grade] <= RANK.probable)
    .sort((a, b) => {
      const ca = byAsin.get(a.asin)!;
      const cb = byAsin.get(b.asin)!;
      return (
        RANK[a.grade] - RANK[b.grade] ||
        Number(!!ca.sponsored) - Number(!!cb.sponsored) ||
        (cb.reviews ?? 0) - (ca.reviews ?? 0)
      );
    });
  const chosen = usable[0] ?? null;
  return {
    chosen,
    alternatives: usable.slice(1).filter((g) => chosen && g.grade === chosen.grade),
    review: graded.filter((g) => g.grade === 'review'),
  };
}
