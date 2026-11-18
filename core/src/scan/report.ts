// Turn what a scan left in the store into ranked rows. Reads only; never searches.
// Profit figures are estimates from fee settings, not the seller's real fees.

import { type KitItem, kitIndex, kitItemParts, kitPageStored, kitPageUnread, type KitRecord, kitRecords, splitItems } from '../kitContents';
import { evaluateBundle, type PricedListing } from '../scanPlan';
import { choicesOf, ownerAnswer } from './answers';
import { componentCounts } from './classify';
import { twinKeysOf } from './twins';
import {
  type BundleRecord,
  type BundleRow,
  type BundleStatus,
  type PartAvailability,
  type PartRow,
  type ReportSection,
  partKey,
  priceActive,
  resolvedParts,
  type SaleOption,
  type ScanReport,
  type ScanSettings,
  type ScanStore,
} from './types';

const SECTION_RANK: Record<ReportSection, number> = { confirmed: 0, waiting: 1, inactive_listing: 2, missing_listing: 3, split: 4 };

async function partRows(store: ScanStore, brand: string, counts: Record<string, number>): Promise<PartRow[]> {
  const rows: PartRow[] = [];
  for (const model of Object.keys(counts)) {
    const match = await store.getMatch(partKey(brand, model));
    const price = match?.asin ? await store.getPrice(match.asin) : undefined;
    const listing = match?.asin ? await store.getListing(match.asin) : undefined;
    let availability: PartAvailability = 'missing';
    if (match?.status === 'matched' && match.asin !== null) {
      availability = priceActive(price) ? 'active' : 'inactive';
    }
    rows.push({
      model,
      qty: counts[model]!,
      status: match?.status ?? 'unmatched',
      availability,
      asin: match?.asin ?? null,
      grade: match?.grade ?? null,
      price: price?.price ?? null,
      priceSeenAt: price?.seenAt ?? null,
      image: listing?.image ?? null,
      title: listing?.title ?? null,
    });
  }
  return rows;
}

/** A part not looked up yet: it has no listing because nobody has looked, not because there is none. */
export const notLookedUp = (p: PartRow): boolean => p.status === 'waiting' || p.status === 'unmatched';

// A bundle with no parts is never confirmed, and neither is one without its own price. A priced
// bundle with a part not looked up yet waits for that lookup, before any listing says inactive or missing.
function sectionOf(parts: PartRow[], bundlePrice: number | null): ReportSection {
  if (parts.length === 0) return 'split';
  if (bundlePrice !== null && parts.some(notLookedUp)) return 'waiting';
  if (parts.some((p) => p.availability === 'missing')) return 'missing_listing';
  if (parts.some((p) => p.availability === 'inactive')) return 'inactive_listing';
  return bundlePrice === null ? 'inactive_listing' : 'confirmed';
}

// ---------------------------------------------------------------- ways to sell (step 6)

/**
 * The component key of a kit item with no model number. It is never looked up, so no listing
 * covers it, and the '~' keeps it apart from every model (a model starts with a letter).
 */
const UNNAMED = '~';

/** An option with what the row takes from it when it is the primary. */
interface Evaluated {
  option: SaleOption;
  status: BundleStatus;
  section: ReportSection;
  uncovered: string[];
}

/** "A", "A and B", "A, B and C". */
const listOf = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`);

/** The option's label, in the plan's exact words; '' when the bundle holds no kit with known contents. */
function labelOf(kits: string[], split: string[]): string {
  const whole = kits.filter((k) => !split.includes(k));
  const words: string[] = [];
  if (split.length > 0) words.push(`${listOf(split)} split into ${split.length === 1 ? 'its' : 'their'} parts`);
  if (whole.length > 0) words.push(`${listOf(whole)} sold whole`);
  return words.join(', ');
}

/** The kits split in each option, whole first: every choice for one or two kits, all whole and all split for more. */
function splitChoices(kits: string[]): string[][] {
  if (kits.length === 2) return [[], [kits[0]!], [kits[1]!], [...kits]];
  return kits.length === 0 ? [[]] : [[], [...kits]];
}

const shown = (name: string, qty: number): string => (qty > 1 ? `${name} ×${qty}` : name);

/**
 * One way to sell: the bundle's parts, with each kit in `split` replaced by its items. A model item
 * joins the part of the same model (its quantity adds); an item with no model number is a component
 * of its own, which the estimate values at the liquidation rate, as any part with no listing.
 */
async function optionOf(
  store: ScanStore, settings: ScanSettings, b: BundleRecord, counts: Record<string, number>, kits: Map<string, KitItem[]>, split: string[],
): Promise<Evaluated> {
  const components: Record<string, number> = {};
  // Component key of each item with no model number -> the page's own text, in page order.
  const unnamed = new Map<string, string>();
  const add = (key: string, qty: number) => {
    components[key] = (Object.hasOwn(components, key) ? components[key]! : 0) + qty;
  };
  for (const [model, qty] of Object.entries(counts)) {
    if (!split.includes(model)) {
      add(model, qty);
      continue;
    }
    for (const item of kits.get(model)!) {
      if (item.model !== null) {
        add(item.model, item.qty * qty);
      } else {
        const key = UNNAMED + item.name;
        unnamed.set(key, item.name);
        add(key, item.qty * qty);
      }
    }
  }
  const models = Object.fromEntries(Object.entries(components).filter(([k]) => !k.startsWith(UNNAMED)));
  const parts = await partRows(store, b.brand, models);
  const priced: PricedListing[] = [];
  for (const p of parts) {
    if (p.availability === 'active' && p.asin !== null && p.price !== null) {
      priced.push({ asin: p.asin, covers: { [p.model]: 1 }, price: p.price });
    }
  }
  // Without a bundle price the plan is still what is left unsold; only the estimate needs the price.
  const evaluation = evaluateBundle(b.price ?? 0, components, priced, settings.fees, settings.liquidationRate);
  const left = new Map<string, number>();
  for (const k of evaluation.plan.liquidated) left.set(k, (left.get(k) ?? 0) + 1);
  const leftUnnamed = [...unnamed].filter(([k]) => left.has(k));
  // A part not looked up yet is not known to be left: only the lookup says it has no listing.
  const leftovers = [
    ...parts.filter((p) => !notLookedUp(p) && left.has(p.model)).map((p) => shown(p.model, left.get(p.model)!)),
    ...leftUnnamed.map(([k, name]) => shown(name, left.get(k)!)),
  ];
  // A part not looked up yet has no price, which is not the same as a price of zero: no estimate until it is.
  // A part that was looked up and has no listing ("none") still counts at the liquidation rate, as the owner set.
  const estimate = b.price === null || parts.some(notLookedUp) ? null : evaluation.result;
  const uncovered = b.price === null
    ? [...parts.map((p) => p.model), ...unnamed.values()]
    : [...evaluation.uncovered.filter((k) => !k.startsWith(UNNAMED)), ...leftUnnamed.map(([, name]) => name)];
  return {
    option: {
      id: split.length === 0 ? 'whole' : `split:${[...split].sort().join('+')}`,
      label: labelOf([...kits.keys()], split),
      splitKits: [...split],
      parts,
      estimate,
      leftovers,
      loose: split.length > 0,
    },
    status: b.price !== null && evaluation.uncovered.length === 0 ? 'complete' : 'partial',
    // Items from a split kit that are left unsold are a missing listing, whatever the models' listings say.
    section: split.length > 0 && leftovers.length > 0 ? 'missing_listing' : sectionOf(parts, b.price),
    uncovered,
  };
}

/**
 * The primary option: among those with an estimate, the ones that leave nothing if any, and of
 * them the highest profit; without any estimate, whole. A tie goes to the earlier option, and
 * whole is first.
 */
function primaryOf(options: Evaluated[]): number {
  const priced = options.flatMap((o, i) => (o.option.estimate ? [i] : []));
  if (priced.length === 0) return 0;
  const clean = priced.filter((i) => options[i]!.option.leftovers.length === 0);
  const profit = (i: number) => options[i]!.option.estimate!.profit;
  return (clean.length > 0 ? clean : priced).reduce((best, i) => (profit(i) > profit(best) ? i : best));
}

/**
 * `recordsOf`: the stored records of one kit's brand and model (kitIndex over kitRecords: bundle
 * records and catalog entries marked a kit), built once per report.
 */
async function bundleRow(
  store: ScanStore, settings: ScanSettings, b: BundleRecord, recordsOf: (brand: string, model: string) => KitRecord[],
): Promise<BundleRow> {
  const base = {
    key: b.key, itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, link: b.link,
    price: b.price, regularPrice: b.regularPrice, percentOff: b.percentOff, seenAt: b.seenAt,
    // The split question's id is the runner's: `split:` and the bundle key.
    answer: ownerAnswer(await store.getReview(`split:${b.key}`), b.split ?? null),
  };
  const split = b.split;
  if (!split || split.status !== 'resolved') {
    return { ...base, status: 'needs_review', section: 'split', parts: [], estimate: null, uncovered: [], options: [], kitsNotRead: [] };
  }
  const counts = componentCounts(split.components);
  // The kits whose own stored page lists their items, in part order. Contents come only from that page.
  const kits = new Map<string, KitItem[]>();
  const kitsNotRead: string[] = [];
  for (const model of Object.keys(counts)) {
    const records = recordsOf(b.brand, model);
    // A list that names the kit itself is not a list of what is inside it: the kit is not split (splitItems).
    const items = splitItems(records, b.brand, model);
    if (items) {
      kits.set(model, items);
    } else if (
      // Not read: no stored record of the kit has its page, and a record of it is stored with no page,
      // a bundle record (Ruling 66) or a catalog entry marked a kit (step 6: one with no item id waits
      // for a listing row to show it again).
      !kitPageStored(records, b.brand, model) && kitPageUnread(records, b.brand, model)
    ) {
      kitsNotRead.push(model);
    }
  }
  const evaluated: Evaluated[] = [];
  for (const choice of splitChoices([...kits.keys()])) evaluated.push(await optionOf(store, settings, b, counts, kits, choice));
  const p = primaryOf(evaluated);
  const primary = evaluated[p]!;
  return {
    ...base,
    status: primary.status,
    section: primary.section,
    parts: primary.option.parts,
    estimate: primary.option.estimate,
    uncovered: primary.uncovered,
    options: [primary, ...evaluated.filter((_, i) => i !== p)].map((e) => e.option),
    kitsNotRead,
  };
}

/** One bundle's row, exactly as buildReport builds it. A product page the owner has open shows it (pageView.ts). Reads only. */
export async function reportRow(store: ScanStore, settings: ScanSettings, b: BundleRecord): Promise<BundleRow> {
  return bundleRow(store, settings, b, kitIndex(kitRecords(await store.listBundles(), await store.listCatalog())));
}

export async function buildReport(store: ScanStore, settings: ScanSettings): Promise<ScanReport> {
  const bundles: BundleRow[] = [];
  // The parts some bundle's split holds now, as the lookups see them (resolved splits only, bundleParts):
  // with the items of every kit a bundle's options split, whatever the kit's own listing, as those
  // items' parts are shown in that option.
  const held = new Set<string>();
  const stored = await store.listBundles();
  const recordsOf = kitIndex(kitRecords(stored, await store.listCatalog()));
  for (const b of stored) {
    bundles.push(await bundleRow(store, settings, b, recordsOf));
    for (const part of [...resolvedParts(b), ...kitItemParts(b, recordsOf)]) held.add(part.key);
  }
  bundles.sort((a, b) => {
    if (a.section !== b.section) return SECTION_RANK[a.section] - SECTION_RANK[b.section];
    const pa = a.estimate?.profit ?? -Infinity;
    const pb = b.estimate?.profit ?? -Infinity;
    if (pa !== pb) return pb > pa ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const review = (await store.listReview())
    .filter((r) => r.answer === null)
    // A match question whose part no bundle holds now (the owner changed a split) is left out, not
    // closed: it is asked again if the part comes back.
    // A twin held counts (Ruling 70, fix round 1): PCL430's question stands for PCL430B, which takes its result.
    .filter((r) => r.kind !== 'match' || held.has(r.subject) || twinKeysOf(r.subject).some((k) => held.has(k)))
    // An item saved before step 5 has no choices stored.
    .map((r) => ({ ...r, choices: choicesOf(r) }))
    .sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { bundles, review };
}
