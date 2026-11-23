// The structured-identity check: does Amazon's own catalog say a listing is the part? Pure.
//
// A title match ("probable") is the brand and the model number in a search row's title; it cannot see a listing's
// part number, pack size or maker. Keepa's product object (1 token) and SerpApi's product page carry them. The check
// reads those fields against the part and answers:
//
//   confirmed     the brand field is the part's brand, the part number (or model) field is the part's model by
//                 sameModel (DEWALT exact; RYOBI with or without its one tool-only B), the manufacturer, when given,
//                 is the brand too, and nothing in the fields or the title contradicts it (below)
//   contradicted  a field plainly disagrees: another brand (and the manufacturer is not the part's brand either), or a
//                 part number that is another model of the brand and not a longer or shorter form of the part's
//   unknown       anything else: a field missing, a maker that is not the brand, a title or count that disagrees
//
// No fuzzy matching and no title-only confirmation: the title can only stop a confirmation, never give one. A field that
// is a variant of the part's model (DCB606YY for DCB606, PCL001K1 for PCL001K) is unknown, never contradicted: the
// fields alone cannot say whether a variant is another product (CLAUDE.md rule 4).

import {
  addsToKit, AFTERMARKET, FOR_BRAND, KIT_CONTENTS, KIT_WITH_EXTRAS, KIT_WORDS, MAYBE_SPARE_PART, MODEL_PATTERNS, MULTI, NOT_INCLUDED_PHRASE, OEM_PART_NUMBER,
  PART_NAME, RENEWED, sameModel, type Wanted,
} from '../match';
import { cleanBrand } from '../serpapi/parsers';
import type { KeepaProduct } from './types';

/** Where the fields came from: a Keepa product pull, or a SerpApi amazon_product page. */
export type IdentitySource = 'keepa_catalog' | 'serpapi_product';

/** A listing's structured fields, as Amazon's catalog gives them. */
export interface ListingIdentity {
  asin: string;
  title: string | null;
  brand: string | null;
  manufacturer: string | null;
  partNumber: string | null;
  model: string | null;
  /** Null when absent (Keepa's -1 or 0). */
  numberOfItems: number | null;
  packageQuantity: number | null;
  source: IdentitySource;
}

export type IdentityStatus = 'confirmed' | 'contradicted' | 'unknown';

export interface IdentityCheck {
  status: IdentityStatus;
  /** One plain sentence: the evidence when confirmed, the disagreement when contradicted, what is missing when unknown. */
  reason: string;
}

/** The part, as the matcher wants it (classify.ts wantedFor): brand, model, whether it is a kit, its pack size when known. */
export type PartIdentity = Wanted;

const where = (source: IdentitySource): string => (source === 'keepa_catalog' ? "Amazon's catalog" : "Amazon's product page");

/** A brand as the check compares it: "Brand: RYOBI", "Ryobi" and "RYOBI" are RYOBI; "DeWalt" is DEWALT. Nothing fuzzier. */
const brandKey = (raw: string | null | undefined): string | null => {
  const b = cleanBrand(raw ?? null);
  const k = b ? b.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  return k === '' ? null : k;
};

/** A part number or model as compared: upper case, without a leading "#" and without spaces. */
const idKey = (raw: string | null | undefined): string | null => {
  const k = (raw ?? '').toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
  return k === '' ? null : k;
};

/** Whether `id` is, as a whole, a model number of the brand's pattern (match.ts MODEL_PATTERNS). */
function isBrandModel(brand: string, id: string): boolean {
  const pattern = MODEL_PATTERNS[brand];
  if (!pattern) return false;
  return Array.from(id.matchAll(new RegExp(pattern.source, 'g')), (m) => m[0]).includes(id);
}

/** RYOBI's tool-only B taken off, as sameModel compares. */
const base = (brand: string, m: string): string => (brand === 'RYOBI' && m.endsWith('B') ? m.slice(0, -1) : m);

/** One model is a longer or shorter form of the other (DCB606YY and DCB606, PCL001K and PCL001B's PCL001): a variant, not plainly another. */
const variantOf = (brand: string, a: string, b: string): boolean => {
  const x = base(brand, a);
  const y = base(brand, b);
  return x.startsWith(y) || y.startsWith(x);
};

// DEWALT's battery letters in a kit model (DCK540D1: one D battery), as amp-hours. Only the letters whose battery is
// certain; a kit with any other letter has no amp-hour rule (the check then reads nothing from the letters).
const DEWALT_BATTERY_AH: Record<string, number[]> = {
  C: [1.3, 1.5], D: [2], E: [1.7], H: [5], L: [3], M: [4], P: [5], T: [6], X: [9], Y: [12],
};
const AMP_HOURS = /(\d+(?:\.\d+)?)\s*-?\s*ah\b/gi;

/**
 * For a DEWALT kit: the amp-hours a title names that none of the model's battery letters gives ("5Ah" for DCK540D1's D,
 * a 2.0Ah battery). Null when the title agrees, names none, or a letter is not in DEWALT_BATTERY_AH.
 */
export function dewaltAmpHourConflict(model: string, title: string): string | null {
  const m = model.toUpperCase();
  const tail = /^DC[A-Z]{1,3}\d{3,4}((?:[A-Z]\d)+)$/.exec(m)?.[1];
  if (!tail) return null;
  const letters = Array.from(tail.matchAll(/([A-Z])\d/g), (x) => x[1]!);
  if (!letters.every((l) => Object.hasOwn(DEWALT_BATTERY_AH, l))) return null;
  const allowed = new Set(letters.flatMap((l) => DEWALT_BATTERY_AH[l]!));
  const named = Array.from(title.matchAll(AMP_HOURS), (x) => Number(x[1]));
  const odd = named.filter((ah) => !allowed.has(ah));
  if (odd.length === 0) return null;
  const said = letters.map((l) => `${l} is ${DEWALT_BATTERY_AH[l]!.map((a) => `${a.toFixed(1)}Ah`).join(' or ')}`).join(', ');
  return `title says ${odd[0]}Ah, but in ${m} ${said}`;
}

/** Why the title or the counts stop a confirmation, or null. Never a reason to contradict: a title is not the catalog. */
function titleOrCountProblem(want: PartIdentity, l: ListingIdentity): string | null {
  const brand = want.brand.trim().toUpperCase();
  const model = want.model.trim().toUpperCase();
  const title = l.title ?? '';
  if (RENEWED.test(title)) return 'title says renewed or used';
  if (AFTERMARKET.test(title) || FOR_BRAND.test(title) || /\breplaces?\b/i.test(title)) return 'title reads as a part made for the tool';
  if (MAYBE_SPARE_PART.test(title) || (OEM_PART_NUMBER.test(title) && PART_NAME.test(title))) return 'title says OEM or Replacement, which often marks a spare part';
  const wantQty = want.packQty ?? 1;
  const multi = MULTI.exec(title);
  const titleQty = multi ? Number(multi[1] ?? multi[2] ?? multi[3] ?? multi[4]) : null;
  if (titleQty !== null && titleQty !== wantQty) return `title says a pack of ${titleQty}`;
  if (l.packageQuantity !== null && l.packageQuantity > 1 && l.packageQuantity !== wantQty) return `${where(l.source)} lists a package of ${l.packageQuantity}`;
  if (!want.isKit && l.numberOfItems !== null && l.numberOfItems > 1 && l.numberOfItems !== wantQty) return `${where(l.source)} lists ${l.numberOfItems} items`;
  if (!want.isKit) {
    const rest = title.replace(NOT_INCLUDED_PHRASE, ' ');
    if (KIT_WORDS.test(rest)) {
      // A kit with a battery, a charger, amp-hours, a combo or a bundle is not one tool, whatever its part number says
      // (B0DNNZ1W52: part number PCL540, "Cut-Out Tool Kit with Battery and Charger").
      if (KIT_CONTENTS.test(rest)) return 'title sells it with a battery, a charger or more';
      // A RYOBI model does not say whether the part is itself a kit (A98401, a 40-piece accessory kit): a bare "kit"
      // beside the catalog's own part number is the product's name. A tool-only B, or a DEWALT tool, is never a kit.
      if (brand !== 'RYOBI' || model.endsWith('B')) return 'title says kit, and the part is one tool';
    }
  } else {
    if (addsToKit(want, title)) return KIT_WITH_EXTRAS;
    if (brand === 'DEWALT') {
      const ah = dewaltAmpHourConflict(model, title);
      if (ah) return ah;
    }
  }
  const pattern = MODEL_PATTERNS[brand];
  if (pattern) {
    const named = Array.from(title.toUpperCase().matchAll(new RegExp(pattern.source, 'g')), (m) => m[0]);
    if (named.length > 0 && !named.some((m) => sameModel(brand, m, model))) return `title names ${named[0]}, not ${model}`;
  }
  return null;
}

/** The structured-identity check (the rule at the top of this file). */
export function checkIdentity(want: PartIdentity, l: ListingIdentity): IdentityCheck {
  const brand = want.brand.trim().toUpperCase();
  const model = want.model.trim().toUpperCase();
  const from = where(l.source);
  const listed = brandKey(l.brand);
  const maker = brandKey(l.manufacturer);
  const shown = cleanBrand(l.brand) ?? '';
  if (listed !== null && listed !== brand) {
    // B0BL8BC8MF: brand FIRE ROSE, manufacturer Ryobi. A seller's brand over the maker's is not plainly another product.
    if (maker === brand) return { status: 'unknown', reason: `${from} lists brand ${shown}, made by ${l.manufacturer}` };
    return { status: 'contradicted', reason: `${from} lists brand ${shown}, not ${brand}` };
  }
  const part = idKey(l.partNumber);
  const alt = idKey(l.model);
  const field = part !== null && sameModel(brand, part, model) ? 'part number' : alt !== null && sameModel(brand, alt, model) ? 'model number' : null;
  if (field === null) {
    // Only the part number field contradicts: Keepa's model field is often a variant or a barcode (DCB606YY, 33287199938).
    if (part !== null && isBrandModel(brand, part) && !variantOf(brand, part, model) && !(alt !== null && variantOf(brand, alt, model))) {
      return { status: 'contradicted', reason: `${from} lists part number ${part}, not ${model}` };
    }
    return { status: 'unknown', reason: `${from} lists no part number that is ${model}` };
  }
  if (listed === null) return { status: 'unknown', reason: `${from} lists no brand` };
  if (maker !== null && maker !== brand) return { status: 'unknown', reason: `${from} lists brand ${shown} but manufacturer ${l.manufacturer}` };
  const problem = titleOrCountProblem(want, l);
  if (problem) return { status: 'unknown', reason: problem };
  const id = field === 'part number' ? part! : alt!;
  return { status: 'confirmed', reason: `${from} lists brand ${shown}, ${field} ${id}` };
}

/** A Keepa product's identity fields. */
export function identityFromKeepa(p: KeepaProduct): ListingIdentity {
  return {
    asin: p.asin,
    title: p.title ?? null,
    brand: p.brand ?? null,
    manufacturer: p.manufacturer ?? null,
    partNumber: p.partNumber ?? null,
    model: p.model ?? null,
    numberOfItems: p.numberOfItems ?? null,
    packageQuantity: p.packageQuantity ?? null,
    source: 'keepa_catalog',
  };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const count = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A SerpApi amazon_product page's identity fields (recorded: fixtures/recorded/amazon-product-*.json). The brand is
 * `product_results.brand` ("Brand: RYOBI"), else `product_details.brand_name`; the part number
 * `manufacturer_part_number`, else `part_number`, else `item_model_number`; the model `model_number` ("#PBLRC25B").
 */
export function identityFromSerpProduct(json: unknown, asin: string): ListingIdentity | null {
  const j = rec(json);
  const product = rec(j.product_results);
  const details = { ...rec(j.item_specifications), ...rec(j.product_details) };
  const title = text(product.title);
  if (!title) return null;
  return {
    asin: text(product.asin) ?? asin,
    title,
    brand: text(product.brand) ?? text(details.brand_name) ?? text(details.brand),
    manufacturer: text(details.manufacturer),
    partNumber: text(details.manufacturer_part_number) ?? text(details.part_number) ?? text(details.item_model_number),
    model: text(details.model_number) ?? text(details.model_name),
    numberOfItems: count(details.number_of_items),
    packageQuantity: count(details.package_quantity) ?? count(details.number_of_packs),
    source: 'serpapi_product',
  };
}
