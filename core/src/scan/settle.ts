// Step 15, decision 4: fewer "Which parts" questions, never a guess (CLAUDE.md rule 4). Two rules settle a split the
// model number and the page left in review, each only on Home Depot's own facts, and each measured on the validation
// set and the owner's real data before it was adopted (scripts/measure-splits.ts, docs/decisions.md):
//
//   1. BOGO pair. Home Depot lists the bundle as a starter + free item pair (the pair rule, tracking/bogoPairs.ts): the
//      split is [starter, free item]. The free item's model is Home Depot's text after the joiner, or the one fuller
//      model the pair's own page names for it (a DEWALT short code: "921B" is DCF921B when the page names DCF921B).
//   2. Home Depot sells each part. The one reading the model number spells out (a RYOBI "A-B", a DEWALT kit joined to a
//      whole tool model) is settled when Home Depot's own catalog confirms every part: a found part-price reading whose
//      page's model is exactly that part's, or a kit whose own page was read; and the bundle's page contradicts nothing
//      (it names no model the parts do not explain, and any tool count it states fits). A part with no reading yet
//      makes the split wait (`waitingFor`), not a question; a reading that came back not found, or for another model,
//      keeps the question, with that reason.
//
// Nothing here guesses a part: every model comes from Home Depot's model number or its own pages. Pure: no store.

import { dewaltBundleForm, type Catalog, type Decomposition, kindsFromTitle, OFFERABLE_PART, PACK_WITH_NOTE, type PageConflict, type SettledPart, type SplitEvidence, type UnsettledPart } from '../decompose';
import { type KitItem, kitPageStored, parseIncludes, splitItems, type KitRecord } from '../kitContents';
import { sameModel } from '../match';
import { pageCatalog, pageReadingOf, RYOBI_TOKEN } from '../pageSplit';
import { kitHalfCount, saysToolsOnly, titleTools, toolCounts } from '../research/verify';
import { BOGO_JOINERS, HOME_DEPOT } from '../tracking/bogoPairs';
import type { PartFact } from '../facts/fact';
import { dayOf } from './suggest';
import { twinKeys } from './twins';
import { type BundleRecord, type MatchRecord, partKey, type PartPriceRecord } from './types';

/** What the settle rules read besides the bundle: the stored part-price readings and the stored kit records. */
export interface SettleData {
  /** Part-price records by partKey. */
  partPrices: ReadonlyMap<string, PartPriceRecord>;
  /** Every stored record of a kit (kitIndex over kitRecords): bundle records and catalog kits, with any page read. */
  kitsOf: (brand: string, model: string) => (KitRecord & { title?: string })[];
  /** Answer once (Nov 23): what the owner settled about each model, by partKey (core/src/facts/fact.ts). Absent: none. */
  facts?: ReadonlyMap<string, PartFact>;
  /**
   * Nov 24, rule B: Amazon's catalog record of exactly this brand and part number, as the catalog check confirmed it on a
   * stored match (catalogConfirmed below), by partKey. Absent: none known.
   */
  amazonCatalog?: ReadonlyMap<string, { text: string; url: string }>;
  /**
   * Nov 25, rule F: the other Home Depot bundles listed under exactly this title (sameTitleKey), each with its model and page.
   * Absent: none known.
   */
  sameTitle?: (brand: string, title: string) => readonly TitleTwin[];
  /** The settle rules turned off, for the measurements only (scripts/measure-fewer-questions*.ts). Absent: all on. */
  off?: readonly SettleRule[];
}

/** Nov 25, rule F: a Home Depot bundle record as sameTitle gives it. */
export interface TitleTwin {
  model: string;
  title: string;
  url?: string;
}

/** Nov 24's settle rules (docs/decisions.md, "Fewer questions"): A the page names the two halves, B a part Home Depot does not sell alone, C a part's own page. */
export type Nov24Rule = 'page_halves' | 'accessory' | 'part_page';
/** Nov 25's (docs/decisions.md, "Questions, round 2"): F a special buy Home Depot also sells as its tools, G a short code the page spells out. */
export type Nov25Rule = 'special_buy_twin' | 'page_code';
export type SettleRule = Nov24Rule | Nov25Rule;
const on = (data: SettleData, rule: SettleRule): boolean => !(data.off ?? []).includes(rule);

/**
 * Nov 25, rule F: a title as two Home Depot listings of the same product write it alike: lower case, "&amp;" read as "&", any
 * run of other characters one space ("5-1/2 in." and "5 1/2 in." are the same words).
 */
export const sameTitleKey = (brand: string, title: string): string =>
  `${up(brand)}|${title.toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim()}`;

/** Nov 24, rule C: how many times Home Depot may refuse a part's own page before a split asks without it. */
export const PART_PAGE_REFUSALS_MAX = 3;

/**
 * Nov 24, rule B: the parts whose stored match the catalog check confirmed (brand and part number of Amazon's own record are
 * the part's, `checkIdentity`), by partKey: a matched listing verified by the catalog, with a confirmed check of that listing.
 */
export function catalogConfirmed(matches: readonly MatchRecord[]): Map<string, { text: string; url: string }> {
  const out = new Map<string, { text: string; url: string }>();
  for (const m of matches) {
    if (m.status !== 'matched' || m.asin === null || m.verifiedBy !== 'keepa_catalog') continue;
    const check = (m.catalogChecks ?? []).find((c) => c.asin === m.asin && c.status === 'confirmed');
    if (!check) continue;
    out.set(m.key, { text: check.reason, url: `https://www.amazon.com/dp/${m.asin}` });
  }
  return out;
}

const up = (s: string): string => s.trim().toUpperCase();
const norm = (s: string): string => up(s).replace(/[-\s]/g, '');
const money = (n: number): string => `$${n.toFixed(2)}`;
const sameParts = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((m, i) => norm(m) === norm(b[i]!));

/** Notes that say the page or the model number disagrees with a reading: no settle rule overrides them. */
const CONTRADICTS = /do not fit the model number|^model number says|^model number and page component ids|page says /;
const contradicted = (split: Decomposition): boolean =>
  split.notes.some((n) => CONTRADICTS.test(n) || n === PACK_WITH_NOTE) || pageReadingOf(split.notes.join('; '));

/** A whole DEWALT model as Home Depot writes one (DCF921B, DCB606, DCB203-2); a short code ("921B", "B606") is not one. */
const WHOLE_DEWALT = /^DC[A-Z]{0,3}\d{3,4}[A-Z0-9]*(?:-\d)?$/;
const DEWALT_TOKEN = /\bDC[A-Z]{0,3}\d{3,4}[A-Z0-9]*\b/g;
const INCLUDES = /^\s*includes\b/i;
const POWER = /\b(batter(y|ies)|charger|\d+(\.\d+)?\s*ah)\b/i;

/** The models a page's bullets name, each once, in page order, with the bullet that names it first. */
function namedModels(brand: string, bullets: readonly string[], includesOnly: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = brand === 'DEWALT' ? DEWALT_TOKEN : RYOBI_TOKEN;
  for (const bullet of bullets) {
    if (includesOnly && !INCLUDES.test(bullet)) continue;
    for (const [m] of bullet.matchAll(pattern)) if (!out.has(m)) out.set(m, bullet);
  }
  return out;
}

// ---------------------------------------------------------------- rule 1: a BOGO pair

/**
 * The free item's model: one fuller model the pair's own page names for it (a longer model that ends or starts with
 * Home Depot's text), or the text itself when it is a whole model. Null when the page names more than one fuller model,
 * or the text is a DEWALT short code the page does not spell out.
 */
function freeModelOf(brand: string, free: string, bullets: readonly string[]): { model: string; quote: string | null } | null {
  const f = up(free);
  const fuller = [...namedModels(brand, bullets, false)].filter(([m]) => m.length > f.length && (m.endsWith(f) || m.startsWith(f)));
  if (fuller.length > 1) return null;
  if (fuller.length === 1) return { model: fuller[0]![0], quote: fuller[0]![1] };
  if (brand === 'DEWALT') return WHOLE_DEWALT.test(f) ? { model: f, quote: null } : null;
  return OFFERABLE_PART.test(f) ? { model: f, quote: null } : null;
}

/** Rule 1: the split of a BOGO pair, or null when the rule does not apply. */
export function bogoSplit(bundle: Pick<BundleRecord, 'brand' | 'model' | 'price' | 'link' | 'page' | 'bogo'>, split: Decomposition): Decomposition | null {
  const tag = bundle.bogo;
  const brand = up(bundle.brand);
  const joiner = BOGO_JOINERS[brand];
  if (!tag || joiner === undefined || split.status === 'resolved' || contradicted(split)) return null;
  const starter = up(tag.starterModel);
  // The record and the pair agree on the model (a record rewritten by another listing row would not).
  if (up(bundle.model) !== `${starter}${joiner}${up(tag.freeModel)}`) return null;
  const free = freeModelOf(brand, tag.freeModel, bundle.page?.bullets ?? []);
  if (!free || sameModel(brand, free.model, starter)) return null;
  const parts = [starter, free.model];
  // The model number's own readings, when it offers any, must include this one.
  if ((split.alternatives ?? []).length > 0 && !split.alternatives!.some((a) => sameParts(a, parts))) return null;
  const price = bundle.price === null ? '' : ` at ${money(bundle.price)}`;
  const evidence: SplitEvidence[] = [
    { kind: 'bogo_pair', text: `Home Depot lists ${up(bundle.model)}${price}, the price of ${starter} alone, as its BOGO pair: ${starter} and the free ${free.model}.`, ...(bundle.link ? { url: bundle.link } : {}) },
    { kind: 'bogo_pair', text: `The BOGO starter ${starter} carries the promotion on its own Home Depot page.`, url: `${HOME_DEPOT}/p/${tag.starterItemId}` },
  ];
  if (free.quote !== null) evidence.push({ kind: 'page_quote', text: free.quote, ...(bundle.link ? { url: bundle.link } : {}) });
  return { components: parts, status: 'resolved', notes: [`BOGO pair: ${starter} and the free ${free.model}`], evidence };
}

// ---------------------------------------------------------------- rule 2: Home Depot sells each part

/** The one reading the model number spells out that rule 2 may settle, or null: a RYOBI hyphen split, or a DEWALT kit joined to a whole tool model. */
function spelledOut(bundle: Pick<BundleRecord, 'brand' | 'model'>, split: Decomposition): string[] | null {
  const alts = split.alternatives ?? [];
  if (split.status === 'resolved' || alts.length !== 1 || alts[0]!.length < 2 || contradicted(split)) return null;
  const reading = alts[0]!.map(up);
  const brand = up(bundle.brand);
  if (brand === 'RYOBI') {
    if (!bundle.model.includes('-') || !sameParts(reading, up(bundle.model).split('-'))) return null;
  } else if (brand === 'DEWALT') {
    const form = dewaltBundleForm(bundle.model);
    if (form?.kind !== 'joined' || !sameParts(reading, [form.base, form.bonus])) return null;
  } else return null;
  // Step 16 (round 2): a special buy among the parts is read like any part (it used to make the rule not apply, so its bundle
  // went straight to a question with nothing read). It is never confirmed as a part (checkPart: a special buy is a bundle,
  // decisions); once read, the question is about it, and the parts Home Depot did confirm are named.
  return reading;
}

type PartCheck =
  /** `parts`: an owner's fact sells a special buy or combo as these tools in its place (ownerFact). */
  | { kind: 'confirmed'; title: string | null; evidence: SplitEvidence; parts?: string[]; more?: SplitEvidence[] }
  /** `wait`: the models whose reading it waits for, when not the part's own (rule F: a special buy's tools). */
  | { kind: 'missing'; wait?: string[] }
  | { kind: 'refused'; why: string; part: UnsettledPart };

/** The stored part-price records of a model, its own and its twin form's (Ruling 70). */
const readingsOf = (brand: string, model: string, data: SettleData): PartPriceRecord[] =>
  [partKey(brand, model), ...twinKeys(brand, model)].map((k) => data.partPrices.get(k)).filter((r): r is PartPriceRecord => r !== undefined);
/** The found reading whose page's model is exactly this part's, or undefined. */
const exactReading = (brand: string, model: string, data: SettleData): PartPriceRecord | undefined =>
  readingsOf(brand, model, data).find((r) => r.price !== null && r.matchedModel !== null && norm(r.matchedModel) === norm(model));

/** What Home Depot's own catalog says of one proposed part. */
function checkPart(brand: string, model: string, catalog: Catalog, data: SettleData): PartCheck {
  const m = up(model);
  const special = /SB$/.test(m);
  const kits = data.kitsOf(brand, m);
  const kit = catalog.get(m)?.isKit === true || kits.some((k) => (k as { isKit?: boolean }).isKit === true);
  const records = readingsOf(brand, m, data);
  const exact = exactReading(brand, m, data);
  if (exact) {
    const tools = exact.title === null ? null : titleTools(exact.title);
    // Step 16 (round 2, measured): Home Depot's own page for exactly a special buy, even one naming no other model, is not proof it
    // is one part: PCL500525SB's page names none, and the key splits it into PCL500B + PCL525B (docs/decisions.md).
    if (special && !data.facts?.get(partKey(brand, m))?.sellAs) {
      // Nov 25, rule F: a special buy Home Depot also sells under the same title as the tools its model number spells out.
      // What the owner said he sells it as (whole, or as tools) always wins: then it is his fact, below (ownerFact).
      const sb = specialBuyTools(brand, m, exact.title, data);
      if (sb?.kind === 'tools') return { kind: 'confirmed', title: exact.title, evidence: sb.evidence[0]!, parts: sb.tools, more: sb.evidence.slice(1) };
      if (sb?.kind === 'wait') return { kind: 'missing', wait: sb.models };
    }
    if (special) return { kind: 'refused', why: `Home Depot sells ${m} as a special buy, itself a bundle, so the parts it holds are asked`, part: { model: m, why: 'special_buy', ...(exact.title ? { what: exact.title } : {}), ...(exact.link ? { url: exact.link } : {}) } };
    if (!kit && tools !== null && tools >= 2) {
      return { kind: 'refused', why: `Home Depot sells ${m} as a ${tools}-tool combo the catalog does not know as a kit`, part: { model: m, why: 'combo', ...(exact.title ? { what: exact.title } : {}), ...(exact.link ? { url: exact.link } : {}) } };
    }
    return {
      kind: 'confirmed', title: exact.title,
      evidence: { kind: 'hd_part_page', text: `Home Depot sells ${m} by itself${exact.title ? `: ${exact.title}` : ''}${exact.price !== null ? ` (${money(exact.price)})` : ''}.`, ...(exact.link ? { url: exact.link } : {}) },
    };
  }
  if (kit && kitPageStored(kits, brand, m)) {
    const page = kits.find((k) => !!k.page && typeof k.itemId === 'string' && /^\d+$/.test(k.itemId));
    return {
      kind: 'confirmed', title: kits.find((k) => typeof k.title === 'string')?.title ?? null,
      evidence: { kind: 'hd_part_page', text: `Home Depot has its own page for the kit ${m}.`, ...(page ? { url: `${HOME_DEPOT}/p/${page.itemId}` } : {}) },
    };
  }
  const other = records.find((r) => r.price !== null && r.matchedModel !== null);
  if (other) return { kind: 'refused', why: `Home Depot sells ${up(other.matchedModel!)}, not ${m}`, part: { model: m, why: 'other_model', other: up(other.matchedModel!) } };
  if (records.length > 0) return { kind: 'refused', why: `Home Depot's search found no ${m} sold by itself`, part: { model: m, why: 'not_sold' } };
  return { kind: 'missing' };
}

/**
 * Answer once (Nov 23): a part Home Depot did not confirm, settled by what the owner already said about that model: a part not
 * sold on its own (or sold as another model) that he approved as a part ("isPart"), or a special buy or combo he sells whole
 * or as its tools ("sellAs"). Null when he said nothing that answers this part's question: then it is asked, as before.
 * Only the question Home Depot left is answered: the page's own contradictions and the tool count are still checked after.
 */
function ownerFact(brand: string, part: UnsettledPart, data: SettleData): PartCheck | null {
  const fact = data.facts?.get(partKey(brand, part.model));
  if (!fact) return null;
  const m = up(part.model);
  const from = (at: number, bundle?: string) => `your answer on ${dayOf(at)}${bundle ? ` (${bundle})` : ''}`;
  if ((part.why === 'not_sold' || part.why === 'other_model') && fact.isPart) {
    return { kind: 'confirmed', title: part.what ?? null, evidence: { kind: 'owner_fact', model: m, text: `${m} is a part of the bundles that name it: ${from(fact.isPart.at, fact.isPart.bundle)}.` } };
  }
  if ((part.why === 'special_buy' || part.why === 'combo') && fact.sellAs) {
    const parts = fact.sellAs.parts;
    const how = parts === null ? `${m} is sold whole` : `${m} is sold as ${parts.join(' and ')}`;
    return {
      kind: 'confirmed', title: part.what ?? null,
      evidence: { kind: 'owner_fact', model: m, text: `${how}: ${from(fact.sellAs.at, fact.sellAs.bundle)}.`, ...(part.url ? { url: part.url } : {}) },
      ...(parts !== null ? { parts } : {}),
    };
  }
  return null;
}

/**
 * Nov 24, rule B: a part Home Depot does not sell by itself ("not_sold"), which the model number spells out, confirmed as a
 * part by one of two records that are not a seller's words: the bundle's own page lists it on an Includes bullet as an item
 * of the box ("Includes: (1) A10FB1G 11 in. flexible shaft bit holder …"), or Amazon's catalog holds a product of exactly
 * that brand and part number (the catalog check, `amazonCatalog`). Null otherwise: the part is asked about, as before.
 * Its Home Depot title is unknown (it has no page of its own there); the Includes item's own words stand in for it.
 */
function accessoryOf(bundle: Pick<BundleRecord, 'link' | 'page'>, brand: string, part: UnsettledPart, data: SettleData): PartCheck | null {
  if (part.why !== 'not_sold') return null;
  const m = up(part.model);
  const bullets = bundle.page?.bullets ?? [];
  for (const bullet of bullets) {
    const item = parseIncludes(brand, [bullet]).find((i) => i.model !== null && sameModel(brand, i.model, m));
    if (item) return { kind: 'confirmed', title: item.name, evidence: { kind: 'page_quote', text: bullet.trim(), ...(bundle.link ? { url: bundle.link } : {}) } };
  }
  const amazon = [partKey(brand, m), ...twinKeys(brand, m)].map((k) => data.amazonCatalog?.get(k)).find((x) => x !== undefined);
  if (amazon) return { kind: 'confirmed', title: null, evidence: { kind: 'amazon_catalog', model: m, text: `${amazon.text}; Home Depot does not sell ${m} by itself.`, url: amazon.url } };
  return null;
}

/** Nov 24, rule C: the items a part's own Home Depot page lists (Includes), once read; [] otherwise, or when that list names the part itself. */
function partPageItems(brand: string, model: string, data: SettleData): KitItem[] {
  const page = exactReading(brand, model, data)?.page;
  if (!page) return [];
  const items = parseIncludes(brand, page.bullets);
  return items.some((i) => i.model !== null && sameModel(brand, i.model, model)) ? [] : items;
}

/**
 * Nov 24, rule C: the tools a kit holds by its own Home Depot page's Includes lists (its kit page, else its part page read
 * by rule C): each item's tools by its own words (titleTools: a tool 1, a battery, charger, bag or accessory 0), times its
 * quantity. Null when no list is stored, or any item's words do not say (an item that might be a tool is never guessed).
 */
export function kitPageTools(brand: string, model: string, data: SettleData): number | null {
  const kitItems = splitItems(data.kitsOf(brand, model), brand, model);
  const items = kitItems ?? partPageItems(brand, model, data);
  if (items.length === 0) return null;
  let sum = 0;
  for (const i of items) {
    const t = titleTools(i.name);
    if (t === null) return null;
    sum += t * i.qty;
  }
  return sum;
}

/**
 * Nov 24, rule C: a part Home Depot confirmed whose own page is not read yet and can be (a digit item id on its reading), and
 * was refused fewer than PART_PAGE_REFUSALS_MAX times: its Includes list may explain a model the bundle's page names, so a
 * split waits for it before it asks. A kit whose own page is stored already gave its list (explains).
 */
export function partPageDue(brand: string, model: string, data: SettleData): boolean {
  return partPageTarget(brand, model, data) !== null;
}

/** Rule C: the part-price reading whose page partPageDue waits for (its item id is the page to read), or null. */
export function partPageTarget(brand: string, model: string, data: SettleData): PartPriceRecord | null {
  const r = exactReading(brand, model, data);
  if (!r || r.itemId === null || !/^\d+$/.test(r.itemId) || r.page) return null;
  if (kitPageStored(data.kitsOf(brand, model), brand, model)) return null;
  return (r.pageRefusals ?? 0) < PART_PAGE_REFUSALS_MAX ? r : null;
}

/** A kit the catalog knows whose own Home Depot page is not stored yet and can be read (a digit item id): the scan's kit pass reads it. */
function kitPageDue(brand: string, model: string, catalog: Catalog, data: SettleData): boolean {
  const kits = data.kitsOf(brand, model);
  const kit = catalog.get(up(model))?.isKit === true || kits.some((k) => (k as { isKit?: boolean }).isKit === true);
  return kit && !kitPageStored(kits, brand, model) && kits.some((k) => typeof k.itemId === 'string' && /^\d+$/.test(k.itemId));
}

/**
 * A model the page names is explained by a part: the part itself, its tool written without the kit or tool-only ending
 * (FVC51 for FVC51K), an item its own kit page lists, or (Nov 24, rule C) an item the part's own Home Depot page lists.
 */
function explains(brand: string, named: string, parts: readonly string[], bundleModel: string, data: SettleData): boolean {
  if (norm(named) === norm(bundleModel)) return true;
  const listed = (items: readonly KitItem[]): boolean => items.some((i) => i.model !== null && sameModel(brand, i.model, named));
  return parts.some((p) => {
    if (sameModel(brand, named, p)) return true;
    if (p.startsWith(named) && /^[A-Z]{1,3}\d?$/.test(p.slice(named.length))) return true;
    return listed(splitItems(data.kitsOf(brand, p), brand, p) ?? []) || listed(partPageItems(brand, p, data));
  });
}

/** A model the bundle's page names that no part explains, as the reason the split stays a question; null when there is none. */
function unexplainedModel(bundle: Pick<BundleRecord, 'brand' | 'model' | 'page'>, parts: readonly string[], data: SettleData): string | null {
  const brand = up(bundle.brand);
  // RYOBI names a part on its Includes bullets; DEWALT anywhere ("DCS380B - 4-position blade clamp").
  for (const [m] of namedModels(brand, bundle.page?.bullets ?? [], brand === 'RYOBI')) {
    if (!explains(brand, m, parts, bundle.model, data)) return `page names ${m}, which none of the parts explains`;
  }
  return null;
}

/**
 * A tool count, or "Tools Only", the bundle states that the parts cannot fit, as the reason; null when they fit or it
 * states none. A count fits when the kit half's own title states it (rule 3: "<N>-Tool Combo Kit … and <extra>" counts
 * the kit's tools) or every part's tools can be read from its title and they add up to it.
 */
export function countMisfit(
  bundle: Pick<BundleRecord, 'title' | 'page'>, parts: readonly string[], titles: ReadonlyMap<string, string | null>, kitPageCount: number | null = null,
): string | null {
  const bullets = bundle.page?.bullets ?? [];
  const stated = new Set([...toolCounts(bundle.title), ...bullets.filter((b) => INCLUDES.test(b)).flatMap(toolCounts)]);
  if (stated.size > 1) return `the bundle states different tool counts (${[...stated].join(', ')})`;
  const toolsOnly = saysToolsOnly(bundle.title) || bullets.some(saysToolsOnly);
  if (toolsOnly && parts.some((p) => POWER.test(titles.get(p) ?? '') && !saysToolsOnly(titles.get(p) ?? ''))) {
    return 'the bundle says Tools Only, and a part holds a battery or a charger';
  }
  if (stated.size === 0) return null;
  const n = [...stated][0]!;
  // Rule 3: "<N>-Tool Combo Kit … and <extra>" counts the kit half, whose own title states the same N. Nov 24, rule C: or
  // whose own Home Depot page lists items that hold N tools (kitPageTools), when its title states no count.
  const kitTitle = titles.get(parts[0]!) ?? null;
  const kitOwn = kitTitle !== null && toolCounts(kitTitle).length > 0 ? toolCounts(kitTitle)[0] : kitPageCount;
  const kitHalf = kitHalfCount(bundle.title) === n && kitOwn === n;
  const each = parts.map((p) => {
    const t = titles.get(p);
    return t ? titleTools(t) : null;
  });
  const total = each.every((t) => t !== null) ? each.reduce<number>((sum, t) => sum + t!, 0) : null;
  if (kitHalf || total === n) return null;
  return `the bundle states ${n} tools, which the parts do not make`;
}

/** Rule 2: the split settled by Home Depot's own catalog, one waiting for its readings, one kept in review with why, or null when the rule does not apply. */
export function homeDepotSplit(
  bundle: Pick<BundleRecord, 'brand' | 'model' | 'title' | 'link' | 'page'>, split: Decomposition, catalog: Catalog, data: SettleData,
): Decomposition | null {
  const reading = spelledOut(bundle, split);
  if (reading === null) return null;
  return settleReading(bundle, split, reading, catalog, data);
}

/**
 * Rule 2's checks on one reading the model number spells out (spelledOut, or rule A's pageHalves): every part confirmed by
 * Home Depot (or rule B), the page contradicting nothing, the tool count fitting; a part still to read makes it wait.
 */
function settleReading(
  bundle: Pick<BundleRecord, 'brand' | 'model' | 'title' | 'link' | 'page'>, split: Decomposition, reading: readonly string[], catalog: Catalog, data: SettleData,
): Decomposition {
  const brand = up(bundle.brand);
  // Answer once (Nov 23): a part Home Depot did not confirm that the owner already settled is settled here too (ownerFact).
  // Nov 24, rule B: a part Home Depot does not sell alone that the bundle's page or Amazon's catalog names (accessoryOf).
  const checks = reading.map((p) => {
    const c = checkPart(brand, p, catalog, data);
    if (c.kind !== 'refused') return [p, c] as const;
    return [p, ownerFact(brand, c.part, data) ?? (on(data, 'accessory') ? accessoryOf(bundle, brand, c.part, data) : null) ?? c] as const;
  });
  // A special buy he sells as its tools stands for those tools in the reading.
  const replaced = checks.flatMap(([p, c]) => (c.kind === 'confirmed' && c.parts ? c.parts : [p]));
  const refused = checks.flatMap(([, c]) => (c.kind === 'refused' ? [c.why] : []));
  const missing = checks.flatMap(([p, c]) => (c.kind === 'missing' ? c.wait ?? [p] : []));
  // Step 16 (round 2): no question while a part still has a free read to come: the refusals are asked once every part is read.
  if (refused.length > 0 && missing.length > 0) return { ...split, waitingFor: missing };
  if (refused.length > 0) {
    // The question is about the parts Home Depot did not confirm; the ones it did are named with their pages.
    // Nov 24 (rule B): a part the bundle's page names is shown with the page's whole line.
    const settledParts: SettledPart[] = checks.flatMap(([p, c]) => (c.kind === 'confirmed' ? [{ model: p, what: c.evidence.kind === 'page_quote' ? c.evidence.text : (c.title ?? c.evidence.text), ...(c.evidence.url ? { url: c.evidence.url } : {}) }] : []));
    const unsettledParts = checks.flatMap(([, c]) => (c.kind === 'refused' ? [c.part] : []));
    return { ...split, notes: [...split.notes, ...refused], ...(settledParts.length > 0 ? { settledParts } : {}), unsettledParts };
  }
  // The page is read before the parts are waited for: a page that names another model asks at once, unless a kit among
  // the parts has its own page still to read, which may list that model (its contents explain it): then it waits too.
  // A model the page names may be explained by the special buy or by the tools he sells in its place.
  const named = unexplainedModel(bundle, [...new Set([...reading, ...replaced])], data);
  if (named !== null) {
    // Nov 24, rule C: a part Home Depot confirmed whose own page is still to read may list the model too (partPageItems).
    const unread = reading.filter((p) => kitPageDue(brand, p, catalog, data) || (on(data, 'part_page') && checks.some(([q, c]) => q === p && c.kind === 'confirmed' && c.evidence.kind === 'hd_part_page') && partPageDue(brand, p, data)));
    if (unread.length === 0) return { ...split, notes: [...split.notes, named] };
    return { ...split, waitingFor: [...new Set([...unread, ...missing])] };
  }
  if (missing.length > 0) return { ...split, waitingFor: missing };
  const titles = new Map(checks.map(([p, c]) => [p, c.kind === 'confirmed' ? c.title : null] as const));
  // The tool count is the bundle's as Home Depot lists it (the special buy whole): his tools in its place do not change it.
  // A part only the owner's fact settled (no Home Depot title to count) is not counted as a tool: the count still checks
  // every part Home Depot's pages read (docs/decisions.md, "Answer once"). Nov 24, rule B: nor is a part Home Depot does not
  // sell alone whose Includes words say no tool count (or that only Amazon's catalog names).
  const uncounted = new Set(checks.flatMap(([p, c]) => (c.kind === 'confirmed' && c.evidence.kind !== 'hd_part_page' && (c.title === null || titleTools(c.title) === null) ? [p] : [])));
  const kitCount = on(data, 'part_page') ? kitPageTools(brand, reading[0]!, data) : null;
  const misfit = countMisfit(bundle, reading, titles, kitCount) === null ? null : countMisfit(bundle, reading.filter((p) => !uncounted.has(p)), titles, kitCount);
  if (misfit !== null) return { ...split, notes: [...split.notes, misfit] };
  const evidence = checks.flatMap(([, c]) => (c.kind === 'confirmed' ? [c.evidence, ...(c.more ?? [])] : []));
  const owner = evidence.some((e) => e.kind === 'owner_fact');
  const named2 = evidence.some((e) => e.kind === 'page_quote' || e.kind === 'amazon_catalog');
  const twin = evidence.some((e) => e.kind === 'hd_same_title');
  const note = owner ? 'Home Depot sells each part under its own model, or you said what it is'
    : twin ? 'Home Depot sells each part under its own model, and the special buy as those tools under the same title'
    : named2 ? 'Home Depot sells each part under its own model, or names the one it does not sell alone'
    : 'Home Depot sells each part under its own model';
  return { components: replaced, status: 'resolved', notes: [note], evidence };
}

// ---------------------------------------------------------------- rule A (Nov 24): the page names the two halves

/**
 * Rule A: a DEWALT model number in no known bundle form that is one whole model, W, and a second model without its leading
 * D (DCF860BWCB2460C = DCF860B with CB2460C), whose page names exactly those two models and no other DEWALT model anywhere.
 * The reading [first, second]; null when the rule does not apply. The W form is the one Home Depot writes for a kit with a
 * bonus item (DCK…W…), where the second half drops its leading D (DCK940D2WCF891B, decompose.ts).
 */
export function pageHalves(bundle: Pick<BundleRecord, 'brand' | 'model' | 'page'>, split: Decomposition): string[] | null {
  if (up(bundle.brand) !== 'DEWALT' || split.status === 'resolved' || (split.alternatives ?? []).length > 0 || !bundle.page) return null;
  if (dewaltBundleForm(bundle.model) !== null) return null;
  const bullets = bundle.page.bullets;
  const leading = [...pageCatalog('DEWALT', bullets).keys()];
  const anywhere = [...namedModels('DEWALT', bullets, false).keys()];
  if (leading.length !== 2 || anywhere.length !== 2 || !anywhere.every((m) => leading.includes(m))) return null;
  const model = norm(bundle.model);
  const pairs: [string, string][] = [[leading[0]!, leading[1]!], [leading[1]!, leading[0]!]];
  for (const [a, b] of pairs) {
    if (WHOLE_DEWALT.test(a) && WHOLE_DEWALT.test(b) && b.startsWith('D') && model === `${a}W${b.slice(1)}`) return [a, b];
  }
  return null;
}

/** Rule A, then rule 2's checks on that reading; null when rule A does not apply. */
export function pageHalvesSplit(
  bundle: Pick<BundleRecord, 'brand' | 'model' | 'title' | 'link' | 'page'>, split: Decomposition, catalog: Catalog, data: SettleData,
): Decomposition | null {
  if (!on(data, 'page_halves')) return null;
  const reading = pageHalves(bundle, split);
  if (reading === null) return null;
  const [a, b] = reading as [string, string];
  const said = `the model number is ${a} with ${b.slice(1)}, and the page names exactly ${a} and ${b}`;
  const base: Decomposition = { components: [], status: 'needs_review', notes: [said], alternatives: [[a, b]] };
  const out = settleReading(bundle, base, reading, catalog, data);
  if (out.status !== 'resolved') return out;
  const quote: SplitEvidence = { kind: 'page_quote', text: `Model ${up(bundle.model)}: ${said}.`, ...(bundle.link ? { url: bundle.link } : {}) };
  return { ...out, evidence: [quote, ...(out.evidence ?? [])] };
}

// ---------------------------------------------------------------- rule F (Nov 25): a special buy Home Depot also sells as its tools

/** A RYOBI special buy whose model number is a prefix and two three-digit tool numbers: PCL406424SB (PCL406B, PCL424B). */
const SPECIAL_SIX = /^([A-Z]{2,4})(\d{3})(\d{3})SB$/;

/** Rule F's reading of a special buy: its tools, settled with the evidence; waiting for Home Depot's reading of some; or null. */
export type SpecialBuyRead = { kind: 'tools'; tools: string[]; evidence: SplitEvidence[] } | { kind: 'wait'; models: string[] } | null;

/**
 * Rule F: the tools inside a RYOBI special buy, when three independent Home Depot records agree and none disagrees:
 *   1. the model number reads as a prefix and two three-digit tool numbers (PCL406424SB: PCL406B and PCL424B), the
 *      special-buy convention decompose.ts already reads with two digits (PBLRC2501SB);
 *   2. Home Depot lists the same set under exactly the same title as a bundle whose model number is exactly those tools
 *      joined by a hyphen (PCL424B-PCL406B, "ONE+ 18V Cordless 2-Tool Combo Kit with Compact Fixed Base Router and 5 in.
 *      Random Orbit Sander (Tools Only)"), and every other bundle of that title reads the same;
 *   3. Home Depot sells each tool by itself under exactly that model, as one tool whose kind the special buy's title names
 *      (and "Tool Only" when the title says Tools Only), and the title's tool count is the number of tools.
 * A tool not read yet makes it wait for that reading. Anything else (no such twin, a count that differs, a tool's page of
 * another kind) is null: the special buy is asked about, as before. Measured on every recorded special buy before it was
 * adopted (scripts/measure-questions-round2.ts); "a special buy is one kit" stays rejected.
 */
export function specialBuyTools(brand: string, model: string, title: string | null, data: SettleData): SpecialBuyRead {
  if (!on(data, 'special_buy_twin') || up(brand) !== 'RYOBI' || title === null) return null;
  const m = SPECIAL_SIX.exec(up(model));
  if (!m || m[2] === m[3]) return null;
  const tools = [`${m[1]}${m[2]}B`, `${m[1]}${m[3]}B`];
  const stated = toolCounts(title);
  if (stated.length !== 1 || stated[0] !== tools.length) return null;
  const twins = (data.sameTitle?.(brand, title) ?? []).filter((t) => norm(t.model) !== norm(model));
  if (twins.length === 0) return null;
  const isTools = (pieces: readonly string[]): boolean =>
    pieces.length === tools.length && tools.every((x) => pieces.some((p) => sameModel('RYOBI', p, x))) && pieces.every((p) => tools.some((x) => sameModel('RYOBI', p, x)));
  if (!twins.every((t) => isTools(up(t.model).split('-')))) return null;
  // A tool not read yet is waited for; one read and not found sold by itself (or found as another model) settles nothing.
  if (tools.some((t) => !exactReading('RYOBI', t, data) && readingsOf('RYOBI', t, data).length > 0)) return null;
  const missing = tools.filter((t) => !exactReading('RYOBI', t, data));
  if (missing.length > 0) return { kind: 'wait', models: missing };
  const titleKinds = new Set(kindsFromTitle(title));
  const twin = twins[0]!;
  const evidence: SplitEvidence[] = [
    { kind: 'hd_same_title', text: `Home Depot sells the same set under the same title as ${up(twin.model)}: "${twin.title}".`, ...(twin.url ? { url: twin.url } : {}) },
  ];
  for (const t of tools) {
    const r = exactReading('RYOBI', t, data)!;
    if (r.title === null || titleTools(r.title) !== 1) return null;
    if (saysToolsOnly(title) && !saysToolsOnly(r.title)) return null;
    const kinds = kindsFromTitle(r.title);
    if (kinds.length === 0 || !kinds.every((k) => titleKinds.has(k))) return null;
    evidence.push({ kind: 'hd_part_page', text: `Home Depot sells ${t} by itself: ${r.title}${r.price !== null ? ` (${money(r.price)})` : ''}.`, ...(r.link ? { url: r.link } : {}) });
  }
  return { kind: 'tools', tools, evidence };
}

/** Rule F on a bundle that is itself the special buy (PCL406424SB): its tools, through rule 2's checks; null when rule F does not apply. */
export function specialBuySplit(
  bundle: Pick<BundleRecord, 'brand' | 'model' | 'title' | 'link' | 'page'>, split: Decomposition, catalog: Catalog, data: SettleData,
): Decomposition | null {
  if (split.status === 'resolved' || bundle.model.includes('-') || contradicted(split)) return null;
  // The owner's own word on how he sells this special buy is never overridden.
  if (data.facts?.get(partKey(bundle.brand, bundle.model))?.sellAs) return null;
  const sb = specialBuyTools(bundle.brand, bundle.model, bundle.title, data);
  if (sb === null) return null;
  if (sb.kind === 'wait') return { ...split, waitingFor: sb.models };
  const out = settleReading(bundle, { ...split, alternatives: [sb.tools] }, sb.tools, catalog, data);
  if (out.status !== 'resolved') return out;
  return { ...out, notes: ['Home Depot sells each part under its own model, and the special buy as those tools under the same title'], evidence: [sb.evidence[0]!, ...(out.evidence ?? [])] };
}

// ---------------------------------------------------------------- rule G (Nov 25): a short code the page spells out

/**
 * Rule G: a DEWALT "<kit>W<two digits>" whose code the stored catalog cannot read (DCKTS681D1P1W82: "'82' matches nothing
 * in the catalog"; decompose.ts never reads a two-character code from listings' titles), where the bundle's own page names
 * exactly one whole DEWALT model, other than the kit, that ends in those digits (DCS382B, named on eight of its lines). The
 * kit must be a kit the catalog knows. The reading [kit, model]; null when the rule does not apply. The code is the tail of
 * the model's number, as in every DEWALT code Home Depot writes (W05 is DCB205 and W34 DCS334B, both the owner's answers).
 */
export function pageCode(bundle: Pick<BundleRecord, 'brand' | 'model' | 'page'>, split: Decomposition, catalog: Catalog): string[] | null {
  if (up(bundle.brand) !== 'DEWALT' || split.status === 'resolved' || (split.alternatives ?? []).length > 0 || !bundle.page) return null;
  const form = dewaltBundleForm(bundle.model);
  if (form?.kind !== 'kit' || !/^\d{2}$/.test(form.bonus) || split.notes[0] !== `'${form.bonus}' matches nothing in the catalog`) return null;
  if (catalog.get(form.base)?.isKit !== true) return null;
  const named = [...namedModels('DEWALT', bundle.page.bullets, false).keys()]
    .filter((m) => WHOLE_DEWALT.test(m) && norm(m) !== norm(form.base) && (norm(m).endsWith(form.bonus) || norm(m).endsWith(`${form.bonus}B`)));
  return named.length === 1 ? [form.base, named[0]!] : null;
}

/**
 * Rule G, then rule 2's checks on that reading (Home Depot sells the model by itself, the page names nothing else no part
 * explains, the count fits); settled only when the model's own Home Depot title is of a kind the bundle's title names
 * ("Reciprocating Saw"). A question it leaves offers the reading. Null when rule G does not apply.
 */
export function pageCodeSplit(
  bundle: Pick<BundleRecord, 'brand' | 'model' | 'title' | 'link' | 'page'>, split: Decomposition, catalog: Catalog, data: SettleData,
): Decomposition | null {
  if (!on(data, 'page_code')) return null;
  const reading = pageCode(bundle, split, catalog);
  if (reading === null) return null;
  const [kit, tool] = reading as [string, string];
  const code = dewaltBundleForm(bundle.model)!.bonus;
  const said = `'${code}' is ${tool}, the one model the page names that ends in ${code}`;
  // The reading leads the question's reason; "'82' matches nothing in the catalog" is no longer what it is about.
  const rest = split.notes.filter((n) => n !== `'${code}' matches nothing in the catalog`);
  const base: Decomposition = { components: split.components, status: 'needs_review', notes: [said, ...rest], alternatives: [[kit, tool]] };
  // A page that already names models the model number does not fit (W21's page names DCD999, DCF887, …: another kit's lines)
  // settles nothing: the question offers the reading, for the owner to approve or not.
  if (contradicted(split)) return base;
  const out = settleReading(bundle, base, reading, catalog, data);
  if (out.status !== 'resolved') return out;
  const title = exactReading('DEWALT', tool, data)?.title ?? null;
  const kinds = title === null ? [] : kindsFromTitle(title);
  const bundleKinds = new Set(kindsFromTitle(bundle.title));
  if (kinds.length === 0 || !kinds.every((k) => bundleKinds.has(k))) {
    return { ...base, notes: [...base.notes, `the title does not name what Home Depot's page of ${tool} is${title ? ` (${title})` : ''}`] };
  }
  const line = (bundle.page?.bullets ?? []).find((b) => b.includes(tool));
  const quote: SplitEvidence = { kind: 'page_quote', text: `Model ${up(bundle.model)}: ${said}${line ? `: "${line.trim()}"` : ''}.`, ...(bundle.link ? { url: bundle.link } : {}) };
  return { ...out, evidence: [quote, ...(out.evidence ?? [])] };
}

// ---------------------------------------------------------------- Nov 25: two Home Depot pages that disagree on a kit

const LEAD_DEWALT = /^\s*(DC[A-Z]{0,3}\d{3,4}[A-Z0-9]*)\b/i;
const NAMES_NOT_FIT = /^page names (.+), which do not fit the model number$/;

/**
 * A DEWALT kit + tool bundle left in review because its page names other models for the kit half (DCK225D2WCS380B: "page
 * names DCD708B, DCF809B, which do not fit the model number"), whose kit has its own Home Depot page that leads its lines
 * with other models (DCK225D2: "DCD794 - …", "DCF809 - …"). Nothing is settled: the two pages disagree, and which is right
 * is the owner's call; this only says how they disagree, with both pages (Decomposition.conflict). Null otherwise.
 */
export function kitPageConflict(bundle: Pick<BundleRecord, 'brand' | 'model' | 'link' | 'page'>, split: Decomposition, data: SettleData): PageConflict | null {
  if (up(bundle.brand) !== 'DEWALT' || split.status === 'resolved' || (split.alternatives ?? []).length !== 1) return null;
  const reading = split.alternatives![0]!;
  const form = dewaltBundleForm(bundle.model);
  if (form?.kind !== 'kit' || reading.length !== 2 || norm(reading[0]!) !== norm(form.base)) return null;
  const [kit, tool] = reading as [string, string];
  const said = split.notes.map((n) => NAMES_NOT_FIT.exec(n)).find((x) => x !== null);
  if (!said) return null;
  const bundleNames = said[1]!.split(',').map((x) => up(x)).filter(Boolean);
  const kitRecord = data.kitsOf('DEWALT', kit).find((k) => k.page && typeof k.itemId === 'string' && /^\d+$/.test(k.itemId));
  if (!kitRecord?.page) return null;
  const kitNames = [...new Set(kitRecord.page.bullets.map((b) => LEAD_DEWALT.exec(b)?.[1]?.toUpperCase()).filter((x): x is string => !!x))];
  if (kitNames.length === 0) return null;
  // The bundle's models the kit's page does not name (DCF809B is its DCF809): when it names them all, the pages agree.
  const differ = bundleNames.filter((b) => !kitNames.some((k) => sameModel('DEWALT', b, k) || b.startsWith(k)));
  if (differ.length === 0) return null;
  const bundleQuote = (bundle.page?.bullets ?? []).find((b) => b.includes(differ[0]!)) ?? '';
  const sentence = (kitRecord.page.description ?? '').split(/(?<=\.)\s+/).find((x) => kitNames.some((k) => x.toUpperCase().includes(k)));
  const kitQuote = sentence ?? kitRecord.page.bullets.find((b) => LEAD_DEWALT.test(b)) ?? '';
  return {
    kit: up(kit), tool: up(tool), bundleNames: differ, bundleQuote: bundleQuote.trim(), ...(bundle.link ? { bundleUrl: bundle.link } : {}),
    kitNames, kitQuote: kitQuote.trim(), kitUrl: `${HOME_DEPOT}/p/${kitRecord.itemId}`,
  };
}

/**
 * The settle rules on a split the model number and the page left in review (rule 1, then rule 2, then A, G and F). A
 * resolved split, or one no rule applies to, comes back unchanged, except that a question on two Home Depot pages that
 * disagree says how (kitPageConflict).
 */
export function settleSplit(bundle: BundleRecord, split: Decomposition, catalog: Catalog, data: SettleData): Decomposition {
  if (split.status === 'resolved') return split;
  const out = bogoSplit(bundle, split) ?? homeDepotSplit(bundle, split, catalog, data) ?? pageHalvesSplit(bundle, split, catalog, data)
    ?? pageCodeSplit(bundle, split, catalog, data) ?? specialBuySplit(bundle, split, catalog, data) ?? split;
  if (out.status === 'resolved' || (out.waitingFor ?? []).length > 0) return out;
  const conflict = kitPageConflict(bundle, out, data);
  return conflict ? { ...out, conflict } : out;
}
