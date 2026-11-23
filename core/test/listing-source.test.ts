import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseSearchState } from '../src/hdPage';
import {
  BUNDLE_LISTING_PAGES_MAX, bundleListingPath, chooseListingSource, isBundleListingPath, LISTING_ITEM_MAX_AGE_MS, readBundleListings, type ListingSourceDeps, type SourceInput,
} from '../src/scan/listingSource';
import { MemoryCache } from '../src/serpapi/client';
import { BRAND_QUERIES } from '../src/settings';
import { HOME_DEPOT, itemCacheKey, type ListedItem, type PromoPageOutcome } from '../src/tracking/bogoPairs';

// The free listing source (core/src/scan/listingSource.ts) with fake readers on the recorded listing shape: each page is a
// recorded search page's `window.__APOLLO_STATE__` (fixtures/homedepot-pages/research-2026-11-20.json, 12
// `base-searchNav-<id>` entries each), read by hdPage.ts parseSearchState as the helper's reader reads it.

const RESEARCH = JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/research-2026-11-20.json', import.meta.url), 'utf8')) as {
  searches: Record<string, { state: unknown }>;
};
const page = (q: string): ListedItem[] => parseSearchState(RESEARCH.searches[q]!.state, HOME_DEPOT);
const P1 = page('ryobi pcl500');
const P2 = page('PCL1600K2');
const DEWALT = page('dewalt dck240c2');
const T0 = Date.UTC(2026, 10, 23, 12);

/** A product page reading for an item, as the promo page reader gives it (parsePromoPage's shape). */
const read = (p: ListedItem, price = 199, wasPrice: number | null = 249): PromoPageOutcome => ({
  itemId: p.itemId, kind: 'read',
  page: { itemId: p.itemId, brand: p.brand, model: p.model, title: p.title, price, wasPrice, bullets: [`Includes: ${p.model}`], description: null, promotions: [] },
});

/** Listing pages by brand token and offset; a `refuse` path throws as the helper's reader does for a refusal. */
function fakes(pages: Record<string, ListedItem[][]>, opts: { refuse?: string; refuseItem?: string } = {}) {
  const asked: string[] = [];
  const itemsAsked: string[][] = [];
  const all = new Map(Object.values(pages).flat(2).map((p) => [p.itemId, p] as const));
  const deps = (over: Partial<ListingSourceDeps> = {}): ListingSourceDeps => ({
    brands: ['DEWALT', 'RYOBI'], queries: BRAND_QUERIES, now: () => T0,
    readListing: async (path) => {
      asked.push(path);
      if (path === opts.refuse) throw new Error('Home Depot refused the bundle list (HTTP 403).');
      const brand = path.includes('Zm5d/') ? 'RYOBI' : 'DEWALT';
      const offset = Number(/Nao=(\d+)/.exec(path)?.[1] ?? 0);
      const list = (pages[brand] ?? []).flat();
      return list.slice(offset, offset + 12);
    },
    readPages: async (ids) => {
      itemsAsked.push(ids);
      return ids.map((id) => (id === opts.refuseItem ? { itemId: id, kind: 'refused', status: 403 } : read(all.get(id)!)));
    },
    ...over,
  });
  return { deps, asked, itemsAsked };
}

describe('the Bundle listing address', () => {
  it('is the address checked live in the owner\'s Chrome, with Nao for later pages', () => {
    expect(bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, 0)).toBe('/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5');
    expect(bundleListingPath('ryobi', BRAND_QUERIES.RYOBI, 12)).toBe('/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5&Nao=12');
    expect(bundleListingPath('DEWALT', BRAND_QUERIES.DEWALT, 0)).toBe('/b/N-5yc1vZbwo64Z4j2/Ntk-elasticplus/Ntt-dewalt%2B20v%2Bcombo%2Bkit?NCNI-5');
    expect(bundleListingPath('MAKITA', 'makita combo kit', 0)).toBeNull();
  });

  it('is the only kind of address the reader accepts (security review M2: no other path reaches the helper)', () => {
    expect(isBundleListingPath(bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, 24))).toBe(true);
    for (const bad of [
      '/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-ryobi%2B18v?NCNI-5', '/b/N-5yc1vZbwo64Zm5dZ123/Ntk-elasticplus/Ntt-x?NCNI-5',
      '/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi?NCNI-5&redirect=x', '//evil.example/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-x?NCNI-5',
      '/p/317987584', 'https://www.homedepot.com/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-x?NCNI-5', 42,
    ]) expect(isBundleListingPath(bad)).toBe(false);
  });
});

describe('readBundleListings with fake readers on the recorded listing shape', () => {
  it('reads every page until one adds nothing: 24 RYOBI bundles in 3 pages, as the live listing did', async () => {
    const f = fakes({ RYOBI: [P1, P2], DEWALT: [DEWALT] });
    const r = await readBundleListings(f.deps({ brands: ['RYOBI'] }));
    expect(f.asked).toEqual([0, 12, 24].map((o) => bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, o)));
    expect(r.brands).toEqual([{ brand: 'RYOBI', query: BRAND_QUERIES.RYOBI, pages: 3, listed: 24, complete: true }]);
    expect(r.rows.map((x) => x.itemId)).toEqual([...P1, ...P2].map((p) => p.itemId));
    expect(r).toMatchObject({ listingPages: 3, itemPagesRead: 24, itemPagesLeft: 0, problem: null, refused: false });
  });

  it('stops at its cap when a listing never ends', async () => {
    let n = 0;
    const endless: ListingSourceDeps['readListing'] = async () => P1.map((p) => ({ ...p, itemId: String(400000000 + n++) }));
    const r = await readBundleListings({ ...fakes({}).deps({ brands: ['RYOBI'] }), readListing: endless, readPages: async () => [] });
    expect(r.brands[0]).toMatchObject({ pages: BUNDLE_LISTING_PAGES_MAX, complete: false });
  });

  it('dedupes: an item a page repeats moves the offset by the new ones only, and one item listed by both brands is one row', async () => {
    // RYOBI's page 2 repeats 4 of page 1; DEWALT's list carries one RYOBI item too.
    const repeat = [...P1.slice(0, 4), ...P2.slice(0, 8)];
    const f = fakes({ RYOBI: [P1, repeat], DEWALT: [[P1[0]!, ...DEWALT.slice(0, 11)]] });
    const r = await readBundleListings(f.deps());
    expect(r.rows).toHaveLength(12 + 11 + 8);
    expect(new Set(r.rows.map((x) => x.itemId)).size).toBe(r.rows.length);
    expect(r.brands.map((b) => [b.brand, b.listed])).toEqual([['DEWALT', 12], ['RYOBI', 19]]);
    // Each listing still pages by its own items: RYOBI's third page starts at 20 (12 + 8 new).
    expect(f.asked.filter((p) => p.includes('Zm5d/'))).toEqual([0, 12, 20].map((o) => bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, o)));
  });

  it('a refusal mid-listing keeps what was read, reads nothing more, and says why', async () => {
    const f = fakes({ RYOBI: [P1, P2], DEWALT: [DEWALT] }, { refuse: bundleListingPath('DEWALT', BRAND_QUERIES.DEWALT, 12)! });
    const r = await readBundleListings(f.deps());
    expect(r.refused).toBe(true);
    expect(r.problem).toBe('Home Depot refused the bundle list (HTTP 403).');
    // DEWALT's first page is kept; RYOBI is never asked, nor any item page.
    expect(f.asked.some((p) => p.includes('Zm5d/'))).toBe(false);
    expect(f.itemsAsked).toEqual([]);
    expect(r.rows.map((x) => x.itemId)).toEqual(DEWALT.map((p) => p.itemId));
    expect(r.rows.every((x) => x.price === null && x.page === null)).toBe(true);
    expect(r.brands.map((b) => [b.brand, b.pages, b.complete])).toEqual([['DEWALT', 1, false], ['RYOBI', 0, false]]);
  });

  it('a refused item page keeps the prices read before it and reads no later batch', async () => {
    const f = fakes({ RYOBI: [P1, P2, P1.map((p) => ({ ...p, itemId: `5${p.itemId.slice(1)}` }))] }, { refuseItem: P1[3]!.itemId });
    const r = await readBundleListings(f.deps({ brands: ['RYOBI'] }));
    expect(f.itemsAsked).toHaveLength(1);
    expect(r).toMatchObject({ refused: true, problem: 'Home Depot refused a bundle page.' });
    expect(r.rows.filter((x) => x.price !== null)).toHaveLength(24);
    expect(r.itemPagesLeft).toBe(12);
  });

  it('a row carries the listing\'s identifiers and the page\'s price, was-price, percent off and reading', async () => {
    const r = await readBundleListings(fakes({ RYOBI: [P1] }).deps({ brands: ['RYOBI'] }));
    const first = P1[0]!;
    expect(r.rows[0]).toEqual({
      itemId: first.itemId, title: first.title, brand: 'RYOBI', model: first.model, price: 199, regularPrice: 249, percentOff: 20, badge: null, link: first.url,
      page: { bullets: [`Includes: ${first.model}`], description: null, readAt: T0 },
    });
  });

  it('a page read in the last six hours, by this pass or the BOGO pass, is not read again; an older one is', async () => {
    const cache = new MemoryCache();
    const f = fakes({ RYOBI: [P1] });
    await readBundleListings(f.deps({ brands: ['RYOBI'], cache }));
    expect(f.itemsAsked.flat()).toHaveLength(12);
    expect(await cache.get(itemCacheKey(P1[0]!.itemId))).toBeDefined();
    const again = await readBundleListings(f.deps({ brands: ['RYOBI'], cache, now: () => T0 + LISTING_ITEM_MAX_AGE_MS }));
    expect(f.itemsAsked.flat()).toHaveLength(12);
    expect(again).toMatchObject({ itemPagesCached: 12, itemPagesRead: 0 });
    expect(again.rows[0]!.price).toBe(199);
    const later = await readBundleListings(f.deps({ brands: ['RYOBI'], cache, now: () => T0 + LISTING_ITEM_MAX_AGE_MS + 1 }));
    expect(later.itemPagesRead).toBe(12);
  });

  it('reads at most the item cap now; the rest wait without a price', async () => {
    const r = await readBundleListings(fakes({ RYOBI: [P1, P2] }).deps({ brands: ['RYOBI'], itemPagesMax: 10 }));
    expect(r).toMatchObject({ itemPagesRead: 10, itemPagesLeft: 14, refused: false, problem: '14 bundle pages wait for the next scan (at most 10 a scan).' });
  });
});

describe('chooseListingSource', () => {
  const base: SourceInput = { setting: 'auto', chromeConnected: true, trigger: 'scheduled', serpWhenChromeClosed: false, serpCanPay: true };
  it('auto: Chrome when the helper is connected, whoever started the scan', () => {
    expect(chooseListingSource(base)).toEqual({ source: 'chrome' });
    expect(chooseListingSource({ ...base, trigger: 'manual' })).toEqual({ source: 'chrome' });
  });
  it('auto, Chrome closed: a scheduled scan waits for Chrome unless the owner allowed SerpApi', () => {
    const closed = { ...base, chromeConnected: false };
    expect(chooseListingSource(closed)).toEqual({ source: 'wait', why: 'Chrome closed' });
    expect(chooseListingSource({ ...closed, serpWhenChromeClosed: true })).toEqual({ source: 'serpapi' });
    expect(chooseListingSource({ ...closed, serpWhenChromeClosed: true, serpCanPay: false })).toEqual({ source: 'none', why: 'no searches left' });
  });
  it('auto, Chrome closed: a scan the owner starts searches when the budget allows', () => {
    const closed = { ...base, chromeConnected: false, trigger: 'manual' as const };
    expect(chooseListingSource(closed)).toEqual({ source: 'serpapi' });
    expect(chooseListingSource({ ...closed, serpCanPay: false })).toEqual({ source: 'none', why: 'no searches left' });
  });
  it('chrome: never a search', () => {
    expect(chooseListingSource({ ...base, setting: 'chrome' })).toEqual({ source: 'chrome' });
    expect(chooseListingSource({ ...base, setting: 'chrome', chromeConnected: false, serpWhenChromeClosed: true })).toEqual({ source: 'wait', why: 'Chrome closed' });
    expect(chooseListingSource({ ...base, setting: 'chrome', chromeConnected: false, trigger: 'manual' })).toEqual({ source: 'none', why: 'Chrome closed' });
  });
  it('serpapi: SerpApi even with Chrome open, while a search can pay', () => {
    expect(chooseListingSource({ ...base, setting: 'serpapi' })).toEqual({ source: 'serpapi' });
    expect(chooseListingSource({ ...base, setting: 'serpapi', serpCanPay: false })).toEqual({ source: 'none', why: 'no searches left' });
  });
});
