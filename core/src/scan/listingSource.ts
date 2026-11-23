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

/** The only addresses the Bundle listing reader may read: the filter tokens above, a query, and an offset. */
const LISTING_PATH = new RegExp(
  `^/b/N-${N_BASE}Z${BUNDLE_FILTER_TOKEN}Z(?:${Object.values(BRAND_FILTER_TOKENS).join('|')})/Ntk-elasticplus/Ntt-[A-Za-z0-9%._~-]{1,120}\\?NCNI-5(&Nao=\\d{1,4})?$`,
);

export const isBundleListingPath = (path: unknown): path is string => typeof path === 'string' && LISTING_PATH.test(path);

/**
 * A brand's Bundle listing address for a search query (settings.ts BRAND_QUERIES, written as the BOGO listing writes it:
 * "ryobi 18v combo kit" is Ntt-ryobi%2B18v%2Bcombo%2Bkit) and an offset; offset 0 has no Nao. Null for a brand with no
 * known filter token.
 */
export function bundleListingPath(brand: string, query: string, offset: number): string | null {
  const token = BRAND_FILTER_TOKENS[brand.trim().toUpperCase()];
  if (token === undefined) return null;
  const ntt = encodeURIComponent(query.trim().toLowerCase().split(/\s+/).join('+'));
  return `/b/N-${N_BASE}Z${BUNDLE_FILTER_TOKEN}Z${token}/Ntk-elasticplus/Ntt-${ntt}?NCNI-5${offset > 0 ? `&Nao=${Math.floor(offset)}` : ''}`;
}

export interface ListingSourceDeps {
  /** Brands in Settings; only those with a filter token and a query are read. */
  brands: readonly string[];
  /** Brand -> the scan's search query (settings.ts BRAND_QUERIES). */
  queries: Readonly<Record<string, string>>;
  /** One listing page's products, in page order. Throws when Chrome could not read it or Home Depot refused it. */
  readListing: (path: string) => Promise<ListedItem[]>;
  /** Item pages with their price, one outcome per id (the BOGO pass's reader). Throws as readListing. */
  readPages: (itemIds: string[]) => Promise<PromoPageOutcome[]>;
  /** The item cache the BOGO pass keeps (`homedepot:bogo-item:<id>`). Absent: nothing is reused or kept. */
  cache?: Cache;
  now: () => number;
  shouldStop?: () => boolean;
  /** Default LISTING_ITEM_PAGES_MAX; a continued job passes what is left. */
  itemPagesMax?: number;
}

export interface ListingBrandResult {
  brand: string;
  query: string;
  /** Listing pages read. */
  pages: number;
  /** Item ids listed, in listing order, each once (an item already listed by an earlier brand is not counted again). */
  listed: number;
  /** Every page until one added nothing was read. */
  complete: boolean;
}

/** One listed product, in the shape a SerpApi listing row has (HdListing), with its page reading when it was read. */
export interface ListingRow extends HdListing {
  /** The product page's Includes bullets and description, as the scan's page reader saves them (P2); null when not read. */
  page: { bullets: string[]; description: string | null; readAt: number } | null;
}

export interface ListingSourceResult {
  brands: ListingBrandResult[];
  rows: ListingRow[];
  /** Listing pages read, all brands. */
  listingPages: number;
  /** Item pages read now (not from the cache). */
  itemPagesRead: number;
  /** Item pages whose price came from a fresh cached reading. */
  itemPagesCached: number;
  /** Listed items whose page was not read (the cap, a refusal, a stop): their rows carry no price. */
  itemPagesLeft: number;
  /** Why the pass ended early, in a sentence; null when every page it wanted was read. */
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

/** A listed item as a listing row: the listing's identifiers, the page's price and reading when there is one. */
function rowOf(listed: ListedItem, item: BogoItem | null): ListingRow {
  const link = listed.url.startsWith(`${HOME_DEPOT}/p/`) ? listed.url : `${HOME_DEPOT}/p/${listed.itemId}`;
  const price = item?.price ?? null;
  const was = price === null ? null : item?.wasPrice ?? null;
  return {
    itemId: listed.itemId, title: listed.title || item?.title || listed.model, brand: listed.brand || item?.brand || null, model: listed.model || item?.model || null,
    price, regularPrice: was, percentOff: percentOff(price, was), badge: null, link,
    page: item ? { bullets: [...item.bullets], description: item.description, readAt: item.readAt } : null,
  };
}

/**
 * Each brand's whole Bundle listing (pages until one brings no new item id, at most BUNDLE_LISTING_PAGES_MAX; the next
 * offset is the items read so far, as the BOGO pass pages), then each listed item's page for its price, from the shared
 * item cache when it was read in the last LISTING_ITEM_MAX_AGE_MS, at most `itemPagesMax` read now. A listing or item
 * page that fails ends the pass: what came before is kept, later brands and pages are not read, and `problem` says why.
 */
export async function readBundleListings(deps: ListingSourceDeps): Promise<ListingSourceResult> {
  const stop = (): boolean => deps.shouldStop?.() === true;
  const out: ListingSourceResult = { brands: [], rows: [], listingPages: 0, itemPagesRead: 0, itemPagesCached: 0, itemPagesLeft: 0, problem: null, refused: false };
  const listed = new Map<string, ListedItem>();
  for (const raw of deps.brands) {
    const brand = raw.trim().toUpperCase();
    const query = deps.queries[brand];
    if (query === undefined || BRAND_FILTER_TOKENS[brand] === undefined) continue;
    const r: ListingBrandResult = { brand, query, pages: 0, listed: 0, complete: false };
    out.brands.push(r);
    if (out.refused || stop()) continue;
    // This listing's own items, so a page that repeats another brand's items still moves the offset on.
    const own = new Set<string>();
    try {
      while (r.pages < BUNDLE_LISTING_PAGES_MAX && !stop()) {
        const path = bundleListingPath(brand, query, own.size)!;
        const products = await deps.readListing(path);
        r.pages += 1;
        out.listingPages += 1;
        const fresh = products.filter((p) => /^\d{6,12}$/.test(p.itemId) && !own.has(p.itemId));
        for (const p of fresh) {
          own.add(p.itemId);
          if (!listed.has(p.itemId)) {
            listed.set(p.itemId, p);
            r.listed += 1;
          }
        }
        if (fresh.length === 0) {
          r.complete = true;
          break;
        }
      }
    } catch (e) {
      out.refused = true;
      out.problem = sentenceOf(e, 'Chrome could not read the Home Depot bundle list.');
    }
  }

  // Prices: a fresh cached reading, else the item's page, until the cap, a refusal or a stop.
  const items = new Map<string, BogoItem>();
  const toRead: string[] = [];
  for (const id of listed.keys()) {
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
      out.problem = sentenceOf(e, 'Chrome could not read the bundle pages.');
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
      } else if (o.kind === 'refused') {
        out.refused = true;
        out.problem ??= 'Home Depot refused a bundle page.';
      }
    }
  }
  out.itemPagesLeft = [...listed.keys()].filter((id) => !items.has(id)).length;
  if (out.problem === null && out.itemPagesLeft > 0 && toRead.length > cap) out.problem = `${out.itemPagesLeft} bundle ${out.itemPagesLeft === 1 ? 'page waits' : 'pages wait'} for the next scan (at most ${cap} a scan).`;
  if (out.problem === null && stop()) out.problem = 'stopped';
  out.rows = [...listed.values()].map((p) => rowOf(p, items.get(p.itemId) ?? null));
  return out;
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
