import { describe, expect, it } from 'vitest';

import type {
  BundleRecord, CatalogCursor, CatalogRecord, ListingRecord, MatchRecord, PartPriceRecord, PriceRecord, ReviewItem, ScanJob, ScanStore,
} from '../src/scan/types';

const bundle = (itemId: string, over: Partial<BundleRecord> = {}): BundleRecord => ({
  key: `homedepot:${itemId}`,
  retailer: 'homedepot',
  itemId,
  title: 'RYOBI 18V 2-Tool Combo Kit',
  brand: 'RYOBI',
  model: 'PBLCK200',
  upc: null,
  price: 99,
  regularPrice: 149,
  percentOff: 34,
  link: null,
  seenAt: 1,
  split: null,
  ...over,
});

const catalog = (model: string, over: Partial<CatalogRecord> = {}): CatalogRecord => ({
  key: `RYOBI:${model}`,
  brand: 'RYOBI',
  model,
  title: 'RYOBI Ratchet',
  kinds: ['ratchet'],
  isKit: false,
  upc: null,
  seenAt: 1,
  ...over,
});

const match = (model = 'PBLRC25B', over: Partial<MatchRecord> = {}): MatchRecord => ({
  key: `RYOBI:${model}`,
  brand: 'RYOBI',
  model,
  status: 'matched',
  asin: 'B0B6Z2ZGVK',
  grade: 'exact',
  alternatives: [],
  decidedBy: 'auto',
  updatedAt: 1,
  waitingSince: null,
  ...over,
});

const price = (asin: string, over: Partial<PriceRecord> = {}): PriceRecord => ({ asin, price: 20, reviews: 5, seenAt: 1, checkedAt: 1, ...over });

const listing = (asin: string, over: Partial<ListingRecord> = {}): ListingRecord => ({
  asin,
  brand: 'RYOBI',
  title: 'ONEAND HP 18V BRUSHLESS Cordless 3/8 in. Extended Reach Ratchet Tool ONLY PBLRC25B',
  models: ['PBLRC25B'],
  image: 'https://m.media-amazon.com/images/I/a.jpg',
  price: 169,
  reviews: 221,
  seenAt: 1,
  checkedAt: 1,
  ...over,
});

const cursor = (brand: string, over: Partial<CatalogCursor> = {}): CatalogCursor => ({ brand, nextPage: 2, passes: 0, updatedAt: 1, ...over });

const review = (id: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id,
  kind: 'match',
  subject: 'RYOBI:PBLRC25B',
  brand: 'RYOBI',
  model: 'PBLRC25B',
  title: null,
  reason: 'Two listings fit',
  candidates: [{ asin: 'B0B6Z2ZGVK', title: 'A', price: 20, reviews: 5, reasons: ['model'], seenAt: 1 }],
  choices: [],
  openedAt: 1,
  answer: null,
  answeredAt: null,
  ...over,
});

const scan = (startedAt: number, over: Partial<ScanJob> = {}): ScanJob => ({
  id: String(startedAt),
  startedAt,
  finishedAt: null,
  status: 'running',
  stopReason: null,
  stopMessage: null,
  phase: 'listing',
  queue: [],
  deferred: [],
  searchesUsed: 0,
  counts: {
    pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
    catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0,
  },
  ...over,
});

// Step 9: the PCL206 drill as Home Depot sells it alone, under its tool-only twin's page (hd-part-prices-2026-11-18.json shape).
const partPrice = (model: string, over: Partial<PartPriceRecord> = {}): PartPriceRecord => ({
  key: `RYOBI:${model}`,
  brand: 'RYOBI',
  model,
  itemId: '317987588',
  matchedModel: `${model}B`,
  price: 89,
  title: 'ONE+ 18V Cordless 5 1/2 in. Circular Saw (Tool Only)',
  link: 'https://www.homedepot.com/p/317987588',
  seenAt: 1,
  checkedAt: 1,
  ...over,
});

export function storeConformance(name: string, make: () => Promise<ScanStore>): void {
describe(`${name} round trips`, () => {
  it('bundles: put, get, replace, missing', async () => {
    const s = await make();
    const a = bundle('1');
    await s.putBundle(a);
    expect(await s.getBundle(a.key)).toEqual(a);
    const b = bundle('1', { price: 80 });
    await s.putBundle(b);
    expect(await s.getBundle(a.key)).toEqual(b);
    expect(await s.listBundles()).toHaveLength(1);
    expect(await s.getBundle('homedepot:nope')).toBeUndefined();
  });

  it('catalog: put, get, replace, missing', async () => {
    const s = await make();
    const a = catalog('PBLRC25B');
    await s.putCatalogEntry(a);
    expect(await s.getCatalogEntry(a.key)).toEqual(a);
    const b = catalog('PBLRC25B', { title: 'New title' });
    await s.putCatalogEntry(b);
    expect(await s.getCatalogEntry(a.key)).toEqual(b);
    expect(await s.getCatalogEntry('RYOBI:NOPE')).toBeUndefined();
    // Step 6: a kit's entry with its item id and page, in the same store, next to one saved before them.
    const kit = catalog('PCL1600K2', { isKit: true, itemId: '317987591', page: { bullets: ['Includes: (1) PCL206 Drill'], description: null, readAt: 2 } });
    await s.putCatalogEntry(kit);
    expect(await s.getCatalogEntry(kit.key)).toEqual(kit);
    expect(await s.getCatalogEntry(a.key)).toEqual(b);
  });

  it('matches: put, get, replace, missing', async () => {
    const s = await make();
    const a = match();
    await s.putMatch(a);
    expect(await s.getMatch(a.key)).toEqual(a);
    const b = match('PBLRC25B', { status: 'none', asin: null, grade: null });
    await s.putMatch(b);
    expect(await s.getMatch(a.key)).toEqual(b);
    expect(await s.getMatch('RYOBI:NOPE')).toBeUndefined();
  });

  it('prices: put, get, replace, missing', async () => {
    const s = await make();
    const a = price('B0B6Z2ZGVK');
    await s.putPrice(a);
    expect(await s.getPrice(a.asin)).toEqual(a);
    const b = price('B0B6Z2ZGVK', { price: 25, checkedAt: 2 });
    await s.putPrice(b);
    expect(await s.getPrice(a.asin)).toEqual(b);
    expect(await s.getPrice('B0NOPE0000')).toBeUndefined();
  });

  it('listings: put, get, replace, missing', async () => {
    const s = await make();
    const a = listing('B0B3JWF5ZV');
    await s.putListing(a);
    expect(await s.getListing(a.asin)).toEqual(a);
    const b = listing('B0B3JWF5ZV', { price: null, image: null, models: [], checkedAt: 2 });
    await s.putListing(b);
    expect(await s.getListing(a.asin)).toEqual(b);
    expect(await s.listListings()).toEqual([b]);
    expect(await s.getListing('B0NOPE0000')).toBeUndefined();
  });

  it('cursors: put, get, replace, missing', async () => {
    const s = await make();
    const a = cursor('DEWALT');
    await s.putCursor(a);
    expect(await s.getCursor('DEWALT')).toEqual(a);
    const b = cursor('DEWALT', { nextPage: 1, passes: 1, updatedAt: 2 });
    await s.putCursor(b);
    expect(await s.getCursor('DEWALT')).toEqual(b);
    expect(await s.getCursor('RYOBI')).toBeUndefined();
  });

  it('review items: put, get, replace, missing', async () => {
    const s = await make();
    const a = review('match:RYOBI:PBLRC25B');
    await s.putReview(a);
    expect(await s.getReview(a.id)).toEqual(a);
    const b = review(a.id, { answer: 'B0B6Z2ZGVK', answeredAt: 2 });
    await s.putReview(b);
    expect(await s.getReview(a.id)).toEqual(b);
    expect(await s.getReview('match:nope')).toBeUndefined();
  });

  it('part prices (step 9): put, get, replace, missing, listed by key; the catalog is untouched', async () => {
    const s = await make();
    const a = partPrice('PCL500');
    await s.putPartPrice(a);
    expect(await s.getPartPrice(a.key)).toEqual(a);
    const b = partPrice('PCL500', { checkedAt: 2 });
    await s.putPartPrice(b);
    expect(await s.getPartPrice(a.key)).toEqual(b);
    await s.putPartPrice(partPrice('PCL206', { itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null }));
    expect((await s.listPartPrices()).map((r) => r.key)).toEqual(['RYOBI:PCL206', 'RYOBI:PCL500']);
    expect(await s.getPartPrice('RYOBI:NOPE')).toBeUndefined();
    expect(await s.listCatalog()).toEqual([]);
    const got = (await s.getPartPrice(a.key))!;
    got.price = 1;
    expect((await s.getPartPrice(a.key))!.price).toBe(89);
  });

  it('scans: put, get, replace, missing', async () => {
    const s = await make();
    const a = scan(1);
    await s.putScan(a);
    expect(await s.getScan(a.id)).toEqual(a);
    const b = scan(1, { status: 'done', finishedAt: 5 });
    await s.putScan(b);
    expect(await s.getScan(a.id)).toEqual(b);
    expect(await s.getScan('999')).toBeUndefined();
  });
});

describe(`${name} isolation and order`, () => {
  it('returns copies, so a caller cannot change the store by accident', async () => {
    const store = await make();
    const m = match();
    await store.putMatch(m);
    const got = (await store.getMatch(m.key))!;
    got.alternatives.push('B0CHANGED00');
    got.status = 'none';
    expect(await store.getMatch(m.key)).toEqual(match());
    m.alternatives.push('B0CHANGED01'); // the object that was put is not held either
    expect((await store.getMatch(m.key))!.alternatives).toEqual([]);
    const listed = await store.listMatches();
    listed[0]!.alternatives.push('B0CHANGED02');
    expect((await store.getMatch(m.key))!.alternatives).toEqual([]);
  });

  it('returns copies of listings and cursors', async () => {
    const store = await make();
    const l = listing('B0B3JWF5ZV');
    await store.putListing(l);
    (await store.getListing(l.asin))!.models.push('CHANGED1');
    l.models.push('CHANGED2');
    (await store.listListings())[0]!.models.push('CHANGED3');
    expect((await store.getListing(l.asin))!.models).toEqual(['PBLRC25B']);

    const c = cursor('DEWALT');
    await store.putCursor(c);
    (await store.getCursor('DEWALT'))!.nextPage = 9;
    c.passes = 9;
    expect(await store.getCursor('DEWALT')).toEqual(cursor('DEWALT'));
  });

  it('lists by key ascending, and scans newest first', async () => {
    const s = await make();
    for (const id of ['b', 'a', 'c']) {
      await s.putBundle(bundle(id));
      await s.putCatalogEntry(catalog(id.toUpperCase()));
      await s.putMatch(match(id.toUpperCase()));
      await s.putReview(review(`match:${id}`));
    }
    expect((await s.listBundles()).map((r) => r.itemId)).toEqual(['a', 'b', 'c']);
    expect((await s.listCatalog()).map((r) => r.model)).toEqual(['A', 'B', 'C']);
    expect((await s.listMatches()).map((r) => r.model)).toEqual(['A', 'B', 'C']);
    expect((await s.listReview()).map((r) => r.id)).toEqual(['match:a', 'match:b', 'match:c']);
    for (const asin of ['B0B6Z2ZGVK', 'B00IJ0ALYS', 'B0B3JWF5ZV']) await s.putListing(listing(asin));
    expect((await s.listListings()).map((r) => r.asin)).toEqual(['B00IJ0ALYS', 'B0B3JWF5ZV', 'B0B6Z2ZGVK']);
    for (const t of [1, 3, 2]) await s.putScan(scan(t));
    expect((await s.listScans()).map((j) => j.startedAt)).toEqual([3, 2, 1]);
  });
});
}
