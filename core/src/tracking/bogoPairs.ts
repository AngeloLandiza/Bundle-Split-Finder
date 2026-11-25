// BOGO deals found by themselves (Nov 23; the PO: "the background agent finds deals and messages me"; the owner: "if
// anything can be automated somehow, do it"). What the recording shows (fixtures/homedepot-pages/bogo-2026-11-23.json,
// read in the owner's Chrome):
//
// - Each brand's Featured BOGO listing (/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-<query>?NCNI-5, &Nao=<n> for
//   later pages) lists the promotion's starters and, as items of their own, every starter + free tool pair.
// - A starter's page carries the promotion (hdPage.ts bogoPromotionsOf): its id, end date and short description. The
//   free tools it may be paired with are not on the page (`omsSkus` null).
// - A pair is listed at exactly the starter's price: RYOBI PCL1201K2-PCL515B $179 (was $268) = PCL1201K2 $179; DEWALT
//   DCK200D1P1W921B $299 (was $538) = DCK200D1P1 $299. RYOBI joins the two models with "-", DEWALT with "W".
//
// So a pair is an item of the same listing whose model is <starter model><joiner><free model> for one starter seen in
// that listing, and whose price equals the starter's to the cent. Anything else stays a normal bundle with no BOGO claim
// (CLAUDE.md rule 4). The free model is the text after the joiner as Home Depot writes it ("921B", "B606", "PCL515B"),
// never a model worked out from it; what the free item is comes from the pair's own page, through the normal split.
// A pair is a bundle like any other: its page, its split, its Amazon matches and its estimate (rule 5) are the
// pipeline's. Pairs are grouped by starter and ranked by that estimate.

import type { BuyingFacts, PagePromotion, PromoPage } from '../hdPage';
import { withBuying } from '../scan/buying';
import { dayOf } from './state';
import { estimateRoiPercent, type AlertSettings } from '../settings';
import type { Cache } from '../serpapi/client';
import { bundleKey, type BundleBogo, type BundleRecord, type BundleRow, type ReportSection } from '../scan/types';

export const HOME_DEPOT = 'https://www.homedepot.com';
const LISTING_PREFIX = '/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-';
/** The only addresses the BOGO listing job may read: the recorded listing, a query, and an offset. */
const LISTING_PATH = /^\/b\/Featured-BOGO\/N-5yc1vZ1z24hvk\/Ntk-elasticplus\/Ntt-[A-Za-z0-9%._~-]{1,120}\?NCNI-5(&Nao=\d{1,4})?$/;

/** How each brand writes a pair's model: the starter's model, this, then the free item's. */
export const BOGO_JOINERS: Readonly<Record<string, string>> = { RYOBI: '-', DEWALT: 'W' };

/** Listing pages read per brand and scan, at most (the recording: 102 RYOBI and 111 DEWALT items, 12 a page). */
export const BOGO_LISTING_PAGES_MAX = 15;
/** Item pages asked for in one worker job. */
export const BOGO_PAGE_BATCH = 25;
/** Item pages read per scan, at most, across brands. A page read today is not read again today. */
export const BOGO_ITEM_PAGES_MAX = 300;

/**
 * The listing's address for a search query (settings.ts BRAND_QUERIES, the same queries the recording used: "ryobi 18v
 * combo kit" is Ntt-ryobi%2B18v%2Bcombo%2Bkit) and an offset; offset 0 has no Nao.
 */
export function bogoListingPath(query: string, offset: number): string {
  const ntt = encodeURIComponent(query.trim().toLowerCase().split(/\s+/).join('+'));
  return `${LISTING_PREFIX}${ntt}?NCNI-5${offset > 0 ? `&Nao=${Math.floor(offset)}` : ''}`;
}

export const isBogoListingPath = (path: unknown): path is string => typeof path === 'string' && LISTING_PATH.test(path);

/** One product of a listing page (hdPage.ts SearchProduct). */
export interface ListedItem {
  itemId: string;
  brand: string;
  model: string;
  title: string;
  url: string;
  /** The listing entry's own pricing, when it carries one (hdPage.ts SearchProduct); absent otherwise. */
  price?: number | null;
  wasPrice?: number | null;
  promotions?: PagePromotion[];
  /**
   * Free scan, fix round 3: a Home Depot set (hdPage.ts ListingProduct: productType CONFIGURABLE_BUNDLE or bundleFlag, with
   * its bundleItems). Its `model` is '' (the entry has none); its items are Home Depot's own list of what it holds.
   */
  set?: ListedSet;
}

/** A set's own data from its listing entry. */
export interface ListedSet {
  items: { itemId: string; quantity: number }[];
  /** The listing's promotion.dollarOff and percentageOff, when it gives them. */
  dollarOff: number | null;
  percentageOff: number | null;
}

/** One item page as the BOGO pass read it: the product page and its BOGO promotions. */
export interface BogoItem {
  itemId: string;
  brand: string;
  model: string;
  title: string;
  price: number | null;
  wasPrice: number | null;
  link: string;
  promotions: PagePromotion[];
  bullets: string[];
  description: string | null;
  readAt: number;
  /** Nov 25: the barcode the item's page states (hdPage.ts barcodeOf); absent when none. */
  upc?: string;
  /** Nov 25: what the item's page states about buying it (hdPage.ts buyingOf); absent when none. */
  buying?: BuyingFacts;
}

/** What a pair carries on its deal (the contract's `bogo` tag). */
export interface BogoTag {
  promotionId: string;
  starterItemId: string;
  starterModel: string;
  /** After the joiner, as Home Depot writes it: "PCL515B", "921B". Never a model worked out from it. */
  freeModel: string;
  /** The promotion's end date, YYYY-MM-DD; null when the page gave none. */
  endsAt: string | null;
  description: string | null;
}

/** A starter + free item pair: the item Home Depot lists, at the starter's price. */
export interface BogoPair extends BogoTag {
  /** The pair's bundle key. */
  key: string;
  itemId: string;
  brand: string;
  model: string;
  title: string;
  price: number;
  wasPrice: number | null;
  link: string;
}

const cents = (n: number): number => Math.round(n * 100);
const FREE_PART = /^[A-Z0-9][A-Z0-9-]{0,39}$/;

/**
 * The pairs among one listing's items. A starter is an item with exactly one BOGO promotion and a price. A pair is an
 * item with no promotion of its own, of the same brand, whose model is `<starter><joiner><free>` for exactly one starter, priced as that starter to
 * the cent. An item two starters could both explain, a brand with no known joiner, a price that differs by a cent or
 * an item with no price is no pair.
 */
export function findBogoPairs(items: readonly BogoItem[]): BogoPair[] {
  const up = (s: string) => s.trim().toUpperCase();
  const starters = items.filter((i) => i.promotions.length === 1 && i.price !== null);
  const out: BogoPair[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const brand = up(item.brand);
    const joiner = BOGO_JOINERS[brand];
    // An item that carries a promotion itself is a starter, never a pair.
    if (joiner === undefined || item.price === null || item.promotions.length > 0 || seen.has(item.itemId)) continue;
    const model = up(item.model);
    const fits = starters.filter((s) => {
      if (s.itemId === item.itemId || up(s.brand) !== brand) return false;
      const head = up(s.model) + joiner;
      return model.startsWith(head) && FREE_PART.test(model.slice(head.length));
    });
    if (fits.length !== 1) continue;
    const s = fits[0]!;
    if (cents(item.price) !== cents(s.price!)) continue;
    const promo = s.promotions[0]!;
    seen.add(item.itemId);
    out.push({
      key: bundleKey(item.itemId), itemId: item.itemId, brand, model, title: item.title, price: item.price, wasPrice: item.wasPrice, link: item.link,
      promotionId: promo.promotionId, starterItemId: s.itemId, starterModel: up(s.model), freeModel: model.slice(up(s.model).length + joiner.length),
      endsAt: promo.endsAt, description: promo.description,
    });
  }
  return out;
}

export const bogoTagOf = (p: BogoPair): BogoTag => ({
  promotionId: p.promotionId, starterItemId: p.starterItemId, starterModel: p.starterModel, freeModel: p.freeModel, endsAt: p.endsAt, description: p.description,
});

// ---------------------------------------------------------------- the pass: listing pages, then item pages

/** One item page's outcome, as the worker answers a promoPage job (core/src/api/contract.ts). */
export type PromoPageOutcome =
  | { itemId: string; kind: 'read'; page: PromoPage }
  | { itemId: string; kind: 'skipped' }
  | { itemId: string; kind: 'unreadable'; note?: string }
  | { itemId: string; kind: 'refused'; status?: number; note?: string };

export interface BogoPassDeps {
  /** Brands in Settings; only those with a joiner and a query are read. */
  brands: readonly string[];
  /** Brand -> the scan's search query (settings.ts BRAND_QUERIES). */
  queries: Readonly<Record<string, string>>;
  /** One listing page's products, in page order. Throws when Chrome could not read it or Home Depot refused. */
  readListing: (path: string) => Promise<ListedItem[]>;
  /** Item pages, one outcome per id. Throws as readListing. */
  readPages: (itemIds: string[]) => Promise<PromoPageOutcome[]>;
  cache: Cache;
  now: () => number;
  shouldStop?: () => boolean;
}

export interface BogoBrandResult {
  brand: string;
  /** Every listing page and item page was read: the pairs found are all there are. */
  complete: boolean;
  listingPages: number;
  listed: number;
  /** Item pages read now (not from today's cache). */
  pagesRead: number;
  items: BogoItem[];
  pairs: BogoPair[];
  problem: string | null;
}

/** The item cache key, shared with the Bundle listing pass (scan/listingSource.ts): a page either pass read is reused. */
export const itemCacheKey = (itemId: string): string => `homedepot:bogo-item:${itemId}`;

export function itemOf(page: PromoPage, listed: ListedItem | undefined, at: number): BogoItem {
  return {
    itemId: page.itemId, brand: page.brand, model: page.model, title: page.title || listed?.title || '', price: page.price, wasPrice: page.wasPrice,
    link: listed?.url && listed.url.startsWith(`${HOME_DEPOT}/p/`) ? listed.url : `${HOME_DEPOT}/p/${page.itemId}`,
    promotions: page.promotions, bullets: page.bullets, description: page.description, readAt: at,
    ...(page.upc ? { upc: page.upc } : {}),
    ...(page.buying ? { buying: page.buying } : {}),
  };
}

/** A cached BogoItem read today; anything else (another day, a shape that is not one) is read again. */
function cachedToday(data: unknown, at: number, now: number): BogoItem | null {
  if (dayOf(at) !== dayOf(now) || !data || typeof data !== 'object') return null;
  const i = data as BogoItem;
  return typeof i.itemId === 'string' && typeof i.model === 'string' && Array.isArray(i.promotions) && Array.isArray(i.bullets) ? i : null;
}

/**
 * Each brand's whole listing (pages until one brings no new item id, at most BOGO_LISTING_PAGES_MAX; the next offset
 * is the items read so far, so a page size other than the recorded one still covers every item), then each item's
 * page, from today's cache when it was read today. A read that fails ends the pass: what came before is kept, the
 * brand is marked incomplete, and later brands are not read.
 */
export async function readBogoPass(deps: BogoPassDeps): Promise<BogoBrandResult[]> {
  const out: BogoBrandResult[] = [];
  let failed: string | null = null;
  let budget = BOGO_ITEM_PAGES_MAX;
  const stop = () => deps.shouldStop?.() === true;
  for (const raw of deps.brands) {
    const brand = raw.trim().toUpperCase();
    const query = deps.queries[brand];
    if (BOGO_JOINERS[brand] === undefined || query === undefined) continue;
    const r: BogoBrandResult = { brand, complete: false, listingPages: 0, listed: 0, pagesRead: 0, items: [], pairs: [], problem: null };
    out.push(r);
    if (failed !== null || stop()) {
      r.problem = failed ?? 'stopped';
      continue;
    }
    const listed = new Map<string, ListedItem>();
    let listingDone = false;
    try {
      while (r.listingPages < BOGO_LISTING_PAGES_MAX && !stop()) {
        const products = await deps.readListing(bogoListingPath(query, listed.size));
        r.listingPages += 1;
        const fresh = products.filter((p) => /^\d{6,12}$/.test(p.itemId) && !listed.has(p.itemId));
        for (const p of fresh) listed.set(p.itemId, p);
        if (fresh.length === 0) {
          listingDone = true;
          break;
        }
      }
    } catch (e) {
      failed = e instanceof Error && e.message ? e.message : 'Chrome could not read the BOGO listing.';
    }
    r.listed = listed.size;
    const items: BogoItem[] = [];
    const toRead: string[] = [];
    for (const id of listed.keys()) {
      const hit = await deps.cache.get(itemCacheKey(id));
      const item = hit ? cachedToday(hit.data, hit.at, deps.now()) : null;
      if (item) items.push(item);
      else toRead.push(id);
    }
    let pagesDone = toRead.length === 0;
    if (failed === null && toRead.length > 0) {
      const ids = toRead.slice(0, budget);
      try {
        let refused = false;
        for (let i = 0; i < ids.length && !refused && !stop(); i += BOGO_PAGE_BATCH) {
          const batch = ids.slice(i, i + BOGO_PAGE_BATCH);
          const outcomes = await deps.readPages(batch);
          const at = deps.now();
          for (const o of outcomes) {
            if (!batch.includes(o.itemId)) continue;
            if (o.kind === 'read' && o.page.itemId === o.itemId) {
              const item = itemOf(o.page, listed.get(o.itemId), at);
              items.push(item);
              r.pagesRead += 1;
              await deps.cache.set(itemCacheKey(o.itemId), { at, data: item });
            } else if (o.kind === 'refused') {
              refused = true;
            }
          }
          budget -= batch.length;
        }
        if (refused) failed = 'Home Depot refused a BOGO item page.';
        pagesDone = !refused && ids.length === toRead.length && !stop();
      } catch (e) {
        failed = e instanceof Error && e.message ? e.message : 'Chrome could not read the BOGO item pages.';
      }
    }
    r.items = items;
    r.pairs = findBogoPairs(items);
    r.complete = listingDone && pagesDone && failed === null;
    if (!r.complete) r.problem = failed ?? (stop() ? 'stopped' : 'not every page was read');
  }
  return out;
}

/**
 * The pairs to keep after a pass: a brand read completely is replaced by what was found; a brand not read completely
 * keeps its earlier pairs plus any found now. A pair whose promotion ended before `today` (YYYY-MM-DD) goes.
 */
export function mergeBogoPairs(prior: Readonly<Record<string, BogoPair>>, results: readonly BogoBrandResult[], today: string): Record<string, BogoPair> {
  const complete = new Set(results.filter((r) => r.complete).map((r) => r.brand));
  const out: Record<string, BogoPair> = {};
  for (const [k, p] of Object.entries(prior)) if (!complete.has(p.brand)) out[k] = p;
  for (const r of results) for (const p of r.pairs) out[p.key] = p;
  for (const [k, p] of Object.entries(out)) if (p.endsAt !== null && p.endsAt < today) delete out[k];
  return out;
}

/** YYYY-MM-DD of the owner's local day. */
export const todayOf = (at: number): string => dayOf(at);

/** Step 15: the pair rule's facts the pair's split is read from (BundleRecord.bogo, scan/settle.ts rule 1). */
export const pairFacts = (p: Pick<BogoPair, 'promotionId' | 'starterItemId' | 'starterModel' | 'freeModel'>): BundleBogo => ({
  promotionId: p.promotionId, starterItemId: p.starterItemId, starterModel: p.starterModel, freeModel: p.freeModel,
});

/**
 * The pair as a bundle record, so the scan reads, splits, matches and estimates it like a listing row. Its page was read
 * by the pass and is saved on it, so the scan does not read it again; a record that already has a page keeps it. Step 15:
 * it carries the pair rule's facts (`bogo`), which its split reads.
 */
export function pairBundleRecord(pair: BogoPair, item: BogoItem | undefined, known: BundleRecord | undefined, at: number): BundleRecord {
  const percentOff = pair.wasPrice !== null && pair.wasPrice > pair.price ? Math.round((1 - pair.price / pair.wasPrice) * 100) : known?.percentOff ?? null;
  const page = known?.page ?? (item ? { bullets: item.bullets, description: item.description, readAt: item.readAt } : undefined);
  return withBuying({
    key: pair.key, retailer: 'homedepot', itemId: pair.itemId, title: pair.title || known?.title || pair.model, brand: pair.brand, model: pair.model,
    upc: known?.upc ?? null, price: pair.price, regularPrice: pair.wasPrice ?? known?.regularPrice ?? null, percentOff, link: pair.link, seenAt: at,
    split: known?.split ?? null,
    ...(page !== undefined ? { page } : {}),
    bogo: pairFacts(pair),
    ...(known?.buying ? { buying: known.buying } : {}),
  }, item?.buying, item?.readAt ?? at);
}

// ---------------------------------------------------------------- grouping, ranking, the digest

export interface BogoChoice {
  /** The pair's bundle key (its deal). */
  key: string;
  itemId: string;
  model: string;
  freeModel: string;
  title: string;
  /** The pair's Home Depot page. */
  link: string;
  price: number;
  wasPrice: number | null;
  /** The pair's estimate as a bundle (fee settings, rule 5); null while it has none. */
  profit: number | null;
  roi: number | null;
  section: ReportSection | null;
}

export interface BogoGroup {
  /** `${promotionId}:${starterItemId}` */
  id: string;
  promotionId: string;
  brand: string;
  starterItemId: string;
  starterModel: string;
  /** The starter's bundle key: its deal, when the starter is a bundle the scan holds. */
  starterKey: string;
  starterLink: string;
  endsAt: string | null;
  description: string | null;
  /** Best estimate first; choices with no estimate last, by model. */
  choices: BogoChoice[];
  /** The first choice with an estimate; null when none has one yet. */
  best: BogoChoice | null;
  /**
   * Choices whose estimate waits for an Amazon lookup (section 'waiting'): the scan looks up a few new pairs per group
   * each run, after every other bundle (scan/runner.ts pairLookupOrder), so the rest come in later scans.
   */
  waitingLookup: number;
  /** "BOGO: 11 free-tool choices — best: PCL515B +$42.10 est." */
  label: string;
}

/** "+$42.10" or "−$3.00" (a real minus). */
export function signedMoney(n: number): string {
  return `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`;
}

export function bogoGroupLabel(count: number, best: BogoChoice | null): string {
  const n = `${count} free-tool ${count === 1 ? 'choice' : 'choices'}`;
  return best && best.profit !== null ? `BOGO: ${n} — best: ${best.freeModel} ${signedMoney(best.profit)} est.` : `BOGO: ${n} — none has an estimate yet`;
}

type RowLike = Pick<BundleRow, 'key' | 'section' | 'estimate'>;

/** The pairs grouped by promotion and starter, each group's choices ranked by the pair's estimate. */
export function bogoGroups(pairs: readonly BogoPair[], rows: readonly RowLike[]): BogoGroup[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const groups = new Map<string, BogoGroup>();
  for (const p of pairs) {
    const id = `${p.promotionId}:${p.starterItemId}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        id, promotionId: p.promotionId, brand: p.brand, starterItemId: p.starterItemId, starterModel: p.starterModel, starterKey: bundleKey(p.starterItemId),
        starterLink: `${HOME_DEPOT}/p/${p.starterItemId}`, endsAt: p.endsAt, description: p.description, choices: [], best: null, waitingLookup: 0, label: '',
      };
      groups.set(id, g);
    }
    const row = byKey.get(p.key);
    g.choices.push({
      key: p.key, itemId: p.itemId, model: p.model, freeModel: p.freeModel, title: p.title, link: p.link, price: p.price, wasPrice: p.wasPrice,
      profit: row?.estimate?.profit ?? null, roi: row?.estimate?.roi ?? null, section: row?.section ?? null,
    });
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.choices.sort((a, b) => (a.profit === null ? 1 : 0) - (b.profit === null ? 1 : 0) || (b.profit ?? 0) - (a.profit ?? 0) || a.model.localeCompare(b.model));
    g.best = g.choices.find((c) => c.profit !== null) ?? null;
    g.waitingLookup = g.choices.filter((c) => c.section === 'waiting').length;
    g.label = bogoGroupLabel(g.choices.length, g.best);
  }
  return out.sort((a, b) => (b.best?.profit ?? -Infinity) - (a.best?.profit ?? -Infinity) || a.id.localeCompare(b.id));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2027-01-31" -> "Jan 31". */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : iso;
}

/** "BOGO: buy DCK200D1P1 and choose 921B (DCK200D1P1W921B) — +$41.20 est., ends Jan 31." */
export function bogoDigestLine(g: BogoGroup, c: BogoChoice): string {
  const ends = g.endsAt ? `, ends ${shortDate(g.endsAt)}` : '';
  return `BOGO: buy ${g.starterModel} and choose ${c.freeModel} (${c.model}) — ${signedMoney(c.profit ?? 0)} est.${ends}.`;
}

export const bogoNotifiedKey = (promotionId: string, at: number): string => `bogo:${promotionId}|bogo|${dayOf(at)}`;

/**
 * One line per promotion not yet sent today: its best choice across its starters, when that pair is confirmed (every
 * part for sale) and its estimate is at or above both of the owner's numbers. Best estimated profit first.
 */
export function bogoDigestLines(groups: readonly BogoGroup[], alerts: AlertSettings, notified: readonly string[], now: number): { lines: string[]; keys: string[]; pairKeys: string[] } {
  const sent = new Set(notified);
  const best = new Map<string, { g: BogoGroup; c: BogoChoice }>();
  for (const g of groups) {
    for (const c of g.choices) {
      if (c.section !== 'confirmed' || c.profit === null || c.roi === null) continue;
      if (c.profit < alerts.minProfit || estimateRoiPercent(c.roi) < alerts.minRoiPercent) continue;
      const cur = best.get(g.promotionId);
      if (!cur || c.profit > cur.c.profit!) best.set(g.promotionId, { g, c });
      break; // choices are ranked: the first that qualifies is this group's best
    }
  }
  const picks = [...best.entries()].filter(([id]) => !sent.has(bogoNotifiedKey(id, now))).sort((a, b) => b[1].c.profit! - a[1].c.profit!);
  return {
    lines: picks.map(([, { g, c }]) => bogoDigestLine(g, c)),
    keys: picks.map(([id]) => bogoNotifiedKey(id, now)),
    pairKeys: picks.map(([, { c }]) => c.key),
  };
}

/** Pair keys that are not their group's best: their own "worth buying now" line is left out of the digest. */
export function pairsBehindBest(groups: readonly BogoGroup[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) for (const c of g.choices) if (c.key !== g.best?.key) out.add(c.key);
  return out;
}
