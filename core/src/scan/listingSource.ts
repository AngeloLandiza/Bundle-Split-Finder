// A scan's discovery, free (Nov 23): each brand's Home Depot Bundle listing read in the owner's Chrome, the same way the
// BOGO pass reads the Featured BOGO listing (core/src/tracking/bogoPairs.ts readBogoPass), instead of SerpApi's
// home_depot search. Pure: the readers are injected (the agent's are worker jobs run by the paired helper).
//
// What was checked live in the owner's Chrome (free, Nov 23): the listing address is the search query's address with
// Home Depot's own filter tokens in its N- value, base `5yc1v`, then `Z` and each token (Bundle `bwo64`, brand RYOBI
// `m5d`, DEWALT `4j2`): /b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5. Its
// `window.__APOLLO_STATE__` holds 12 `base-searchNav-<itemId>` entries a page (hdPage.ts parseSearchState); `&Nao=12`
// gives the next 12 and `&Nao=24` none: 24 RYOBI bundles for that query. SerpApi applies no filter token reliably,
// so its listing (hundreds of rows, bundles and single tools mixed) is replaced, not filtered.
//
// The recorded listing entries (fixtures/homedepot-pages/research-2026-11-20.json) hold only identifiers (brand, model,
// title, canonical address), so a bundle's price and was-price come from its own product page, read here in the same
// pass (hdPage.ts parsePromoPage, the BOGO pass's reader) and kept in the BOGO pass's item cache, so a page either pass
// read is not read again while it is fresh. That page's Includes bullets are the bundle's page reading too (P1), so a
// new bundle costs one page read, not two.
//
// The rules every reader keeps (docs/decisions.md, the doorway rule): pages are read the way a normal tab loads them,
// paced by the reader; a refusal is never retried: it ends the pass, what was read before it is kept, and the problem
// says so.

import type { Cache } from '../serpapi/client';
import { HOME_DEPOT, itemCacheKey, itemOf, type BogoItem, type ListedItem, type PromoPageOutcome } from '../tracking/bogoPairs';
import type { HdListing } from '../serpapi/parsers';

/** Home Depot's "Bundle" filter token (recorded in scripts/fixture-requests.ts; checked live Nov 23). */
export const BUNDLE_FILTER_TOKEN = 'bwo64';
/** Home Depot's brand filter tokens (the same recordings). Only these brands have a Bundle listing. */
export const BRAND_FILTER_TOKENS: Readonly<Record<string, string>> = { RYOBI: 'm5d', DEWALT: '4j2' };
/** The N- value every listing address starts from (the live check, and the Featured BOGO listing's). */
const N_BASE = '5yc1v';

/** Listing pages read per brand and scan, at most (12 a page: 120 bundles; the live RYOBI listing had 24). */
export const BUNDLE_LISTING_PAGES_MAX = 10;
/** Item pages read per scan for prices, at most (the page reader's own limit per scan, docs/decisions.md "Pace"). */
export const LISTING_ITEM_PAGES_MAX = 60;
/** Item pages asked for in one call to the reader (the BOGO pass's batch). */
export const LISTING_ITEM_BATCH = 25;
/**
 * A bundle's price read from its page is used again for this long, by either pass (the BOGO pass reads its own items once
 * a day). Six hours: at the recommended scan every 3 hours a listed bundle's page is read at most four times a day.
 */
export const LISTING_ITEM_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * The only addresses the Bundle listing reader may read: the filter tokens above, then either a query and an offset
 * (`/Ntk-elasticplus/Ntt-<query>?NCNI-5&Nao=<n>`) or no query at all (`?Nao=<n>`: the brand's whole Bundle list).
 */
const TOKENS = `N-${N_BASE}Z${BUNDLE_FILTER_TOKEN}Z(?:${Object.values(BRAND_FILTER_TOKENS).join('|')})`;
const LISTING_PATH = new RegExp(`^/b/${TOKENS}(?:/Ntk-elasticplus/Ntt-[A-Za-z0-9%._~-]{1,120}\\?NCNI-5(&Nao=\\d{1,4})?|(\\?Nao=\\d{1,4})?)$`);

export const isBundleListingPath = (path: unknown): path is string => typeof path === 'string' && LISTING_PATH.test(path);

/**
 * A brand's Bundle listing address for a search query (settings.ts BRAND_QUERIES, written as the BOGO listing writes it:
 * "ryobi 18v combo kit" is Ntt-ryobi%2B18v%2Bcombo%2Bkit), or with `query` null the brand's whole Bundle list
 * (`/b/N-5yc1vZbwo64Z4j2`, as the controller gave it), and an offset; offset 0 has no Nao. Null for a brand with no known
 * filter token.
 */
export function bundleListingPath(brand: string, query: string | null, offset: number): string | null {
  const token = BRAND_FILTER_TOKENS[brand.trim().toUpperCase()];
  if (token === undefined) return null;
  const base = `/b/N-${N_BASE}Z${BUNDLE_FILTER_TOKEN}Z${token}`;
  if (query === null) return `${base}${offset > 0 ? `?Nao=${Math.floor(offset)}` : ''}`;
  const ntt = encodeURIComponent(query.trim().toLowerCase().split(/\s+/).join('+'));
  return `${base}/Ntk-elasticplus/Ntt-${ntt}?NCNI-5${offset > 0 ? `&Nao=${Math.floor(offset)}` : ''}`;
}

/** The brand whose filter token a Bundle listing path carries; null for any other path. */
export function brandOfListingPath(path: string): string | null {
  if (!isBundleListingPath(path)) return null;
  for (const [brand, token] of Object.entries(BRAND_FILTER_TOKENS)) if (path.startsWith(`/b/N-${N_BASE}Z${BUNDLE_FILTER_TOKEN}Z${token}`)) return brand;
  return null;
}

/** The first words of the problem a list that came back with its page state but no product is said with. */
export const LIST_EMPTY = "Home Depot's bundle list came back empty";

/** One listing page as the helper read it: its products, and, when it held none, what its state held instead. */
export interface ListingPage {
  products: ListedItem[];
  note?: string;
}

export interface ListingSourceDeps {
  /** Brands in Settings; only those with a filter token are read. */
  brands: readonly string[];
  /** Brand -> the scan's search query (settings.ts BRAND_QUERIES); each brand's list is also read without it. */
  queries: Readonly<Record<string, string>>;
  /** One listing page. Throws when Chrome could not read it or Home Depot refused it. */
  readListing: (path: string) => Promise<ListingPage>;
  /** Item pages with their price, one outcome per id (the BOGO pass's reader). Throws as readListing. */
  readPages: (itemIds: string[]) => Promise<PromoPageOutcome[]>;
  /** The item cache the BOGO pass keeps (`homedepot:bogo-item:<id>`). Absent: nothing is reused or kept. */
  cache?: Cache;
  now: () => number;
  shouldStop?: () => boolean;
  /** Default LISTING_ITEM_PAGES_MAX; a continued job passes what is left. */
  itemPagesMax?: number;
}

/** One list read: a brand's Bundle list with the query, or without it. */
export interface ListingListResult {
  brand: string;
  /** The search words; null for the brand's whole Bundle list. */
  query: string | null;
  /** Listing pages read. */
  pages: number;
  /** Items this list showed, each once. */
  listed: number;
  /** Of those, items no list read before it in this pass showed (the union's growth). */
  added: number;
  /** Every page until one added nothing was read. */
  complete: boolean;
  /** Its first page came back with its state but no product: said as a problem, never taken as "no bundles". */
  empty: boolean;
}

/** One listed product, in the shape a SerpApi listing row has (HdListing), with its page reading when it was read. */
export interface ListingRow extends HdListing {
  /** The product page's Includes bullets and description, as the scan's page reader saves them (P2); null when not read. */
  page: { bullets: string[]; description: string | null; readAt: number } | null;
  /** The listing entry or the item page carried a BOGO promotion (the BOGO pass still decides pairs). */
  bogo: boolean;
}

export interface ListingSourceResult {
  lists: ListingListResult[];
  rows: ListingRow[];
  /** Listing pages read, all lists. */
  listingPages: number;
  /** Items whose price and was-price came with the listing entry (no item page read for them). */
  pricedByList: number;
  /** Item pages read now (not from the cache). */
  itemPagesRead: number;
  /** Item pages whose price came from a fresh cached reading. */
  itemPagesCached: number;
  /** Listed items with no price from the list whose page was not read (the cap, a refusal, a stop). */
  itemPagesLeft: number;
  /** Why the pass ended early or a list came back empty, in sentences; null when every page it wanted was read. */
  problem: string | null;
  /** Home Depot refused (or Chrome could not read) a listing or item page: nothing more was read. */
  refused: boolean;
}

/** A cached item reading younger than LISTING_ITEM_MAX_AGE_MS; anything else is read again. */
function freshItem(data: unknown, at: number, now: number): BogoItem | null {
  if (now - at > LISTING_ITEM_MAX_AGE_MS || now < at || !data || typeof data !== 'object') return null;
  const i = data as BogoItem;
  return typeof i.itemId === 'string' && typeof i.model === 'string' && Array.isArray(i.promotions) && Array.isArray(i.bullets) ? i : null;
}

const sentenceOf = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : fallback);

const percentOff = (price: number | null, was: number | null): number | null =>
  price !== null && was !== null && was > price ? Math.round(((was - price) / was) * 100) : null;

/** Whether the listing entry carried its own pricing entry (the live listing does; the old recordings were slimmed). */
const listPriced = (p: ListedItem): boolean => p.price !== undefined;

/** A listed item as a listing row: the listing's identifiers; the list's own price when it has one, else the page's. */
function rowOf(listed: ListedItem, item: BogoItem | null): ListingRow {
  const link = listed.url.startsWith(`${HOME_DEPOT}/p/`) ? listed.url : `${HOME_DEPOT}/p/${listed.itemId}`;
  const price = listPriced(listed) ? listed.price ?? null : item?.price ?? null;
  const was = price === null ? null : listPriced(listed) ? listed.wasPrice ?? null : item?.wasPrice ?? null;
  return {
    itemId: listed.itemId, title: listed.title || item?.title || listed.model, brand: listed.brand || item?.brand || null, model: listed.model || item?.model || null,
    price, regularPrice: was, percentOff: percentOff(price, was), badge: null, link,
    page: item ? { bullets: [...item.bullets], description: item.description, readAt: item.readAt } : null,
    bogo: (listed.promotions?.length ?? 0) > 0 || (item?.promotions.length ?? 0) > 0,
  };
}

const listName = (brand: string, query: string | null): string => (query === null ? `${brand} list without search words` : `${brand} list for "${query}"`);

/**
 * Each brand's Bundle list, with the query and then without it (pages until one brings no new item id, at most
 * BUNDLE_LISTING_PAGES_MAX a list; the next offset is the list's own items so far, as the BOGO pass pages), merged into one
 * set of items. A list whose first page comes back with its state but no product is a problem said in words (LIST_EMPTY),
 * not a refusal: the other lists are still read. Then the price: the listing entry's own when it carries one, else the
 * item's page, from the shared item cache when it was read in the last LISTING_ITEM_MAX_AGE_MS, at most `itemPagesMax`
 * read now. A listing or item page that fails ends the pass: what came before is kept, and `problem` says why.
 */
export async function readBundleListings(deps: ListingSourceDeps): Promise<ListingSourceResult> {
  const stop = (): boolean => deps.shouldStop?.() === true;
  const out: ListingSourceResult = { lists: [], rows: [], listingPages: 0, pricedByList: 0, itemPagesRead: 0, itemPagesCached: 0, itemPagesLeft: 0, problem: null, refused: false };
  const problems: string[] = [];
  const listed = new Map<string, ListedItem>();
  for (const raw of deps.brands) {
    const brand = raw.trim().toUpperCase();
    if (BRAND_FILTER_TOKENS[brand] === undefined) continue;
    const query = deps.queries[brand];
    for (const q of query === undefined ? [null] : [query, null]) {
      const r: ListingListResult = { brand, query: q, pages: 0, listed: 0, added: 0, complete: false, empty: false };
      out.lists.push(r);
      if (out.refused || stop()) continue;
      // This list's own items, so a page that repeats another list's items still moves the offset on.
      const own = new Set<string>();
      try {
        while (r.pages < BUNDLE_LISTING_PAGES_MAX && !stop()) {
          const page = await deps.readListing(bundleListingPath(brand, q, own.size)!);
          r.pages += 1;
          out.listingPages += 1;
          const fresh = page.products.filter((p) => /^\d{6,12}$/.test(p.itemId) && !own.has(p.itemId));
          if (fresh.length === 0 && r.pages === 1) {
            r.empty = true;
            problems.push(`${LIST_EMPTY}: the ${listName(brand, q)} had no product${page.note ? ` (${page.note})` : ''}.`);
            break;
          }
          for (const p of fresh) {
            own.add(p.itemId);
            r.listed += 1;
            if (!listed.has(p.itemId)) {
              listed.set(p.itemId, p);
              r.added += 1;
            }
          }
          if (fresh.length === 0) {
            r.complete = true;
            break;
          }
        }
      } catch (e) {
        out.refused = true;
        problems.push(sentenceOf(e, 'Chrome could not read the Home Depot bundle list.'));
      }
    }
  }

  // Prices: the list's own, else a fresh cached reading, else the item's page, until the cap, a refusal or a stop.
  const items = new Map<string, BogoItem>();
  const toRead: string[] = [];
  for (const [id, p] of listed) {
    if (listPriced(p)) {
      out.pricedByList += 1;
      continue;
    }
    const hit = deps.cache ? await deps.cache.get(itemCacheKey(id)) : undefined;
    const item = hit ? freshItem(hit.data, hit.at, deps.now()) : null;
    if (item && item.itemId === id) {
      items.set(id, item);
      out.itemPagesCached += 1;
    } else toRead.push(id);
  }
  const cap = Math.max(0, Math.floor(deps.itemPagesMax ?? LISTING_ITEM_PAGES_MAX));
  const ids = out.refused ? [] : toRead.slice(0, cap);
  for (let i = 0; i < ids.length && !out.refused && !stop(); i += LISTING_ITEM_BATCH) {
    const batch = ids.slice(i, i + LISTING_ITEM_BATCH);
    let outcomes: PromoPageOutcome[];
    try {
      outcomes = await deps.readPages(batch);
    } catch (e) {
      out.refused = true;
      problems.push(sentenceOf(e, 'Chrome could not read the bundle pages.'));
      break;
    }
    const at = deps.now();
    for (const o of outcomes) {
      if (!batch.includes(o.itemId) || items.has(o.itemId)) continue;
      if (o.kind === 'read' && o.page.itemId === o.itemId) {
        const item = itemOf(o.page, listed.get(o.itemId), at);
        items.set(o.itemId, item);
        out.itemPagesRead += 1;
        if (deps.cache) await deps.cache.set(itemCacheKey(o.itemId), { at, data: item });
      } else if (o.kind === 'refused' && !out.refused) {
        out.refused = true;
        problems.push('Home Depot refused a bundle page.');
      }
    }
  }
  out.itemPagesLeft = toRead.filter((id) => !items.has(id)).length;
  if (!out.refused && out.itemPagesLeft > 0 && toRead.length > cap) problems.push(`${out.itemPagesLeft} bundle ${out.itemPagesLeft === 1 ? 'page waits' : 'pages wait'} for the next scan (at most ${cap} a scan).`);
  if (problems.length === 0 && stop()) problems.push('stopped');
  out.problem = problems.length > 0 ? problems.join(' ') : null;
  out.rows = [...listed.values()].map((p) => rowOf(p, items.get(p.itemId) ?? null));
  return out;
}

/** "RYOBI: 24 with the search words, 16 more without them; DEWALT: 3 with the search words, 40 more without them." */
export function listCounts(lists: readonly Pick<ListingListResult, 'brand' | 'query' | 'listed' | 'added' | 'empty' | 'pages'>[]): string {
  const brands = [...new Set(lists.map((l) => l.brand))];
  return brands.map((b) => {
    const parts = lists.filter((l) => l.brand === b && l.pages > 0).map((l) => {
      const n = l.empty ? 'empty' : String(l.query === null ? l.added : l.listed);
      return l.query === null ? `${n === 'empty' ? 'empty' : `${n} more`} without them` : `${n} with the search words`;
    });
    return parts.length > 0 ? `${b}: ${parts.join(', ')}` : '';
  }).filter((x) => x !== '').join('; ');
}

// ---------------------------------------------------------------- which source a scan uses

/** Settings: where a scan finds Home Depot's bundles. 'auto' (the default): Chrome when the helper is connected. */
export type ListingSourceSetting = 'chrome' | 'serpapi' | 'auto';
export const LISTING_SOURCES: readonly ListingSourceSetting[] = ['auto', 'chrome', 'serpapi'];
export const DEFAULT_LISTING_SOURCE: ListingSourceSetting = 'auto';

export interface SourceInput {
  setting: ListingSourceSetting;
  /** The paired helper answers now. */
  chromeConnected: boolean;
  /** Who started the scan: a scheduled scan keeps the reserve and, with Chrome closed, waits for it. */
  trigger: 'manual' | 'scheduled';
  /** Settings: a scheduled scan may search SerpApi for the lists when Chrome is closed (default off). */
  serpWhenChromeClosed: boolean;
  /** SerpApi can pay for at least one listing page now (the scan's own budget guard). */
  serpCanPay: boolean;
}

export type SourceChoice =
  | { source: 'chrome' }
  | { source: 'serpapi' }
  /** A scheduled scan with Chrome closed: it does not start; it starts when Chrome is back (the next tick). */
  | { source: 'wait'; why: string }
  /** The scan runs without finding new bundles (the pages and lookups of bundles found before still run). */
  | { source: 'none'; why: string };

/**
 * Which source a scan's bundle lists come from. Chrome is free, so it is the source whenever it can be; SerpApi only when
 * the owner chose it, or (auto) when Chrome is closed and either the owner started the scan or allowed it in Settings,
 * and a search can pay. A scheduled scan that may not search waits for Chrome, as the page reads already do.
 */
export function chooseListingSource(i: SourceInput): SourceChoice {
  if (i.setting === 'serpapi') return i.serpCanPay ? { source: 'serpapi' } : { source: 'none', why: 'no searches left' };
  if (i.chromeConnected) return { source: 'chrome' };
  if (i.setting === 'auto' && (i.trigger === 'manual' || i.serpWhenChromeClosed)) {
    return i.serpCanPay ? { source: 'serpapi' } : { source: 'none', why: 'no searches left' };
  }
  return i.trigger === 'scheduled' ? { source: 'wait', why: 'Chrome closed' } : { source: 'none', why: 'Chrome closed' };
}
