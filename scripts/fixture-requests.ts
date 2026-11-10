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
];
