// Brand aliases for the listing ladder's rungs 0 and 1 (Nov 23, measured: scripts/measure-autoconfirm.ts
// measureBrandAliases; docs/decisions.md). A listing's brand field counts as the part's brand when it is a recorded alias
// of it; every other condition of the rung is unchanged. Each alias carries the listings it rests on. Pure.
//
// Derived from the data: the brand-field values that the rows the answer key marks right carry, per brand
// (fixtures/validation/labels-2026-11-18.json and the owner's live deals):
//   RYOBI  TTI     B09HDZ5MPV "TTI Ryobi PBP004 …" (PBP004, key: right; brand field TTI in the live record)
//                  B096WHWDNB "TTI Ryobi PCG002 …, bulk packaged" (PCG002, key: uncertain; not counted either way)
//          ONEAND  B0B1QRQYK2 "ONEAND 18V Lithium-ION Charger PCG002" (PCG002, key: right; brand field ONEAND in the live record)
// Left out: FIRE ROSE (B0BL8BC8MF, key: right for PCL265B) is a seller's brand over RYOBI's, already read through its
// manufacturer field, and nothing ties the name to RYOBI elsewhere; "ONE+" as a brand field is in no recorded or live row.
// DEWALT: no right row carries another brand field.

import { cleanBrand } from '../serpapi/parsers';

export interface BrandAlias {
  /** The brand field as compared: upper case, letters and digits only ("ONEAND"). */
  alias: string;
  /** What the evidence says: "Amazon lists it under TTI, the maker of RYOBI". */
  says: string;
  /** The listings the alias rests on. */
  evidence: string[];
}

export const BRAND_ALIASES: Readonly<Record<string, readonly BrandAlias[]>> = {
  RYOBI: [
    { alias: 'TTI', says: 'Amazon lists it under TTI, the maker of RYOBI', evidence: ['B09HDZ5MPV (PBP004, right)', 'B096WHWDNB (PCG002, uncertain)'] },
    { alias: 'ONEAND', says: "Amazon lists it under ONEAND, Amazon's spelling of RYOBI ONE+", evidence: ['B0B1QRQYK2 (PCG002, right)'] },
  ],
};

const key = (raw: string | null | undefined): string => (cleanBrand(raw ?? null) ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The alias the brand field is of the part's brand, or null. */
export function brandAliasOf(brand: string, brandField: string | null | undefined): BrandAlias | null {
  const k = key(brandField);
  if (k === '') return null;
  return BRAND_ALIASES[brand.trim().toUpperCase()]?.find((a) => a.alias === k) ?? null;
}

// The manufacturer field (Nov 23, measured: scripts/measure-autoconfirm.ts measureManufacturerRule; docs/decisions.md).
// Rungs 0 and 1 and the listing judge's check held a listing whose brand field is the part's brand when its manufacturer
// field was anything else. Two manufacturer values are not a reason to hold it, given the brand field is the part's brand
// (or a recorded brand alias) and every other condition of the rung holds:
//   (a) a recorded manufacturer alias of the brand, with the listings it rests on:
//         RYOBI  TTI  B09HDZ5MPV "TTI Ryobi PBP004 …" (PBP004, key: right; brand RYOBI, manufacturer TTI in after-scan5)
//                     B0CRFS4F6G "18V ONE+ … Inflator/Deflator, PCL031B" (PCL031B, no key; not counted either way)
//   (b) the brand's own name followed by the one word "Tools" ("RYOBI Tools", RYOBI's own name for itself), and nothing
//       else: no "Inc", "Co", "Corp", "Power Tools" or "Industrial" is in any recorded listing, so none is accepted.
//         B0B1QRQYK2 "ONEAND 18V Lithium-ION Charger PCG002" (PCG002, key: right; manufacturer RYOBI Tools)
//         B0CM7TMB22 "Ryobi ONE+ 18V Cordless Verse Clamp Speaker PCL615B" (PCL615B, no key)
// Left out: Partyreal (B08L38QFFW, key: right for PSBDD01) is a seller's name, nothing ties it to RYOBI, and a listing
// under it stays held. A manufacturer alias never turns another brand in the BRAND field into the part's brand.

export interface MakerAlias {
  /** The manufacturer field as compared: upper case, letters and digits only ("TTI"). */
  maker: string;
  /** What the evidence says: "TTI (Techtronic Industries) makes RYOBI". */
  says: string;
  /** The listings the alias rests on. */
  evidence: string[];
}

export const MANUFACTURER_ALIASES: Readonly<Record<string, readonly MakerAlias[]>> = {
  RYOBI: [
    { maker: 'TTI', says: 'TTI (Techtronic Industries) makes RYOBI', evidence: ['B09HDZ5MPV (PBP004, right)', 'B0CRFS4F6G (PCL031B, no key)'] },
  ],
};

/** The one generic company word accepted after the brand's name in the manufacturer field ("RYOBI Tools"). */
export const MAKER_COMPANY_WORD = 'TOOLS';

/**
 * How a listing's manufacturer field reads against the part's brand: 'none' (empty), 'brand' (the brand itself), 'alias'
 * (a recorded manufacturer alias), 'company' (the brand plus "Tools"), or 'other' (anything else: the listing is held).
 * The brand field is the caller's to check first.
 */
export function makerReading(brand: string, manufacturer: string | null | undefined): { as: 'none' | 'brand' | 'other' } | { as: 'alias'; alias: MakerAlias } | { as: 'company' } {
  const b = brand.trim().toUpperCase();
  const k = key(manufacturer);
  if (k === '') return { as: 'none' };
  if (k === b) return { as: 'brand' };
  const alias = MANUFACTURER_ALIASES[b]?.find((a) => a.maker === k);
  if (alias) return { as: 'alias', alias };
  if (k === `${b}${MAKER_COMPANY_WORD}`) return { as: 'company' };
  return { as: 'other' };
}

/**
 * Whether the manufacturer field leaves the listing to the other conditions (the rule above). `makers: false` is the rule
 * before Nov 23 (the brand itself or nothing), kept for the measurement.
 */
export function makerAgrees(brand: string, manufacturer: string | null | undefined, opts: { makers?: boolean } = {}): boolean {
  const r = makerReading(brand, manufacturer);
  if (r.as === 'none' || r.as === 'brand') return true;
  return opts.makers !== false && r.as !== 'other';
}

/** Words for a confirmation read through the rule: "manufacturer TTI: TTI (Techtronic Industries) makes RYOBI"; null otherwise. */
export function makerWords(brand: string, manufacturer: string | null | undefined): string | null {
  const r = makerReading(brand, manufacturer);
  if (r.as === 'alias') return `manufacturer ${manufacturer!.trim()}: ${r.alias.says}`;
  if (r.as === 'company') return `manufacturer ${manufacturer!.trim()}: ${brand.trim().toUpperCase()}'s own name`;
  return null;
}
