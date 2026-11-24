// A second line of checks on what the app has already decided (docs/decisions.md, "Checking the app's own work").
//
// It reads only outputs: the deals the report built (BundleRow, as store/deals.json and an audit export hold them), never
// the rules that made them. So it catches a wrong listing whatever rule confirmed it. A `hold` finding keeps a deal from
// being Buy now and asks the owner to look; it never changes a match or an estimate (CLAUDE.md rule 4: a doubtful case is
// shown as doubtful, not answered). A `note` is shown and holds nothing.
//
// Every threshold below was chosen from the recorded data (fixtures/e2e-2026-11-23 after-scan3 and after-scan5, the audit
// corpus, the Keepa answer key) and is written down with its measurement in docs/decisions.md. Pure: no node:*, no chrome.*.

import { hasModelToken, sameModel, titleHasModel } from '../match';
import type { BundleRow, PartRow, SaleOption, VerifiedBy } from '../scan/types';

export type SanityKind =
  /** A listing confirmed for the part whose title names another model and not the part's. */
  | 'title_other_model'
  /** The counted Amazon price is far above (hold) or far below (note) Home Depot's price for the part sold alone. */
  | 'price_vs_home_depot'
  /** The estimate is beyond anything a right answer reached: ROI, or the parts' Amazon total against the regular price. */
  | 'too_good'
  /** One Amazon listing counted for two different models. */
  | 'listing_two_models'
  /**
   * The listing's title names the part and another model too (another part of the bundle, a second tool): it may sell
   * more than the part. Not for a kit, whose title names its tools.
   */
  | 'title_extra_model'
  /** The listing's title says a pack of N while the part is one unit. */
  | 'pack_counted_as_one';

export type SanitySeverity = 'hold' | 'note';

export interface SanityLink {
  label: string;
  url: string;
}

export interface SanityFinding {
  kind: SanityKind;
  severity: SanitySeverity;
  bundleId: string;
  /** The part's model, for a finding about one part. */
  part?: string;
  asin?: string;
  /** One plain sentence for the owner ("Needs a look: <sentence>"). */
  sentence: string;
  /** The figures behind it (ratio, prices, ROI), for the table and the tests. */
  numbers: Record<string, number>;
  /** Home Depot's page first, then the Amazon listing: where to check it by eye. */
  links: SanityLink[];
  /**
   * What "This is right" remembers: `listing|BRAND:MODEL|ASIN` for a finding about a part's listing (cleared for that
   * listing on every deal), `bundle|<bundleId>|<kind>` for one about a deal's estimate.
   */
  clearKey: string;
}

/**
 * The thresholds, each from the measured distribution (docs/decisions.md has the numbers):
 * - priceRatio 3: right answers reach 2.80 (A98401, Home Depot on clearance at $9.97); the wrong ones are 4.04 (PCL702B on a
 *   two-vacuum listing) and 9.73 (DWST08017 on a $389 backpack).
 * - roi 1.0 (100%): right estimates reach 44%; the wrong ones read 107% and 473%.
 * - amazonOverRegular 1.5: the parts' Amazon total reaches 1.27 times the bundle's regular price on right answers; 1.79
 *   and 5.53 on the wrong ones.
 */
export const SANITY_LIMITS = { priceRatio: 3, priceRatioLow: 0.3, roi: 1, amazonOverRegular: 1.5 } as const;

/**
 * A part sold as a kit, whose listing title names its tools ("DCK225D2: … DCD794 Drill, DCF809 Impact Driver"): DEWALT's
 * DCK models, RYOBI's K-kits and starter kits (PCL1201K2, P307K1, PSK1212SB).
 */
export function isKitModel(brand: string, model: string): boolean {
  const m = model.trim().toUpperCase();
  const b = brand.trim().toUpperCase();
  return (b === 'DEWALT' && m.startsWith('DCK')) || (b === 'RYOBI' && (/K[0-9]?$/.test(m) || m.startsWith('PSK')));
}

/** The kits of a deal: by their model (isKitModel), and any kit a way to sell splits. */
function kitModels(b: BundleRow): Set<string> {
  const out = new Set<string>();
  for (const o of b.options) for (const k of o.splitKits) out.add(k.toUpperCase());
  for (const p of [...b.parts, ...b.options.flatMap((o) => o.parts)]) if (isKitModel(b.brand, p.model)) out.add(p.model.toUpperCase());
  return out;
}

/** The rungs that confirm a listing automatically. The owner's own choice is his; a title match is not a confirmation. */
const CONFIRMED_BY: readonly VerifiedBy[] = ['keepa_catalog', 'serpapi_product', 'listing_fields'];

/**
 * Model-like tokens in a title: one to six letters, then digits and letters with at least three digits in all, and an
 * optional "-1" ("DWST60122-1", "PCL700B", "DCD794", "A10FB1G", "R18ID2-0"). A unit never matches: it starts with a digit
 * ("18V", "450-CFM") or has fewer than three digits ("M18", "F1").
 */
const MODEL_TOKEN = /(?<![A-Z0-9])[A-Z]{1,6}[0-9][A-Z0-9]*(?:-[0-9]{1,2})?(?![A-Z0-9])/g;

export function modelTokens(title: string): string[] {
  const out = new Set<string>();
  for (const m of title.toUpperCase().matchAll(MODEL_TOKEN)) {
    if ((m[0].match(/[0-9]/g) ?? []).length >= 3) out.add(m[0]);
  }
  return [...out];
}

/** The title's model tokens that are not the part's model (nor its RYOBI twin, nor the part with a "-2" pack suffix). */
export function otherModels(brand: string, title: string, model: string): string[] {
  const base = model.toUpperCase().replace(/-[0-9]{1,2}$/, '');
  return modelTokens(title).filter((t) => !sameModel(brand, t, model) && !sameModel(brand, t.replace(/-[0-9]{1,2}$/, ''), base));
}

/** "2-Pack", "pack of 2", "2 pk", "Double Pack", "Twin Pack": how many units the title sells, or null. */
export function packOf(title: string): number | null {
  const t = title.toUpperCase();
  if (/\b(DOUBLE|TWIN)[\s-]*PACK\b/.test(t)) return 2;
  const m = /\b(\d+)\s*-?\s*(?:PACK|PK)\b|\bPACK\s+OF\s+(\d+)\b/.exec(t);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isFinite(n) && n >= 2 && n <= 50 ? n : null;
}

const amazon = (asin: string): SanityLink => ({ label: 'Amazon listing', url: `https://www.amazon.com/dp/${encodeURIComponent(asin)}` });
const usd = (n: number): string => `$${n.toFixed(2)}`;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const homeDepotOf = (p: PartRow) => p.prices.find((x) => x.kind === 'homedepot') ?? null;

function homeDepotLinks(b: BundleRow, p?: PartRow): SanityLink[] {
  const out: SanityLink[] = [];
  if (b.link) out.push({ label: 'Home Depot bundle', url: b.link });
  const hd = p ? homeDepotOf(p) : null;
  if (hd?.link) out.push({ label: `Home Depot ${p!.model} sold alone`, url: hd.link });
  return out;
}

/** Each way to sell's parts with a counted listing, each (model, ASIN) once per bundle, with the options it is in. */
function countedParts(b: BundleRow): PartRow[] {
  const seen = new Map<string, PartRow>();
  const options: SaleOption[] = b.options.length > 0 ? b.options : [{ parts: b.parts } as SaleOption];
  for (const o of options) {
    for (const p of o.parts) {
      if (p.status !== 'matched' || !p.asin) continue;
      const k = `${p.model.toUpperCase()}|${p.asin}`;
      if (!seen.has(k)) seen.set(k, p);
    }
  }
  return [...seen.values()];
}

const listingKey = (brand: string, model: string, asin: string): string => `listing|${brand.trim().toUpperCase()}:${model.trim().toUpperCase()}|${asin}`;

/** The findings about one deal's parts and estimates (every check but listing_two_models, which looks across deals). */
function bundleFindings(b: BundleRow): SanityFinding[] {
  const out: SanityFinding[] = [];
  const kits = kitModels(b);
  for (const p of countedParts(b)) {
    const asin = p.asin!;
    const clearKey = listingKey(b.brand, p.model, asin);
    const links = [...homeDepotLinks(b, p), amazon(asin)];
    const title = p.title ?? '';

    const judged = title !== '' && p.verifiedBy !== 'owner';
    const how = p.verifiedBy !== undefined && CONFIRMED_BY.includes(p.verifiedBy) ? 'confirmed' : 'counted';
    if (judged && !titleHasModel(b.brand, title, p.model)) {
      const others = otherModels(b.brand, title, p.model);
      if (others.length > 0) {
        out.push({
          kind: 'title_other_model', severity: 'hold', bundleId: b.key, part: p.model, asin, clearKey, links, numbers: {},
          sentence: `the Amazon listing ${how} for ${p.model} is titled "${title}", which names ${others.join(', ')} and not ${p.model}.`,
        });
      }
    } else if (judged && !kits.has(p.model.toUpperCase())) {
      const others = otherModels(b.brand, title, p.model);
      if (others.length > 0) {
        const ours = others.filter((t) => [b.model, ...b.parts.map((x) => x.model)].some((m) => m !== '' && sameModel(b.brand, m, t)));
        out.push({
          kind: 'title_extra_model', severity: 'hold', bundleId: b.key, part: p.model, asin, clearKey, links, numbers: { models: others.length + 1 },
          sentence: ours.length > 0
            ? `the Amazon listing ${how} for ${p.model} also names ${ours.join(', ')} of this bundle: "${title}".`
            : `the Amazon listing ${how} for ${p.model} also names ${others.join(', ')}: "${title}". It may sell more than the part.`,
        });
      }
    }

    const hd = homeDepotOf(p);
    if (p.price !== null && hd !== null && hd.price > 0) {
      const ratio = p.price / hd.price;
      if (ratio > SANITY_LIMITS.priceRatio) {
        out.push({
          kind: 'price_vs_home_depot', severity: 'hold', bundleId: b.key, part: p.model, asin, clearKey, links,
          numbers: { amazon: p.price, homeDepot: hd.price, ratio: round2(ratio) },
          sentence: `Amazon's ${usd(p.price)} for ${p.model} is ${round2(ratio)} times Home Depot's ${usd(hd.price)} for it sold alone.`,
        });
      } else if (ratio < SANITY_LIMITS.priceRatioLow) {
        // Too low only lowers the estimate (a deal missed, never a bad buy): shown, holds nothing.
        out.push({
          kind: 'price_vs_home_depot', severity: 'note', bundleId: b.key, part: p.model, asin, clearKey, links,
          numbers: { amazon: p.price, homeDepot: hd.price, ratio: round2(ratio) },
          sentence: `Amazon's ${usd(p.price)} for ${p.model} is under a third of Home Depot's ${usd(hd.price)} for it sold alone; the listing may be an accessory or a part.`,
        });
      }
    }

    if (judged) {
      const pack = packOf(title);
      if (pack !== null && !/-[0-9]{1,2}$/.test(p.model)) {
        out.push({
          kind: 'pack_counted_as_one', severity: 'hold', bundleId: b.key, part: p.model, asin, clearKey, links, numbers: { pack, qty: p.qty },
          sentence: `the Amazon listing counted for ${p.model} sells a pack of ${pack} ("${title}"), counted as ${p.qty === 1 ? 'one' : p.qty}.`,
        });
      }
    }
  }

  const options: SaleOption[] = b.options.length > 0 ? b.options : [];
  let tooGood: SanityFinding | null = null;
  for (const o of options) {
    const est = o.estimate;
    const total = o.parts.every((p) => p.price !== null) && o.parts.length > 0 ? o.parts.reduce((n, p) => n + p.price! * p.qty, 0) : null;
    const over = total !== null && b.regularPrice !== null && b.regularPrice > 0 ? total / b.regularPrice : null;
    const roiHigh = est !== null && est.roi > SANITY_LIMITS.roi;
    const overHigh = over !== null && over > SANITY_LIMITS.amazonOverRegular;
    if (!roiHigh && !overHigh) continue;
    const roiPct = est ? Math.round(est.roi * 100) : null;
    const words = [
      roiHigh ? `an estimated ROI of ${roiPct}%` : null,
      overHigh ? `parts that sell on Amazon for ${round2(over!)} times Home Depot's regular ${usd(b.regularPrice!)}` : null,
    ].filter((x): x is string => x !== null);
    const f: SanityFinding = {
      kind: 'too_good', severity: 'hold', bundleId: b.key, clearKey: `bundle|${b.key}|too_good`,
      links: [...homeDepotLinks(b), ...o.parts.flatMap((p) => (p.asin ? [amazon(p.asin)] : []))],
      numbers: { ...(est ? { roi: est.roi, profit: est.profit } : {}), ...(over !== null ? { amazonOverRegular: round2(over) } : {}) },
      sentence: `${words.join(' and ')} is more than any checked deal reached; one of the listings may not be the part.`,
    };
    if (tooGood === null || (f.numbers.roi ?? 0) > (tooGood.numbers.roi ?? 0)) tooGood = f;
  }
  if (tooGood) out.push({ ...tooGood, sentence: capital(tooGood.sentence) });
  return out.map((f) => ({ ...f, sentence: capital(f.sentence) }));
}

const capital = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

/** One listing counted for models that are not the same model (RYOBI's PCL515 and PCL515B are one), across every deal. */
function twoModelFindings(bundles: readonly BundleRow[]): SanityFinding[] {
  const byAsin = new Map<string, { brand: string; model: string; bundle: BundleRow; part: PartRow }[]>();
  for (const b of bundles) {
    for (const p of countedParts(b)) {
      const list = byAsin.get(p.asin!) ?? [];
      list.push({ brand: b.brand, model: p.model, bundle: b, part: p });
      byAsin.set(p.asin!, list);
    }
  }
  const out: SanityFinding[] = [];
  for (const [asin, uses] of byAsin) {
    for (const u of uses) {
      const others = [...new Set(uses.filter((x) => !(x.brand.toUpperCase() === u.brand.toUpperCase() && sameModel(u.brand, x.model, u.model))).map((x) => x.model))];
      if (others.length === 0) continue;
      out.push({
        kind: 'listing_two_models', severity: 'hold', bundleId: u.bundle.key, part: u.model, asin, clearKey: listingKey(u.brand, u.model, asin),
        links: [...homeDepotLinks(u.bundle, u.part), amazon(asin)], numbers: { models: others.length + 1 },
        sentence: `The same Amazon listing is counted for ${u.model} and for ${others.join(', ')}; one listing cannot be both.`,
      });
    }
  }
  return out;
}

export interface SanityOptions {
  /** clearKeys the owner marked "This is right": such findings are left out. */
  cleared?: Iterable<string>;
}

/** Every finding on the deals, holds first, then by deal and part. */
export function sanityFindings(bundles: readonly BundleRow[], opts: SanityOptions = {}): SanityFinding[] {
  const cleared = new Set(opts.cleared ?? []);
  const all = [...bundles.flatMap(bundleFindings), ...twoModelFindings(bundles)].filter((f) => !cleared.has(f.clearKey));
  const rank = (s: SanitySeverity) => (s === 'hold' ? 0 : 1);
  return all.sort((a, b) => rank(a.severity) - rank(b.severity) || a.bundleId.localeCompare(b.bundleId) || (a.part ?? '').localeCompare(b.part ?? '') || a.kind.localeCompare(b.kind));
}

/** The deals a hold keeps from Buy now, each with its first hold's sentence ("Needs a look: …"). */
export function heldDeals(findings: readonly SanityFinding[]): Map<string, SanityFinding> {
  const out = new Map<string, SanityFinding>();
  for (const f of findings) if (f.severity === 'hold' && !out.has(f.bundleId)) out.set(f.bundleId, f);
  return out;
}
