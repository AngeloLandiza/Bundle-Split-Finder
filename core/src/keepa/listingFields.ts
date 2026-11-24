// Rung 1 of the listing ladder (docs/decisions.md, "Confirming listings by themselves"): more code evidence from the
// fields a listing pull already returned, for a listing the catalog check (verify.ts checkIdentity) left unknown. Pure.
// No new call: Keepa's product object, or a SerpApi product page, already carries the fields read here.
//
// Each sub-rule names one place the part's model number may stand as a whole token, and confirms only together with the
// gate below. A sub-rule is adopted (ADOPTED_RULES) only when scripts/measure-autoconfirm.ts measures it at zero wrong
// on every recorded row with a known answer; the others stay written and measured, never applied.
//
//   id_field   the model as a whole token inside the part number or model field ("Ryobi+P1895" for P1895)
//   features   the model as a whole token in a feature bullet
//   title      the model as a whole token in the title (what a title match already read, now with the catalog's brand)
//   gtin       a listing barcode equal to the Home Depot part's UPC
//
// The gate, for every sub-rule: the brand field is the part's brand; the manufacturer, when given, is the brand too (or a
// recorded maker of it, or its name plus "Tools": brandAliases.ts makerAgrees); the
// part number field, when given, is not another identifier (a variant or a European code is not the part's number); and
// no contradiction (verify.ts titleOrCountProblem: pack or count, kit versus bare tool, renewed, "replacement",
// "compatible", "for <brand>", another model of the brand in the title, a DEWALT battery size), nor a feature bullet
// that sells a bare tool with a battery or charger ("Comes with a 4Ah battery", B0FD1B8BG5), nor a bullet that names
// another model of the brand and not this one. The fields can stop a confirmation; they never contradict one.

import { toUpc12 } from '../identifiers';
import { FOR_BRAND, AFTERMARKET, KIT_CONTENTS, MODEL_PATTERNS, NOT_INCLUDED_PHRASE, sameModel, type Wanted } from '../match';
import { cleanBrand } from '../serpapi/parsers';
import { brandAliasOf, makerAgrees, makerWords } from './brandAliases';
import { checkIdentity, titleOrCountProblem, withAlias, type CheckOptions, type IdentityCheck, type ListingIdentity } from './verify';

export type FieldRule = 'id_field' | 'features' | 'title' | 'gtin';

/**
 * The sub-rules applied in the scan and the drip, by measurement (scripts/measure-autoconfirm.ts, Nov 23), on the 237
 * recorded rows the catalog check left unknown: 'title' 22 right, 0 wrong (42 rows the key says are another product
 * reached its gate and each was stopped: 33 with no brand field, 9 by a contradiction). 'id_field', 'features' and
 * 'gtin' settled no recorded row either way (no recorded Home Depot UPC meets a listing barcode), so they are not
 * adopted: an unmeasured rule does not confirm (docs/decisions.md).
 */
export const ADOPTED_RULES: readonly FieldRule[] = ['title'];

export interface FieldCheck extends IdentityCheck {
  /** The sub-rule that confirmed, when status is confirmed by this rung; null otherwise. */
  rule: FieldRule | null;
}

const brandKey = (raw: string | null | undefined): string | null => {
  const b = cleanBrand(raw ?? null);
  const k = b ? b.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  return k === '' ? null : k;
};

/** The brand-pattern model numbers a text names, upper case. */
function modelsIn(brand: string, text: string): string[] {
  const pattern = MODEL_PATTERNS[brand];
  if (!pattern) return [];
  return Array.from(text.toUpperCase().matchAll(new RegExp(pattern.source, 'g')), (m) => m[0]);
}

/** Whether `text` names the part's model as a whole token (by sameModel), and no other model of the brand. */
function namesOnly(brand: string, model: string, text: string): 'only' | 'other' | 'none' {
  const named = modelsIn(brand, text);
  if (named.length === 0) return 'none';
  return named.every((m) => sameModel(brand, m, model)) ? 'only' : 'other';
}

/** The tokens of an identifier field ("Ryobi+P1895" -> RYOBI, P1895). */
const tokens = (raw: string | null): string[] => (raw ?? '').toUpperCase().split(/[^A-Z0-9-]+/).filter((t) => t !== '');

/** Why the gate refuses, or null. Also rung 3's contradiction check (listingJudge). */
export function listingProblem(want: Wanted, l: ListingIdentity, opts: Pick<CheckOptions, 'makers' | 'family'> = {}): string | null {
  const brand = want.brand.trim().toUpperCase();
  const model = want.model.trim().toUpperCase();
  const listed = brandKey(l.brand);
  if (listed !== brand) return listed === null ? 'the listing names no brand' : `the listing's brand is ${cleanBrand(l.brand)}`;
  const maker = brandKey(l.manufacturer);
  if (maker !== null && !makerAgrees(brand, l.manufacturer, opts)) return `the listing's manufacturer is ${l.manufacturer}`;
  const part = (l.partNumber ?? '').toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
  if (part !== '' && !sameModel(brand, part, model)) return `the listing's part number is ${part}`;
  const problem = titleOrCountProblem(want, l, opts);
  if (problem) return problem;
  for (const f of l.features ?? []) {
    if (!want.isKit && KIT_CONTENTS.test(f.replace(NOT_INCLUDED_PHRASE, ' ')) && /\b(?:comes with|includes?|included|kit)\b/i.test(f.replace(NOT_INCLUDED_PHRASE, ' '))) {
      return 'a feature bullet sells it with a battery, a charger or more';
    }
    if (AFTERMARKET.test(f) || FOR_BRAND.test(f)) return 'a feature bullet reads as a part made for the tool';
    if (namesOnly(brand, model, f) === 'other') return 'a feature bullet names another model';
  }
  return null;
}

/** Which sub-rule's evidence the listing carries, first found in the order of FieldRule; null when none. */
function evidence(want: Wanted, l: ListingIdentity, rules: readonly FieldRule[], hdUpc: string | null): { rule: FieldRule; said: string } | null {
  const brand = want.brand.trim().toUpperCase();
  const model = want.model.trim().toUpperCase();
  if (rules.includes('id_field')) {
    for (const [name, raw] of [['part number', l.partNumber], ['model', l.model]] as const) {
      const hit = tokens(raw).find((t) => sameModel(brand, t, model));
      if (hit) return { rule: 'id_field', said: `its ${name} field reads ${raw}` };
    }
  }
  if (rules.includes('features')) {
    const bullet = (l.features ?? []).find((f) => namesOnly(brand, model, f) === 'only');
    if (bullet) return { rule: 'features', said: `a feature bullet names ${model}` };
  }
  if (rules.includes('title') && l.title && namesOnly(brand, model, l.title) === 'only') return { rule: 'title', said: `its title names ${model}` };
  if (rules.includes('gtin')) {
    const want12 = toUpc12(hdUpc);
    if (want12 !== null && (l.gtins ?? []).some((g) => toUpc12(g) === want12)) return { rule: 'gtin', said: `its barcode is Home Depot's ${want12}` };
  }
  return null;
}

/**
 * Rung 1: the catalog check first (verify.ts checkIdentity, its answer kept when it is confirmed or contradicted); for
 * its unknown, the sub-rules `rules` (ADOPTED_RULES by default) under the gate above. Never contradicts.
 */
export function checkListingFields(
  want: Wanted, l: ListingIdentity, opts: { rules?: readonly FieldRule[]; hdUpc?: string | null } & CheckOptions = {},
): FieldCheck {
  // A brand field that is a recorded alias of the part's brand (brandAliases.ts) counts as it; nothing else changes.
  const alias = opts.aliases === false ? null : brandAliasOf(want.brand, l.brand);
  if (alias) return withAlias(alias, checkListingFields(want, { ...l, brand: want.brand }, { ...opts, aliases: false }));
  const makers = { ...(opts.makers === false ? { makers: false } : {}), ...(opts.family === false ? { family: false } : {}) };
  const first = checkIdentity(want, l, { aliases: false, ...makers });
  if (first.status !== 'unknown') return { ...first, rule: null };
  const rules = opts.rules ?? ADOPTED_RULES;
  const found = evidence(want, l, rules, opts.hdUpc ?? want.upc ?? null);
  if (!found) return { ...first, rule: null };
  const problem = listingProblem(want, l, makers);
  if (problem) return { status: 'unknown', reason: `${first.reason}; ${found.said}, but ${problem}`, rule: null };
  const shown = cleanBrand(l.brand) ?? want.brand;
  const where = l.source === 'keepa_catalog' ? "Amazon's catalog" : "Amazon's product page";
  const made = opts.makers === false ? null : makerWords(want.brand, l.manufacturer);
  return { status: 'confirmed', reason: `${where} lists brand ${shown}, and ${found.said}${made ? `; ${made}` : ''}`, rule: found.rule };
}
