// kitPageTargets builds kitPageTarget's three indexes once for many kits of the same stored records (perf, Nov 25):
// buildReport asked kitPageTarget per bundle with a kit not read, and each call indexed every stored bundle and catalog
// entry three times. This keeps a copy of kitPageTarget as it was and checks the new one, and the report's kitReads,
// give exactly the same answers: on the owner's store after scan 6 (fixtures/e2e-2026-11-23/after-scan6), the same
// store with every bundle stored again under another key, and hand-made records for each kind of answer. No network.

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { kitIndex, kitPageStored, kitPageUnread, kitRecords } from '../src/kitContents';
import { HOME_DEPOT_ITEM_ID, kitCatalog, kitPageTarget, kitPageTargets, type KitPageTarget, pickUnread } from '../src/scan/kitPage';
import { buildReport } from '../src/scan/report';
import { bundleKey, type BundleRecord, type CatalogRecord, DEFAULT_SCAN_SETTINGS, partKey } from '../src/scan/types';

// ---- kitPageTarget before the change, copied as it was
const sameText = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();
function oldKitPageTarget(bundles: BundleRecord[], catalog: CatalogRecord[], brand: string, model: string): KitPageTarget {
  const own = kitIndex(bundles)(brand, model);
  const kits = kitIndex(catalog.filter((c) => c.isKit === true))(brand, model);
  const all = kitIndex(kitRecords(bundles, catalog))(brand, model);
  if (kitPageStored(all, brand, model)) return { kind: 'stored' };
  if (!kitPageUnread(all, brand, model)) return { kind: 'none' };
  if (own.length > 0) {
    const exact = own.find((b) => sameText(b.model, model) && typeof b.itemId === 'string' && HOME_DEPOT_ITEM_ID.test(b.itemId));
    const bundle = exact ?? pickUnread(own);
    return bundle && typeof bundle.itemId === 'string' ? { kind: 'page', where: 'bundle', key: bundle.key, itemId: bundle.itemId } : { kind: 'no-id' };
  }
  const kit = pickUnread(kits);
  return kit && typeof kit.itemId === 'string' ? { kind: 'page', where: 'catalog', key: kit.key, itemId: kit.itemId } : { kind: 'no-id' };
}

const AFTER_SCAN6 = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan6');

/** Every model a kit page could be asked for, as stored and as written otherwise (case, spaces, RYOBI's B twin). */
function asked(bundles: BundleRecord[], catalog: CatalogRecord[]): [string, string][] {
  const out = new Map<string, [string, string]>();
  const add = (brand: string, model: string) => {
    for (const b of [brand, brand.toLowerCase(), ` ${brand} `]) {
      for (const m of [model, model.toLowerCase(), ` ${model} `, `${model}B`, model.endsWith('B') ? model.slice(0, -1) : `${model}BB`]) out.set(`${b}|${m}`, [b, m]);
    }
  };
  for (const b of bundles) {
    add(b.brand, b.model);
    for (const c of b.split?.components ?? []) add(b.brand, c);
    for (const alt of b.split?.alternatives ?? []) for (const c of alt) add(b.brand, c);
  }
  for (const c of catalog) add(c.brand, c.model);
  add('RYOBI', 'NOT-STORED');
  add('MILWAUKEE', 'DCK226D2');
  return [...out.values()];
}

describe('kitPageTargets answers as kitPageTarget did (perf, Nov 25)', () => {
  it('on the owner store after scan 6, for every stored model in every written form', async () => {
    const store = await loadScanFolder(AFTER_SCAN6);
    const bundles = await store.listBundles();
    const catalog = await kitCatalog(store);
    const targetOf = kitPageTargets(bundles, catalog);
    const kinds = new Set<string>();
    for (const [brand, model] of asked(bundles, catalog)) {
      const was = oldKitPageTarget(bundles, catalog, brand, model);
      expect({ brand, model, target: targetOf(brand, model) }).toEqual({ brand, model, target: was });
      expect(kitPageTarget(bundles, catalog, brand, model)).toEqual(was);
      kinds.add(was.kind === 'page' ? `page:${was.where}` : was.kind);
    }
    // The real store reaches every kind of answer but no-id (the hand-made records below reach it).
    expect([...kinds].sort()).toEqual(['none', 'page:bundle', 'page:catalog', 'stored']);
  });

  it('with every bundle stored again under another key, and the report kitReads as the old pick gives them', async () => {
    const store = await loadScanFolder(AFTER_SCAN6);
    for (const b of await store.listBundles()) await store.putBundle({ ...b, key: `homedepot:${b.itemId}01`, itemId: `${b.itemId}01` });
    const bundles = await store.listBundles();
    const catalog = await kitCatalog(store);
    const targetOf = kitPageTargets(bundles, catalog);
    for (const [brand, model] of asked(bundles, catalog)) expect(targetOf(brand, model)).toEqual(oldKitPageTarget(bundles, catalog, brand, model));
    const report = await buildReport(store, DEFAULT_SCAN_SETTINGS);
    const withKits = report.bundles.filter((r) => r.kitsNotRead.length > 0);
    expect(withKits).toHaveLength(8);
    for (const r of report.bundles) {
      const want = r.kitsNotRead.flatMap((model) => {
        const t = oldKitPageTarget(bundles, catalog, r.brand, model);
        return t.kind === 'page' ? [{ model, itemId: t.itemId }] : [];
      });
      expect(r.kitReads).toEqual(want);
    }
  });

  const T0 = Date.UTC(2026, 10, 20, 12);
  const cat = (model: string, itemId: string | null, page = false, isKit = true): CatalogRecord => ({
    key: partKey('RYOBI', model), brand: 'RYOBI', model, title: model, kinds: [], isKit, upc: null, seenAt: T0,
    ...(itemId === null ? {} : { itemId }),
    ...(page ? { page: { bullets: ['Includes: (1) PCL206 Drill'], description: null, readAt: T0 } } : {}),
  });
  const bun = (itemId: string, model: string, page = false): BundleRecord => ({
    key: bundleKey(itemId), retailer: 'homedepot', itemId, title: model, brand: 'RYOBI', model, upc: null, price: 100, regularPrice: null,
    percentOff: null, link: null, seenAt: T0, split: null, ...(page ? { page: { bullets: [], description: null, readAt: T0 } } : {}),
  });

  it('on hand-made records of each kind, in stored order, with ids skipped and twins', () => {
    const bundles = [bun('9', 'PCL1600K2B'), bun('abc', 'PCL1600K2'), bun('3', 'PCL1600K2'), bun('4', 'PSK005', true), bun('5', 'P1819')];
    const catalog = [
      cat('PCL1201K2', '317987584'), cat('PCL1201K2B', '2'), cat('PSK005', '6'), cat('A1', null), cat('A2', 'x'), cat('P1819', '7', false, false),
      cat('PBP2003', '8', true), cat('PBP2003B', '10'),
    ];
    const targetOf = kitPageTargets(bundles, catalog);
    for (const [brand, model] of asked(bundles, catalog)) expect(targetOf(brand, model)).toEqual(oldKitPageTarget(bundles, catalog, brand, model));
    expect(targetOf('RYOBI', 'PCL1201K2')).toEqual({ kind: 'page', where: 'catalog', key: partKey('RYOBI', 'PCL1201K2'), itemId: '317987584' });
    expect(targetOf('ryobi', ' pcl1600k2 ')).toEqual({ kind: 'page', where: 'bundle', key: bundleKey('3'), itemId: '3' });
    expect(targetOf('RYOBI', 'A1')).toEqual({ kind: 'no-id' });
    expect(targetOf('RYOBI', 'PCL1600K2')).toEqual({ kind: 'page', where: 'bundle', key: bundleKey('3'), itemId: '3' });
    expect(kitPageTargets([], [])('RYOBI', 'PCL1201K2')).toEqual({ kind: 'none' });
  });
});
