import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseListingText, parseSearchState, SAMPLE_CHARS } from '../src/hdPage';
import {
  brandOfListingPath, BUNDLE_LISTING_PAGES_MAX, LISTING_PAGES_PER_SCAN, bundleListingPath, chooseListingSource, isBundleListingPath, LIST_EMPTY, listCounts, LISTING_ITEM_MAX_AGE_MS, readBundleListings, searchListingPath, withNao, type ListingSourceDeps, type SourceInput,
} from '../src/scan/listingSource';
import { MemoryCache } from '../src/serpapi/client';
import { HD_LIST_REREAD_MS } from '../src/scan/hdPace';
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

/**
 * Listing pages by list and offset: `RYOBI` is the list with the search words, `RYOBI:all` the list without them (by
 * default the same items as the query's list, so it adds none); a `refuse` path throws as the helper's reader does.
 */
function fakes(pages: Record<string, ListedItem[][]>, opts: { refuse?: string; refuseItem?: string } = {}) {
  const asked: string[] = [];
  const itemsAsked: string[][] = [];
  const all = new Map(Object.values(pages).flat(2).map((p) => [p.itemId, p] as const));
  const deps = (over: Partial<ListingSourceDeps> = {}): ListingSourceDeps => ({
    brands: ['DEWALT', 'RYOBI'], queries: BRAND_QUERIES, now: () => T0,
    readListing: async (path) => {
      asked.push(path);
      if (path === opts.refuse) throw new Error('Home Depot refused the bundle list (HTTP 403).');
      const brand = path.includes('Zm5d') || path.startsWith('/s/ryobi') ? 'RYOBI' : 'DEWALT';
      // Fix round 3: the plain keyword search (`RYOBI:search`), by default the query list's items again (it adds none).
      const list = path.startsWith('/s/') ? `${brand}:search` : path.includes('/Ntt-') ? brand : `${brand}:all`;
      const offset = Number(/Nao=(\d+)/.exec(path)?.[1] ?? 0);
      const items = (pages[list] ?? pages[brand] ?? []).flat();
      return { products: items.slice(offset, offset + 12), ...(items.length === 0 ? { note: 'its state had 40 entries, none a product' } : {}) };
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
  it('is the address checked live in the owner\'s Chrome, with Nao for later pages, and the brand list without search words', () => {
    expect(bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, 0)).toBe('/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5');
    expect(bundleListingPath('ryobi', BRAND_QUERIES.RYOBI, 12)).toBe('/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi%2B18v%2Bcombo%2Bkit?NCNI-5&Nao=12');
    expect(bundleListingPath('DEWALT', BRAND_QUERIES.DEWALT, 0)).toBe('/b/N-5yc1vZbwo64Z4j2/Ntk-elasticplus/Ntt-dewalt%2B20v%2Bcombo%2Bkit?NCNI-5');
    expect(bundleListingPath('DEWALT', null, 0)).toBe('/b/N-5yc1vZbwo64Z4j2');
    expect(bundleListingPath('DEWALT', null, 24)).toBe('/b/N-5yc1vZbwo64Z4j2?Nao=24');
    expect(bundleListingPath('MAKITA', 'makita combo kit', 0)).toBeNull();
    expect(brandOfListingPath('/b/N-5yc1vZbwo64Z4j2?Nao=24')).toBe('DEWALT');
  });

  it('is the only kind of address the reader accepts (security review M2: no other path reaches the helper)', () => {
    expect(isBundleListingPath(bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, 24))).toBe(true);
    expect(isBundleListingPath(bundleListingPath('RYOBI', null, 12))).toBe(true);
    for (const bad of [
      '/b/Featured-BOGO/N-5yc1vZ1z24hvk/Ntk-elasticplus/Ntt-ryobi%2B18v?NCNI-5', '/b/N-5yc1vZbwo64Zm5dZ123/Ntk-elasticplus/Ntt-x?NCNI-5',
      '/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-ryobi?NCNI-5&redirect=x', '//evil.example/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-x?NCNI-5',
      '/b/N-5yc1vZbwo64Zm5d?redirect=x', '/b/N-5yc1vZbwo64Zm5d/', '/b/N-5yc1vZbwo64Zm5d?Nao=12&Nao=24',
      '/b/RYOBI/Bundle/N-5yc1vZm5dZ1z24hvk', '/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64Z4j2', '/b/RYOBI/Bundle/N-5yc1vZm5d', '/b/a/b/c/d/N-5yc1vZm5dZbwo64',
      '/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64?searchRedirect=ryobi', '/b/RY%2FOBI/Bundle/N-5yc1vZm5dZbwo64',
      '/p/317987584', 'https://www.homedepot.com/b/N-5yc1vZbwo64Zm5d/Ntk-elasticplus/Ntt-x?NCNI-5', 42,
    ]) expect(isBundleListingPath(bad)).toBe(false);
  });
});

describe('readBundleListings with fake readers on the recorded listing shape', () => {
  it('reads every page until one adds nothing, with the search words and then without them', async () => {
    const f = fakes({ RYOBI: [P1, P2] });
    const r = await readBundleListings(f.deps({ brands: ['RYOBI'] }));
    expect(f.asked).toEqual([
      ...[0, 12, 24].map((o) => bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, o)),
      ...[0, 12, 24].map((o) => bundleListingPath('RYOBI', null, o)),
      // Fix round 3: then the plain keyword search, to its page limit.
      ...[0, 12].map((o) => searchListingPath(BRAND_QUERIES.RYOBI, o)),
    ]);
    expect(f.asked.at(-1)).toBe('/s/ryobi+18v+combo+kit?NCNI-5&Nao=12');
    expect(r.lists).toEqual([
      { brand: 'RYOBI', source: 'bundle', query: BRAND_QUERIES.RYOBI, pages: 3, listed: 24, added: 24, complete: true, empty: false, total: null, cut: false },
      { brand: 'RYOBI', source: 'bundle', query: null, pages: 3, listed: 24, added: 0, complete: true, empty: false, total: null, cut: false },
      { brand: 'RYOBI', source: 'search', query: BRAND_QUERIES.RYOBI, pages: 2, listed: 24, added: 0, complete: false, empty: false, total: null, cut: true },
    ]);
    expect(r.rows.map((x) => x.itemId)).toEqual([...P1, ...P2].map((p) => p.itemId));
    expect(r).toMatchObject({ listingPages: 8, itemPagesRead: 24, itemPagesLeft: 0, problem: null, refused: false });
  });

  it('the union: the list without search words adds what the query\'s list did not show, and the counts say which listed more', async () => {
    const f = fakes({ DEWALT: [DEWALT.slice(0, 3)], 'DEWALT:all': [DEWALT, P1] });
    const r = await readBundleListings(f.deps({ brands: ['DEWALT'] }));
    expect(r.lists.map((l) => [l.source, l.query, l.listed, l.added])).toEqual([['bundle', BRAND_QUERIES.DEWALT, 3, 3], ['bundle', null, 24, 21], ['search', BRAND_QUERIES.DEWALT, 3, 0]]);
    expect(r.rows).toHaveLength(24);
    expect(listCounts(r.lists)).toBe(
      'DEWALT list for "dewalt 20v combo kit": 3 (2 pages), 3 new; DEWALT list without search words: 24 (3 pages), 21 new; DEWALT search for "dewalt 20v combo kit": 3 (2 pages), 0 new',
    );
  });

  it('stops at its cap when a listing never ends', async () => {
    let n = 0;
    const endless: ListingSourceDeps['readListing'] = async () => ({ products: P1.map((p) => ({ ...p, itemId: String(400000000 + n++) })) });
    const r = await readBundleListings({ ...fakes({}).deps({ brands: ['RYOBI'] }), readListing: endless, readPages: async () => [] });
    expect(r.lists[0]).toMatchObject({ pages: BUNDLE_LISTING_PAGES_MAX, complete: false });
  });

  it('dedupes: an item a page repeats moves the offset by the new ones only, and one item listed by both brands is one row', async () => {
    // RYOBI's page 2 repeats 4 of page 1; DEWALT's list carries one RYOBI item too.
    const repeat = [...P1.slice(0, 4), ...P2.slice(0, 8)];
    const f = fakes({ RYOBI: [P1, repeat], DEWALT: [[P1[0]!, ...DEWALT.slice(0, 11)]] });
    const r = await readBundleListings(f.deps());
    expect(r.rows).toHaveLength(12 + 11 + 8);
    expect(new Set(r.rows.map((x) => x.itemId)).size).toBe(r.rows.length);
    expect(r.lists.filter((l) => l.source === 'bundle' && l.query !== null).map((b) => [b.brand, b.listed, b.added])).toEqual([['DEWALT', 12, 12], ['RYOBI', 20, 19]]);
    // Each page moves the offset by the entries it returned (fix round 2): RYOBI's third page starts at 24.
    expect(f.asked.filter((p) => p.includes('Zm5d/'))).toEqual([0, 12, 24].map((o) => bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, o)));
  });

  it('a list whose first page has its state but no product is a problem said in words, not "no bundles"; the other lists are read', async () => {
    const f = fakes({ DEWALT: [], 'DEWALT:all': [DEWALT], RYOBI: [], 'RYOBI:all': [] });
    const r = await readBundleListings(f.deps());
    expect(r.refused).toBe(false);
    expect(r.lists.map((l) => [l.brand, l.source, l.query === null, l.empty])).toEqual([
      ['DEWALT', 'bundle', false, true], ['DEWALT', 'bundle', true, false], ['DEWALT', 'search', false, true],
      ['RYOBI', 'bundle', false, true], ['RYOBI', 'bundle', true, true], ['RYOBI', 'search', false, true],
    ]);
    expect(r.rows).toHaveLength(12);
    expect(r.problem).toContain(`${LIST_EMPTY}: the DEWALT list for "dewalt 20v combo kit" had no product (its state had 40 entries, none a product).`);
    expect(r.problem).toContain(`${LIST_EMPTY}: the RYOBI list without search words had no product`);
  });

  it('a refusal mid-listing keeps what was read, reads nothing more, and says why', async () => {
    const f = fakes({ RYOBI: [P1, P2], DEWALT: [DEWALT] }, { refuse: bundleListingPath('DEWALT', BRAND_QUERIES.DEWALT, 12)! });
    const r = await readBundleListings(f.deps());
    expect(r.refused).toBe(true);
    expect(r.problem).toBe('Home Depot refused the bundle list (HTTP 403).');
    // DEWALT's first page is kept; nothing else is asked, nor any item page.
    expect(f.asked).toHaveLength(2);
    expect(f.itemsAsked).toEqual([]);
    expect(r.rows.map((x) => x.itemId)).toEqual(DEWALT.map((p) => p.itemId));
    expect(r.rows.every((x) => x.price === null && x.page === null)).toBe(true);
    expect(r.lists.map((b) => [b.brand, b.pages, b.complete])).toEqual([['DEWALT', 1, false], ['DEWALT', 0, false], ['DEWALT', 0, false], ['RYOBI', 0, false], ['RYOBI', 0, false], ['RYOBI', 0, false]]);
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
      page: { bullets: [`Includes: ${first.model}`], description: null, readAt: T0 }, bogo: false,
    });
  });

  it('a listing entry with its own pricing gives the price and the BOGO flag: no item page is read for it', async () => {
    const promo = { promotionId: '945815', startsAt: '2026-10-26', endsAt: '2027-01-31', description: 'Purchase Select Ryobi Starter Kit and receive a select FREE Tool' };
    const priced = P1.map((p, i) => (i < 4 ? { ...p, price: 179, wasPrice: 268, promotions: i === 0 ? [promo] : [] } : p));
    const f = fakes({ RYOBI: [priced] });
    const r = await readBundleListings(f.deps({ brands: ['RYOBI'] }));
    expect(r.pricedByList).toBe(4);
    expect(f.itemsAsked.flat()).toEqual(P1.slice(4).map((p) => p.itemId));
    expect(r.rows[0]).toMatchObject({ price: 179, regularPrice: 268, percentOff: 33, page: null, bogo: true });
    expect(r.rows[1]).toMatchObject({ price: 179, bogo: false });
  });

  it('a page read in the last six hours, by this pass or the BOGO pass, is not read again; an older one is', async () => {
    // The item readings only: the lists' own cursors (read again a day later, Home Depot's pace) are not kept here.
    const kept = new MemoryCache();
    const cache = { get: (k: string) => kept.get(k), set: async (k: string, e: Parameters<MemoryCache['set']>[1]) => (k.startsWith('homedepot:list:') ? undefined : kept.set(k, e)) };
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

// Fix round 2, read live in the owner's Chrome: `/b/N-5yc1vZbwo64Zm5d` answers from `/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64`
// with "totalProducts":101, and a Nao on the first address is dropped by that redirect (the same first page comes back).
describe('fix round 2: the redirect, the final address and totalProducts', () => {
  const CANONICAL = '/b/RYOBI/Bundle/N-5yc1vZm5dZbwo64';
  const items = (n: number, from = 0): ListedItem[] =>
    Array.from({ length: n }, (_, i) => ({ itemId: String(500000000 + from + i), brand: 'RYOBI', model: `PBLSV719K-A${from + i}`, title: 'kit', url: `${HOME_DEPOT}/p/x/${500000000 + from + i}` }));
  const ALL = items(30);
  /** Home Depot as read live: the brand list redirects (dropping Nao); its canonical address pages; 12 a page; total 30. */
  function site() {
    const asked: string[] = [];
    const readListing: ListingSourceDeps['readListing'] = async (path) => {
      asked.push(path);
      if (path.includes('/Ntt-')) return { products: [], total: 0 };
      if (path.startsWith('/b/N-')) return { products: ALL.slice(0, 12), finalPath: CANONICAL, total: 30 };
      const offset = Number(/Nao=(\d+)/.exec(path)?.[1] ?? 0);
      return { products: ALL.slice(offset, offset + 12), total: 30 };
    };
    return { asked, readListing };
  }

  it('the canonical address is a Bundle list path in both checks; Nao is set on it, other parameters kept', () => {
    expect(isBundleListingPath(CANONICAL)).toBe(true);
    expect(isBundleListingPath(`${CANONICAL}?Nao=12`)).toBe(true);
    expect(isBundleListingPath('/b/DEWALT/Bundle/N-5yc1vZbwo64Z4j2/Ntk-elasticplus/Ntt-dewalt%2B20v?NCNI-5&Nao=24')).toBe(true);
    expect(brandOfListingPath(CANONICAL)).toBe('RYOBI');
    expect(withNao(CANONICAL, 12)).toBe(`${CANONICAL}?Nao=12`);
    expect(withNao(`${CANONICAL}?NCNI-5&Nao=12`, 24)).toBe(`${CANONICAL}?NCNI-5&Nao=24`);
    expect(withNao(`${CANONICAL}?Nao=12`, 0)).toBe(CANONICAL);
  });

  it('pages on the final address, by the entries each page returned, until the list\'s totalProducts', async () => {
    const s = site();
    const r = await readBundleListings({ brands: ['RYOBI'], queries: {}, readListing: s.readListing, readPages: async () => [], now: () => T0 });
    expect(s.asked).toEqual(['/b/N-5yc1vZbwo64Zm5d', `${CANONICAL}?Nao=12`, `${CANONICAL}?Nao=24`]);
    // 30 of 30 read: no fourth page is asked for.
    expect(r.lists).toEqual([{ brand: 'RYOBI', source: 'bundle', query: null, pages: 3, listed: 30, added: 30, complete: true, empty: false, total: 30, pagedOn: CANONICAL, cut: false }]);
    expect(listCounts(r.lists)).toBe('RYOBI list without search words: 30 of 30 (3 pages), 30 new');
  });

  it('a final address that is not a Bundle list is not followed', async () => {
    const asked: string[] = [];
    const readListing: ListingSourceDeps['readListing'] = async (path) => {
      asked.push(path);
      const offset = Number(/Nao=(\d+)/.exec(path)?.[1] ?? 0);
      return { products: ALL.slice(offset, offset + 12), finalPath: '/account/settings' };
    };
    await readBundleListings({ brands: ['RYOBI'], queries: {}, readListing, readPages: async () => [], now: () => T0 });
    expect(asked).toEqual(['/b/N-5yc1vZbwo64Zm5d', '/b/N-5yc1vZbwo64Zm5d?Nao=12', '/b/N-5yc1vZbwo64Zm5d?Nao=24', '/b/N-5yc1vZbwo64Zm5d?Nao=30']);
  });

  it('an empty list keeps the sample of what its state held', async () => {
    const sample = { kinds: { '#': 30, ROOT_QUERY: 1, BundleItem: 5 }, entries: [{ kind: '#', key: '1917265066', text: '{"a":1}' }] };
    const r = await readBundleListings({
      brands: ['RYOBI'], queries: { RYOBI: BRAND_QUERIES.RYOBI }, now: () => T0, readPages: async () => [],
      readListing: async (path) => (path.includes('/Ntt-') ? { products: [], note: 'its state had 36 entries, none a product', sample } : { products: [] }),
    });
    expect(r.lists[0]).toMatchObject({ empty: true, sample });
    expect(r.lists[1]!.sample).toBeUndefined();
  });
});

describe('fix round 2: parseListingText reads totalProducts, and samples a state with no product', () => {
  it('the list\'s own total, wherever the state holds it', () => {
    const state = { 'searchModel({"nao":0})': { searchReport: { totalProducts: 24 } }, ...Object.fromEntries(P1.map((p) => [`base-searchNav-${p.itemId}`, { identifiers: { brandName: p.brand, modelNumber: p.model, productLabel: p.title } }])) };
    const got = parseListingText(`window.__APOLLO_STATE__=${JSON.stringify(state)}`, HOME_DEPOT)!;
    expect(got.total).toBe(24);
    expect(got.products).toHaveLength(12);
    expect(got.sample).toBeUndefined();
  });

  it('a state of other kinds: the kinds counted, the first entry of the 3 largest, cut, credential-named fields dropped', () => {
    const big = 'x'.repeat(3000);
    const state: Record<string, unknown> = { ROOT_QUERY: { __typename: 'Query' }, 'BundleItem:1917265066': { name: big, authToken: 'secret', nested: { sessionId: 's', ok: 1 } } };
    for (let i = 0; i < 30; i++) state[String(1917265000 + i)] = { itemId: String(i), cookie: 'c' };
    state['csrfToken'] = 'abc';
    const got = parseListingText(`window.__APOLLO_STATE__=${JSON.stringify(state)}`, HOME_DEPOT)!;
    expect(got.products).toEqual([]);
    expect(got.sample!.kinds).toEqual({ '#': 30, ROOT_QUERY: 1, BundleItem: 1 });
    expect(got.sample!.entries.map((e) => [e.kind, e.key])).toEqual([['#', '1917265000'], ['BundleItem', 'BundleItem:1917265066'], ['ROOT_QUERY', 'ROOT_QUERY']]);
    expect(got.sample!.entries[0]!.text).toBe('{"itemId":"0"}');
    const bundle = got.sample!.entries[1]!.text;
    expect(bundle.length).toBe(SAMPLE_CHARS);
    expect(bundle).not.toMatch(/authToken|secret|sessionId|cookie|csrf/);
  });
});

describe('fix round 3: the keyword search, the page limits, and "read 48 of 101"', () => {
  it('the keyword search page is the recorded searchUrl, paged with Nao, and passes the path check; nothing else under /s/ does', () => {
    expect(searchListingPath('ryobi 18v combo kit', 0)).toBe('/s/ryobi+18v+combo+kit?NCNI-5');
    expect(searchListingPath('ryobi 18v combo kit', 24)).toBe('/s/ryobi+18v+combo+kit?NCNI-5&Nao=24');
    expect(isBundleListingPath('/s/ryobi+18v+combo+kit?NCNI-5&Nao=24')).toBe(true);
    expect(brandOfListingPath('/s/ryobi+18v+combo+kit?NCNI-5')).toBe('RYOBI');
    for (const bad of ['/s/ryobi?searchRedirect=x', '/s/../account', '/s/a/b', '/s/ryobi?Nao=1&Nao=2', '/s/' + 'x'.repeat(121)]) expect(isBundleListingPath(bad)).toBe(false);
  });

  it('a list a page limit stops before its end says so', async () => {
    let n = 0;
    const endless: ListingSourceDeps['readListing'] = async () => ({ products: P1.map((p) => ({ ...p, itemId: String(400000000 + n++) })), total: 400 });
    const r = await readBundleListings({ brands: ['RYOBI'], queries: {}, readListing: endless, readPages: async () => [], now: () => T0 });
    expect(r.lists[0]).toMatchObject({ pages: BUNDLE_LISTING_PAGES_MAX, listed: 120, total: 400, cut: true, complete: false });
    expect(listCounts(r.lists)).toBe('RYOBI list without search words: read 120 of 400 (10 pages, page limit), 120 new');
  });

  it('every list together reads at most LISTING_PAGES_PER_SCAN pages', async () => {
    let n = 0;
    const endless: ListingSourceDeps['readListing'] = async () => ({ products: P1.map((p) => ({ ...p, itemId: String(400000000 + n++) })) });
    const r = await readBundleListings({ brands: ['DEWALT', 'RYOBI'], queries: BRAND_QUERIES, readListing: endless, readPages: async () => [], now: () => T0, itemPagesMax: 0 });
    expect(r.listingPages).toBe(LISTING_PAGES_PER_SCAN);
    expect(r.lists.filter((l) => l.cut).length).toBeGreaterThan(0);
  });
});

describe("Home Depot's pace: each list is read at most once a day, and one the scan's pages cut continues next scan", () => {
  it('a list read through is not read again for 22 hours (no page asked, said as read then); after that it is', async () => {
    const cache = new MemoryCache();
    const f = fakes({ RYOBI: [P1, P2] });
    await readBundleListings(f.deps({ brands: ['RYOBI'], cache }));
    expect(f.asked).toHaveLength(8);
    const later = await readBundleListings(f.deps({ brands: ['RYOBI'], cache, now: () => T0 + HD_LIST_REREAD_MS - 60_000 }));
    expect(f.asked).toHaveLength(8);
    expect(later.listingPages).toBe(0);
    expect(later.lists.map((l) => [l.complete, l.readAt])).toEqual([[true, T0], [true, T0], [true, T0]]);
    const nextDay = await readBundleListings(f.deps({ brands: ['RYOBI'], cache, now: () => T0 + HD_LIST_REREAD_MS }));
    expect(nextDay.listingPages).toBe(8);
    expect(f.asked.slice(8)).toEqual(f.asked.slice(0, 8));
  });

  it("the scan's Home Depot pages end a list part-way: the next scan asks its next page, not its first, and nothing more is asked now", async () => {
    const cache = new MemoryCache();
    const f = fakes({ RYOBI: [P1, P2] });
    let left = 2;
    const base = f.deps({ brands: ['RYOBI'], cache, itemPagesMax: 0 });
    const deps: ListingSourceDeps = {
      ...base,
      readListing: async (path) => {
        left -= 1;
        return base.readListing(path);
      },
      pagesLeft: () => left,
    };
    const first = await readBundleListings(deps);
    expect(f.asked).toEqual([0, 12].map((o) => bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, o)));
    expect(first).toMatchObject({ listingPages: 2, paced: true, refused: false });
    expect(first.lists[0]).toMatchObject({ pages: 2, complete: false, waits: true });
    expect(listCounts(first.lists)).toBe('RYOBI list for "ryobi 18v combo kit": 24 (2 pages, continues next scan), 24 new');
    left = 40;
    const second = await readBundleListings({ ...deps, now: () => T0 + 3 * 60 * 60_000 });
    // The list with the search words goes on at its third page (offset 24, which adds nothing: its end), then the others.
    expect(f.asked.slice(2, 3)).toEqual([bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, 24)]);
    expect(second.lists[0]).toMatchObject({ pages: 1, complete: true });
  });
});
