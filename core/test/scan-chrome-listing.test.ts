// Free scan (Nov 23): the runner reads the brands' Bundle lists in Chrome (core/src/scan/listingSource.ts) in place of
// SerpApi's listing pages. Fake readers only; nothing reaches the network.
//
// The rows are real: SerpApi's recorded listing pages for the two default queries (fixtures/recorded/hd-search-*-combo-p1.json)
// and the owner's store after his third scan (fixtures/e2e-2026-11-23/after-scan3). The Chrome side is those same
// products in the recorded listing shape (`base-searchNav-<itemId>` identifiers, parsed by hdPage.ts parseSearchState)
// with their prices on their item pages, so the replay shows the Chrome rows build the same records as SerpApi's.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseSearchState } from '../src/hdPage';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { pipelineView } from '../src/scan/pipeline';
import { runScan } from '../src/scan/runner';
import { bundleListingPath } from '../src/scan/listingSource';
import type { BundleRecord, PageOutcome, ReadPages, ScanJob, ScanSettings, ScanStore, SearchClient } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, type SearchResult } from '../src/serpapi/client';
import { BRAND_QUERIES, DEFAULT_SETTINGS, toScanSettings } from '../src/settings';
import { HOME_DEPOT, type ListedItem, type PromoPageOutcome } from '../src/tracking/bogoPairs';
import * as fx from './fixtures';

const T0 = Date.UTC(2026, 10, 23, 12);
const recorded = (name: string): { products: Record<string, unknown>[] } =>
  JSON.parse(readFileSync(new URL(`../../fixtures/recorded/${name}.json`, import.meta.url), 'utf8')) as { products: Record<string, unknown>[] };
const SERP = { RYOBI: recorded('hd-search-ryobi-combo-p1'), DEWALT: recorded('hd-search-dewalt-combo-p1') };

/** A SerpApi product row as a listing page's state entry (the recorded shape: identifiers only). */
function stateOf(rows: Record<string, unknown>[]): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const p of rows) {
    const link = String(p.link);
    state[`base-searchNav-${String(p.product_id)}`] = {
      __typename: 'BaseProduct', itemId: p.product_id,
      identifiers: { brandName: p.brand, productLabel: p.title, modelNumber: p.model_number, canonicalUrl: link.slice(HOME_DEPOT.length) },
    };
  }
  return state;
}

/** Chrome readers over listing pages of 12 and item pages from `price` (the item's page price and was-price). */
function chrome(lists: Record<string, ListedItem[]>, price: (id: string) => { price: number | null; was: number | null }, opts: { refuseAt?: string } = {}) {
  const asked: string[] = [];
  const items = new Map(Object.values(lists).flat().map((p) => [p.itemId, p] as const));
  return {
    asked,
    deps: {
      queries: BRAND_QUERIES,
      readListing: async (path: string): Promise<ListedItem[]> => {
        asked.push(path);
        if (path === opts.refuseAt) throw new Error('Home Depot refused the bundle list (HTTP 403).');
        const brand = path.includes('Zm5d/') ? 'RYOBI' : 'DEWALT';
        const offset = Number(/Nao=(\d+)/.exec(path)?.[1] ?? 0);
        return (lists[brand] ?? []).slice(offset, offset + 12);
      },
      readPages: async (ids: string[]): Promise<PromoPageOutcome[]> =>
        ids.map((id) => {
          const p = items.get(id)!;
          const { price: value, was } = price(id);
          return { itemId: id, kind: 'read', page: { itemId: id, brand: p.brand, model: p.model, title: p.title, price: value, wasPrice: was, bullets: [`Includes: ${p.model} page`], description: null, promotions: [] } };
        }),
    },
  };
}

/** A SerpApi client that answers the default queries' first pages from the recordings and refuses anything else. */
function serpClient(budget: SearchBudget, calls: string[]): SearchClient {
  return {
    async search(params): Promise<SearchResult> {
      calls.push(`${params.engine} ${params.q ?? params.k}`);
      budget.record(1);
      const brand = String(params.q).startsWith('ryobi') ? 'RYOBI' : 'DEWALT';
      return { data: params.engine === 'home_depot' ? { products: SERP[brand].products } : { organic_results: [] }, source: 'network', at: T0 };
    },
  };
}

const settingsOf = (over: Partial<ScanSettings> = {}): ScanSettings => ({ ...toScanSettings(DEFAULT_SETTINGS), catalogPagesPerScan: 0, ...over });
const noPages: ReadPages = async (ids) => ids.map((itemId): PageOutcome => ({ itemId, kind: 'skipped' }));

async function scan(store: ScanStore, deps: Partial<Parameters<typeof runScan>[0]> = {}) {
  let clock = T0;
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
  const calls: string[] = [];
  const job = await runScan({ client: serpClient(budget, calls), budget, store, settings: settingsOf(), now: () => (clock += 100), cache: new MemoryCache(), ...deps });
  return { job, calls };
}

const listedFromSerp = (brand: 'RYOBI' | 'DEWALT'): ListedItem[] => parseSearchState(stateOf(SERP[brand].products), HOME_DEPOT);
const serpPrice = (id: string) => {
  const p = [...SERP.RYOBI.products, ...SERP.DEWALT.products].find((r) => r.product_id === id)!;
  return { price: (p.price as number | undefined) ?? null, was: (p.price_was as number | undefined) ?? null };
};
const shape = (b: BundleRecord) => ({ key: b.key, brand: b.brand, model: b.model, title: b.title, price: b.price, regularPrice: b.regularPrice, percentOff: b.percentOff, link: b.link });

describe('a scan with the Chrome bundle lists', () => {
  it('spends no search: no SerpApi listing page is planned, and the step list says where the lists came from', async () => {
    const store = new MemoryScanStore();
    const c = chrome({ RYOBI: listedFromSerp('RYOBI'), DEWALT: listedFromSerp('DEWALT') }, serpPrice);
    const { job, calls } = await scan(store, { chromeListing: c.deps, readPages: noPages });
    // No listing search (the Amazon lookups the new bundles want are step 15's routing, as before).
    expect(calls.filter((x) => x.startsWith('home_depot'))).toEqual([]);
    // 24 a list: page 1 and 2 read, page 3 (offset 24) adds nothing.
    expect(c.asked).toHaveLength(6);
    expect(job.chromeListing).toMatchObject({ done: true, pages: 6, complete: true, itemPagesRead: 48 });
    const view = pipelineView(job, {}, T0);
    const bundles = (await store.listBundles()).length;
    expect(view.steps[0]).toMatchObject({ label: 'Home Depot bundle lists', state: 'done', figure: `read in Chrome · ${bundles} bundles · 0 searches` });
    expect(job.chromeListing!.bundles).toBe(bundles);
  });

  it('replay on the recorded SerpApi rows: the Chrome rows build the same bundles and catalog entries', async () => {
    const viaSerp = new MemoryScanStore();
    const serp = await scan(viaSerp, { settings: settingsOf({ pagesPerQuery: 1 }), readPages: noPages });
    expect(serp.calls).toEqual(['home_depot dewalt 20v combo kit', 'home_depot ryobi 18v combo kit']);
    const viaChrome = new MemoryScanStore();
    await scan(viaChrome, { chromeListing: chrome({ RYOBI: listedFromSerp('RYOBI'), DEWALT: listedFromSerp('DEWALT') }, serpPrice).deps, readPages: noPages });
    const a = (await viaSerp.listBundles()).map(shape).sort((x, y) => (x.key < y.key ? -1 : 1));
    const b = (await viaChrome.listBundles()).map(shape).sort((x, y) => (x.key < y.key ? -1 : 1));
    // Missing from Chrome / extra in Chrome: none.
    expect(b.map((x) => x.key)).toEqual(a.map((x) => x.key));
    expect(b).toEqual(a);
    expect((await viaChrome.listCatalog()).map((c) => c.key).sort()).toEqual((await viaSerp.listCatalog()).map((c) => c.key).sort());
    // The Chrome rows bring each bundle's page reading too: the bundle pass reads none of them again.
    expect((await viaChrome.listBundles()).every((x) => x.page?.bullets[0]?.endsWith(' page'))).toBe(true);
  });

  it('a refusal mid-list keeps what was read, says so, and reads no other Home Depot page in the scan', async () => {
    const store = new MemoryScanStore();
    const refuseAt = bundleListingPath('RYOBI', BRAND_QUERIES.RYOBI, 12)!;
    const c = chrome({ RYOBI: listedFromSerp('RYOBI'), DEWALT: listedFromSerp('DEWALT') }, serpPrice, { refuseAt });
    let pageReads = 0;
    const { job } = await scan(store, { chromeListing: c.deps, readPages: async (ids) => { pageReads += ids.length; return noPages(ids); } });
    expect(c.asked.at(-1)).toBe(refuseAt);
    // DEWALT's whole list and RYOBI's first page are kept, without prices (no item page after a refusal).
    const kept = new Set([...listedFromSerp('DEWALT'), ...listedFromSerp('RYOBI').slice(0, 12)].map((p) => p.itemId));
    const stored = await store.listBundles();
    expect(stored.every((x) => kept.has(x.itemId) && x.price === null)).toBe(true);
    expect(pageReads).toBe(0);
    expect(job.stopMessage).toContain('Home Depot refused the bundle list (HTTP 403). What was read is kept; the rest is read next scan.');
    expect(job.chromeListing).toMatchObject({ complete: false, itemPagesRead: 0 });
    const steps = pipelineView(job, {}, T0).steps;
    expect(steps[0]!.figure).toMatch(/^read in Chrome · \d+ bundles · 0 searches$/);
    expect(steps[1]).toMatchObject({ label: 'Bundle pages', state: 'skipped', figure: 'Home Depot refused' });
  });

  it('a refusal on the first list page fails the step, and the scan goes on', async () => {
    const refuseAt = bundleListingPath('DEWALT', BRAND_QUERIES.DEWALT, 0)!;
    const { job } = await scan(new MemoryScanStore(), { chromeListing: chrome({}, serpPrice, { refuseAt }).deps, readPages: noPages });
    expect(job.status).toBe('done');
    expect(pipelineView(job, {}, T0).steps[0]).toMatchObject({ label: 'Home Depot bundle lists', state: 'failed', figure: 'Home Depot refused' });
  });

  it('a bundle whose page was not read this time keeps its stored price, page and BOGO facts', async () => {
    const store = new MemoryScanStore();
    const first = listedFromSerp('RYOBI').find((p) => p.model.includes('-'))!;
    const stored: BundleRecord = {
      key: `homedepot:${first.itemId}`, retailer: 'homedepot', itemId: first.itemId, title: first.title, brand: 'RYOBI', model: first.model, upc: null,
      price: 179, regularPrice: 268, percentOff: 33, link: first.url, seenAt: T0 - 1000, split: null,
      page: { bullets: ['Includes: stored'], description: null, readAt: T0 - 1000 },
      bogo: { promotionId: '945815', starterItemId: '317987584', starterModel: 'PCL1201K2', freeModel: 'PCL515B' },
    };
    await store.putBundle(stored);
    const c = chrome({ RYOBI: [first] }, () => ({ price: null, was: null }));
    await scan(store, { chromeListing: c.deps, readPages: noPages, settings: settingsOf({ brands: ['RYOBI'] }) });
    const after = (await store.getBundle(stored.key))!;
    expect(after).toMatchObject({ price: 179, regularPrice: 268, percentOff: 33, page: stored.page, bogo: stored.bogo });
    expect(after.seenAt).toBeGreaterThan(stored.seenAt);
  });
});

// The owner's store after his third scan: 59 bundles, 22 of them from SerpApi's listing pages (the other 37 are BOGO
// pairs the BOGO pass stored). A scan whose Chrome lists hold those 22 finds the same 22 and changes neither their pages
// nor their splits; the BOGO pairs stay as they are. Whether Home Depot's own Bundle lists hold the same 22 needs the
// lists recorded once in the owner's Chrome (docs/decisions.md, the free scan's live check).
describe('replay on the owner\'s store (fixtures/e2e-2026-11-23/after-scan3)', () => {
  const rows = <T>(f: string): T[] =>
    (JSON.parse(readFileSync(new URL(`../../fixtures/e2e-2026-11-23/after-scan3/scan/${f}.json`, import.meta.url), 'utf8')) as [string, T][]).map(([, v]) => v);

  it('the 22 listing bundles are found again from the Chrome source, with no missing and no extra', async () => {
    const store = new MemoryScanStore();
    for (const b of rows<BundleRecord>('bundles')) await store.putBundle(b);
    for (const c of rows<never>('catalog')) await store.putCatalogEntry(c);
    for (const l of rows<never>('listings')) await store.putListing(l);
    for (const p of rows<never>('partPrices')) await store.putPartPrice(p);
    for (const m of rows<never>('matches')) await store.putMatch(m);
    for (const r of rows<never>('reviews')) await store.putReview(r);
    for (const s of rows<ScanJob>('scans')) await store.putScan(s);
    const before = rows<BundleRecord>('bundles');
    const fromListing = before.filter((b) => !b.bogo);
    expect(fromListing).toHaveLength(22);
    const listed = (brand: string): ListedItem[] =>
      fromListing.filter((b) => b.brand === brand).map((b) => ({ itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, url: b.link! }));
    const prices = new Map(fromListing.map((b) => [b.itemId, { price: b.price, was: b.regularPrice }]));
    const c = chrome({ RYOBI: listed('RYOBI'), DEWALT: listed('DEWALT') }, (id) => prices.get(id)!);
    const last = before.reduce((t, b) => Math.max(t, b.seenAt), 0);
    let clock = last + 3_600_000;
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 0 });
    const job = await runScan({
      client: serpClient(budget, []), budget, store, settings: settingsOf(), now: () => (clock += 100), cache: new MemoryCache(), chromeListing: c.deps, readPages: noPages,
    });
    expect(job.searchesUsed).toBe(0);
    const after = await store.listBundles();
    const found = new Set(c.asked.length > 0 ? after.filter((b) => b.seenAt > last).map((b) => b.key) : []);
    const want = new Set(fromListing.map((b) => b.key));
    expect([...want].filter((k) => !found.has(k))).toEqual([]);
    expect([...found].filter((k) => !want.has(k))).toEqual([]);
    for (const b of fromListing) {
      const a = after.find((x) => x.key === b.key)!;
      expect({ ...shape(a), page: a.page, split: a.split?.components }).toEqual({ ...shape(b), page: b.page, split: b.split?.components });
    }
    // The BOGO pairs are untouched.
    for (const b of before.filter((x) => x.bogo)) expect(after.find((x) => x.key === b.key)?.bogo).toEqual(b.bogo);
  });
});
