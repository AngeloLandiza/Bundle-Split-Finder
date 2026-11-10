// npm run fixtures:record [-- --dry-run]
//
// Records each request below ONCE into fixtures/recorded/. A request that already
// has a file is skipped, so re-running costs nothing. Spends from the "fixtures"
// allocation and stops when it is used up.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BudgetExceededError, type Params } from '../core/src/serpapi/client';
import { NoKeyError, openDevClient } from './dev-client';
import { ROOT } from './node-store';

const REQUESTS: { name: string; params: Params }[] = [
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

const OUT = join(ROOT, 'fixtures', 'recorded');
const dryRun = process.argv.includes('--dry-run');
const missing = REQUESTS.filter((r) => !existsSync(join(OUT, `${r.name}.json`)));

console.log(`${REQUESTS.length - missing.length} of ${REQUESTS.length} fixtures already recorded. ${missing.length} to record (1 search each).`);
if (missing.length === 0 || dryRun) process.exit(0);

try {
  const { client, allowance } = await openDevClient('fixtures', missing.length);
  console.log(`Allowed to spend ${allowance} now.`);
  mkdirSync(OUT, { recursive: true });
  for (const req of missing) {
    const { data, source } = await client.search(req.params, { label: `fixtures:${req.name}` });
    // Never write the key to disk, whatever the response echoes back.
    const text = JSON.stringify(data, null, 2).split(process.env.SERPAPI_API_KEY ?? '\u0000').join('REDACTED');
    writeFileSync(join(OUT, `${req.name}.json`), text);
    console.log(`  recorded ${req.name} (${source})`);
  }
} catch (err) {
  if (err instanceof BudgetExceededError || err instanceof NoKeyError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
