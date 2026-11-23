// npm run keepa:record [-- --dry-run]
//
// Records Keepa responses under fixtures/keepa/ once each. Re-running is free from cache.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KeepaBudgetExceededError } from '../core/src/keepa/client';
import { centsToDollars } from '../core/src/keepa/parse';
import { NoKeepaKeyError, openKeepaDev } from './open-keepa-dev';
import { ROOT } from './node-store';

const OUT = join(ROOT, 'fixtures', 'keepa');

/** Keep fixtures small: full Keepa bodies include multi-MB csv history. */
function slimKeepaProduct(body: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set([
    'csv',
    'csvBirth',
    'salesRanks',
    'salesRankReference',
    'salesRankReferenceHistory',
    'buyBoxSellerIdHistory',
    'buyBoxUsedHistory',
    'offers',
    'liveOffersOrder',
    'couponHistory',
    'variationCSV',
    'eBayListingIds',
    'eanList',
    'upcList',
  ]);
  const slim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!drop.has(k)) slim[k] = v;
  }
  return slim;
}

function slimKeepaBody(raw: Record<string, unknown>): Record<string, unknown> {
  const products = Array.isArray(raw.products)
    ? raw.products
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map(slimKeepaProduct)
    : raw.products;
  return { ...raw, products };
}

const RECORDS = [
  {
    name: 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB',
    estimate: 3,
    run: async (client: Awaited<ReturnType<typeof openKeepaDev>>['client']) =>
      client.getProducts(['B0BGYFTPGK', 'B01H9BL8EO', 'B09M3TL9BB'], 1, { label: 'fixtures:validation-sample', estimate: 3 }),
  },
  {
    name: 'search-RYOBI-PCL235B',
    estimate: 10,
    run: async (client: Awaited<ReturnType<typeof openKeepaDev>>['client']) =>
      client.searchProducts('RYOBI PCL235B', 1, { label: 'fixtures:search-sample', estimate: 10 }),
  },
] as const;

const dryRun = process.argv.includes('--dry-run');
const missing = RECORDS.filter((r) => !existsSync(join(OUT, `${r.name}.json`)));
const tokensNeeded = missing.reduce((a, r) => a + r.estimate, 0);

console.log(`${RECORDS.length - missing.length} of ${RECORDS.length} Keepa fixtures on disk. ${missing.length} to record (${tokensNeeded} tokens if paid).`);
if (missing.length === 0 || dryRun) process.exit(0);

let release: (() => void) | undefined;
try {
  const opened = await openKeepaDev(tokensNeeded + 5);
  release = opened.release;
  const { client, budget } = opened;
  console.log(`Session may spend up to ${tokensNeeded + 5} Keepa tokens (reserve applies after the first response).`);
  mkdirSync(OUT, { recursive: true });
  const key = process.env.KEEPA_API_KEY ?? '';
  for (const rec of missing) {
    const { data, source, meta, raw } = await rec.run(client);
    if (!raw) throw new Error(`Expected a network response for ${rec.name}.`);
    const text = JSON.stringify(slimKeepaBody(raw), null, 2).split(key).join('REDACTED');
    writeFileSync(join(OUT, `${rec.name}.json`), text);
    const searchHit = 'asinList' in data ? data : null;
    const summary = data.products?.length
      ? data.products.map((p) => `${p.asin} ${p.partNumber ?? '—'} $${centsToDollars(p.amazonPrice) ?? '—'}`).join('; ')
      : (searchHit?.asinList ?? []).join(', ');
    console.log(`  recorded ${rec.name} (${source}, ${meta.tokensConsumed} tokens, ${meta.tokensLeft} left) ${summary}`);
  }
  console.log(`Done. Spent about ${budget.spentThisRun} tokens this session.`);
} catch (err) {
  if (err instanceof KeepaBudgetExceededError || err instanceof NoKeepaKeyError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
} finally {
  release?.();
}