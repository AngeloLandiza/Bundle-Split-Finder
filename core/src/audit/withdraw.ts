// Which of the audit's findings (sanity.ts) are certain enough for the app to act on by itself as "Wrong listing"
// (docs/decisions.md, "The app replaces a wrong listing itself", Nov 25). Withdrawing a listing only lowers confidence,
// but a listing withdrawn for a part is never chosen for it again by the app, so a rule is adopted only at zero right
// listings withdrawn on every answer key (scripts/measure-repick.ts):
//
//   title    a counted listing's title names another model and not the part's (title_other_model): 0 right of the labelled
//            listings it fires on (validation 804 rows, audit corpus, the owner's stores, the Nov 24 backpack)
//   two      one listing counted for two different models (listing_two_models), neither of them a kit (a kit's listing
//            names its tools), the title does not name this part alone (a title naming both, "PCL700B & PCL702B", sells
//            both, so it is neither part alone), and no rung confirmed it for this part from Amazon's fields
//
// The other findings stay holds for the owner: a title naming the part and another model too (P119's charger listing
// names what it charges, and is right), a pack of N (PBP2003 is itself a 2-pack), a price ratio on its own, too good to
// be true. A listing the owner chose is never withdrawn. Pure: no node:*, no chrome.*.

import { sameModel, titleHasModel } from '../match';
import type { BundleRow, PartRow } from '../scan/types';
import { isKitModel, otherModels, type SanityFinding } from './sanity';

export interface CertainWithdrawal {
  bundleId: string;
  brand: string;
  model: string;
  asin: string;
  kind: 'title_other_model' | 'listing_two_models';
  /** The finding's own sentence: what the owner would have read as "Needs a look". */
  reason: string;
}

/** The title rule: the listing's title names another model and not the part's. */
export const titleNamesAnother = (brand: string, model: string, title: string): boolean =>
  !titleHasModel(brand, title, model) && otherModels(brand, title, model).length > 0;

/** Whether the title names this part and no other model (then a listing counted twice is the other part's mistake). */
export const titleNamesOnly = (brand: string, model: string, title: string): boolean =>
  titleHasModel(brand, title, model) && otherModels(brand, title, model).length === 0;

/**
 * The two-models rule for one use of a listing: counted for `model` and for `others` (models not the same), none of them
 * a kit, and its title (known) does not name `model` alone.
 */
export function twoModelsWithdraws(brand: string, model: string, others: readonly string[], title: string | null): boolean {
  if (title === null || title === '' || others.length === 0) return false;
  if (isKitModel(brand, model) || others.some((o) => isKitModel(brand, o))) return false;
  if (others.every((o) => sameModel(brand, o, model))) return false;
  return !titleNamesOnly(brand, model, title);
}

const CONFIRMED_BY: readonly string[] = ['keepa_catalog', 'serpapi_product', 'listing_fields'];

const partIn =(b: BundleRow, model: string, asin: string): PartRow | undefined =>
  [...b.parts, ...b.options.flatMap((o) => o.parts)].find((p) => p.model === model && p.asin === asin);

/**
 * The findings the app acts on by itself, one per part and listing: hold findings of the two kinds above on a listing the
 * owner did not choose. `findings` are those the owner has not marked right (sanityFindings with `cleared`).
 */
export function certainWithdrawals(findings: readonly SanityFinding[], bundles: readonly BundleRow[]): CertainWithdrawal[] {
  const byKey = new Map(bundles.map((b) => [b.key, b]));
  // Every model each listing is counted for, across the deals, as the two-models check reads it.
  const counted = new Map<string, Set<string>>();
  for (const b of bundles) for (const p of [...b.parts, ...b.options.flatMap((o) => o.parts)]) {
    if (p.status === 'matched' && p.asin) counted.set(p.asin, (counted.get(p.asin) ?? new Set()).add(p.model));
  }
  const out = new Map<string, CertainWithdrawal>();
  for (const f of findings) {
    if (f.severity !== 'hold' || !f.part || !f.asin) continue;
    const b = byKey.get(f.bundleId);
    const p = b ? partIn(b, f.part, f.asin) : undefined;
    if (!b || !p || p.verifiedBy === 'owner') continue;
    const title = p.title ?? null;
    // A use a rung confirmed from Amazon's fields is spared by the two-models rule: the other use is then the likely mistake
    // (it stays a hold for the owner). Measured exposure without it: P119's charger listing names P100 and P101 too.
    const confirmed = p.verifiedBy !== undefined && CONFIRMED_BY.includes(p.verifiedBy);
    const certain =
      f.kind === 'title_other_model'
        ? title !== null && titleNamesAnother(b.brand, p.model, title)
        : f.kind === 'listing_two_models'
          ? !confirmed && twoModelsWithdraws(b.brand, p.model, [...(counted.get(f.asin) ?? [])].filter((m) => !sameModel(b.brand, m, p.model)), title)
          : false;
    if (!certain) continue;
    const key = `${b.brand.toUpperCase()}:${p.model.toUpperCase()}|${f.asin}`;
    if (!out.has(key)) out.set(key, { bundleId: b.key, brand: b.brand, model: p.model, asin: f.asin, kind: f.kind as CertainWithdrawal['kind'], reason: f.sentence });
  }
  return [...out.values()];
}
