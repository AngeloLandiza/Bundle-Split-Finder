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
import { kindsFromTitle } from '../decompose';
import { findModel, normaliseText } from '../judge/verify';
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
  return { ok: true, quote: { quote: q.quote.trim(), sourceId: entry.id, label: entry.label, url: entry.url, names: false, norm, entry } };
}

const strip = (qs: FoundQuote[]): VerifiedQuote[] => qs.map(({ norm: _n, entry: _e, ...q }) => q);

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

/** The tool counts a text states. */
function toolCounts(text: string): number[] {
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
  return [...new Set(kindsFromTitle(text).map((k) => (k === 'batteries' ? 'battery' : k === 'jigsaw' ? 'jig saw' : k)))];
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

interface Item {
  /** Which Includes bullet the item is on. */
  list: number;
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

/** The items of the Includes lists of some entries, each bullet read once however many entries hold it. */
function includesItems(brand: string, entries: ResearchLedgerEntry[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  let list = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      const t = l.suspect ? null : includesText(l);
      if (t === null || seen.has(normaliseText(t))) continue;
      seen.add(normaliseText(t));
      const items = parseIncludes(brand, [t]);
      if (items.length === 0) continue;
      for (const it of items) {
        // parseIncludes leaves a joining "and" as its own piece before "(n)" ("Charger, and (2) Tool Bags" gives "and";
        // "(29) Impact Driving Bits And (1) ..." gives "Impact Driving Bits And", recorded on 345177929): not an item.
        const name = it.name.replace(/^(and|&)\s+/i, '').replace(/\s+(and|&)$/i, '').trim();
        if (name === '' || /^(and|&)$/i.test(name)) continue;
        const kinds = kindsOf(name);
        out.push({ list, model: it.model, name, qty: it.qty, kinds, product: it.model !== null || kinds.length > 0 });
      }
      list++;
    }
  }
  return out;
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
    const naming = quotes.filter((q) => names(q.norm, brand, model));
    if (naming.length === 0) problems.push(`No quote given for ${model} names ${model}.`);
    for (const q of naming) q.names = true;

    // Its names: Home Depot's and the catalog's titles, and the brand-site passages quoted naming it.
    const siteNames = naming.filter((q) => q.entry.kind === 'brand_site').map((q) => q.quote);
    const titles = [...new Set([...fromLedger.map((x) => x.title), ...fromCatalog.map((c) => c.title), ...siteNames].map((t) => t.trim()).filter((t) => t !== ''))];
    const kitFlag = fromLedger.some((x) => x.kit === true) || fromCatalog.some((c) => c.kind === 'kit');
    const ownPages = ledger.filter((e) => !e.isBundle && e.pageModel !== undefined && sameModel(brand, e.pageModel, model));
    parts.push({
      model, qty: p.qty, quotes, product: productOf(titles, kitFlag),
      // What the quotes naming the model say it is; a quote of a part's own page (its model line) says what its title says.
      quotedKinds: [...new Set(naming.flatMap((q) => [
        ...kindsOf(q.quote),
        ...(q.entry.pageModel !== undefined && !q.entry.isBundle && sameModel(brand, q.entry.pageModel, model)
          ? q.entry.lines.filter((l) => l.field === 'title' && !l.suspect).flatMap((l) => kindsOf(l.text)) : []),
      ]))],
      contents: includesItems(brand, ownPages),
    });
  }

  // Coverage against the bundle's own words.
  const bundleLines = bundleEntries.flatMap((e) => e.lines.filter((l) => !l.suspect && l.field !== 'description'));
  const titleTexts = [...(item.title ? [item.title] : []), ...bundleLines.filter((l) => l.field === 'title').map((l) => l.text)];
  const items = includesItems(brand, bundleEntries);
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
      if (total !== count) problems.push(`The bundle states ${count} tool${count === 1 ? '' : 's'}; the parts hold ${total}.`);
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

  if (items.length > 0) checkIncludes(items, parts, brand, problems);
  else checkWithoutIncludes(parts, brand, count, problems);

  if (problems.length > 0) return unverified([...new Set(problems)]);
  const quotes = parts.flatMap((p) => p.quotes);
  const ordered = [...quotes.filter((q) => q.names), ...quotes.filter((q) => !q.names)];
  return {
    status: 'verified',
    answer: { decision: 'parts', kind: 'split', parts: parts.flatMap((p) => Array<string>(p.qty).fill(p.model)) },
    quotes: strip(ordered),
    reason,
  };
}

/** The items a quote points at: those whose whole name it holds, unless it also holds another item's name that is not part of it. */
function claimedBy(quote: FoundQuote, items: Item[]): number[] {
  const inside = items.map((it, i) => ({ i, name: normaliseText(it.name) })).filter((x) => x.name !== '' && holds(quote.norm, x.name));
  return inside.filter((x) => inside.every((y) => y.name === x.name || x.name.includes(y.name))).map((x) => x.i);
}

/** Every item of the bundle's Includes lists is accounted for by the parts given, and every part accounts for one. */
function checkIncludes(items: Item[], parts: PartCheck[], brand: string, problems: string[]): void {
  const owners: Set<PartCheck>[] = items.map(() => new Set());
  const inKit = (p: PartCheck, it: Item): boolean =>
    p.product.kit && p.contents.some((c) => (it.model !== null && c.model !== null && sameModel(brand, c.model, it.model)) || normaliseText(c.name) === normaliseText(it.name));

  items.forEach((it, i) => {
    for (const p of parts) {
      // An item with a model number is that model's part; a kit's own page says which items are the kit's.
      if ((it.model !== null && sameModel(brand, it.model, p.model)) || inKit(p, it)) owners[i]!.add(p);
    }
  });
  // Items the answer quotes under a part, from the bundle's own page.
  for (const p of parts) {
    for (const q of p.quotes.filter((x) => x.entry.isBundle)) {
      for (const i of claimedBy(q, items)) {
        const it = items[i]!;
        if (owners[i]!.has(p)) continue;
        if (it.model !== null) {
          problems.push(`"${show(it.name)}" is model ${it.model}, not ${p.model}.`);
          continue;
        }
        if (it.product) {
          const own = p.product.kit
            ? new Set([...p.product.kinds, ...p.quotedKinds, ...p.contents.flatMap((c) => c.kinds)])
            : new Set(p.quotedKinds);
          const fits = it.kinds.some((k) => own.has(k)) && (p.product.kit || p.product.titles.length === 0 || it.kinds.some((k) => p.product.kinds.includes(k)));
          if (!fits) {
            problems.push(p.quotedKinds.length === 0 && !p.product.kit
              ? `"${show(it.name)}" is a ${it.kinds.join(' and ')}, and no quote naming ${p.model} says what it is.`
              : `"${show(it.name)}" is a ${it.kinds.join(' and ')}; ${p.model} is ${p.product.titles[0] ? `"${show(p.product.titles[0])}"` : `a ${[...own].join(', ') || 'product of unknown kind'}`}.`);
            continue;
          }
        }
        owners[i]!.add(p);
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
  for (const p of parts) {
    if (!accounted.has(p)) {
      problems.push(`${p.model} accounts for nothing on the bundle's Includes list.`);
      continue;
    }
    if (p.product.kit) continue;
    // A part that is not a kit is, on each list, as many of the list's products as its quantity says.
    const lists = new Set(items.map((it) => it.list));
    for (const l of lists) {
      const n = items.filter((it, i) => it.list === l && it.product && owners[i]!.has(p)).reduce((s, it) => s + it.qty, 0);
      if (n > 0 && n !== p.qty) problems.push(`${p.model} is given quantity ${p.qty}; the Includes items it accounts for count ${n}.`);
    }
  }
}

/** With no Includes list: a stated tool count, and each part shown by a quote of the bundle's page naming its model or its kind. */
function checkWithoutIncludes(parts: PartCheck[], brand: string, count: number | null, problems: string[]): void {
  if (count === null) {
    problems.push("The bundle's page has no Includes list and states no tool count, so nothing shows that no part is left over.");
  }
  for (const p of parts) {
    const kinds = new Set([...p.quotedKinds, ...p.product.kinds]);
    const shown = p.quotes.filter((q) => q.entry.isBundle).some((q) => names(q.norm, brand, p.model) || [...kinds].some((k) => holds(q.norm, k)));
    if (!shown) problems.push(`No quote from the bundle's own page shows ${p.model} (its model, or its kind of product) is in the bundle.`);
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
