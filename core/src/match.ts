// Grade Amazon listings for one component.
//
// A lookup returns candidates, not an answer: the same tool can have a retail
// listing, a renewed listing, a kit listing and a 2-pack. Each candidate is graded:
//
//   exact     barcode matches, single unit, same brand           -> used automatically
//   strong    manufacturer part number matches exactly           -> used automatically
//   probable  brand confirmed and the model number is a whole
//             word in the title (all a search result can show)   -> used, labelled "verify"
//   review    model number in the title, brand not confirmed,
//             or a title that may name a spare part              -> a person decides once
//   reject    renewed, other brand, aftermarket, spare part,
//             wrong pack size, or a kit variant of a single tool -> never used
//
// A "probable" match becomes "exact" by loading the listing's detail page
// (1 search), which carries the barcode.

import { toUpc12 } from './identifiers';

const RENEWED = /\b(renewed|refurbished|reconditioned|used|pre-owned|open box)\b/i;
const AFTERMARKET = /\b(replacement for|compatible with|for use with|fits|aftermarket)\b/i;
// A spare part for the tool, not the tool (Ruling 65). Each form is taken from recorded titles that
// carry the RYOBI brand and the model as a whole word, so the title test alone made them "probable":
//   "OEM 89240027010 Replacement Miter Saw Inlet Dust Chute P553 TS1144"
//   "OEM 303590006 Sander Backing Pad P343 P570 PCL430 MT100 …"
// "OEM" followed by a run of digits is a part number, never a RYOBI or DEWALT model number; with a
// part's name anywhere in the title it is the part. Either signal alone is not enough: a genuine
// battery can carry an OEM number, and a genuine sander can come "with 3 Replacement Sanding Pads".
// The part names are the ones in recorded spare-part titles.
const OEM_PART_NUMBER = /\bOEM\s+\d{6,}\b/i;
const PART_NAME = /\b(chute|knob|cap|indicator|pads?|sleeve|wheels?)\b/i;
// Possibly a spare part: "OEM" or "Replacement" anywhere else. The title alone then cannot make a
// listing "probable"; the owner decides. No genuine tool, battery, charger or kit row in the
// recordings uses either word.
const MAYBE_SPARE_PART = /\b(OEM|replacement)\b/i;
const BULK = /(bulk packaged|non-retail packag|no retail packag)/i;
const MULTI = /\b(\d+)\s*-?\s*pack\b|\bpack of (\d+)\b|\bset of (\d+)\b/i;
const KIT_WORDS = /\b(kit|combo|bundle|with battery|with charger|w\/ battery|and charger)\b/i;

export type Grade = 'exact' | 'strong' | 'probable' | 'review' | 'reject';

/** The reason a listing showing the model is review when nothing confirms its brand. */
export const BRAND_NOT_CONFIRMED = 'model number in the title, brand not confirmed';

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
  image?: string | null;
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

const norm = (s: string): string => s.toUpperCase().trim();
// RYOBI writes a tool without its tool-only B (PBLRC25 for PBLRC25B): a kit's Home Depot page lists
// "(1) PCL206 …" where Amazon sells PCL206B. One trailing B is removed from both models before they are
// compared, so X matches X and XB, XB matches XB and X, and XBB matches neither (it is compared as XB).
const ryobiBase = (m: string): string => (m.endsWith('B') ? m.slice(0, -1) : m);

/** Whether two models of a brand name the same kit or tool, by the rule above. DEWALT: only the same model. */
export function sameModel(brand: string, a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || (norm(brand) === 'RYOBI' && ryobiBase(x) === ryobiBase(y));
}

/** The key under which sameModel's models meet: brand, and the model without one RYOBI trailing B. */
export const kitKey = (brand: string, model: string): string => {
  const b = norm(brand);
  return `${b}:${b === 'RYOBI' ? ryobiBase(norm(model)) : norm(model)}`;
};

/**
 * Ruling 70: every way a model may be written that sameModel accepts for it, the model itself first:
 * PCL206 and PCL206B for a RYOBI PCL206 or PCL206B; only the model for DEWALT, and for a RYOBI XBB.
 */
export function modelForms(brand: string, model: string): string[] {
  const m = norm(model);
  if (norm(brand) !== 'RYOBI') return [m];
  const base = ryobiBase(m);
  return [...new Set([m, base, `${base}B`])].filter((f) => sameModel(brand, f, m));
}

/** Ruling 70: the title carries the model, or for RYOBI its other form by sameModel, as a whole token. */
export function titleHasModel(brand: string, title: string, model: string): boolean {
  return modelForms(brand, model).some((f) => hasModelToken(title, f));
}

/** Ruling 71: the title says "OEM" or "Replacement", which often marks a spare part (MAYBE_SPARE_PART). */
export const maySparePart = (title: string): boolean => MAYBE_SPARE_PART.test(title);

export function grade(want: Wanted, cand: Candidate): Graded {
  const packaging = BULK.test(cand.title) ? 'bulk' : 'retail';
  const out = (g: Grade, ...reasons: string[]): Graded => ({ asin: cand.asin, grade: g, packaging, reasons });
  const brand = want.brand.trim().toUpperCase();

  if (cand.brand && cand.brand.trim().toUpperCase() !== brand) return out('reject', 'different brand');
  if (AFTERMARKET.test(cand.title)) return out('reject', 'aftermarket or compatible part');
  const wantUpc = toUpc12(want.upc);
  const upcOk = wantUpc !== null && (cand.upcs ?? []).some((u) => toUpc12(u) === wantUpc);
  // A barcode match is the listing itself, whatever its title says.
  if (!upcOk && OEM_PART_NUMBER.test(cand.title) && PART_NAME.test(cand.title)) return out('reject', 'spare part');
  if (RENEWED.test(cand.title)) return out('reject', 'renewed or used listing');

  let qty = cand.packageQty ?? null;
  const multi = MULTI.exec(cand.title);
  if (multi) qty = Number(multi[1] ?? multi[2] ?? multi[3]);
  const wantQty = want.packQty ?? 1;
  if (qty && qty !== wantQty) return out('reject', `pack of ${qty}, component is a pack of ${wantQty}`);

  const partOk = !!cand.partNumber && clean(cand.partNumber) === clean(want.model);
  // Ruling 70: a RYOBI part written without its tool-only B (PCL206) is its Amazon listing's PCL206B.
  const titleOk = titleHasModel(want.brand, cand.title, want.model);

  if (!want.isKit && KIT_WORDS.test(cand.title) && !partOk) {
    return out('reject', 'listing is a kit, component is a single item');
  }

  if (upcOk) return out('exact', 'barcode match', ...(partOk || titleOk ? ['model number match'] : []));
  if (partOk) return out('strong', 'manufacturer part number match');
  if (titleOk) {
    const brandConfirmed =
      (!!cand.brand && cand.brand.trim().toUpperCase() === brand) ||
      cand.title.trim().toUpperCase().startsWith(brand);
    if (!brandConfirmed) return out('review', BRAND_NOT_CONFIRMED);
    if (MAYBE_SPARE_PART.test(cand.title)) {
      return out('review', 'brand and model number in the title, but the title may name a spare part (OEM or Replacement)');
    }
    return out('probable', 'brand and model number in the title; barcode not checked yet');
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
