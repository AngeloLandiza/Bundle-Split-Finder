// The owner's data as the sanity checks see it: fixtures/e2e-2026-11-23/after-scan5, and the same store with the wrong
// confirmation the owner caught on Nov 24 put back in (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json): set
// 339422000's adaptor plate DWST08017 read ($39.99), the set split into its two items, and DWST08017 matched by the catalog
// rule to B0DGLWKS9S, a $389 DWST60122-1 backpack. The report is then built by the app's own code (buildReport), so the
// estimate is the one the app would show. Free; no network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadScanFolder } from '../../scripts/data-folder';
import { buildReport } from '../src/scan/report';
import type { MemoryScanStore } from '../src/scan/memoryStore';
import { DEFAULT_SCAN_SETTINGS, type BundleRow, type MatchRecord } from '../src/scan/types';

export const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
export const AFTER_SCAN5 = join(FIXTURES, 'e2e-2026-11-23', 'after-scan5');
export const AFTER_SCAN3 = join(FIXTURES, 'e2e-2026-11-23', 'after-scan3');
export const WRONG_FIXTURE = join(FIXTURES, 'keepa', 'catalog-wrong-part-number-B0DGLWKS9S.json');
/** The set the wrong listing reached. */
export const WRONG_SET = 'homedepot:339422000';

interface WrongFixture {
  wanted: { brand: string; model: string; homeDepotPriceSoldAlone: number };
  product: { asin: string; title: string; brand: string };
  amazonPrice: number;
  match: Pick<MatchRecord, 'key' | 'status' | 'asin' | 'grade' | 'verifiedBy' | 'alternatives' | 'verifyEvidence'>;
}

export const wrongFixture = (): WrongFixture => JSON.parse(readFileSync(WRONG_FIXTURE, 'utf8')) as WrongFixture;

/** The stored deals of a data folder (store/deals.json), as the app showed them. */
export function storedDeals(dir: string): BundleRow[] {
  return (JSON.parse(readFileSync(join(dir, 'store', 'deals.json'), 'utf8')) as { bundles: BundleRow[] }).bundles;
}

/** after-scan5's scan store with the Nov 24 wrong confirmation in it. */
export async function storeWithWrongListing(): Promise<MemoryScanStore> {
  const store = await loadScanFolder(AFTER_SCAN5);
  const w = wrongFixture();
  const at = 1795540000000;
  const set = (await store.getBundle(WRONG_SET))!;
  const items = set.set!.items.map((i) =>
    i.itemId === '322961591'
      ? { ...i, brand: w.wanted.brand, model: w.wanted.model, title: 'Adaptor Plate for TOUGHSYSTEM 2.0', price: w.wanted.homeDepotPriceSoldAlone, readAt: at }
      : i,
  );
  await store.putBundle({
    ...set, set: { ...set.set!, items },
    split: { components: [w.wanted.model, 'DWST14925'], status: 'resolved', notes: ['set items read'] },
  });
  await store.putPartPrice({
    key: `${w.wanted.brand}:${w.wanted.model}`, brand: w.wanted.brand, model: w.wanted.model, itemId: '322961591', matchedModel: w.wanted.model,
    price: w.wanted.homeDepotPriceSoldAlone, title: 'Adaptor Plate for TOUGHSYSTEM 2.0', link: 'https://www.homedepot.com/p/322961591', seenAt: at, checkedAt: at,
  });
  await store.putListing({ asin: w.product.asin, brand: w.product.brand, title: w.product.title, models: [], image: null, price: w.amazonPrice, reviews: null, seenAt: at, checkedAt: at });
  await store.putPrice({ asin: w.product.asin, price: w.amazonPrice, reviews: null, seenAt: at, checkedAt: at });
  await store.putMatch({
    ...w.match, brand: w.wanted.brand, model: w.wanted.model, decidedBy: 'auto', updatedAt: at, waitingSince: null, source: 'page',
    catalogChecks: [{ asin: w.product.asin, status: 'confirmed', reason: 'Amazon\'s catalog lists brand DEWALT, part number DWST08017', at }],
  } as MatchRecord);
  return store;
}

/** The report's deals for a store, built as the app builds them. */
export async function dealsOf(store: MemoryScanStore): Promise<BundleRow[]> {
  return (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles;
}
