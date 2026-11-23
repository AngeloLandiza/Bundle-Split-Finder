import type { SearchResult } from '../serpapi/client';
import type { KeepaClient } from './client';
import { serpApiProductBodyFromKeepa, serpApiSearchBodyFromKeepa } from './amazon';
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