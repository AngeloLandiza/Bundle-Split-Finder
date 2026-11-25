import { toUpc12 } from '../identifiers';
import { grade, type Wanted } from '../match';
import type { SearchResult } from '../serpapi/client';
import { parseAmazonSearch } from '../serpapi/parsers';
import type { KeepaClient } from './client';
import { serpApiProductBodyFromKeepa, serpApiSearchBodyFromKeepa } from './amazon';
import { holdsBarcode } from './barcode';
import type { KeepaProduct } from './types';
import { KEEPA_LOOKUP_TOKEN_ESTIMATE, KEEPA_SEARCH_TOKEN_ESTIMATE, productTokenEstimate } from './estimates';
import type { KeepaTrackingDepth } from './types';

export { KEEPA_LOOKUP_TOKEN_ESTIMATE, KEEPA_SEARCH_TOKEN_ESTIMATE, productTokenEstimate };

/** One ASIN product pull shaped like engine=amazon_product for applyIdentify / applyRefresh. */
export async function keepaProductSearchResult(
  client: KeepaClient,
  asin: string,
  options: { label: string; estimate?: number; maxAgeMs?: number; trackingDepth?: KeepaTrackingDepth },
): Promise<SearchResult> {
  const r = await client.getProducts([asin], 1, {
    label: options.label,
    estimate: options.estimate ?? productTokenEstimate(options.trackingDepth, 1),
    maxAgeMs: options.maxAgeMs,
    trackingDepth: options.trackingDepth,
  });
  const p = r.data.products.find((x) => x.asin === asin) ?? r.data.products[0];
  if (!p) throw new Error('Keepa returned no product for this ASIN.');
  return {
    data: serpApiProductBodyFromKeepa(p),
    source: r.source,
    at: r.at,
    billAs: 'keepa',
    keepaTokens: r.meta.tokensConsumed,
    keepaProduct: p,
  };
}

/** Product search shaped like engine=amazon for applyLookup. */
export async function keepaLookupSearchResult(
  client: KeepaClient,
  term: string,
  options: { label: string; estimate?: number },
): Promise<SearchResult> {
  const r = await client.searchProducts(term, 1, { label: options.label, estimate: options.estimate ?? KEEPA_SEARCH_TOKEN_ESTIMATE });
  let products = r.data.products ?? [];
  let tokens = r.meta.tokensConsumed;
  if (products.length === 0 && (r.data.asinList?.length ?? 0) > 0) {
    const batch = r.data.asinList!.slice(0, 20);
    const detail = await client.getProducts(batch, 1, { label: `${options.label}:detail`, estimate: batch.length });
    products = detail.data.products;
    tokens += detail.meta.tokensConsumed;
  }
  return {
    data: serpApiSearchBodyFromKeepa(products),
    source: r.source,
    at: r.at,
    billAs: 'keepa',
    keepaTokens: tokens,
  };
}

/** Nov 25: what a part's Keepa lookup is asked with besides its brand and model. */
export interface KeepaLookupAsk {
  /** The barcode Home Depot's page states for the part (scan/barcodeLookup.ts partBarcode): asked by code first. */
  barcode?: string | null;
  /** The part as the matcher wants it (classify.ts wantedFor): whether the code's products leave a candidate it keeps. */
  want?: Wanted;
  /** The code request only, never the term search after it (the drip's look at a part a search already found nothing for). */
  codeOnly?: boolean;
}

/** The candidates a set of Keepa products gives the matcher: the search-row shape, exactly as a term search's rows are. */
const rowsOf = (products: KeepaProduct[]) => parseAmazonSearch(serpApiSearchBodyFromKeepa(products));

/**
 * Nov 25: one part's Amazon lookup on Keepa, barcode first. With a valid barcode, Keepa's product request by code runs
 * before any term search, and the products it returns are candidates exactly as a search's rows are (the same shape, the
 * same matcher, then the same ladder): a way to FIND the listing, not proof of it. When the matcher keeps none of them (no
 * product came back, or each is rejected for `want`), the term search runs as before, within the same budget, its rows
 * after the code's. `codeOnly` stops after the code. Without a barcode it is the term search alone (keepaLookupSearchResult).
 * Tokens are what Keepa counted (`tokensConsumed`); what the code found is on `barcode`, its products whole on
 * `keepaProducts` (with stats: their price and catalog fields come with them, so no pull follows for a listing they hold).
 * Throws what the client throws: a code refused by the budget before it is sent throws with nothing spent; a search refused
 * after the code throws too, the code's answer cached, so asking again costs it nothing.
 */
export async function keepaPartLookup(
  client: KeepaClient, brand: string, model: string, label: string, ask: KeepaLookupAsk = {},
): Promise<SearchResult> {
  const term = `${brand} ${model}`;
  const code = toUpc12(ask.barcode ?? null);
  if (code === null) return keepaLookupSearchResult(client, term, { label });
  const byCode = await client.productsByCode([code], 1, { label: `${label}:code` });
  const products = byCode.data.products;
  const codeTokens = byCode.source === 'network' ? byCode.meta.tokensConsumed : 0;
  const want: Wanted = ask.want ?? { brand, model };
  const kept = rowsOf(products).some((row) => grade(want, row).grade !== 'reject');
  const found = products.map((p) => ({ asin: p.asin, sameBarcode: holdsBarcode(p, code) }));
  if (kept || ask.codeOnly) {
    return {
      data: serpApiSearchBodyFromKeepa(products), source: byCode.source, at: byCode.at, billAs: 'keepa', keepaTokens: codeTokens,
      keepaProducts: products, barcode: { code, via: 'code', products: found, codeTokens, searchTokens: 0 },
    };
  }
  const search = await keepaLookupSearchResult(client, term, { label });
  const searchTokens = search.source === 'network' ? (search.keepaTokens ?? 0) : 0;
  const rows = (b: unknown): unknown[] => (Array.isArray((b as { organic_results?: unknown }).organic_results) ? (b as { organic_results: unknown[] }).organic_results : []);
  const codeRows = rows(serpApiSearchBodyFromKeepa(products));
  const asins = new Set(products.map((p) => p.asin));
  const searchRows = rows(search.data).filter((r) => !asins.has(String((r as { asin?: unknown }).asin)));
  return {
    data: { organic_results: [...codeRows, ...searchRows] },
    source: byCode.source === 'network' || search.source === 'network' ? 'network' : 'cache',
    at: search.at, billAs: 'keepa', keepaTokens: codeTokens + searchTokens,
    keepaProducts: products, barcode: { code, via: 'search', products: found, codeTokens, searchTokens },
  };
}
