// The requests recorded into fixtures/recorded/. Kept apart from record-fixtures.ts,
// which runs on import, so tests and the replay can read the list safely.

import type { Params } from '../core/src/serpapi/client';

export interface FixtureRequest {
  name: string;
  params: Params;
}

export const REQUESTS: FixtureRequest[] = [
  { name: 'hd-search-ryobi-combo-p1', params: { engine: 'home_depot', q: 'ryobi 18v combo kit', page: 1 } },
  { name: 'hd-search-dewalt-combo-p1', params: { engine: 'home_depot', q: 'dewalt 20v combo kit', page: 1 } },
  { name: 'hd-search-ryobi-ratchet', params: { engine: 'home_depot', q: 'ryobi extended reach ratchet', page: 1 } },
  { name: 'hd-product-328814689', params: { engine: 'home_depot_product', product_id: '328814689' } },
  { name: 'amazon-search-PBLRC25B', params: { engine: 'amazon', k: 'RYOBI PBLRC25B', amazon_domain: 'amazon.com' } },
  { name: 'amazon-search-PBLRC01B', params: { engine: 'amazon', k: 'RYOBI PBLRC01B', amazon_domain: 'amazon.com' } },
  { name: 'amazon-search-DCF891B', params: { engine: 'amazon', k: 'DEWALT DCF891B', amazon_domain: 'amazon.com' } },
  { name: 'amazon-product-B0B6Z2ZGVK', params: { engine: 'amazon_product', asin: 'B0B6Z2ZGVK', amazon_domain: 'amazon.com' } },
  { name: 'amazon-product-B0B3JWF5ZV', params: { engine: 'amazon_product', asin: 'B0B3JWF5ZV', amazon_domain: 'amazon.com' } },
  // Home Depot's own "Bundle" filter (bwo64) plus the brand filter (RYOBI m5d, DEWALT 4j2).
  { name: 'hd-bundles-ryobi-p1', params: { engine: 'home_depot', q: 'ryobi 18v combo kit', hd_filter_tokens: 'bwo64,m5d', page: 1 } },
  { name: 'hd-bundles-dewalt-p1', params: { engine: 'home_depot', q: 'dewalt 20v combo kit', hd_filter_tokens: 'bwo64,4j2', page: 1 } },
  // One page of a brand's own Amazon listings: Amazon's brand filter, read from an earlier response.
  { name: 'amazon-brand-ryobi-p1', params: { engine: 'amazon', k: 'RYOBI', rh: 'p_123:252605', amazon_domain: 'amazon.com' } },
  { name: 'amazon-brand-dewalt-p1', params: { engine: 'amazon', k: 'DEWALT', rh: 'p_123:195991', amazon_domain: 'amazon.com' } },
  // A kit that is a part of a bundle: the lookup the scan sends for it.
  { name: 'amazon-search-PCL1201K2', params: { engine: 'amazon', k: 'RYOBI PCL1201K2', amazon_domain: 'amazon.com' } },
];
