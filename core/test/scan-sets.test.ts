// Free scan, fix round 3: Home Depot's Bundle filter lists "sets" (CONFIGURABLE_BUNDLE, no model number, Home Depot's own
// list of items). Real data: fixtures/homedepot-pages/bundle-list-ryobi-2026-11-23.json (the RYOBI Bundle list for
// "ryobi 18v combo kit", 12 products, slimmed and checksum-verified against the page) and the reader's own sample of the
// same page (bundle-listing-sample-2026-11-23.json). The state is rebuilt in the shape the sample shows (12
// `base-searchNav-<id>` entries whose bundleItems are references to `BundleItems:<id>` entries). The set items' own pages
// are not recorded: the fake page reader below answers them with made-up models, to test the pipeline's mechanics only.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseListingState, parseListingText, type PromoPage } from '../src/hdPage';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { listedOf, listCounts, type ListingPage } from '../src/scan/listingSource';
import { setSplit } from '../src/scan/split';
import { bySaving, pagesWanted } from '../src/scan/hdOrder';
import type { BundleRecord, ScanStore, SearchClient } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache } from '../src/serpapi/client';
import { BRAND_QUERIES, DEFAULT_SETTINGS, toScanSettings } from '../src/settings';
import type { PromoPageOutcome } from '../src/tracking/bogoPairs';
import * as fx from './fixtures';

interface Recorded {
  searchReport: { totalProducts: number; searchUrl: string };
  products: {
    itemId: string;
    identifiers: Record<string, unknown>;
    pricing: { value: number; original: number; promotion: { dollarOff: number; percentageOff: number } | null; conditionalPromotions: unknown };
    bundleFlag: boolean;
    bundleItems: { id: string; quantity: number }[];
  }[];
}
const FIX = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/homedepot-pages/${name}`, import.meta.url), 'utf8'));
const LIST = FIX('bundle-list-ryobi-2026-11-23.json') as Recorded;
const SAMPLE = FIX('bundle-listing-sample-2026-11-23.json') as { result: { total: number; sample: { kinds: Record<string, number> } } };
const PRICING = 'pricing({"isBrandPricingPolicyCompliant":false,"storeId":"121"})';
const T0 = Date.UTC(2026, 10, 23, 23);

/** The page's state as the sample shows it: base-searchNav entries, their bundleItems as references, the BundleItems entries. */
function stateOf(list: Recorded): Record<string, unknown> {
  const state: Record<string, unknown> = { ROOT_QUERY: { __typename: 'Query' }, 'searchModel({})': { searchReport: list.searchReport } };
  for (const p of list.products) {
    state[`base-searchNav-${p.itemId}`] = {
      __typename: 'BaseProduct', itemId: p.itemId, identifiers: p.identifiers, [PRICING]: p.pricing, bundleFlag: p.bundleFlag,
      bundleItems: p.bundleItems.map((i) => ({ __ref: `BundleItems:${i.id}` })),
    };
    for (const i of p.bundleItems) state[`BundleItems:${i.id}`] = { __typename: 'BundleItems', id: i.id, quantity: i.quantity };
  }
  return state;
}

describe('the listing parser keeps every product entry, model number or not (A)', () => {
  it('12 of 12 sets, each with Home Depot\'s own list of its items, exactly', () => {
    const products = parseListingState(stateOf(LIST));
    expect(products).toHaveLength(12);
    expect(products.map((p) => p.itemId)).toEqual(LIST.products.map((p) => p.itemId));
    for (const [i, p] of products.entries()) {
      const rec = LIST.products[i]!;
      expect(p).toMatchObject({ model: null, productType: 'CONFIGURABLE_BUNDLE', bundleFlag: true, price: rec.pricing.value, wasPrice: rec.pricing.original });
      expect(p.bundleItems).toEqual(rec.bundleItems.map((b) => ({ itemId: b.id, quantity: b.quantity })));
      expect(p.url).toBe(`https://www.homedepot.com${String(rec.identifiers.canonicalUrl)}`);
    }
    expect(products.find((p) => p.itemId === '344978523')).toMatchObject({ brand: '', price: 128.19, wasPrice: 169.19, dollarOff: 41, percentageOff: 24 });
  });

  it('the state the reader sampled live held the same: 12 entries and 22 BundleItems; the parser now finds the 12', () => {
    expect(SAMPLE.result.sample.kinds).toMatchObject({ 'base-searchNav-#': 12, BundleItems: 22 });
    const got = parseListingText(`window.__APOLLO_STATE__=${JSON.stringify(stateOf(LIST))}`)!;
    expect(got.products).toHaveLength(12);
    expect(got.total).toBe(SAMPLE.result.total);
    expect(got.sample).toBeUndefined();
  });
});

/** Made-up readings of the set items' own pages (none is recorded): RYOBI, model `C<item id>`, $10 each. */
const itemPage = (itemId: string): PromoPage => ({ itemId, brand: 'RYOBI', model: `C${itemId}`, title: `Item ${itemId}`, price: 10, wasPrice: null, bullets: [], description: null, promotions: [] });

async function scanSets(opts: { unreadable?: string[]; hdCap?: number } = {}) {
  const store = new MemoryScanStore();
  const listed = parseListingState(stateOf(LIST)).map(listedOf);
  const asked: string[][] = [];
  // Home Depot's pace: every page any reader is asked for counts against the scan's pages (the agent's HdPace does this).
  let left = opts.hdCap ?? Number.POSITIVE_INFINITY;
  const lists: string[] = [];
  const readListing = async (path: string): Promise<ListingPage> => {
    left -= 1;
    lists.push(path);
    // The RYOBI list for the query is the recording; every other list and the keyword search hold nothing more here.
    if (path.includes('Zm5d/Ntk-elasticplus') && !path.includes('Nao=')) return { products: listed, total: 24 };
    return { products: path.startsWith('/s/') || path.includes('Zm5d') ? listed : [] };
  };
  const readPages = async (ids: string[]): Promise<PromoPageOutcome[]> => {
    asked.push(ids);
    left -= ids.length;
    return ids.map((id) => (opts.unreadable?.includes(id) ? { itemId: id, kind: 'unreadable' } : { itemId: id, kind: 'read', page: itemPage(id) }));
  };
  let clock = T0;
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 0 });
  const client: SearchClient = { search: async () => { throw new Error('no search in this test'); } };
  const job = await runScan({
    client, budget, store, settings: { ...toScanSettings(DEFAULT_SETTINGS), brands: ['RYOBI'], queries: [], catalogPagesPerScan: 0 }, now: () => (clock += 100), cache: new MemoryCache(),
    chromeListing: { queries: BRAND_QUERIES, readListing, readPages }, readPages: async (ids) => ids.map((itemId) => ({ itemId, kind: 'skipped' as const })), waitForPages: true,
    ...(opts.hdCap !== undefined ? { hdPagesLeft: () => Math.max(0, left) } : {}),
  });
  return { store, job, asked, lists };
}

const sets = async (store: ScanStore): Promise<BundleRecord[]> => (await store.listBundles()).filter((b) => b.set);

describe('a set end to end (B)', () => {
  it('a set is a bundle with no model number: its item id is its key, its price the listing\'s value, its saving original − value', async () => {
    const { store } = await scanSets();
    const all = await sets(store);
    expect(all).toHaveLength(12);
    const s = (await store.getBundle('homedepot:344978523'))!;
    expect(s).toMatchObject({ model: '', brand: 'RYOBI', price: 128.19, regularPrice: 169.19, percentOff: 24, set: { dollarOff: 41, percentageOff: 24 } });
    expect(s.link).toMatch(/^https:\/\/www\.homedepot\.com\/p\/sets\/.+\/344978523$/);
  });

  it('each item\'s own page is read once, free, and the set\'s split is Home Depot\'s list: settled, evidenced, no question', async () => {
    const { store, job, asked } = await scanSets();
    // 22 distinct items across the 12 sets (35 places), each page asked once.
    expect(asked.flat().sort()).toEqual([...new Set(LIST.products.flatMap((p) => p.bundleItems.map((i) => i.id)))].sort());
    expect(job.setItemsRead).toBe(22);
    const s = (await store.getBundle('homedepot:344978523'))!;
    expect(s.split).toMatchObject({
      status: 'resolved', components: ['C317987598', 'C314892344', 'C317036936', 'C204273414', 'C204273933'], notes: ["Home Depot lists this set's 5 items."],
      evidence: [{ kind: 'hd_set', text: "Home Depot lists this set's 5 items.", url: s.link }],
    });
    expect((await store.listReview()).filter((r) => r.kind === 'split')).toEqual([]);
    // Each item's price sold alone is the part pipeline's own Home Depot reading of its model.
    expect(await store.getPartPrice('RYOBI:C317987598')).toMatchObject({ itemId: '317987598', price: 10, link: 'https://www.homedepot.com/p/317987598' });
    const report = await buildReport(store, toScanSettings(DEFAULT_SETTINGS));
    const row = report.bundles.find((b) => b.key === 'homedepot:344978523')!;
    expect(row).toMatchObject({ model: '', setItems: 5 });
    expect(row.parts.map((p) => p.model).sort()).toEqual(['C204273414', 'C204273933', 'C314892344', 'C317036936', 'C317987598']);
  });

  it('a set whose item page could not be read waits for it: no split, no question, "waiting for its page"', async () => {
    const { store } = await scanSets({ unreadable: ['204273414'] });
    const s = (await store.getBundle('homedepot:344978523'))!;
    expect(s.split).toMatchObject({ status: 'needs_review', components: [] });
    expect(s.set!.items.find((i) => i.itemId === '204273414')!.model).toBeUndefined();
    expect((await store.listReview()).filter((r) => r.kind === 'split')).toEqual([]);
    const row = (await buildReport(store, toScanSettings(DEFAULT_SETTINGS))).bundles.find((b) => b.key === s.key)!;
    expect(row).toMatchObject({ waitingPage: true, setItems: 5 });
    // A set with every item read is settled in the same scan.
    expect((await store.getBundle('homedepot:339857091'))!.split!.status).toBe('resolved');
  });

  it('an item of another brand leaves the split unsettled (rule 4)', () => {
    const b = { key: 'homedepot:1', itemId: '1', brand: 'RYOBI', model: '', title: 't', link: null, set: { dollarOff: null, percentageOff: null, items: [{ itemId: '2', quantity: 2, brand: 'RYOBI', model: 'PCL235B' }, { itemId: '3', quantity: 1, brand: 'DEWALT', model: 'DCB203' }] } } as unknown as BundleRecord;
    expect(setSplit(b)).toMatchObject({ status: 'needs_review', notes: ["a set item's own page names another brand: DEWALT DCB203"] });
    const ok = { ...b, set: { ...b.set!, items: [b.set!.items[0]!] } } as BundleRecord;
    expect(setSplit(ok)).toMatchObject({ status: 'resolved', components: ['PCL235B', 'PCL235B'], notes: ["Home Depot lists this set's 2 items."] });
  });
});

describe('replay on the two fixtures (D): what a scan now makes of the RYOBI Bundle list', () => {
  it('12 sets (4 with no brand name, the list\'s brand), 22 items to read for 35 places, the counts per list', async () => {
    const { store, job } = await scanSets();
    const all = await sets(store);
    expect(all.filter((b) => b.split?.status === 'resolved')).toHaveLength(12);
    expect(LIST.products.filter((p) => p.identifiers.brandName === null)).toHaveLength(4);
    expect(all.reduce((n, b) => n + b.set!.items.length, 0)).toBe(35);
    expect(job.chromeListing!.lists!.map((l) => [l.source, l.query, l.listed, l.added])).toEqual([
      ['bundle', BRAND_QUERIES.RYOBI, 12, 12], ['bundle', null, 12, 0], ['search', BRAND_QUERIES.RYOBI, 12, 0],
    ]);
    expect(listCounts(job.chromeListing!.lists!)).toBe(
      'RYOBI list for "ryobi 18v combo kit": 12 of 24 (2 pages), 12 new; RYOBI list without search words: 12 (2 pages), 0 new; RYOBI search for "ryobi 18v combo kit": 12 (2 pages), 0 new',
    );
  });
});

describe("Home Depot's pace in a scan (hdPagesLeft)", () => {
  it('lists and set item pages together stay within the scan\'s pages; the items read are the sets with the biggest saving, whole sets first', async () => {
    const cap = 12;
    const { store, asked, lists, job } = await scanSets({ hdCap: cap });
    expect(lists.length + asked.flat().length).toBe(cap);
    const read = asked.flat();
    // The order the sets waited in before any item was read (hdOrder.ts), cut at what the lists left.
    const unread = (await store.listBundles()).map((b) => (b.set ? { ...b, set: { ...b.set, items: b.set.items.map(({ itemId, quantity }) => ({ itemId, quantity })) } } : b));
    const order = pagesWanted(unread).map((w) => w.itemId);
    expect(read.length).toBeGreaterThan(0);
    expect(read).toEqual(order.slice(0, read.length));
    const before = new Set(read);
    // Every set whose items were all read has a saving at least as big as any set left waiting.
    const all = (await store.listBundles()).filter((b) => b.set).sort(bySaving);
    const done = all.filter((b) => b.set!.items.every((i) => before.has(i.itemId) || i.readAt !== undefined));
    expect(done.length).toBeGreaterThan(0);
    const firstWaiting = all.findIndex((b) => !done.includes(b));
    expect(all.slice(0, firstWaiting)).toEqual(done);
    expect(job.setItemsRead).toBe(read.length);
  });
});
