// Nov 25: Home Depot's page state states each product's barcode (identifiers.upc, upcGtin13), and every page the helper
// reads keeps it: the part price record, the catalog entry, a set item's reading. Built on the recorded identifiers of
// 316627328 (DEWALT DCF850B).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { barcodeOf, parseBundlePage, parseProductPage, parsePromoPage } from '../src/hdPage';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { partPricesWanted, readSetItemsFor, savePartPrices } from '../src/scan/runner';
import { type BundleRecord, bundleKey, DEFAULT_SCAN_SETTINGS } from '../src/scan/types';

const rec = JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/identifiers-upc-316627328-2026-11-25.json', import.meta.url), 'utf8')) as {
  stateKey: string;
  identifiers: { brandName: string; modelNumber: string; itemId: string; upc: string; upcGtin13: string };
};
const ITEM = rec.identifiers.itemId;

/** The page text as the helper hands it over: from `window.__APOLLO_STATE__=` on, the recorded identifiers in place. */
const pageText = (ids: Record<string, unknown> = rec.identifiers, extra: Record<string, unknown> = {}): string =>
  `window.__APOLLO_STATE__=${JSON.stringify({
    [rec.stateKey]: {
      identifiers: { ...ids, productLabel: 'ATOMIC 20V MAX Cordless Brushless Compact 1/4 in. Impact Driver (Tool-Only)' },
      'pricing({"storeId":"8119"})': { value: 99, original: 129 },
      details: { descriptiveAttributes: [{ value: 'Tool only' }], description: 'Compact impact driver.' },
      ...extra,
    },
  })};</script>`;

describe('the barcode on a Home Depot page (recorded 316627328)', () => {
  it('reads identifiers.upc and upcGtin13 as one 12-digit UPC-A', () => {
    expect(rec.identifiers.upc).toBe('885911758215');
    expect(barcodeOf({ identifiers: rec.identifiers })).toBe('885911758215');
    expect(barcodeOf({ identifiers: { upcGtin13: rec.identifiers.upcGtin13 } })).toBe('885911758215');
  });

  it('gives none when the two disagree, or neither is a valid barcode', () => {
    expect(barcodeOf({ identifiers: { upc: '885911758215', upcGtin13: '0885911758222' } })).toBeNull();
    expect(barcodeOf({ identifiers: { upc: '885911758216' } })).toBeNull();
    expect(barcodeOf({ identifiers: { upc: null } })).toBeNull();
  });

  it('a product page, a promo page and a bundle page all keep it', () => {
    expect(parseProductPage(pageText(), ITEM)).toMatchObject({ brand: 'DEWALT', model: 'DCF850B', price: 99, upc: '885911758215' });
    expect(parsePromoPage(pageText(), ITEM)).toMatchObject({ model: 'DCF850B', upc: '885911758215' });
    expect(parseBundlePage(pageText(), ITEM)).toEqual({ bullets: ['Tool only'], description: 'Compact impact driver.', upc: '885911758215' });
  });

  it('a page with no barcode has no upc field at all', () => {
    const { upc: _u, upcGtin13: _g, ...ids } = rec.identifiers;
    expect(parseProductPage(pageText(ids), ITEM)).not.toHaveProperty('upc');
    expect(parseBundlePage(pageText(ids), ITEM)).toEqual({ bullets: ['Tool only'], description: 'Compact impact driver.' });
  });
});

describe('the part price record keeps the barcode', () => {
  const found = (over: Record<string, unknown> = {}) => ({
    brand: 'DEWALT', model: 'DCF850B', status: 'found', itemId: ITEM, matchedModel: 'DCF850B', price: 99, title: 't',
    link: `https://www.homedepot.com/p/${ITEM}`, upc: '0885911758215', ...over,
  });

  it('a found reading saves it normalised; a later reading without one keeps it; a not_found keeps it', async () => {
    const store = new MemoryScanStore();
    const asked = [{ brand: 'DEWALT', model: 'DCF850B' }];
    await savePartPrices(store, asked, [found()], 1);
    expect((await store.getPartPrice('DEWALT:DCF850B'))?.upc).toBe('885911758215');
    await savePartPrices(store, asked, [found({ upc: undefined, price: 89 })], 2);
    expect(await store.getPartPrice('DEWALT:DCF850B')).toMatchObject({ price: 89, upc: '885911758215' });
    await savePartPrices(store, asked, [{ ...found(), status: 'not_found', price: null, upc: undefined }], 3);
    expect(await store.getPartPrice('DEWALT:DCF850B')).toMatchObject({ price: 89, checkedAt: 3, upc: '885911758215' });
  });

  it('an invalid barcode is never stored', async () => {
    const store = new MemoryScanStore();
    await savePartPrices(store, [{ brand: 'DEWALT', model: 'DCF850B' }], [found({ upc: '885911758216' })], 1);
    expect(await store.getPartPrice('DEWALT:DCF850B')).not.toHaveProperty('upc');
  });

  it('a set item page read saves the barcode on the item part price record', async () => {
    const store = new MemoryScanStore();
    const set: BundleRecord = {
      key: 'hd:400000001', retailer: 'homedepot', itemId: '400000001', title: 'Set', brand: 'DEWALT', model: '', upc: null, price: 150,
      regularPrice: 200, percentOff: 25, link: null, seenAt: 0, split: null,
      set: { items: [{ itemId: ITEM, quantity: 1 }], dollarOff: 50, percentageOff: 25 },
    } as BundleRecord;
    await store.putBundle(set);
    const page = parsePromoPage(pageText(), ITEM)!;
    const out = await readSetItemsFor({ store, read: async () => [{ itemId: ITEM, kind: 'read', page }], itemIds: [ITEM], now: () => 5 });
    expect(out.read).toBe(1);
    expect(await store.getPartPrice('DEWALT:DCF850B')).toMatchObject({ price: 99, upc: '885911758215' });
  });
});

describe("Home Depot's reading order prefers a part with no Amazon listing and no barcode at a tie", () => {
  it('equal savings: the part with neither is read first; a matched part or one whose barcode is known comes after', async () => {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 't', brand: 'DEWALT', model: 'DCF850B-DCF860B-DCF887B', upc: null, price: 100,
      regularPrice: 150, percentOff: null, link: null, seenAt: 1, split: { components: ['DCF850B', 'DCF860B', 'DCF887B'], status: 'resolved', notes: [] },
    });
    // Without any record, the key decides: DCF850B, DCF860B, DCF887B.
    const before = (await partPricesWanted(store, DEFAULT_SCAN_SETTINGS, 10)).map((p) => p.model);
    expect(before).toEqual(['DCF850B', 'DCF860B', 'DCF887B']);
    // DCF850B is matched on Amazon; DCF860B's barcode is on its catalog entry; DCF887B has neither.
    await store.putMatch({ key: 'DEWALT:DCF850B', brand: 'DEWALT', model: 'DCF850B', status: 'matched', asin: 'B0C1', grade: 'strong', alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null });
    await store.putCatalogEntry({ key: 'DEWALT:DCF860B', brand: 'DEWALT', model: 'DCF860B', title: 't', kinds: [], isKit: false, upc: '885911758215', seenAt: 1 });
    const after = (await partPricesWanted(store, DEFAULT_SCAN_SETTINGS, 10)).map((p) => p.model);
    expect(after).toEqual(['DCF887B', 'DCF850B', 'DCF860B']);
  });
});
