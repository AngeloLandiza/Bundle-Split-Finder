// Turn what a scan left in the store into ranked rows. Reads only; never searches.
// Profit figures are estimates from fee settings, not the seller's real fees.

import { type KitItem, kitIndex, kitItemParts, kitPageStored, kitPageUnread, type KitRecord, kitRecords, splitItems } from '../kitContents';
import { isBulkPackaging } from '../match';
import { priceForNet, type BundleResult } from '../money';
import { evaluateBundle, type PricedListing } from '../scanPlan';
import { choicesOf, ownerAnswer } from './answers';
import { kitCatalog, kitPageTarget } from './kitPage';
import { ebayPriceOption } from '../ebay/value';
import { componentCounts } from './classify';
import { twinKeys, twinKeysOf } from './twins';
import {
  type BundleRecord,
  type BundleRow,
  type CatalogRecord,
  type BundleStatus,
  type ConfirmedPrice,
  type IncompleteEstimate,
  type EbayQuestion,
  type EbayValueRecord,
  effectiveVerdict,
  type ListingRecord,
  type MatchRecord,
  type VerifiedBy,
  type PartAvailability,
  type PartPriceRecord,
  type PartRow,
  type PriceKind,
  type PriceOption,
  type PriceRange,
  type PriceRecord,
  type ReportSection,
  partKey,
  priceActive,
  resolvedParts,
  type SaleOption,
  type UnnamedItem,
  type UnpricedState,
  type ScanReport,
  type ScanSettings,
  type ScanStore,
} from './types';

const SECTION_RANK: Record<ReportSection, number> = { confirmed: 0, waiting: 1, inactive_listing: 2, missing_listing: 3, split: 4 };

/**
 * The reference figures kept apart from splitting, read once per report and never from the catalog: a part's
 * stored Home Depot price (step 9: its own part price record with a price, else a twin's, Ruling 70), and its
 * eBay value (step 10: its own record with a value, else a twin's).
 */
interface RefsOf {
  hd(brand: string, model: string): PartPriceRecord | undefined;
  ebay(brand: string, model: string): EbayValueRecord | undefined;
  /** The owner's confirmed price for this part only. A twin's price is a different product. */
  confirmed(brand: string, model: string): ConfirmedPrice | undefined;
}

async function refsOf(store: ScanStore): Promise<RefsOf> {
  const hdByKey = new Map((await store.listPartPrices()).filter((r) => r.price !== null).map((r) => [r.key, r] as const));
  const ebayByKey = new Map((await store.listEbayValues()).filter((r) => r.value !== null).map((r) => [r.key, r] as const));
  const confirmedByKey = new Map((await store.listConfirmedPrices()).map((r) => [r.key, r] as const));
  const first = <T>(by: Map<string, T>, brand: string, model: string): T | undefined => {
    for (const key of [partKey(brand, model), ...twinKeys(brand, model)]) {
      const found = by.get(key);
      if (found) return found;
    }
    return undefined;
  };
  return {
    hd: (brand, model) => first(hdByKey, brand, model),
    ebay: (brand, model) => first(ebayByKey, brand, model),
    confirmed: (brand, model) => confirmedByKey.get(partKey(brand, model)),
  };
}

/** Ties among equal prices go in this order. */
const KIND_ORDER: Record<PriceKind, number> = { amazon_new: 0, amazon_buybox: 1, confirmed: 2, ebay_sold_new: 3, amazon_list: 4, homedepot: 5 };

/**
 * Step 9: every price known for a part, each labelled, highest first. Amazon's only for the part's
 * matched listing: its featured price while active (the estimate's price), the Buy Box a Verify read and
 * its list price; then Home Depot's price for the part sold alone. A listing in review is not the part's,
 * so it gives none. The list price and Home Depot's are for reference: never counted (`reference`). So is a
 * Buy Box older than the featured price a later search row saw: it is counted only while no older than it.
 * Home Depot's price read from the RYOBI twin's page says so (`soldAs`).
 */
function priceOptions(
  settings: ScanSettings, model: string, matched: boolean, asin: string | null, active: boolean, price: PriceRecord | undefined, listing: ListingRecord | undefined,
  hd: PartPriceRecord | undefined, ebay: EbayValueRecord | undefined, confirmed: ConfirmedPrice | undefined,
): PriceOption[] {
  const out: PriceOption[] = [];
  const base = { condition: 'new' as const, seller: null, shipsFrom: null, offers: null };
  if (matched && asin !== null) {
    const link = `https://www.${settings.amazonDomain}/dp/${encodeURIComponent(asin)}`;
    if (active && price?.price != null && price.seenAt !== null) {
      out.push({ ...base, kind: 'amazon_new', price: price.price, asin, link, seenAt: price.seenAt, reference: false });
    }
    const box = listing?.buyBox;
    if (box) {
      // Fix round (Nov 18): as current as the featured price, or not counted. No clock: the report reads only the store.
      const current = price?.seenAt == null || box.seenAt >= price.seenAt;
      out.push({
        ...base, kind: 'amazon_buybox', price: box.price, seller: box.soldBy, shipsFrom: box.shipsFrom, asin, link, seenAt: box.seenAt, reference: !current,
        ...(box.singleOffer ? { singleOffer: true as const } : {}),
      });
    }
    if (typeof listing?.listPrice === 'number') {
      out.push({ ...base, kind: 'amazon_list', price: listing.listPrice, asin, link, seenAt: listing.checkedAt, reference: true });
    }
  }
  // Counted while no Amazon New price is. Once one is, the owner's figure stays, as a reference, with its link.
  if (confirmed) {
    const amazonCounts = active && price?.price != null && price.seenAt !== null;
    out.push({ ...base, kind: 'confirmed', price: confirmed.price, asin: null, link: confirmed.link, seenAt: confirmed.confirmedAt, reference: amazonCounts, ...(confirmed.note ? { note: confirmed.note } : {}) });
  }
  if (hd && hd.price !== null && hd.seenAt !== null) {
    const soldAs = hd.matchedModel ?? hd.model;
    out.push({
      ...base, kind: 'homedepot', price: hd.price, seller: 'Home Depot', asin: null, link: hd.link, seenAt: hd.seenAt, reference: true,
      ...(soldAs.toUpperCase() !== model.trim().toUpperCase() ? { soldAs } : {}),
    });
  }
  // Step 10: what New units of the part sell for on eBay: a reference, never counted. Absent, never $0, without a value.
  if (ebay?.value) out.push({ ...ebayPriceOption(ebay.value, ebay.checkedAt), ebay: ebay.value });
  return out.sort((a, b) => b.price - a.price || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/**
 * Prices a range counts. An active listing's non-reference prices, and a confirmed price that is still
 * counting (it is marked reference once an Amazon New price exists). An inactive listing's Buy Box does not count.
 */
const countedPrices = (p: PartRow): number[] =>
  p.prices.filter((o) => !o.reference && (p.availability === 'active' || o.kind === 'confirmed')).map((o) => o.price);

/** The one price the estimate uses for a part: its Amazon New price, or the confirmed price while it has none. */
function listingFor(p: PartRow): PricedListing | null {
  if (p.availability === 'active' && p.asin !== null) {
    const featured = p.prices.find((o) => o.kind === 'amazon_new' && !o.reference);
    if (featured) return { asin: p.asin, covers: { [p.model]: 1 }, price: featured.price };
  }
  const confirmed = p.prices.find((o) => o.kind === 'confirmed' && !o.reference);
  return confirmed ? { asin: `confirmed:${p.model}`, covers: { [p.model]: 1 }, price: confirmed.price } : null;
}

async function partRows(store: ScanStore, settings: ScanSettings, refs: RefsOf, brand: string, counts: Record<string, number>): Promise<PartRow[]> {
  const rows: PartRow[] = [];
  for (const model of Object.keys(counts)) {
    const match = await store.getMatch(partKey(brand, model));
    const price = match?.asin ? await store.getPrice(match.asin) : undefined;
    const listing = match?.asin ? await store.getListing(match.asin) : undefined;
    let availability: PartAvailability = 'missing';
    const matched = match?.status === 'matched' && match.asin !== null;
    if (matched) {
      availability = priceActive(price) ? 'active' : 'inactive';
    }
    const prices = priceOptions(
      settings, model, matched, match?.asin ?? null, availability === 'active', price, listing,
      refs.hd(brand, model), refs.ebay(brand, model), refs.confirmed(brand, model),
    );
    const featured = prices.find((o) => o.kind === 'amazon_new' && !o.reference);
    const confirmedOpt = prices.find((o) => o.kind === 'confirmed' && !o.reference);
    rows.push({
      model,
      qty: counts[model]!,
      status: match?.status ?? 'unmatched',
      availability,
      asin: match?.asin ?? null,
      grade: match?.grade ?? null,
      price: featured?.price ?? confirmedOpt?.price ?? price?.price ?? null,
      priceSeenAt: featured ? featured.seenAt : confirmedOpt ? confirmedOpt.seenAt : (price?.seenAt ?? null),
      image: listing?.image ?? null,
      title: listing?.title ?? null,
      prices,
      // The PO (Nov 18): a New listing in bulk packaging is a place to sell; the panel labels it.
      ...(listing && isBulkPackaging(listing.title) ? { packaging: 'bulk' as const } : {}),
      ...verification(match),
    });
  }
  return rows;
}

/** Catalog check: how the part's listing was verified, and the evidence, as the part row carries them. */
function verification(match: MatchRecord | undefined): Pick<PartRow, 'verifiedBy' | 'verifyEvidence'> {
  if (!match) return {};
  const matched = match.status === 'matched' && match.asin !== null;
  const by: VerifiedBy | undefined = matched && match.decidedBy === 'user' ? 'owner' : matched && match.verifiedBy ? match.verifiedBy : matched && match.grade === 'probable' ? 'title' : undefined;
  return { ...(by ? { verifiedBy: by } : {}), ...(match.verifyEvidence ? { verifyEvidence: match.verifyEvidence } : {}) };
}

/** A part not looked up yet: it has no listing because nobody has looked, not because there is none. */
export const notLookedUp = (p: PartRow): boolean => p.status === 'waiting' || p.status === 'unmatched';

/** Nov 23: why a model part with no counted price has none (UnpricedState). */
export function unpricedState(p: PartRow): UnpricedState {
  if (notLookedUp(p)) return 'waiting';
  if (p.status === 'review') return 'review';
  if (p.status === 'none' || p.availability === 'missing') return 'no_listing';
  return 'inactive';
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Nov 23, the third real scan: what an option with an unpriced model part says instead of an estimate. The priced
 * parts are evaluated as the estimate is (evaluateBundle, the same components and fees) with nothing else valued, so
 * `pricedNet` is what they bring after fees; the gap to the cost is what the unpriced parts must bring together.
 * Never a price for an unpriced part (rule 4): the break-even is what it would have to sell for, labelled as such.
 */
function incompleteOf(
  settings: ScanSettings, bundlePrice: number, components: Record<string, number>, parts: PartRow[], priced: PricedListing[], unpriced: PartRow[],
): IncompleteEstimate {
  const floor = evaluateBundle(bundlePrice, components, priced, settings.fees, 0).result;
  const breakEvenNet = round2(Math.max(0, floor.cost - floor.netRevenue));
  const one = unpriced.length === 1 ? unpriced[0]! : null;
  return {
    priced: parts.length - unpriced.length,
    total: parts.length,
    cost: floor.cost,
    pricedNet: floor.netRevenue,
    breakEvenNet,
    breakEvenPrice: one && breakEvenNet > 0 ? priceForNet(breakEvenNet / one.qty, settings.fees) : null,
    unpriced: unpriced.map((p) => ({ model: p.model, qty: p.qty, state: unpricedState(p) })),
  };
}

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
  store: ScanStore, settings: ScanSettings, refs: RefsOf, b: BundleRecord, counts: Record<string, number>, kits: Map<string, KitItem[]>, split: string[],
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
  const parts = await partRows(store, settings, refs, b.brand, models);
  const priced: PricedListing[] = [];
  for (const p of parts) {
    const listing = listingFor(p);
    if (listing) priced.push(listing);
  }
  // A leftover with no model number is never looked up. A price counts only when the owner confirmed
  // it, one sale per unit, the same way a part's confirmed price does. The median of an eBay range
  // is not a listing and is not added here.
  const extras: PricedListing[] = [];
  const unnamedItems: UnnamedItem[] = [];
  for (const [key, name] of unnamed) {
    const confirmed = refs.confirmed(b.brand, key);
    unnamedItems.push({ model: key, name, qty: components[key] ?? 1, price: confirmed?.price ?? null, link: confirmed?.link ?? null });
    if (confirmed) extras.push({ asin: `confirmed:${key}`, covers: { [key]: 1 }, price: confirmed.price });
  }
  priced.push(...extras);
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
  // Nov 23 (supersedes "counted at zero"): neither is a part in Review, with no listing, or with an inactive listing.
  // An estimate exists only when every model part has a counted price; otherwise the option is incomplete, with what
  // the priced parts bring and the break-even. An item with no model number is not a reason (it is not counted).
  const unpriced = parts.filter((p) => listingFor(p) === null);
  const estimate = b.price === null || unpriced.length > 0 ? null : evaluation.result;
  const incomplete = b.price !== null && unpriced.length > 0 ? incompleteOf(settings, b.price, components, parts, priced, unpriced) : undefined;
  const uncovered = b.price === null
    ? [...parts.map((p) => p.model), ...unnamed.values()]
    : [...evaluation.uncovered.filter((k) => !k.startsWith(UNNAMED)), ...leftUnnamed.map(([, name]) => name)];
  // Every leftover with no model number has a price the owner confirmed. That is not an Amazon listing.
  const ownerFilled = split.length > 0 && unnamed.size > 0 && leftUnnamed.length === 0 && extras.length > 0;
  return {
    option: {
      id: split.length === 0 ? 'whole' : `split:${[...split].sort().join('+')}`,
      label: labelOf([...kits.keys()], split),
      splitKits: [...split],
      parts,
      estimate,
      leftovers,
      loose: split.length > 0,
      unnamed: unnamedItems,
      range: estimate === null ? NO_RANGE : rangeOf(settings, b.price!, components, parts, estimate, extras),
      ...(incomplete ? { incomplete } : {}),
      ...(split.length > 0 ? { kitParts: Object.fromEntries(split.map((k) => [k, kits.get(k)!.length])) } : {}),
    },
    status: b.price !== null && evaluation.uncovered.length === 0 && !ownerFilled ? 'complete' : 'partial',
    // Items from a split kit that are left unsold are a missing listing, whatever the models' listings say.
    // So is a leftover the owner priced: the bundle stays in Missing listing when every model is active.
    // Nov 23: a part not looked up yet comes first here too (sectionOf): the split option waits for its lookups.
    section: b.price !== null && parts.some(notLookedUp) ? 'waiting' : (split.length > 0 && leftovers.length > 0) || ownerFilled ? 'missing_listing' : sectionOf(parts, b.price),
    uncovered,
  };
}

const NO_RANGE: PriceRange = { lowest: null, amazonNew: null, highest: null };

/**
 * Step 9: an option's range, where its estimate exists. Each end is evaluated exactly as the estimate
 * is (evaluateBundle, the same components and fees), with each part at its lowest or highest counted
 * price (countedPrices). The lowest values a part with none at $0; the highest at the liquidation
 * rate, as the estimate does, so lowest <= amazonNew <= highest. amazonNew is the estimate itself.
 * `extras` are confirmed prices for items with no model number: one price, so both ends count it.
 */
function rangeOf(
  settings: ScanSettings, bundlePrice: number, components: Record<string, number>, parts: PartRow[], estimate: BundleResult, extras: PricedListing[],
): PriceRange {
  const at = (end: (prices: number[]) => number, liquidationRate: number): BundleResult => {
    const priced: PricedListing[] = [
      ...parts.flatMap((p) => {
        const prices = countedPrices(p);
        return prices.length > 0 ? [{ asin: p.model, covers: { [p.model]: 1 }, price: end(prices) }] : [];
      }),
      ...extras,
    ];
    return evaluateBundle(bundlePrice, components, priced, settings.fees, liquidationRate).result;
  };
  return { lowest: at((xs) => Math.min(...xs), 0), amazonNew: estimate, highest: at((xs) => Math.max(...xs), settings.liquidationRate) };
}

/**
 * The primary option: among those with an estimate, the ones that leave nothing if any, and of
 * them the highest profit; without any estimate, whole. A tie goes to the earlier option, and
 * whole is first.
 */
function primaryOf(options: Evaluated[]): number {
  const priced = options.flatMap((o, i) => (o.option.estimate ? [i] : []));
  if (priced.length === 0) {
    // Nov 23: no option has an estimate. A kit whose own lookup found no listing for sale (none, or inactive) does not
    // sell whole, so the option that splits exactly those kits is the way to sell once its parts are looked up (they are
    // looked up for it by the same rule, runner.ts itemsWanted). A kit not looked up yet, or in Review (Ruling 69), and a
    // split whose parts still wait, stay whole: the whole option says the kit has no listing for sale.
    const whole = options.find((o) => o.option.id === 'whole');
    const dead = (whole?.option.incomplete?.unpriced ?? []).filter((u) => u.state === 'no_listing' || u.state === 'inactive').map((u) => u.model);
    const kits = options.flatMap((o) => o.option.splitKits).filter((k) => dead.includes(k));
    const want = [...new Set(kits)].sort().join('+');
    const i = want ? options.findIndex((o) => [...o.option.splitKits].sort().join('+') === want && !o.option.parts.some(notLookedUp)) : -1;
    return i >= 0 ? i : 0;
  }
  const clean = priced.filter((i) => options[i]!.option.leftovers.length === 0);
  const profit = (i: number) => options[i]!.option.estimate!.profit;
  return (clean.length > 0 ? clean : priced).reduce((best, i) => (profit(i) > profit(best) ? i : best));
}

/**
 * `recordsOf`: the stored records of one kit's brand and model (kitIndex over kitRecords: bundle
 * records and catalog entries marked a kit), built once per report; `refs` (steps 9 and 10) too.
 */
async function bundleRow(
  store: ScanStore, settings: ScanSettings, b: BundleRecord, recordsOf: (brand: string, model: string) => KitRecord[], refs: RefsOf,
  bundles: BundleRecord[], catalog: CatalogRecord[],
): Promise<BundleRow> {
  // The split question's id is the runner's: `split:` and the bundle key.
  const question = await store.getReview(`split:${b.key}`);
  const base = {
    key: b.key, itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, link: b.link,
    price: b.price, regularPrice: b.regularPrice, percentOff: b.percentOff, seenAt: b.seenAt,
    answer: ownerAnswer(question, b.split ?? null),
  };
  const split = b.split;
  if (!split || split.status !== 'resolved') {
    // Nov 23: not split, its own page not read, and no question open nor answered for it: it waits for its page.
    const pageRead = b.page !== undefined && b.page !== null;
    const waitingPage = !pageRead && base.answer === null && !(question && question.answer === null);
    // Step 15: read, its split waits for Home Depot's part pages (scan/settle.ts rule 2), and no question open nor answered.
    const waitingParts = !waitingPage && pageRead && (split?.waitingFor ?? []).length > 0 && base.answer === null && !(question && question.answer === null);
    return {
      ...base, status: 'needs_review', section: 'split', parts: [], estimate: null, uncovered: [], options: [], kitsNotRead: [], kitReads: [], range: NO_RANGE,
      ...(waitingPage ? { waitingPage: true } : {}),
      ...(waitingParts ? { waitingParts: true } : {}),
    };
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
  for (const choice of splitChoices([...kits.keys()])) evaluated.push(await optionOf(store, settings, refs, b, counts, kits, choice));
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
    kitReads: kitsNotRead.flatMap((model) => {
      const target = kitPageTarget(bundles, catalog, b.brand, model);
      return target.kind === 'page' ? [{ model, itemId: target.itemId }] : [];
    }),
    range: primary.option.range,
    ...(primary.option.incomplete ? { incomplete: primary.option.incomplete } : {}),
    // Step 15: what settled the split, when a settle rule did (the BOGO pair, Home Depot's page of each part).
    ...(split.evidence && split.evidence.length > 0 ? { splitEvidence: split.evidence } : {}),
  };
}

/**
 * Part rows for models no bundle's split holds, as the report builds a bundle's parts (a BOGO's free items,
 * core/src/tracking/bogo.ts): the stored match, listing and every labelled price. Reads only.
 */
export async function partRowsFor(store: ScanStore, settings: ScanSettings, parts: { brand: string; model: string; qty: number }[]): Promise<PartRow[]> {
  const refs = await refsOf(store);
  const out: PartRow[] = [];
  for (const p of parts) out.push(...(await partRows(store, settings, refs, p.brand, { [p.model]: p.qty })));
  return out;
}

/** One bundle's row, exactly as buildReport builds it. A product page the owner has open shows it (pageView.ts). Reads only. */
export async function reportRow(store: ScanStore, settings: ScanSettings, b: BundleRecord): Promise<BundleRow> {
  const stored = await store.listBundles();
  // Nov 23: with the kits Home Depot's part pages name (partPriceKits), so a kit no listing page showed is "not read".
  const catalog = await kitCatalog(store);
  return bundleRow(store, settings, b, kitIndex(kitRecords(stored, catalog)), await refsOf(store), stored, catalog);
}

export async function buildReport(store: ScanStore, settings: ScanSettings): Promise<ScanReport> {
  const bundles: BundleRow[] = [];
  // The parts some bundle's split holds now, as the lookups see them (resolved splits only, bundleParts):
  // with the items of every kit a bundle's options split, whatever the kit's own listing, as those
  // items' parts are shown in that option.
  const held = new Set<string>();
  const stored = await store.listBundles();
  // Nov 23: with the kits Home Depot's part pages name (partPriceKits), so a kit no listing page showed is "not read".
  const catalog = await kitCatalog(store);
  const recordsOf = kitIndex(kitRecords(stored, catalog));
  const refs = await refsOf(store);
  for (const b of stored) {
    bundles.push(await bundleRow(store, settings, b, recordsOf, refs, stored, catalog));
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
  return { bundles, review, ebayQuestions: await ebayQuestions(store, held) };
}

/**
 * Step 10: the eBay listings the judge left unsure that could count, for the parts some bundle holds now (a
 * twin held counts), oldest check first. A listing counts only with a USD price and units sold, as ebayValue
 * counts it: asking about one that could not count would only tire the owner. An answered listing is not asked again.
 */
async function ebayQuestions(store: ScanStore, held: Set<string>): Promise<EbayQuestion[]> {
  const out: EbayQuestion[] = [];
  for (const r of await store.listEbayValues()) {
    if (!held.has(r.key) && !twinKeysOf(r.key).some((k) => held.has(k))) continue;
    for (const l of r.listings) {
      if (effectiveVerdict(l) !== 'unsure') continue;
      if (l.currency !== 'USD' || l.price === null || !(l.price > 0) || !((l.soldQuantity ?? 0) > 0)) continue;
      out.push({
        id: `${r.key}|${l.itemId}`, key: r.key, brand: r.brand, model: r.model, itemId: l.itemId, title: l.title, url: l.url,
        price: l.price, soldQuantity: l.soldQuantity, reasons: [...l.reasons], openedAt: r.checkedAt,
      });
    }
  }
  return out.sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
