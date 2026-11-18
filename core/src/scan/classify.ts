// Sort a retailer row before it is stored, and describe a part before it is looked up.
//
// looksLikeBundle answers from the model number's shape only. Whether the split
// resolves is decompose()'s job: a row with a bundle shape that the splitter cannot
// resolve goes to the review queue, not to the catalog.

import { type Catalog, dewaltBundleForm } from '../decompose';
import type { Wanted } from '../match';

// "PBLRC2501SB", "PCL500525SB": four or more digits, then SB.
const RYOBI_SPECIAL_BUY = /\d{4,}SB$/;
// "DCB205-2": a DEWALT battery N-pack, as Home Depot writes it and so as the splitter returns it
// from the catalog. Also the one hyphen form a typed DEWALT part may take (answers.ts, Ruling 47).
export const DEWALT_PACK = /^DCB\d+-(\d)$/;

/** True when the model number has the shape of a retailer bundle. Shape only: it does not say the split will resolve. */
export function looksLikeBundle(brand: string, model: string): boolean {
  const b = brand.trim().toUpperCase();
  const m = model.trim().toUpperCase();
  if (b === 'RYOBI') return m.includes('-') || RYOBI_SPECIAL_BUY.test(m);
  if (b === 'DEWALT') return dewaltBundleForm(m) !== null;
  return false;
}

/** What to ask of an Amazon listing for this part. */
export function wantedFor(brand: string, model: string, catalog: Catalog): Wanted {
  const b = brand.trim().toUpperCase();
  const m = model.trim().toUpperCase();
  const want: Wanted = { brand: b, model: m };
  if (catalog.get(m)?.isKit || (b === 'DEWALT' && m.startsWith('DCK'))) want.isKit = true;
  const pack = b === 'DEWALT' ? DEWALT_PACK.exec(m) : null;
  if (pack) want.packQty = Number(pack[1]);
  return want;
}

/** ['A', 'B', 'A'] -> { A: 2, B: 1 } */
export function componentCounts(components: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of components) counts[c] = (Object.hasOwn(counts, c) ? counts[c]! : 0) + 1;
  return counts;
}
