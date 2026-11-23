// npm run keepa:measure — free; reads fixtures/keepa only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { measureKeepaFixture } from '../core/src/keepa/measure';
import { ROOT } from './node-store';

const FIXTURE = join(ROOT, 'fixtures', 'keepa', 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json');

const body = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
const samples = [
  { brand: 'RYOBI', model: 'PCL235B' },
  { brand: 'DEWALT', model: 'DCB606' },
  { brand: 'DEWALT', model: 'DCF921B' },
];

for (const catalog of samples) {
  const row = measureKeepaFixture(body, catalog).find((r) => r.partNumber === catalog.model);
  if (!row) {
    console.log(`${catalog.brand} ${catalog.model}: not in fixture`);
    continue;
  }
  console.log(
    `${catalog.brand} ${catalog.model} (${row.asin}): Keepa ~${row.keepaTokensPerProduct.toFixed(1)} token/product vs SerpApi ~${row.serpApiSearchesTypical} searches; grade from Keepa fields: ${row.gradeWithPartNumber ?? '—'}`,
  );
}