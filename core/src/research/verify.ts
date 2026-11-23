// The code-side check of a research answer. The model's word alone never makes a verified suggestion
// (CLAUDE.md rule 4); every check here only lowers. A parts answer is verified only when:
//   1. every quote is found word for word (normalised as the listing judge normalises) in one line of
//      the ledger entry it names, and that line does not read as words written to an AI;
//   2. no line anywhere in the ledger reads as words written to an AI;
//   3. every part's model is real, of the bundle's brand: a catalog entry, a model field of a Home
//      Depot page or search result in the ledger, or a brand-site passage the part quotes;
//   4. every part is named (its model, in any written form) by at least one of its own quotes;
//   5. coverage, against the bundle's own words:
//      - a tool count its title, its Includes list or its "Number of Tools" row states equals the
//        parts' tools, and the parts' tools can all be read;
//      - "Tools Only", "Battery and charger sold separately", "Number of Total Batteries Included: 0"
//        or "Charger Not Included" allow no part that is or holds a battery (or a charger);
//      - when the bundle's own page has an Includes list, every item of every list is accounted for
//        by a part (no leftovers, the PO's rule) and every part accounts for an item. An item with a
//        model number is that model's; a kit's items are those its own page lists; any other item is
//        accounted for only by a quote of it under a part, and a tool, battery or charger item only by
//        a part whose own quoted words (the quote naming its model) and whose names are that kind of
//        product ("18V Jig Saw" by the search result "RYOBI PCL525B ...: ONE+ 18V Cordless Jig Saw");
//      - with no Includes list, a stated tool count, and each part shown by a quote of the bundle's
//        own page naming its model or its kind of product.
// A choose answer is checked by Ask AI's own rules (verifySuggestion); a none is none_suggested and a
// cannot_tell is cannot_tell, never verified. Verified means grounded, not right: the owner approves.

import { verifySuggestion } from '../assist/verify';
import type { AssistEvidence, AssistRaw, CheckedSuggestion, EvidenceLine, EvidenceSource, VerifiedQuote } from '../assist/types';
import { dewaltBundleForm, kindsFromTitle } from '../decompose';
import { findModel, kitBatteryCount, normaliseText } from '../judge/verify';
import { parseIncludes } from '../kitContents';
import { modelForms, sameModel } from '../match';
import type { ReviewItem } from '../scan/types';
import { INCLUDES_SPEC, safeUrl } from './ledger';
import { parseResearchAnswer } from './schema';
import type { CatalogEntry, ResearchLedgerEntry, LedgerLine, ResearchAnswer, ResearchQuote } from './types';

/** The model's reason is shown to the owner; longer than this it is cut. */
export const MAX_RESEARCH_REASON_CHARS = 300;
/** A part's quantity in a bundle: 1 to 9, as the splitter reads a page's "(n)". */
export const MAX_PART_QTY = 9;

const cut = (s: string): string => (s.length > MAX_RESEARCH_REASON_CHARS ? `${s.slice(0, MAX_RESEARCH_REASON_CHARS - 1)}…` : s);
const show = (q: string): string => {
  const t = q.trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};
const up = (s: string): string => s.trim().toUpperCase();

// --- Quotes ---------------------------------------------------------------------------------------

interface FoundQuote extends VerifiedQuote {
  norm: string;
  entry: ResearchLedgerEntry;
  /** The model fields of the lines that hold the quote (a search row, a catalog entry): whose line it is. */
  lineModels: string[];
}

type Found = { ok: true; quote: FoundQuote } | { ok: false; problem: string };

function findQuote(q: ResearchQuote, ledger: ResearchLedgerEntry[]): Found {
  // A brand-site source is named by its address, which the model may write as the API showed it or as the ledger keeps it.
  const id = q.sourceId.trim();
  const asUrl = /^https?:\/\//i.test(id) ? safeUrl(id) : null;
  const entry = ledger.find((e) => e.id === id) ?? (asUrl ? ledger.find((e) => e.kind === 'brand_site' && e.id === asUrl) : undefined);
  if (!entry) return { ok: false, problem: `The quote "${show(q.quote)}" names a source that was not read (${show(q.sourceId)}).` };
  const norm = normaliseText(q.quote);
  if (norm === '') return { ok: false, problem: 'The answer gave an empty quote.' };
  const lines = entry.lines.filter((l) => normaliseText(l.text).includes(norm));
  if (lines.length === 0) return { ok: false, problem: `The quote "${show(q.quote)}" is not found in the ${entry.label} (${entry.id}).` };
  if (lines.every((l) => l.suspect)) return { ok: false, problem: `The quote "${show(q.quote)}" comes from text written to an AI, which is never evidence.` };
  const lineModels = lines.filter((l) => !l.suspect && l.model !== undefined).map((l) => l.model!);
  return { ok: true, quote: { quote: q.quote.trim(), sourceId: entry.id, label: entry.label, url: entry.url, names: false, norm, entry, lineModels } };
}

const strip = (qs: FoundQuote[]): VerifiedQuote[] => qs.map(({ norm: _n, entry: _e, lineModels: _m, ...q }) => q);

/** Whether normalised text names a model, in any way it may be written (modelForms, whole token). */
const names = (text: string, brand: string, model: string): boolean => modelForms(brand, model).some((f) => findModel(text, f) >= 0);
/** Whether normalised text holds a phrase as whole words. */
const holds = (text: string, phrase: string): boolean => findModel(text, phrase) >= 0;

// --- What a product is ----------------------------------------------------------------------------

const POWER_KINDS = new Set(['battery', 'charger']);
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
// "2-Tool", "(2-Tool)", "3 Tool", "6 Tools", "Two-Tool". Not "Tool Only".
const TOOL_COUNT = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*-?\s*tools?\b/gi;
const TOOL_COUNT_SPEC = /^\s*number of tools\b[^:]*:\s*(\d{1,2})\s*$/i;
const TOOLS_ONLY = /\btools?[- ]only\b|\bbare tool\b/i;
// Accessories, never a tool, battery or charger however they are named ("Jig Saw Blade Set",
// "65-Piece Drill and Impact Drive Kit", "Reciprocating Saw Blade", "(29) Impact Driving Bits").
const ACCESSORY = /\b\d+\s*-?\s*(piece|pc|pcs)\b|\b(blades?|bits?|bit holder|sockets?|nut drivers?|sandpaper|sanding pad|accessory|accessories|hex keys?|shoe|bags?|manuals?)\b|(?<!impact )\bwrench(es)?\b/i;
const BATTERY = /\bbatter(y|ies)\b|\b\d+(\.\d+)?\s*ah\b/i;
const CHARGER = /\bcharger\b/i;
const NO_BATTERY = /\bbatter(y|ies)\b[^.;]{0,40}\b(not included|sold separately)\b|\bno battery\b|^\s*number of total batteries included\s*:\s*0\s*$|^\s*batteries included\s*:\s*no\s*$/i;
const NO_CHARGER = /\bcharger\b[^.;]{0,40}\b(not included|sold separately)\b/i;
const BRUSHED_SPEC = /^\s*motor type\s*:\s*brushed\s*$/i;

/** The tool counts a text states. */
export function toolCounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(TOOL_COUNT)) {
    const w = m[1]!.toLowerCase();
    out.push(NUMBER_WORDS[w] ?? Number(w));
  }
  return out;
}

/** The kinds of product a name says (kindsFromTitle, plural and spelling folded), none for an accessory's name. */
function kindsOf(text: string): string[] {
  if (ACCESSORY.test(text) && toolCounts(text).length === 0 && !TOOLS_ONLY.test(text)) return [];
  return [...new Set(kindsFromTitle(text).map(fold))];
}

/** The message when a part shown only by its kind is not tied to the bundle, or null when it is (or no other model of the kind is in the ledger). */
type TieCheck = (p: PartCheck, kind: string, what: string) => string | null;

const plural = (kind: string): string => (kind === 'battery' ? 'batteries' : kind.endsWith('s') ? kind : `${kind}s`);

/** One spelling per kind: "batteries" is "battery", "jigsaw" is "jig saw". */
function fold(k: string): string {
  return k === 'batteries' ? 'battery' : k === 'jigsaw' ? 'jig saw' : k;
}

interface Product {
  /** Tools the product holds: a kit's count, 1 for a tool, 0 for a battery, charger or accessory; null when its names do not say. */
  tools: number | null;
  /** It is or holds a battery / a charger; null when no name of it is known or its names disagree. */
  battery: boolean | null;
  charger: boolean | null;
  kinds: string[];
  kit: boolean;
  titles: string[];
}

// Step 15, rule 3: a title that counts the kit half of a kit + extra bundle. "6-Tool Combo Kit with 1.5 Ah and 4.0 Ah
// Batteries, Charger, and Miter Saw" (PCL1600K2-P553), "2-Tool Combo Kit with (2) 1.5 Ah Batteries, Charger, and ONE+ 13”
// String Trimmer" (PCL1201K2-P20015BTL), "Combo Kit (5-Tool) and ATOMIC Brushless 5/8 in. Hammer Drill" (DCK540D1WCH172B):
// the count, then the combo kit, then what comes with it. Read only on a bundle whose model is the kit and the extra.
const COUNT_WORD = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const JOINED_EXTRA = String.raw`.*?(?:\band\b|\bwith\b|\bw\/|&)`;
const KIT_HALF = [
  new RegExp(String.raw`\b${COUNT_WORD}\s*-?\s*tools?\b[^,;()]*?\bcombo kit\b${JOINED_EXTRA}`, 'i'),
  new RegExp(String.raw`\bcombo kit\s*\(\s*${COUNT_WORD}\s*-?\s*tools?\s*\)${JOINED_EXTRA}`, 'i'),
];

/** Step 15, rule 3: the tool count a "<N>-Tool Combo Kit … and <extra>" title gives its kit half; null when the title has no such phrase. */
export function kitHalfCount(title: string): number | null {
  for (const re of KIT_HALF) {
    const m = re.exec(title);
    if (m) {
      const w = m[1]!.toLowerCase();
      return NUMBER_WORDS[w] ?? Number(w);
    }
  }
  return null;
}

/**
 * Step 15, rule 3: the kit a kit + extra bundle's model starts with, when the model is one (a RYOBI "<kit>-<extra>", a
 * DEWALT "<kit>W<extra>" or "<kit><tool>"); null otherwise.
 */
export function kitHalfOf(brand: string, bundleModel: string): string | null {
  const b = up(brand);
  if (b === 'RYOBI') {
    const pieces = up(bundleModel).split('-');
    return pieces.length === 2 && pieces.every((p) => p !== '') ? pieces[0]! : null;
  }
  if (b === 'DEWALT') {
    const form = dewaltBundleForm(bundleModel);
    return form && form.kind !== 'pack' ? form.base : null;
  }
  return null;
}

/**
 * Step 16 (lever 3): the extra a kit + extra bundle's model number spells out as a whole model (a RYOBI "<kit>-<extra>"'s
 * second piece, a DEWALT "<kit><whole model>"'s model); null otherwise, and for a DEWALT short code ("W921B").
 */
export function extraHalfOf(brand: string, bundleModel: string): string | null {
  const b = up(brand);
  if (b === 'RYOBI') {
    const pieces = up(bundleModel).split('-');
    return pieces.length === 2 && pieces.every((p) => p !== '') ? pieces[1]! : null;
  }
  if (b === 'DEWALT') {
    const form = dewaltBundleForm(bundleModel);
    return form && form.kind === 'joined' ? form.bonus : null;
  }
  return null;
}

/** Step 15: the tools a product holds by its one title (a kit's count, 1 for a tool, 0 for a battery or an accessory); null when the title does not say. */
export const titleTools = (title: string): number | null => productOf([title], false).tools;

/** Step 15: whether a text says "Tools Only" (or "Bare Tool"). */
export const saysToolsOnly = (text: string): boolean => TOOLS_ONLY.test(text);

/** What a product is, from its names (Home Depot or catalog titles). Names that disagree make it unknown. */
function productOf(titles: string[], kitFlag: boolean): Product {
  if (titles.length === 0) return { tools: null, battery: null, charger: null, kinds: [], kit: kitFlag, titles };
  const each = titles.map((t) => {
    const count = toolCounts(t)[0];
    const kinds = kindsOf(t);
    const accessory = kinds.length === 0 && ACCESSORY.test(t);
    const bare = TOOLS_ONLY.test(t);
    const battery = !bare && BATTERY.test(t) && !NO_BATTERY.test(t);
    const charger = !bare && CHARGER.test(t) && !NO_CHARGER.test(t);
    let tools: number | null;
    if (count !== undefined) tools = count;
    else if (accessory) tools = 0;
    else if (kinds.some((k) => !POWER_KINDS.has(k))) tools = 1;
    else if (battery || charger) tools = 0;
    else tools = null;
    return { tools, battery, charger, kinds, kit: (count !== undefined && count > 1) || /\b(combo|starter) kit\b/i.test(t) };
  });
  const same = <K extends 'tools' | 'battery' | 'charger'>(k: K) => (each.every((e) => e[k] === each[0]![k]) ? each[0]![k] : null);
  return { tools: same('tools'), battery: same('battery'), charger: same('charger'), kinds: [...new Set(each.flatMap((e) => e.kinds))], kit: kitFlag || each.some((e) => e.kit), titles };
}

// --- Includes lists -------------------------------------------------------------------------------

export interface Item {
  /** The Includes lists the item is on, first where it is first named: a product the page names twice is one item on both. */
  lists: number[];
  model: string | null;
  name: string;
  qty: number;
  kinds: string[];
  /** A tool, battery or charger (or any item with a model number), as opposed to an accessory. */
  product: boolean;
}

/** A line as an Includes bullet: an "Includes: ..." bullet, or an Includes / What's in the box specification row. */
function includesText(l: LedgerLine): string | null {
  if (l.field === 'bullet') return l.text;
  if (l.field === 'spec') {
    const at = l.text.indexOf(':');
    if (at > 0 && INCLUDES_SPEC.test(l.text.slice(0, at))) return `Includes: ${l.text.slice(at + 1).trim()}`;
  }
  return null;
}

// Two lists in one bullet ("... and Accessories : Includes: (29) Impact Driving Bits ..."), as kitContents splits them.
const NEXT_LIST = /\s:\s*(?=includes\s*:)/i;

const JOIN = /\s+(?:and|&)\s+/i;

/**
 * The products an Includes item names: two or more when it joins products with "and" or "&" ("18V ONE+ 5-1/2 in.
 * Circular Saw and 18V ONE+ Jig Saw", a highlight of 328690510), each piece then to be accounted for. Only when every
 * piece is a product by its own words (a kind word in each); otherwise the item is one ("1/4" and 3/8" Extended Reach
 * Ratchets": a size before the "and"; "Black Oxide Drill and Drive Bits": no product after it). An item with a model
 * number, or a count other than 1, is one: which piece the model or the count belongs to would be a guess.
 */
function pieces(name: string, model: string | null, qty: number): string[] {
  if (model !== null || qty !== 1) return [name];
  const parts = name.split(JOIN).map((p) => p.trim());
  return parts.length > 1 && parts.every((p) => kindsOf(p).length > 0) ? parts : [name];
}

/**
 * The items of the Includes lists of some entries, each list read once however many entries hold it. A
 * bullet holding two lists ("... : Includes: ...") is two lists: a quote that spans both claims nothing.
 * An item named again on another list (a highlight that repeats an Includes bullet: the same model number,
 * or the same words and count) is the same item, on both lists, and is accounted for once.
 */
export function includesItems(brand: string, entries: ResearchLedgerEntry[]): Item[] {
  return includesListsOf(brand, entries).items;
}

/** includesItems, with each list's own text (normalised), by list number. */
function includesListsOf(brand: string, entries: ResearchLedgerEntry[]): { items: Item[]; lists: string[] } {
  const seen = new Set<string>();
  const out: Item[] = [];
  const texts: string[] = [];
  let list = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      const bullet = l.suspect ? null : includesText(l);
      if (bullet === null) continue;
      for (const t of bullet.split(NEXT_LIST)) {
        if (seen.has(normaliseText(t))) continue;
        seen.add(normaliseText(t));
        const items = parseIncludes(brand, [t]);
        if (items.length === 0) continue;
        for (const it of items) {
          // parseIncludes leaves a joining "and" as its own piece before "(n)" ("Charger, and (2) Tool Bags" gives "and";
          // "(29) Impact Driving Bits And (1) ..." gives "Impact Driving Bits And", recorded on 345177929): not an item.
          const whole = it.name.replace(/^(and|&)\s+/i, '').replace(/\s+(and|&)$/i, '').trim();
          if (whole === '' || /^(and|&)$/i.test(whole)) continue;
          for (const name of pieces(whole, it.model, it.qty)) {
            const again = out.find((o) => !o.lists.includes(list) && o.qty === it.qty && (it.model !== null
              ? o.model !== null && sameModel(brand, o.model, it.model)
              : o.model === null && normaliseText(o.name) === normaliseText(name)));
            if (again) {
              again.lists.push(list);
              continue;
            }
            const kinds = kindsOf(name);
            out.push({ lists: [list], model: it.model, name, qty: it.qty, kinds, product: it.model !== null || kinds.length > 0 });
          }
        }
        texts[list] = normaliseText(t);
        list++;
      }
    }
  }
  return { items: out, lists: texts };
}

// --- Counts a name states ----------------------------------------------------------------------------

/** "65-Piece", "(30-Piece)", "70PC": the piece counts a text states. */
function pieceCounts(text: string): number[] {
  return [...text.matchAll(/\b(\d+)\s*-?\s*(?:pieces?|pcs?)\b/gi)].map((m) => Number(m[1]));
}

/** Batteries an Includes item names: its "(n)" times a leading count ("2 Batteries", "(2) Compact Lithium Battery"). */
function itemBatteries(it: Item): number {
  const lead = /^(\d)\s+(?:\S+\s+){0,3}?batter(y|ies)\b/i.exec(it.name);
  return it.qty * (lead ? Number(lead[1]) : 1);
}

/**
 * The batteries a kit's own page lists, or null when its lists disagree. Battery items that all carry a model
 * number, none on two lists, are counted together (two lists may name different batteries). Otherwise each list
 * that names batteries counts them on its own, and the lists must agree: a highlight's "2 Batteries" and the
 * Includes bullet's PBP005 and PBP002 are the same two batteries (317987591), not four.
 */
function pageBatteries(contents: Item[]): number | null {
  const batteries = contents.filter((c) => c.kinds.includes('battery'));
  if (batteries.length === 0) return 0;
  if (batteries.every((c) => c.model !== null && c.lists.length === 1)) return batteries.reduce((n, c) => n + itemBatteries(c), 0);
  const perList = [...new Set(batteries.flatMap((c) => c.lists))]
    .map((l) => batteries.filter((c) => c.lists.includes(l)).reduce((n, c) => n + itemBatteries(c), 0));
  return perList.every((n) => n === perList[0]) ? perList[0]! : null;
}

/**
 * Step 16 (lever 3): kitBatteryCount, and a count whose parentheses the stored title lost: "2  1.5 Ah Batteries" for
 * "(2) 1.5 Ah Batteries" (324904496 and 324903619 as SerpApi gave them). Only when every Ah rating of the title is in
 * such a phrase, the noun is plural and no "(n)" or singular "battery" is there to read instead.
 */
export function titleBatteryCount(title: string): number | null {
  const n = kitBatteryCount(title);
  const name = normaliseText(title);
  if (/\(\d\)/.test(name) || /\bbattery\b/.test(name)) return n;
  const bare = [...name.matchAll(/(?:^|[\s,])(\d)\s+\d+(?:\.\d+)?\s*ah\s+batteries\b/g)];
  const ratings = (name.match(/\d+(\.\d+)?\s*ah\b/g) ?? []).length;
  if (n === null || bare.length === 0 || bare.length !== ratings) return n;
  return bare.reduce((sum, m) => sum + Number(m[1]), 0);
}

/** A product's battery count: a kit's own page (its battery items) first, else its names (kitBatteryCount); a lone battery is 1 (or its pack). */
function partBatteries(p: { product: Product; contents: Item[] }): number | null {
  const fromPage = pageBatteries(p.contents);
  if (fromPage === null) return null;
  if (fromPage > 0) return fromPage;
  if (p.product.battery === false) return 0;
  const named = p.product.titles.map((t) => kitBatteryCount(t));
  if (named.length > 0 && named.every((n) => n !== null && n === named[0])) return named[0]!;
  if (p.product.tools === 0 && p.product.kinds.length === 1 && p.product.kinds[0] === 'battery') {
    const packs = p.product.titles.map((t) => Number(/\b(\d)\s*-?\s*pack\b/i.exec(t)?.[1] ?? 1));
    return packs.every((n) => n === packs[0]) ? packs[0]! : null;
  }
  return null;
}

// --- The check ------------------------------------------------------------------------------------

interface PartCheck {
  model: string;
  qty: number;
  quotes: FoundQuote[];
  product: Product;
  /** The kinds of product the part's own quotes naming its model say. */
  quotedKinds: string[];
  /** The kit's own Includes items, when its page is in the ledger. */
  contents: Item[];
  /** The catalog knows it as a kit (a manufacturer kit, one part). */
  catalogKit: boolean;
}

/**
 * Checks a research answer against the question and the ledger the loop kept. `catalog` is the catalog
 * the scan knows, for whether a model is real. Never raises an answer: it confirms it, or says why not.
 */
export function verifyResearch(answer: unknown, item: ReviewItem, ledger: ResearchLedgerEntry[], catalog: CatalogEntry[] = []): CheckedSuggestion {
  const parsed = parseResearchAnswer(answer);
  if (!parsed.ok) return { status: 'unverified', reasons: [parsed.problem], claimed: null };
  const a = parsed.answer;
  const reason = cut(a.reason.trim());
  const unverified = (reasons: string[]): CheckedSuggestion => ({ status: 'unverified', reasons, claimed: null, researchClaim: a });
  if (item.kind !== 'split') return unverified(['Research answers split questions only.']);

  const found = (qs: ResearchQuote[], problems: string[]): FoundQuote[] => {
    const out: FoundQuote[] = [];
    for (const q of qs) {
      const f = findQuote(q, ledger);
      if (!f.ok) problems.push(f.problem);
      else if (!out.some((o) => o.sourceId === f.quote.sourceId && o.norm === f.quote.norm)) out.push(f.quote);
    }
    return out;
  };

  if (a.decision === 'cannot_tell') return { status: 'cannot_tell', reason, quotes: strip(found(a.quotes, [])) };
  // A "none" is never verified (as in Ask AI): a quote can show what a page says, not that nothing fits.
  if (a.decision === 'none') return { status: 'none_suggested', reason, quotes: strip(found(a.quotes, [])) };
  if (a.decision === 'choose') return verifyChoice(a, item, ledger);

  const problems: string[] = [];
  if (ledger.some((e) => e.lines.some((l) => l.suspect))) {
    problems.push('A page read holds text written to an AI; read it yourself before answering.');
  }
  const brand = up(item.brand);
  const bundleEntries = ledger.filter((e) => e.isBundle);
  if (a.parts.length === 0) problems.push('The answer gives parts but lists none.');

  // Each part: its quotes found, its model real and named, its quantity sane.
  const parts: PartCheck[] = [];
  for (const p of a.parts) {
    const model = up(p.model);
    const quotes = found(p.quotes, problems);
    if (model === '') {
      problems.push('The answer gives a part with no model number.');
      continue;
    }
    if (!(p.qty >= 1 && p.qty <= MAX_PART_QTY)) problems.push(`${model}'s quantity ${p.qty} is not 1 to ${MAX_PART_QTY}.`);
    if (sameModel(brand, model, item.model)) problems.push(`${model} is the bundle itself, not one of its parts.`);
    if (parts.some((x) => sameModel(brand, x.model, model))) problems.push(`${model} is listed twice; a part is given once, with its quantity.`);

    const fromLedger = ledger.flatMap((e) => e.products).filter((x) => (x.brand === null || up(x.brand) === brand) && sameModel(brand, x.model, model));
    const fromCatalog = catalog.filter((c) => up(c.brand) === brand && sameModel(brand, c.model, model));
    const fromBrandSite = quotes.some((q) => q.entry.kind === 'brand_site' && names(q.norm, brand, model));
    if (fromLedger.length === 0 && fromCatalog.length === 0 && !fromBrandSite) {
      problems.push(`${model} is not a model any source read gives: no catalog entry, Home Depot page or search result of ${brand} has it, and no brand-site passage quoted names it.`);
    }
    // A quote names the part when it holds the model, or comes from the part's own Home Depot page (fix round 2).
    const ownPage = (q: FoundQuote) => !q.entry.isBundle && q.entry.pageModel !== undefined && sameModel(brand, q.entry.pageModel, model);
    const naming = quotes.filter((q) => names(q.norm, brand, model) || ownPage(q));
    if (naming.length === 0) problems.push(`No quote given for ${model} names ${model}.`);
    for (const q of naming) q.names = true;

    // Its names: Home Depot's and the catalog's titles, and the brand-site passages quoted naming it.
    const siteNames = naming.filter((q) => q.entry.kind === 'brand_site').map((q) => q.quote);
    const titles = [...new Set([...fromLedger.map((x) => x.title), ...fromCatalog.map((c) => c.title), ...siteNames].map((t) => t.trim()).filter((t) => t !== ''))];
    const kitFlag = fromLedger.some((x) => x.kit === true) || fromCatalog.some((c) => c.kind === 'kit');
    const ownPages = ledger.filter((e) => !e.isBundle && e.pageModel !== undefined && sameModel(brand, e.pageModel, model));
    const contents = includesItems(brand, ownPages);
    // Fix round 2: a product that is itself a bundle of other products is not a part (the splitter's rule, decompose.ts
    // and kitContents.ts): a manufacturer kit is a part when the catalog marks it a kit (catalog.isKit, what decomposeRyobi
    // resolves as one part); anything else whose own page's Includes list names other model numbers splits into them,
    // as the answer key splits PSK1212SB into PBP004 + PBP003 + PCG002. A starter kit whose page names no model (PSK0114)
    // stays one part.
    const catalogKit = fromCatalog.some((c) => c.kind === 'kit')
      || ledger.filter((e) => e.kind === 'catalog').flatMap((e) => e.products).some((x) => x.kit === true && sameModel(brand, x.model, model));
    const inner = [...new Set(contents.filter((c) => c.model !== null && !sameModel(brand, c.model, model)).map((c) => up(c.model!)))];
    if (!catalogKit && inner.length > 0) {
      problems.push(`${model} is itself a bundle of ${inner.join(', ')}: its own Home Depot page lists them, and the catalog does not know it as a kit. Give those as the parts.`);
    }
    const product = productOf(titles, kitFlag);
    // Fix round 3 (risk 7): a combo of tools is one part only as a kit the catalog knows; a Home Depot combo SKU
    // (PCL500B-PCL525B, PCL500525SB) whose page names its tools in words only is not one.
    if (!catalogKit && (product.tools ?? 0) >= 2) {
      problems.push(`${model} is a combo of ${product.tools} tools that the catalog does not know as a kit; give its tools as the parts.`);
    }
    // Fix round 3: the bundle's page says its motor is brushed; a part whose own name says brushless is another tool.
    if (bundleEntries.some((e) => e.lines.some((l) => !l.suspect && l.field === 'spec' && BRUSHED_SPEC.test(l.text))) && titles.some((t) => /\bbrushless\b/i.test(t))) {
      problems.push(`The bundle's page says "Motor Type: Brushed"; ${model} is brushless.`);
    }
    parts.push({
      model, qty: p.qty, quotes, product,
      // What the quotes naming the model say it is; a quote of a part's own page (its model line) says what its title says.
      // A row of another product (a sibling listing naming the part among others) says nothing of what the part is.
      quotedKinds: [...new Set([...naming.filter((q) => q.lineModels.length === 0 || q.lineModels.some((m) => sameModel(brand, m, model))).flatMap((q) => [
        ...kindsOf(q.quote),
        ...(q.entry.pageModel !== undefined && !q.entry.isBundle && sameModel(brand, q.entry.pageModel, model)
          ? q.entry.lines.filter((l) => l.field === 'title' && !l.suspect).flatMap((l) => kindsOf(l.text)) : []),
      ]),
      // Step 16 (lever 1): Home Depot's own page for exactly this model, read by the scan (a part-price reading,
      // reverify.ts), says what the part is, as its own page quoted would. Never a tie: that is still asked for.
      ...ledger.filter((e) => e.kind === 'reading').flatMap((e) => e.products)
        .filter((x) => x.title !== '' && sameModel(brand, x.model, model)).flatMap((x) => kindsOf(x.title))])],
      contents,
      catalogKit,
    });
  }

  // Coverage against the bundle's own words.
  const bundleLines = bundleEntries.flatMap((e) => e.lines.filter((l) => !l.suspect && l.field !== 'description'));
  const titleTexts = [...(item.title ? [item.title] : []), ...bundleLines.filter((l) => l.field === 'title').map((l) => l.text)];
  const { items, lists: listTexts } = includesListsOf(brand, bundleEntries);
  const counts = new Set([
    ...titleTexts.flatMap(toolCounts),
    ...items.flatMap((i) => toolCounts(i.name)),
    ...bundleLines.filter((l) => l.field === 'spec').map((l) => TOOL_COUNT_SPEC.exec(l.text)?.[1]).filter((n): n is string => n !== undefined).map(Number),
  ]);
  if (counts.size > 1) problems.push(`The bundle's own page states different tool counts (${[...counts].join(', ')}).`);
  const count = counts.size === 1 ? [...counts][0]! : null;
  if (count !== null && parts.length > 0) {
    const unknown = parts.filter((p) => p.product.tools === null);
    for (const p of unknown) problems.push(`What ${p.model} is cannot be read from its names, so its tools cannot be counted.`);
    if (unknown.length === 0) {
      const total = parts.reduce((n, p) => n + p.product.tools! * p.qty, 0);
      // Step 15, rule 3: "<N>-Tool Combo Kit … and <extra>" on a kit + extra bundle counts the kit half: the kit part (the
      // model's own kit, once) holds N by every one of its own titles, and the extra parts come on top.
      const base = kitHalfOf(brand, item.model);
      const kitPart = base === null ? undefined : parts.find((p) => sameModel(brand, p.model, base));
      const kitHalf = titleTexts[0] !== undefined && kitHalfCount(titleTexts[0]) === count && kitPart !== undefined && kitPart.qty === 1
        && kitPart.product.kit && kitPart.product.titles.length > 0 && kitPart.product.titles.every((t) => toolCounts(t)[0] === count) && parts.length >= 2;
      if (total !== count && !kitHalf) problems.push(`The bundle states ${count} tool${count === 1 ? '' : 's'}; the parts hold ${total}.`);
    }
  }
  const said = [...titleTexts, ...bundleLines.map((l) => l.text)];
  const toolsOnly = said.some((t) => TOOLS_ONLY.test(t));
  const noBattery = toolsOnly || said.some((t) => NO_BATTERY.test(t));
  const noCharger = toolsOnly || said.some((t) => NO_CHARGER.test(t));
  for (const p of parts) {
    if (noBattery && p.product.battery !== false) {
      problems.push(p.product.battery === true
        ? `The bundle comes without a battery; ${p.model} is or holds one.`
        : `The bundle comes without a battery, and whether ${p.model} holds one cannot be read from its names.`);
    }
    if (noCharger && p.product.charger !== false) {
      problems.push(p.product.charger === true
        ? `The bundle comes without a charger; ${p.model} is or holds one.`
        : `The bundle comes without a charger, and whether ${p.model} holds one cannot be read from its names.`);
    }
  }

  // What the bundle's title names, every part must be (fix round 2): a piece-counted set ("65-Piece") is a part of that
  // count, and a kind of tool ("Miter Saw") is a part's, or inside a kit part's own page.
  const allKinds = (p: PartCheck): Set<string> => new Set([...p.product.kinds, ...p.quotedKinds, ...p.contents.flatMap((c) => c.kinds)]);
  for (const t of titleTexts.slice(0, 1)) {
    for (const n of new Set(pieceCounts(t))) {
      if (!parts.some((p) => p.product.titles.some((x) => pieceCounts(x).includes(n)))) problems.push(`The bundle's title names a ${n}-piece set that no part is.`);
    }
    for (const k of new Set(kindsFromTitle(t).map(fold).filter((k) => !POWER_KINDS.has(k)))) {
      if (!parts.some((p) => allKinds(p).has(k))) problems.push(`The bundle's title names a ${k} that no part is or holds.`);
    }
  }

  // Fix round 3: when a word-only item could be filled by more than one model of its kind the ledger shows, the
  // chosen model must be tied to the bundle (never guess): the bundle's own page names it, or a listing of the same
  // bundle (same tool count, same named tools, same Tools Only) whose model number lists it is quoted under it.
  const sig = (t: string) => JSON.stringify([toolCounts(t)[0] ?? null, [...new Set(kindsFromTitle(t).map(fold).filter((k) => !POWER_KINDS.has(k)))].sort(), TOOLS_ONLY.test(t)]);
  const bundleSig = titleTexts[0] !== undefined && kindsFromTitle(titleTexts[0]).length > 0 ? sig(titleTexts[0]) : null;
  const products = ledger.flatMap((e) => e.products).filter((x) => x.brand === null || up(x.brand) === brand);
  const lists = (combo: string, model: string) => combo.includes('-') && combo.split('-').some((piece) => sameModel(brand, piece, model));
  const siblings = new Set(products.filter((x) => bundleSig !== null && !sameModel(brand, x.model, item.model) && sig(x.title) === bundleSig).map((x) => up(x.model)));
  const tied = (p: PartCheck): boolean =>
    bundleLines.some((l) => names(normaliseText(l.text), brand, p.model))
    || p.quotes.some((q) => q.lineModels.some((m) => siblings.has(up(m)) && lists(up(m), p.model))
      || (!q.entry.isBundle && q.entry.pageModel !== undefined && siblings.has(up(q.entry.pageModel)) && names(q.norm, brand, p.model)));
  const fillers = (p: PartCheck, kind: string): string[] => [...new Set(products.filter((x) => {
    if (sameModel(brand, x.model, p.model) || sameModel(brand, x.model, item.model)) return false;
    const pr = productOf([x.title], x.kit === true);
    const single = pr.kinds.includes(kind) && !pr.kit && (pr.tools === 1 || (POWER_KINDS.has(kind) && pr.tools === 0));
    return single && !(noBattery && pr.battery === true) && !(noCharger && pr.charger === true);
  }).map((x) => up(x.model)))];
  // Asked for even when the ledger shows no other model of the kind: run 3 searched each model by its number, so the
  // ledger held one row each and could not show the others the brand sells (a recorded "ryobi jig saw tool only"
  // search holds five RYOBI jig saws). A word-only item names no model; only a tie says which one it is.
  const tie: TieCheck = (p, kind, what) => {
    if (tied(p)) return null;
    return fillers(p, kind).length > 0
      ? `Several ${brand} ${plural(kind)} fit "${show(what)}"; nothing ties ${p.model} to this bundle.`
      : `"${show(what)}" names no model, and nothing ties ${p.model} to this bundle: neither the bundle's page nor a listing of this same bundle that is quoted names it.`;
  };

  // Step 16 (lever 3): the extra half Home Depot's model number spells (RYOBI <kit>-<extra>, DEWALT <kit><whole model>).
  const extraHalf = extraHalfOf(brand, item.model);
  const spelledExtra = (p: PartCheck): boolean => {
    if (extraHalf === null || p.product.kit || !sameModel(brand, p.model, extraHalf) || p.qty !== 1) return false;
    const base = kitHalfOf(brand, item.model);
    const kit = base === null ? undefined : parts.find((x) => sameModel(brand, x.model, base));
    const title = titleTexts[0] ?? '';
    const kinds = new Set(kindsFromTitle(title).map(fold));
    return kit !== undefined && kit.catalogKit && kit.qty === 1 && parts.length === 2 && (p.product.tools === 0 || p.product.tools === 1)
      && p.product.kinds.length > 0 && p.product.kinds.every((k) => kinds.has(k)) && kitHalfCount(title) !== null;
  };
  if (items.length > 0) checkIncludes(items, listTexts, parts, brand, tie, problems, spelledExtra);
  else checkWithoutIncludes(parts, brand, count, titleTexts, bundleLines.map((l) => l.text), tie, problems);

  if (problems.length > 0) return unverified([...new Set(problems)]);
  const quotes = parts.flatMap((p) => p.quotes);
  // The quotes that name a part first, each once (a sibling listing quoted under two parts is shown once).
  const ordered = [...quotes.filter((q) => q.names), ...quotes.filter((q) => !q.names)]
    .filter((q, i, all) => all.findIndex((x) => x.sourceId === q.sourceId && x.norm === q.norm) === i);
  return {
    status: 'verified',
    answer: { decision: 'parts', kind: 'split', parts: parts.flatMap((p) => Array<string>(p.qty).fill(p.model)) },
    quotes: strip(ordered),
    reason,
  };
}

/**
 * The items a quote points at: those whose whole name it holds, within one Includes list. A quote of a
 * whole list ("Includes: 6 Tools, 2 Batteries, Charger, Bag, and Accessories") points at each of its items
 * (fix round 2: the first real runs quote lists whole); a quote that spans two lists points at none.
 */
function claimedBy(quote: FoundQuote, items: Item[], listTexts: readonly string[] = []): { items: number[]; spans: boolean } {
  // Step 16 (lever 3): a quote that lies wholly inside one list's own text is a quote of that list. Of the items whose
  // names it holds, it points only at that list's: another list's "Charger" read inside this list's "(1) 18V Charger" is
  // a word of this list's item, not a second list (the real 321809549 and 321811428, whose highlight lists name
  // "Charger" and "Bag"). A quote no single list holds keeps the rule below.
  const within = new Set(listTexts.flatMap((t, l) => (t !== undefined && t.includes(quote.norm) ? [l] : [])));
  const inside = items.map((it, i) => ({ i, it, name: normaliseText(it.name) }))
    .filter((x) => x.name !== '' && holds(quote.norm, x.name) && (within.size === 0 || x.it.lists.some((l) => within.has(l))));
  // Within one list: some list holds every item the quote names (an item named on two lists is on both).
  const lists = [...new Set(inside.flatMap((x) => x.it.lists))];
  if (inside.length > 0 && !lists.some((l) => inside.every((x) => x.it.lists.includes(l)))) return { items: [], spans: true };
  // An item whose name the quote holds only inside a longer item's name ("2 in. impact drive bits" in "3 1/2 in. impact
  // drive bits") is not pointed at by it: the longer names are taken out of the quote before the shorter is looked for.
  const pointed = inside.filter((x) => {
    let rest = quote.norm;
    for (const y of inside) if (y.name !== x.name && y.name.includes(x.name)) rest = rest.split(y.name).join(' | ');
    return holds(rest, x.name);
  });
  return { items: pointed.map((x) => x.i), spans: false };
}

const BAG = /\bbags?\b/i;
const ACCESSORIES = /^\s*(other\s+)?accessor(y|ies)\s*$/i;

/**
 * Whether a part may account for an Includes item a quote of it points at, or why not. An item with a model
 * number is that model's (or inside a kit part whose own page lists it). A kit part (fix round 2) accounts
 * for a generic item only as its own title or page states it, counts agreeing: "6 Tools" for a 6-Tool kit,
 * "2 Batteries" for a kit of two, "Charger" and "Bag" when it holds one, "Accessories" when its page lists
 * some, a named tool of a kind its page holds. Any other part accounts for an accessory as quoted, and for a
 * tool, battery or charger item only when its own quoted words and its names are that kind.
 */
function canAccount(p: PartCheck, it: Item, brand: string, tie: TieCheck): { ok: true } | { ok: false; why: string; loud?: true } {
  const no = (why: string) => ({ ok: false as const, why });
  if (it.model !== null) {
    return p.product.kit && p.contents.some((c) => c.model !== null && sameModel(brand, c.model, it.model!)) ? { ok: true } : no(`"${show(it.name)}" is model ${it.model}, not ${p.model}.`);
  }
  if (p.product.kit) {
    const kinds = new Set([...p.product.kinds, ...p.contents.flatMap((c) => c.kinds)]);
    const counted = toolCounts(it.name);
    if (counted.length > 0) {
      return counted.every((n) => n === p.product.tools) ? { ok: true } : no(`"${show(it.name)}" says ${counted[0]} tools; ${p.model} holds ${p.product.tools ?? 'an unknown number of'}.`);
    }
    if (it.kinds.includes('battery')) {
      const has = partBatteries(p);
      if (has === null || itemBatteries(it) !== has) return no(`"${show(it.name)}" is ${itemBatteries(it)} batter${itemBatteries(it) === 1 ? 'y' : 'ies'}; ${p.model}'s own title and page say ${has ?? 'no count'}.`);
    }
    if (it.kinds.includes('charger') && !(p.product.charger === true || kinds.has('charger'))) return no(`"${show(it.name)}" is a charger; ${p.model}'s own title and page name none.`);
    const tools = it.kinds.filter((k) => !POWER_KINDS.has(k));
    if (tools.some((k) => !kinds.has(k))) return no(`"${show(it.name)}" is a ${tools.join(' and ')}; ${p.model}'s own title and page do not name one.`);
    if (it.kinds.length > 0) return { ok: true };
    if (BAG.test(it.name)) {
      return [...p.product.titles, ...p.contents.map((c) => c.name)].some((t) => BAG.test(t)) ? { ok: true } : no(`"${show(it.name)}": ${p.model}'s own title and page name no bag.`);
    }
    if (ACCESSORIES.test(it.name)) {
      return p.contents.some((c) => !c.product) ? { ok: true } : no(`"${show(it.name)}": ${p.model}'s own page lists no accessories.`);
    }
    return no(`"${show(it.name)}" is not something ${p.model}'s own title or page says it holds.`);
  }
  if (!it.product) return { ok: true };
  const fits = it.kinds.some((k) => p.quotedKinds.includes(k)) && (p.product.titles.length === 0 || it.kinds.some((k) => p.product.kinds.includes(k)));
  if (fits) {
    // Several models of the kind could be this word-only item: the part must be tied to the bundle (fix round 3).
    const kind = it.kinds.find((k) => p.quotedKinds.includes(k))!;
    const untied = tie(p, kind, it.name);
    return untied === null ? { ok: true } : { ok: false, why: untied, loud: true };
  }
  return no(p.quotedKinds.length === 0
    ? `"${show(it.name)}" is a ${it.kinds.join(' and ')}, and no quote naming ${p.model} says what it is.`
    : `"${show(it.name)}" is a ${it.kinds.join(' and ')}; ${p.model} is ${p.product.titles[0] ? `"${show(p.product.titles[0])}"` : `a ${p.quotedKinds.join(', ')}`}.`);
}

/** Every item of the bundle's Includes lists is accounted for by the parts given, and every part accounts for one. */
function checkIncludes(items: Item[], listTexts: readonly string[], parts: PartCheck[], brand: string, tie: TieCheck, problems: string[], spelledExtra: (p: PartCheck) => boolean = () => false): void {
  const owners: Set<PartCheck>[] = items.map(() => new Set());
  const inKit = (p: PartCheck, it: Item): boolean =>
    p.product.kit && p.contents.some((c) => (it.model !== null && c.model !== null && sameModel(brand, c.model, it.model)) || normaliseText(c.name) === normaliseText(it.name));

  items.forEach((it, i) => {
    for (const p of parts) {
      // An item with a model number is that model's part; a kit's own page says which items are the kit's.
      if ((it.model !== null && sameModel(brand, it.model, p.model)) || inKit(p, it)) owners[i]!.add(p);
    }
  });
  // Items the answer quotes under a part, from the bundle's own page. A quote of one item that the part cannot be is a
  // problem; a quote of a whole list claims, of its items, those the part can be.
  for (const p of parts) {
    for (const q of p.quotes.filter((x) => x.entry.isBundle)) {
      const claim = claimedBy(q, items, listTexts);
      if (claim.spans) problems.push(`The quote "${show(q.quote)}" spans two Includes lists; quote each list on its own.`);
      for (const i of claim.items) {
        if (owners[i]!.has(p)) continue;
        const can = canAccount(p, items[i]!, brand, tie);
        if (can.ok) owners[i]!.add(p);
        else if (claim.items.length === 1 || ('loud' in can && can.loud)) problems.push(can.why);
      }
    }
  }

  const accounted = new Set<PartCheck>();
  items.forEach((it, i) => {
    const by = [...owners[i]!];
    for (const p of by) accounted.add(p);
    if (by.length === 0) {
      problems.push(`"${show(it.name)}" on the bundle's Includes list is left over: no part accounts for it.`);
      return;
    }
    // One kind of product, several parts: their quantities must make the item's count ("18V Jig Saw" is one jig saw).
    if (it.product && by.length > 1 && (it.kinds.length <= 1 || by.some((p) => p.product.kit))) {
      const n = by.reduce((s, p) => s + p.qty, 0);
      if (by.some((p) => p.product.kit) || n !== it.qty) problems.push(`"${show(it.name)}" is given to more than one part (${by.map((p) => p.model).join(', ')}).`);
    }
  });
  const leftovers = items.some((_, i) => owners[i]!.size === 0);
  for (const p of parts) {
    if (!accounted.has(p)) {
      // Step 16 (lever 3): the extra half of a "<kit>-<extra>" model number whose Includes lists are all the kit's
      // (PCL1600K2-PBP003: both lists are PCL1600K2's, and the title adds "ONE+18V 2.0 Ah Battery"). Home Depot's model
      // number names the part, and the title names its kind; nothing on the lists is left for it, and nothing is left over.
      if (!leftovers && spelledExtra(p)) continue;
      problems.push(`${p.model} accounts for nothing on the bundle's Includes list.`);
      continue;
    }
    if (p.product.kit) continue;
    // A part that is not a kit is, on each list, as many of the list's products as its quantity says.
    const lists = new Set(items.flatMap((it) => it.lists));
    for (const l of lists) {
      const n = items.filter((it, i) => it.lists.includes(l) && it.product && owners[i]!.has(p)).reduce((s, it) => s + it.qty, 0);
      if (n > 0 && n !== p.qty) problems.push(`${p.model} is given quantity ${p.qty}; the Includes items it accounts for count ${n}.`);
    }
  }
}

/**
 * With no Includes list: a stated tool count, each part shown by the bundle's own words (its model, a kit's
 * "6-Tool", a set's "65-Piece", or its kind of tool), and a battery count the title states matched by the
 * parts' (fix round 2: read from the bundle's own title and page in the ledger, quoted or not).
 */
function checkWithoutIncludes(parts: PartCheck[], brand: string, count: number | null, titles: string[], lines: string[], tie: TieCheck, problems: string[]): void {
  if (count === null) {
    problems.push("The bundle's page has no Includes list and states no tool count, so nothing shows that no part is left over.");
  }
  const said = [...titles, ...lines].map(normaliseText).join(' \n ');
  const saidCounts = toolCounts(said);
  const saidPieces = pieceCounts(said);
  for (const p of parts) {
    const kinds = [...new Set([...p.quotedKinds, ...p.product.kinds])];
    const strong = names(said, brand, p.model)
      || (p.product.kit && (p.product.tools ?? 0) >= 2 && saidCounts.includes(p.product.tools!))
      || p.product.titles.some((t) => pieceCounts(t).some((n) => saidPieces.includes(n)));
    const byKind = !p.product.kit ? kinds.find((k) => holds(said, k)) : undefined;
    if (!strong && byKind === undefined) {
      problems.push(`Nothing on the bundle's own page shows ${p.model} (its model, its tool or piece count, or its kind of product) is in the bundle.`);
    } else if (!strong && byKind !== undefined) {
      // Shown by its kind alone ("Miter Saw"): any model of that kind would be, so it must be tied (fix round 3).
      const untied = tie(p, byKind, byKind);
      if (untied !== null) problems.push(untied);
    }
  }
  const want = titles.length > 0 ? titleBatteryCount(titles[0]!) : null;
  if (want !== null) {
    const each = parts.map((p) => ({ p, n: partBatteries(p) }));
    const unknown = each.filter((x) => x.n === null);
    if (unknown.length > 0) for (const x of unknown) problems.push(`The bundle's title counts ${want} batter${want === 1 ? 'y' : 'ies'}, and how many ${x.p.model} holds cannot be read.`);
    else {
      const total = each.reduce((s, x) => s + x.n! * x.p.qty, 0);
      if (total !== want) problems.push(`The bundle's title counts ${want} batter${want === 1 ? 'y' : 'ies'}; the parts hold ${total}.`);
    }
  }
}

// --- choose: Ask AI's rules ------------------------------------------------------------------------

const FIELD: Record<LedgerLine['field'], EvidenceLine['field']> = {
  title: 'title', model: 'model', bullet: 'bullet', spec: 'bullet', description: 'description', result: 'bullet', entry: 'bullet', cited: 'bullet', page: 'bullet',
};

/**
 * A choose answer, checked by verifySuggestion: the bundle's own entries are read as Ask AI's `bundle`
 * source (its content lines must name every part of the reading), every other entry as a source that
 * cannot name one.
 */
function verifyChoice(a: ResearchAnswer, item: ReviewItem, ledger: ResearchLedgerEntry[]): CheckedSuggestion {
  const bundles = ledger.filter((e) => e.isBundle);
  const toLines = (e: ResearchLedgerEntry): EvidenceLine[] => e.lines.map((l) => ({ field: FIELD[l.field], text: l.text, ...(l.suspect ? { suspect: true as const } : {}) }));
  const sources: EvidenceSource[] = [
    { id: 'bundle', kind: 'bundle', label: bundles[0]?.label ?? 'Home Depot page', url: bundles[0]?.url ?? null, lines: bundles.flatMap(toLines) },
    ...ledger.filter((e) => !e.isBundle).map((e): EvidenceSource => ({ id: e.id, kind: 'kit', label: e.label, url: e.url, lines: toLines(e) })),
  ];
  const evidence: AssistEvidence = { questionId: item.id, kind: 'split', brand: up(item.brand), model: up(item.model), modelForms: [up(item.model)], sources, notes: [], missing: [] };
  const bundleIds = new Set(bundles.map((e) => e.id));
  const raw: AssistRaw = {
    evidence: a.quotes.map((q) => ({ quote: q.quote, source: bundleIds.has(q.sourceId.trim()) ? 'bundle' : q.sourceId })),
    reason: a.reason, decision: 'choose', choiceIndex: a.choiceIndex, asin: null,
  };
  const checked = verifySuggestion(raw, item, evidence);
  if (checked.status === 'unverified') return { ...checked, researchClaim: a };
  if (checked.status !== 'verified') return checked;
  // Each quote keeps the page it came from, so its link opens that page.
  const original = (q: VerifiedQuote): VerifiedQuote => {
    if (q.sourceId !== 'bundle') return q;
    const e = bundles.find((b) => b.lines.some((l) => normaliseText(l.text).includes(normaliseText(q.quote))));
    return e ? { ...q, sourceId: e.id, label: e.label, url: e.url } : q;
  };
  return { ...checked, quotes: checked.quotes.map(original) };
}
