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

import { dewaltBundleForm, type Catalog, type Decomposition, OFFERABLE_PART, PACK_WITH_NOTE, type SettledPart, type SplitEvidence, type UnsettledPart } from '../decompose';
import { kitPageStored, splitItems, type KitRecord } from '../kitContents';
import { sameModel } from '../match';
import { pageReadingOf, RYOBI_TOKEN } from '../pageSplit';
import { kitHalfCount, saysToolsOnly, titleTools, toolCounts } from '../research/verify';
import { BOGO_JOINERS, HOME_DEPOT } from '../tracking/bogoPairs';
import { twinKeys } from './twins';
import { type BundleRecord, partKey, type PartPriceRecord } from './types';

/** What the settle rules read besides the bundle: the stored part-price readings and the stored kit records. */
export interface SettleData {
  /** Part-price records by partKey. */
  partPrices: ReadonlyMap<string, PartPriceRecord>;
  /** Every stored record of a kit (kitIndex over kitRecords): bundle records and catalog kits, with any page read. */
  kitsOf: (brand: string, model: string) => (KitRecord & { title?: string })[];
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
  | { kind: 'confirmed'; title: string | null; evidence: SplitEvidence }
  | { kind: 'missing' }
  | { kind: 'refused'; why: string; part: UnsettledPart };

/** What Home Depot's own catalog says of one proposed part. */
function checkPart(brand: string, model: string, catalog: Catalog, data: SettleData): PartCheck {
  const m = up(model);
  const special = /SB$/.test(m);
  const kits = data.kitsOf(brand, m);
  const kit = catalog.get(m)?.isKit === true || kits.some((k) => (k as { isKit?: boolean }).isKit === true);
  const records = [partKey(brand, m), ...twinKeys(brand, m)].map((k) => data.partPrices.get(k)).filter((r): r is PartPriceRecord => r !== undefined);
  const exact = records.find((r) => r.price !== null && r.matchedModel !== null && norm(r.matchedModel) === norm(m));
  if (exact) {
    const tools = exact.title === null ? null : titleTools(exact.title);
    // Step 16 (round 2, measured): Home Depot's own page for exactly a special buy, even one naming no other model, is not proof it
    // is one part: PCL500525SB's page names none, and the key splits it into PCL500B + PCL525B (docs/decisions.md).
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

/** A kit the catalog knows whose own Home Depot page is not stored yet and can be read (a digit item id): the scan's kit pass reads it. */
function kitPageDue(brand: string, model: string, catalog: Catalog, data: SettleData): boolean {
  const kits = data.kitsOf(brand, model);
  const kit = catalog.get(up(model))?.isKit === true || kits.some((k) => (k as { isKit?: boolean }).isKit === true);
  return kit && !kitPageStored(kits, brand, model) && kits.some((k) => typeof k.itemId === 'string' && /^\d+$/.test(k.itemId));
}

/** A model the page names is explained by a part: the part itself, its tool written without the kit or tool-only ending (FVC51 for FVC51K), or an item its own kit page lists. */
function explains(brand: string, named: string, parts: readonly string[], bundleModel: string, data: SettleData): boolean {
  if (norm(named) === norm(bundleModel)) return true;
  return parts.some((p) => {
    if (sameModel(brand, named, p)) return true;
    if (p.startsWith(named) && /^[A-Z]{1,3}\d?$/.test(p.slice(named.length))) return true;
    return (splitItems(data.kitsOf(brand, p), brand, p) ?? []).some((i) => i.model !== null && sameModel(brand, i.model, named));
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
export function countMisfit(bundle: Pick<BundleRecord, 'title' | 'page'>, parts: readonly string[], titles: ReadonlyMap<string, string | null>): string | null {
  const bullets = bundle.page?.bullets ?? [];
  const stated = new Set([...toolCounts(bundle.title), ...bullets.filter((b) => INCLUDES.test(b)).flatMap(toolCounts)]);
  if (stated.size > 1) return `the bundle states different tool counts (${[...stated].join(', ')})`;
  const toolsOnly = saysToolsOnly(bundle.title) || bullets.some(saysToolsOnly);
  if (toolsOnly && parts.some((p) => POWER.test(titles.get(p) ?? '') && !saysToolsOnly(titles.get(p) ?? ''))) {
    return 'the bundle says Tools Only, and a part holds a battery or a charger';
  }
  if (stated.size === 0) return null;
  const n = [...stated][0]!;
  // Rule 3: "<N>-Tool Combo Kit … and <extra>" counts the kit half, whose own title states the same N.
  const kitTitle = titles.get(parts[0]!) ?? null;
  const kitHalf = kitHalfCount(bundle.title) === n && kitTitle !== null && toolCounts(kitTitle)[0] === n;
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
  const brand = up(bundle.brand);
  const checks = reading.map((p) => [p, checkPart(brand, p, catalog, data)] as const);
  const refused = checks.flatMap(([, c]) => (c.kind === 'refused' ? [c.why] : []));
  const missing = checks.filter(([, c]) => c.kind === 'missing').map(([p]) => p);
  // Step 16 (round 2): no question while a part still has a free read to come: the refusals are asked once every part is read.
  if (refused.length > 0 && missing.length > 0) return { ...split, waitingFor: missing };
  if (refused.length > 0) {
    // The question is about the parts Home Depot did not confirm; the ones it did are named with their pages.
    const settledParts: SettledPart[] = checks.flatMap(([p, c]) => (c.kind === 'confirmed' ? [{ model: p, what: c.title ?? c.evidence.text, ...(c.evidence.url ? { url: c.evidence.url } : {}) }] : []));
    const unsettledParts = checks.flatMap(([, c]) => (c.kind === 'refused' ? [c.part] : []));
    return { ...split, notes: [...split.notes, ...refused], ...(settledParts.length > 0 ? { settledParts } : {}), unsettledParts };
  }
  // The page is read before the parts are waited for: a page that names another model asks at once, unless a kit among
  // the parts has its own page still to read, which may list that model (its contents explain it): then it waits too.
  const named = unexplainedModel(bundle, reading, data);
  if (named !== null) {
    const unread = reading.filter((p) => kitPageDue(brand, p, catalog, data));
    if (unread.length === 0) return { ...split, notes: [...split.notes, named] };
    return { ...split, waitingFor: [...new Set([...unread, ...missing])] };
  }
  if (missing.length > 0) return { ...split, waitingFor: missing };
  const titles = new Map(checks.map(([p, c]) => [p, c.kind === 'confirmed' ? c.title : null] as const));
  const misfit = countMisfit(bundle, reading, titles);
  if (misfit !== null) return { ...split, notes: [...split.notes, misfit] };
  const evidence = checks.flatMap(([, c]) => (c.kind === 'confirmed' ? [c.evidence] : []));
  return { components: reading, status: 'resolved', notes: ['Home Depot sells each part under its own model'], evidence };
}

/**
 * The settle rules on a split the model number and the page left in review (rule 1, then rule 2). A resolved split, or
 * one no rule applies to, comes back unchanged.
 */
export function settleSplit(bundle: BundleRecord, split: Decomposition, catalog: Catalog, data: SettleData): Decomposition {
  if (split.status === 'resolved') return split;
  return bogoSplit(bundle, split) ?? homeDepotSplit(bundle, split, catalog, data) ?? split;
}
