import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { parseBundlePage } from '../src/hdPage';
import { kitCatalog, partPriceKits } from '../src/scan/kitPage';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { kitPagesWanted, plannedWork, readKitPagesFor } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type PageOutcome, type PartPriceRecord, partKey, type ReadPages } from '../src/scan/types';

// Nov 23, the owner's third real scan: DCK200D1P1, the DEWALT starter kit in 14 of his bundles, has no Amazon listing,
// and nothing knew it is a kit: no listing page showed it, so it has no catalog entry, its page was never read, and its
// items were never looked up. Home Depot's own page for it was read for its price (334337675, "2-Tool Combo Kit ... and
// Kit Bag"). Real data only (fixtures/e2e-2026-11-23/after-scan3, the recorded page 317987591); nothing reaches the network.

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3');
const T0 = Date.UTC(2026, 10, 23, 12);

const PAGES = (
  JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as { pages: { itemId: string; text: string }[] }
).pages;
const recordedPages = (asked: string[]): ReadPages => async (ids) => ids.map((itemId): PageOutcome => {
  asked.push(itemId);
  const rec = PAGES.find((p) => p.itemId === itemId);
  const content = rec ? parseBundlePage(rec.text, itemId) : null;
  return content ? { itemId, kind: 'read', content } : { itemId, kind: 'unreadable' };
});

describe('a kit named only by Home Depot\'s part page', () => {
  it('DCK200D1P1 is a kit whose page can be read, from its part-price reading; a kit the catalog holds is not added twice', async () => {
    const store = await loadScanFolder(DIR);
    const added = partPriceKits(await store.listPartPrices(), await store.listCatalog());
    expect(added.map((k) => [k.model, k.itemId, k.isKit, k.page])).toEqual([['DCK200D1P1', '334337675', true, null], ['DCK540D1', '343971918', true, null]]);
    // PCL1600K2, PCL1400K2 and DCK225D2 have catalog entries already; a tool's part page (DCF921B) is no kit.
    expect((await kitCatalog(store)).length).toBe((await store.listCatalog()).length + 2);
  });

  it('the report names it as a kit whose page is not read, with the item id to read, and the next scan reads it', async () => {
    const store = await loadScanFolder(DIR);
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.model === 'DCK200D1P1W921B')!;
    expect(row.kitsNotRead).toEqual(['DCK200D1P1']);
    expect(row.kitReads).toEqual([{ model: 'DCK200D1P1', itemId: '334337675' }]);
    expect((await kitPagesWanted(store)).map((k) => [k.model, k.itemId])).toContainEqual(['DCK200D1P1', '334337675']);
  });

  it('between scans, only the pages of kits with no listing for sale are read: DCK200D1P1, not DCK540D1 (matched, for sale)', async () => {
    const store = await loadScanFolder(DIR);
    const asked: string[] = [];
    // Its page is not among the recorded ones: unreadable, so nothing is saved and it is asked again next time.
    expect(await readKitPagesFor({ store, readPages: recordedPages(asked), now: () => T0 })).toBe(0);
    expect(asked).toEqual(['334337675']);
    expect(await store.getCatalogEntry(partKey('DEWALT', 'DCK200D1P1'))).toBeUndefined();
  });

  it('PCL1600K2 with only its part-price reading: its page is read, saved as a catalog kit, and its items are then planned for lookup', async () => {
    const real = await loadScanFolder(DIR);
    const part = (await real.getPartPrice(partKey('RYOBI', 'PCL1600K2'))) as PartPriceRecord;
    const store = new MemoryScanStore();
    await store.putPartPrice(part);
    await store.putBundle({
      key: bundleKey('320243741'), retailer: 'homedepot', itemId: '320243741', title: 'PCL1600K2-P553', brand: 'RYOBI', model: 'PCL1600K2-P553', upc: null,
      price: 388, regularPrice: 577, percentOff: 33, link: null, seenAt: T0, split: { components: ['PCL1600K2', 'P553'], status: 'resolved', notes: [] },
    });
    // Looked up, no Amazon listing found: the kit does not sell whole.
    for (const model of ['PCL1600K2', 'P553']) {
      await store.putMatch({ key: partKey('RYOBI', model), brand: 'RYOBI', model, status: 'none', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
    }
    expect((await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles[0]!.kitsNotRead).toEqual(['PCL1600K2']);
    const asked: string[] = [];
    expect(await readKitPagesFor({ store, readPages: recordedPages(asked), now: () => T0 })).toBe(1);
    expect(asked).toEqual(['317987591']);
    expect(await store.getCatalogEntry(partKey('RYOBI', 'PCL1600K2'))).toMatchObject({ isKit: true, itemId: '317987591', page: { readAt: T0 } });
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles[0]!;
    expect(row.kitsNotRead).toEqual([]);
    expect(row.options.map((o) => o.id)).toEqual(['whole', 'split:PCL1600K2']);
    expect(row.options[1]!.kitParts).toEqual({ PCL1600K2: 19 });
    const { work } = await plannedWork(store, DEFAULT_SCAN_SETTINGS, T0);
    expect(work.lookups).toEqual(expect.arrayContaining(['PCL206', 'PCL235', 'PCL500', 'PCL515', 'PCL430', 'PCL660', 'PBP005', 'PBP002'].map((m) => partKey('RYOBI', m))));
    // Read once: nothing more to read.
    expect(await readKitPagesFor({ store, readPages: recordedPages(asked), now: () => T0 })).toBe(0);
  });
});
