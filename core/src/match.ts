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

import { KIND_WORDS } from './decompose';
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
// "2Pk" too (fix round 1): "18V LED Light, PCL660 2Pk - Bulk Packaged" (B0CRSVC28P).
const MULTI = /\b(\d+)\s*-?\s*pack\b|\bpack of (\d+)\b|\bset of (\d+)\b|\b(\d+)\s*-?\s*pk\b/i;
const KIT_WORDS = /\b(kit|combo|bundle|with battery|with charger|w\/ battery|and charger)\b/i;
// What says a listing carries more than a tool: a combo or bundle, or any battery, charger or amp-hours
// ("Inflator Kit with 4Ah Battery", B0DY31QJ4Q). A title that says "kit" with none of these may be a kit
// that is itself the part (A986501, a 65-piece accessory kit).
const KIT_CONTENTS = /\b(combo|bundle|batter(?:y|ies)|chargers?|\d+(?:\.\d+)?\s*ah)\b/i;
// Step 8b: "Battery and Charger NOT Included" (B0BL8BC8MF, PSBDD01, P2900B) says the opposite of a
// kit. Only the battery and charger the phrase names are taken out, joined by "and", "&" or "or" (a
// comma may end the list: "with Battery, Charger Not Included"); any other kit word still counts.
// "Sold Separately" is not read: such a title stays rejected (conservative, fix round 1).
const NOT_INCLUDED_PHRASE = /\b(?:batter(?:y|ies)|charger)(?:\s+(?:and|&|or)\s+(?:batter(?:y|ies)|charger))*\s+(?:(?:is|are)\s+)?not\s+included\b/gi;
// Step 8b: a third-party title says what it is for. Never a reason to lift a reject.
const FOR_BRAND = /\bfor\s+(ryobi|dewalt)\b/i;
// Step 8b: TTI makes RYOBI; "TTI Ryobi PBP004 …" (B09HDZ5MPV) states the brand with no brand field.
const MAKER_PREFIX: Record<string, RegExp> = { RYOBI: /^\s*TTI\s+RYOBI\b/i };
// Model numbers as whole tokens, per brand; titles are upper-cased first (scan/listings.ts modelsInTitle).
export const MODEL_PATTERNS: Record<string, RegExp> = {
  // A P, up to five letters, two to four digits, then letters or digits: PBLRC25B, PCL430B, PSK006, P1819.
  RYOBI: /(?<![A-Z0-9])P[A-Z]{0,5}[0-9]{2,4}[A-Z0-9]*(?![A-Z0-9])/g,
  // DC, one to three letters, three or four digits, then letters or digits, with an optional
  // "-" and one digit: DCK240C2, DCS334B, DCB205-2, DCC020IB.
  DEWALT: /(?<![A-Z0-9])DC[A-Z]{1,3}[0-9]{3,4}[A-Z0-9]*(?:-[0-9])?(?![A-Z0-9])/g,
};

// Kit extras: for a part that is itself a kit, a title that sells the kit with more. Recorded (DCK240C2,
// the validation's responses), each labelled not the part:
//   "DCK240C2 … Drill Driver/Impact Combo Kit (1.3Ah) with 20V MAX Circular Saw"              (B0722GYTWL)
//   "DCK240C2 … Combo Kit (1.3Ah) with FlexTorq Screw Driving Set, 40-Piece"                   (B072B8GHHL)
//   "Mechanics Tool Set, Drill/Driver & Impact Driver Combo Kit (DCK240C2)"                    (B08P6NCHMW)
// Any sign is enough.
// (1) An accessory set: "set", or a count of pieces ("40-Piece", Home Depot's "70PC", "70 PC"). A kit's own
//     title calls the kit a set of tools, counted, powered or multi: "Power Tool Set" (DCK1021D2),
//     "Woodworking 3-Tool Set" (DCK300P1), "2-Tool Set" (DCK202P1), "Oscillating Multi-tool Set"
//     (DCK551D1M1); such a set is not counted.
// (2) Something added after a joining word: "with", "w/", "plus", a spaced "+" (RYOBI's "ONE+" is not one)
//     or "bundle". Every joining word is read. The kit's own tools are those the title names before the
//     first joining word or, when it names none there, right after it ("Combo Kit with Hammer Drill &
//     Impact Driver", DCK2100P2, lists the kit's own). After that, a part is added when it names a tool
//     that is not among them, or a model number that is not the part's ("with 5Ah Battery DCB205"); and
//     after any joining word, "extra", "additional" or "bonus" with a battery, charger or tool after it adds.
//     A battery or a charger named by its kind alone is what a kit holds.
// "&", "and" and a comma are not joining words, on purpose: kits list their own tools that way, so an
// addition written with them is not seen (a known gap, docs/decisions.md).
// Tool words are the splitter's kind words (decompose.ts KIND_WORDS) read as whole words, a plural "s"
// allowed: "Lightweight" names no light. kindsFromTitle, which reads them inside words, is not used here.
const ACCESSORY_SET = /\bset\b|\b\d+\s*-?\s*(?:pieces?|pcs?)\b/i;
const POWER_TOOL_SET = /\b(?:power|multi|\d+)\s*-?\s*tools?\s+set\b/gi;
// RYOBI's line is "ONE+", also written "ONE +" and "ONE + (PLUS)" (B0781B4R4C): neither is a joining word.
const JOINING = /\bwith\b|\bw\/|(?<!\bone\s*(?:\+\s*)?\(?)\bplus\b|\bbundle\b|(?<!\bone)\s\+|^\+/i;
// "Extra" adds when a battery, a charger or a tool follows within three words: "Extra 5Ah Battery DCB205",
// not "Extra Long Run Time" (B079LDT7ML).
const EXTRA = /\b(?:extra|additional|bonus)\s+(?:\S+\s+){0,3}?(?:batter(?:y|ies)|chargers?|tools?)\b/i;
const KIT_HOLDS = new Set(['battery', 'batteries', 'charger']);
const TOOL_WORDS: [string, RegExp][] = KIND_WORDS.filter((w) => !KIT_HOLDS.has(w))
  .map((w) => [w, new RegExp(`\\b${w.replace(/ /g, '\\s+')}s?\\b`, 'gi')]);

/** The tool words a text names as whole words, longest first, each taken out once found ("hammer drill" is not also "drill"). */
function toolsIn(text: string): string[] {
  let rest = text;
  const found: string[] = [];
  for (const [word, re] of TOOL_WORDS) {
    let hit = false;
    rest = rest.replace(re, () => {
      hit = true;
      return ' ';
    });
    if (hit) found.push(word);
  }
  return found;
}

/** A model number of the part's brand in the text that is not the part's own. */
function otherModel(want: Wanted, text: string): boolean {
  const pattern = MODEL_PATTERNS[want.brand.trim().toUpperCase()];
  if (!pattern) return false;
  return Array.from(text.toUpperCase().matchAll(pattern), (m) => m[0]).some((m) => !sameModel(want.brand, m, want.model));
}

/** The title sells the kit with more: an accessory set, or something added after a joining word. */
function addsToKit(want: Wanted, title: string): boolean {
  if (ACCESSORY_SET.test(title.replace(POWER_TOOL_SET, ' '))) return true;
  const [first = '', ...after] = title.split(JOINING);
  if (after.length === 0) return false;
  if (after.some((part) => EXTRA.test(part))) return true;
  let own = toolsIn(first);
  let added = after;
  if (own.length === 0) {
    own = toolsIn(after[0]!);
    added = after.slice(1);
  }
  const kit = new Set(own);
  return added.some((part) => toolsIn(part).some((k) => !kit.has(k)) || otherModel(want, part));
}

export type Grade = 'exact' | 'strong' | 'probable' | 'review' | 'reject';

/** The reason a listing showing the model is review when nothing confirms its brand. */
export const BRAND_NOT_CONFIRMED = 'model number in the title, brand not confirmed';

// Step 8b: the four reasons a title that the rules below used to reject is review instead. Each caps
// the grade at review: the owner confirms the listing (CLAUDE.md rule 4). A match question repeats
// them as its notes (scan/runner.ts matchQuestion), so none contains "; ", which joins notes. A fifth,
// KIT_WITH_EXTRAS, caps a title that was probable.
/** The title begins with the brand's maker ("TTI Ryobi") and the brand field is empty. */
export const BRAND_IN_TITLE_ONLY = 'title begins TTI Ryobi (TTI makes RYOBI), brand field empty';
/** The title's only kit words are a battery or charger it says are not included. */
export const NOT_INCLUDED = 'title names a battery or charger only as not included';
/** A RYOBI title that says "kit" and nothing more: the part may itself be a kit or an accessory set. */
export const KIT_NOT_KNOWN = 'title says kit, and a RYOBI model number does not say whether the part is itself a kit';
/** A RYOBI title that says a pack of n: the part may itself be the pack. */
export const packNotKnown = (n: number): string => `title says a pack of ${n}, and a RYOBI model number does not say the part's pack size`;
const PACK_NOT_KNOWN = /^title says a pack of \d+, and a RYOBI model number does not say the part's pack size$/;
/** For a part that is itself a kit: the title sells the kit with more (addsToKit). Caps a grade at review the same way. */
export const KIT_WITH_EXTRAS = 'title sells the kit with more: another tool or an accessory set';
/** Whether a grade reason is one of the four above, or KIT_WITH_EXTRAS. */
export const isReviewCap = (reason: string): boolean =>
  reason === BRAND_IN_TITLE_ONLY || reason === NOT_INCLUDED || reason === KIT_NOT_KNOWN || PACK_NOT_KNOWN.test(reason) || reason === KIT_WITH_EXTRAS;

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

  const partOk = !!cand.partNumber && clean(cand.partNumber) === clean(want.model);
  // Ruling 70: a RYOBI part written without its tool-only B (PCL206) is its Amazon listing's PCL206B.
  const titleOk = titleHasModel(want.brand, cand.title, want.model);
  const brandField = !!cand.brand && cand.brand.trim().toUpperCase() === brand;
  const brandPrefix = cand.title.trim().toUpperCase().startsWith(brand);
  const makerPrefix = !cand.brand && !brandPrefix && (MAKER_PREFIX[brand]?.test(cand.title) ?? false);
  // Step 8b: a RYOBI title with the brand stated and the model as a whole token, not "for Ryobi". RYOBI's
  // model numbers do not say whether a part is a pack or a kit (PBP2003 is a 2-pack, A986501 a 65-piece
  // kit, PCL265B a tool), so a pack or a bare "kit" in such a title is a question, not a reject.
  // A title that says "Replacement" or "OEM" (MAYBE_SPARE_PART) is rejected by these rules as before.
  const sparePart = MAYBE_SPARE_PART.test(cand.title);
  const ryobiOwn = brand === 'RYOBI' && titleOk && (brandField || brandPrefix || makerPrefix) && !FOR_BRAND.test(cand.title) && !sparePart;
  // The title with the battery and charger it says are not included taken out.
  const rest = cand.title.replace(NOT_INCLUDED_PHRASE, ' ');
  // Set when a rule below would have rejected the title but cannot know: the grade is review at most.
  let cap: string | null = null;

  let qty = cand.packageQty ?? null;
  const multi = MULTI.exec(cand.title);
  if (multi) qty = Number(multi[1] ?? multi[2] ?? multi[3] ?? multi[4]);
  const wantQty = want.packQty ?? 1;
  if (qty && qty !== wantQty) {
    // DEWALT writes a pack in its model (DCB205-2, wantedFor sets packQty). A RYOBI model with the
    // tool-only B (PBLRC25B) is one bare tool, so its pack stays rejected, in either written form
    // (Ruling 70): the part's model or the title's ends in B. So does a bulk pack. Fix round 1: a pack
    // opens a question only when the title names a battery, as every RYOBI pack model on the
    // recordings does (PBP2003, PBP2005, P102, P129, P145, P161, P164); "RYOBI PCL265 2-Pack" does not.
    const m = want.model.trim().toUpperCase();
    const toolOnly = m.endsWith('B') || (ryobiOwn && hasModelToken(cand.title, `${ryobiBase(m)}B`));
    const battery = /\bbatter(?:y|ies)\b/i.test(rest);
    if (want.packQty === undefined && ryobiOwn && !toolOnly && battery && packaging === 'retail') cap = packNotKnown(qty);
    else return out('reject', `pack of ${qty}, component is a pack of ${wantQty}`);
  }

  if (!want.isKit && KIT_WORDS.test(cand.title) && !partOk) {
    // Fix round 1: and nothing else in the title names a battery or charger ("…, Includes 2 Batteries").
    if (!KIT_WORDS.test(rest) && !KIT_CONTENTS.test(rest) && !FOR_BRAND.test(cand.title) && !sparePart) cap ??= NOT_INCLUDED;
    else if (ryobiOwn && !KIT_CONTENTS.test(rest)) cap ??= KIT_NOT_KNOWN;
    else return out('reject', 'listing is a kit, component is a single item');
  }

  // Kit extras: review at most, never reject. The grade has only the kit's model, not what the kit holds,
  // so it cannot know the saw or the set is not in the box; the owner decides (CLAUDE.md rule 4). A
  // manufacturer part number does not lift it (a seller's bundle page can carry the kit's); a barcode does.
  if (want.isKit && !upcOk && addsToKit(want, cand.title)) cap ??= KIT_WITH_EXTRAS;

  const graded = ((): Graded => {
    if (upcOk) return out('exact', 'barcode match', ...(partOk || titleOk ? ['model number match'] : []));
    if (partOk) return out('strong', 'manufacturer part number match');
    if (titleOk) {
      if (makerPrefix) return out('review', BRAND_IN_TITLE_ONLY);
      if (!brandField && !brandPrefix) return out('review', BRAND_NOT_CONFIRMED);
      if (MAYBE_SPARE_PART.test(cand.title)) {
        return out('review', 'brand and model number in the title, but the title may name a spare part (OEM or Replacement)');
      }
      return out('probable', 'brand and model number in the title; barcode not checked yet');
    }
    return out('reject', 'no identifier matches');
  })();
  return cap && graded.grade !== 'reject' ? out('review', cap, ...graded.reasons) : graded;
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
