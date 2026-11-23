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
