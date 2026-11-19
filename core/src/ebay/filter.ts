import { hasModelToken, modelForms } from '../match';
import type { EbayListingSummary } from './types';

// The deterministic step before the judge. It never accepts a listing: it drops what cannot be the part
// and passes the rest on, so every kept listing still has to be judged. Each rule only removes.

export const MAX_CANDIDATES = 8;
const NEW_CONDITION = '1000';
/** eBay's "Power Tools" category: a listing outside it is an accessory, a case or a holder (the PCL206B search). */
export const POWER_TOOLS_CATEGORY = '3247';

export interface Dropped { itemId: string; reason: string }

const alnum = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
// A brand field that names no brand says nothing; it neither drops nor passes a listing by itself.
const NO_BRAND = new Set(['', 'UNBRANDED', 'DOESNOTAPPLY', 'NA', 'GENERIC']);

/**
 * kept: at most 8, in the order given (search order). dropped: why each one went.
 * Rules, in order: not New, no price, not USD, brand names another brand, outside Power Tools (a
 * listing with no category is not dropped), title/MPN/aspects name neither the model nor its RYOBI
 * twin (modelForms) as a whole token, beyond the 8th.
 */
export function preFilter<T extends EbayListingSummary>(
  part: { brand: string; model: string },
  listings: T[],
): { kept: T[]; dropped: Dropped[] } {
  const kept: T[] = [];
  const dropped: Dropped[] = [];
  const forms = modelForms(part.brand, part.model);
  const want = alnum(part.brand);
  for (const l of listings) {
    const drop = (reason: string): void => { dropped.push({ itemId: l.itemId, reason }); };
    if (l.conditionId !== NEW_CONDITION) { drop('not New'); continue; }
    if (l.price === null || !(l.price > 0)) { drop('no price'); continue; }
    if (l.currency !== 'USD') { drop('not priced in USD'); continue; }
    const brands = [l.brand, ...(l.aspects ?? []).filter((a) => a.name.toLowerCase() === 'brand').map((a) => a.value)]
      .map((b) => alnum(b ?? ''))
      .filter((b) => !NO_BRAND.has(b));
    if (brands.some((b) => b !== want)) { drop('names another brand'); continue; }
    if (l.categoryIds.length > 0 && !l.categoryIds.includes(POWER_TOOLS_CATEGORY)) { drop('not in Power Tools'); continue; }
    const places = [l.title, l.mpn ?? '', ...(l.aspects ?? []).map((a) => a.value)];
    if (!forms.some((f) => places.some((p) => hasModelToken(p, f)))) { drop('model not named'); continue; }
    if (kept.length >= MAX_CANDIDATES) { drop(`beyond the first ${MAX_CANDIDATES} candidates`); continue; }
    kept.push(l);
  }
  return { kept, dropped };
}
