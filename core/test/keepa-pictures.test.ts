// Nov 25: a Keepa product's picture, from the recorded responses in fixtures/keepa/ (images[].m / .l / .variant, the address
// https://m.media-amazon.com/images/I/<name> per https://keepa.com/api-docs/product-object.html). No network.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TokenBudget } from '../src/keepa/budget';
import { KeepaClient } from '../src/keepa/client';
import { keepaLookupSearchResult } from '../src/keepa/fetchStep';
import { keepaPicture, parseProductResponse, parseSearchResponse } from '../src/keepa/parse';
import { keepListingPicture, listingFrom } from '../src/scan/listings';
import { MemoryScanStore } from '../src/scan/memoryStore';
import type { ListingRecord } from '../src/scan/types';
import { MemoryCache } from '../src/serpapi/client';
import { parseAmazonSearch } from '../src/serpapi/parsers';

const body = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/keepa/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

describe('a Keepa product’s picture', () => {
  it('is the MAIN image’s medium file on Amazon’s image host, for every recorded product', () => {
    const products = parseProductResponse(body('product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json')).products;
    expect(products.map((p) => [p.asin, p.image])).toEqual([
      ['B0BGYFTPGK', 'https://m.media-amazon.com/images/I/31335X5Nl8L.jpg'],
      ['B01H9BL8EO', 'https://m.media-amazon.com/images/I/41wrCzdlAwL.jpg'],
      ['B09M3TL9BB', 'https://m.media-amazon.com/images/I/41WmSLY8N0L.jpg'],
    ]);
    const search = parseSearchResponse(body('search-RYOBI-PCL235B.json')).products ?? [];
    expect(search).toHaveLength(20);
    expect(search.every((p) => p.image?.startsWith('https://m.media-amazon.com/images/I/'))).toBe(true);
    expect(parseProductResponse(body('product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json')).products.every((p) => p.image)).toBe(true);
  });

  it('takes the large file when the MAIN entry has no medium one, and a name with a plus as recorded', () => {
    expect(keepaPicture([{ l: '71p4UACZuCL.jpg', lH: 1600, lW: 1600, variant: 'MAIN' }])).toBe('https://m.media-amazon.com/images/I/71p4UACZuCL.jpg');
    expect(keepaPicture([{ m: '41w-+fzrg3L.jpg', variant: 'MAIN' }])).toBe('https://m.media-amazon.com/images/I/41w-+fzrg3L.jpg');
    // No MAIN: the first entry.
    expect(keepaPicture([{ m: '51L5Wkn8U6L.jpg', variant: 'PT01' }])).toBe('https://m.media-amazon.com/images/I/51L5Wkn8U6L.jpg');
  });

  it.each([
    ['no images', undefined],
    ['an empty list', []],
    ['a path', [{ m: '../x.jpg', variant: 'MAIN' }]],
    ['another host', [{ m: 'https://evil.example/x.jpg', variant: 'MAIN' }]],
    ['not an image file', [{ m: '31335X5Nl8L.svg', variant: 'MAIN' }]],
    ['a query', [{ m: '31335X5Nl8L.jpg?x=1', variant: 'MAIN' }]],
  ])('is none for %s', (_n, images) => expect(keepaPicture(images)).toBeNull());

  it('reaches a Keepa search’s rows as each row’s picture, and the listing saved from it', async () => {
    const cache = new MemoryCache();
    await cache.set('keepa:search?domain=1&term=RYOBI PCL235B&type=product', { at: 1, data: body('search-RYOBI-PCL235B.json') });
    const fetchFn = (() => { throw new Error('no network in this test'); }) as unknown as typeof fetch;
    const client = new KeepaClient({ apiKey: 'fixture', budget: new TokenBudget({ reserve: 0, maxPerRun: 20 }), cache, fetchFn });
    const rows = parseAmazonSearch((await keepaLookupSearchResult(client, 'RYOBI PCL235B', { label: 'test' })).data);
    const row = rows.find((r) => r.asin === 'B0BGYFTPGK')!;
    expect(row.image).toBe('https://m.media-amazon.com/images/I/31335X5Nl8L.jpg');
    expect(listingFrom(row, ['RYOBI'], 5)!.image).toBe(row.image);
  });
});

describe('a pull’s picture on the stored listing', () => {
  const listing = (image: string | null): ListingRecord => ({
    asin: 'B0BGYFTPGK', brand: 'RYOBI', title: 'RYOBI ONE+ 18V Cordless Compact LED Light (Tool Only) PCL235B', models: ['PCL235B'],
    image, price: 20, reviews: 100, seenAt: 1, checkedAt: 1,
  });

  it('fills a stored listing that has none', async () => {
    const store = new MemoryScanStore();
    await store.putListing(listing(null));
    expect(await keepListingPicture(store, 'B0BGYFTPGK', 'https://m.media-amazon.com/images/I/31335X5Nl8L.jpg')).toBe(true);
    expect((await store.getListing('B0BGYFTPGK'))!.image).toBe('https://m.media-amazon.com/images/I/31335X5Nl8L.jpg');
  });

  it('never replaces a stored picture, never stores nothing over one, and never creates a listing', async () => {
    const store = new MemoryScanStore();
    const had = 'https://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg';
    await store.putListing(listing(had));
    expect(await keepListingPicture(store, 'B0BGYFTPGK', 'https://m.media-amazon.com/images/I/31335X5Nl8L.jpg')).toBe(false);
    expect(await keepListingPicture(store, 'B0BGYFTPGK', undefined)).toBe(false);
    expect((await store.getListing('B0BGYFTPGK'))!.image).toBe(had);
    expect(await keepListingPicture(store, 'B000000000', 'https://m.media-amazon.com/images/I/31335X5Nl8L.jpg')).toBe(false);
    expect(await store.getListing('B000000000')).toBeUndefined();
  });

  it('keeps a row’s missing picture as the stored one (listingFrom)', () => {
    const old = listing('https://m.media-amazon.com/images/I/81XPDrUh9sL._AC_UL320_.jpg');
    expect(listingFrom({ asin: old.asin, title: old.title, brand: 'RYOBI', price: 21, reviews: null, image: null }, ['RYOBI'], 9, old)!.image).toBe(old.image);
    expect(listingFrom({ asin: old.asin, title: old.title, brand: 'RYOBI', price: 21, reviews: null, image: 'https://evil.example/x.jpg' }, ['RYOBI'], 9, old)!.image).toBe(old.image);
  });
});
