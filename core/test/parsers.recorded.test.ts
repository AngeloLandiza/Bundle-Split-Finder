import { describe, expect, it } from 'vitest';

import { grade, pick } from '../src/match';
import { cleanBrand, parseAmazonProduct, parseAmazonSearch, parseHomeDepotProduct, parseHomeDepotSearch } from '../src/serpapi/parsers';
import { RECORDED_NAMES, recorded } from './recorded';

it.each(RECORDED_NAMES)('%s is a successful recorded response', (name) => {
  const j = recorded(name) as { search_metadata?: { status?: string } };
  expect(j.search_metadata?.status).toBe('Success');
});

describe.each([
  // name, rows, rows with a model number, rows with a was-price
  ['hd-search-ryobi-combo-p1', 24, 24, 12],
  ['hd-search-dewalt-combo-p1', 24, 24, 11],
  ['hd-search-ryobi-ratchet', 24, 24, 6],
] as const)('parseHomeDepotSearch(%s)', (name, count, withModel, withWas) => {
  const { listings, hasNextPage } = parseHomeDepotSearch(recorded(name));
  it('keeps every product row', () => expect(listings).toHaveLength(count));
  it('reads an all-digit item id, a title, a brand and a numeric price on every row', () => {
    for (const l of listings) {
      expect(l.itemId).toMatch(/^\d+$/);
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.brand).toEqual(expect.any(String));
      expect(l.price).toEqual(expect.any(Number));
    }
  });
  it('reads model numbers', () => expect(listings.filter((l) => l.model).length).toBe(withModel));
  it('reads was-prices as numbers above the price, with a percentage', () => {
    const marked = listings.filter((l) => l.regularPrice !== null);
    expect(marked).toHaveLength(withWas);
    for (const l of marked) {
      expect(l.regularPrice!).toBeGreaterThan(l.price!);
      expect(l.percentOff).toEqual(expect.any(Number));
    }
  });
  it('sees a next page', () => expect(hasNextPage).toBe(true));
});

it('reads the founder\'s bundle exactly as Home Depot lists it', () => {
  const { listings } = parseHomeDepotSearch(recorded('hd-search-ryobi-ratchet'));
  expect(listings.find((l) => l.itemId === '328814689')).toEqual({
    itemId: '328814689',
    title: 'ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
    brand: 'RYOBI',
    model: 'PBLRC2501SB',
    price: 189,
    regularPrice: 338,
    percentOff: 44,
    badge: 'Special-Buy',
    link: 'https://www.homedepot.com/p/RYOBI-ONE-HP-18V-Brushless-Cordless-1-4-in-and-3-8-in-Extended-Reach-Ratchets-Tools-Only-PBLRC2501SB/328814689',
  });
});

it('reads a row that is not on sale', () => {
  const { listings } = parseHomeDepotSearch(recorded('hd-search-dewalt-combo-p1'));
  expect(listings.find((l) => l.itemId === '206510146')).toMatchObject({ model: 'DCK940D2', price: 799, regularPrice: null, percentOff: null, badge: null });
});

it.each([
  // name, rows, rows with no price
  ['amazon-search-PBLRC25B', 10, 0],
  ['amazon-search-PBLRC01B', 48, 3],
  ['amazon-search-DCF891B', 60, 6],
] as const)('%s: every row is kept, priced or not', (name, rows, unpriced) => {
  const results = parseAmazonSearch(recorded(name));
  expect(results).toHaveLength(rows);
  expect(results.filter((r) => r.price === null)).toHaveLength(unpriced);
});

it.each([
  ['amazon-search-PBLRC25B', 'RYOBI', 'PBLRC25B', 'B0B3JWF5ZV', 169, 221],
  ['amazon-search-PBLRC01B', 'RYOBI', 'PBLRC01B', 'B0B6Z2ZGVK', 146.94, 212],
] as const)('%s: pick() chooses the founder\'s listing', (name, brand, model, asin, price, reviews) => {
  const results = parseAmazonSearch(recorded(name));
  expect(results.find((r) => r.asin === asin)).toMatchObject({ brand: 'RYOBI', price, reviews, sponsored: false });
  expect(pick({ brand, model }, results).chosen).toMatchObject({ asin, grade: 'probable' });
});

it('reads the brand Amazon shows on a search row', () => {
  const brands = new Set(parseAmazonSearch(recorded('amazon-search-PBLRC25B')).map((r) => r.brand));
  expect(brands).toEqual(new Set(['RYOBI', 'Amazon Renewed']));
});

it('amazon-search-DCF891B: one DEWALT listing is chosen as a title match, with no alternatives', () => {
  const picked = pick({ brand: 'DEWALT', model: 'DCF891B' }, parseAmazonSearch(recorded('amazon-search-DCF891B')));
  expect(picked.chosen?.grade).toBe('probable');
  expect(picked.alternatives).toEqual([]);
});

it('marks sponsored results', () => {
  const results = parseAmazonSearch(recorded('amazon-search-DCF891B'));
  expect(results.filter((r) => r.sponsored).map((r) => r.asin)).toEqual([
    'B0FP14XK2J', 'B0H4VCY8M1', 'B0FXM7V5ND', 'B0FJRQ1CG6', 'B0FTTW9HT1', 'B0HCTK4BLL',
    'B0HQGDLWH9', 'B0HQG2WS5V', 'B0H93QPDC2', 'B0FDVXVJCN', 'B0HQNL1PKM', 'B0HN1TBD9C',
  ]);
});

it('amazon-product-B0B6Z2ZGVK carries brand, part number and barcode', () => {
  const c = parseAmazonProduct(recorded('amazon-product-B0B6Z2ZGVK'), 'B0B6Z2ZGVK');
  expect(c).toEqual({
    asin: 'B0B6Z2ZGVK',
    title: 'RYOBI ONEAND HP 18V BRUSHLESS Cordless 1/4 in. Extended Reach Ratchet Tool ONLY PBLRC01B',
    brand: 'RYOBI',
    partNumber: 'PBLRC01B',
    upcs: ['033287193714'],
    price: 160,
    reviews: 212,
  });
  expect(grade({ brand: 'RYOBI', model: 'PBLRC01B' }, c!).grade).toBe('strong');
  expect(grade({ brand: 'RYOBI', model: 'PBLRC01B', upc: '033287193714' }, c!).grade).toBe('exact');
});

it('amazon-product-B0B3JWF5ZV carries brand, part number and barcode', () => {
  const c = parseAmazonProduct(recorded('amazon-product-B0B3JWF5ZV'), 'B0B3JWF5ZV');
  expect(c).toMatchObject({ asin: 'B0B3JWF5ZV', brand: 'RYOBI', partNumber: 'PBLRC25B', upcs: ['033287193721'], price: 169, reviews: 221 });
  expect(grade({ brand: 'RYOBI', model: 'PBLRC25B' }, c!).grade).toBe('strong');
});

it('hd-product-328814689 is the founder\'s bundle', () => {
  expect(parseHomeDepotProduct(recorded('hd-product-328814689'))).toEqual({
    retailer: 'homedepot',
    itemId: '328814689',
    storeSku: '1010927962',
    model: 'PBLRC2501SB',
    brand: 'RYOBI',
    upc: '033287232581',
    price: 189,
    regularPrice: 338,
    title: 'ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only)',
  });
  expect(parseHomeDepotProduct({})).toBeNull();
});

it('keeps a Home Depot row with no price at all', () => {
  const { listings } = parseHomeDepotSearch({ products: [{ product_id: '1', title: 'T', model_number: 'M' }] });
  expect(listings[0]).toMatchObject({ itemId: '1', price: null, regularPrice: null, percentOff: null, badge: null, brand: null });
});
it('keeps an Amazon row with no price, and reads a price range as no price', () => {
  const rows = parseAmazonSearch({ organic_results: [{ asin: 'A1', title: 'T' }, { asin: 'A2', title: 'T', price: '$10.00 - $20.00' }] });
  expect(rows.map((r) => r.price)).toEqual([null, null]);
  expect(rows[0]).toMatchObject({ brand: null, reviews: null, sponsored: false });
});
it('reads sponsored only from sponsored: true', () => {
  const rows = parseAmazonSearch({ organic_results: [{ asin: 'A1', title: 'T', sponsored: true }, { asin: 'A2', title: 'T', sponsored: 'yes' }, { asin: 'A3', title: 'T' }] });
  expect(rows.map((r) => r.sponsored)).toEqual([true, false, false]);
});
it('reads no barcode and no part number from a detail page that has neither', () => {
  expect(parseAmazonProduct({ product_results: { title: 'RYOBI Ratchet PBLRC25B' } }, 'A1')).toMatchObject({ asin: 'A1', partNumber: null, upcs: [], brand: null });
});
it('reads every barcode when a detail page lists several', () => {
  expect(parseAmazonProduct({ product_results: { title: 'T' }, product_details: { upc: '033287193714 033287193721' } }, 'A1')!.upcs).toEqual(['033287193714', '033287193721']);
});
it('returns empty values for a successful response with no results', () => {
  const none = { search_metadata: { status: 'Success' }, error: "Amazon hasn't returned any results for this query." };
  expect(parseHomeDepotSearch(none)).toEqual({ listings: [], hasNextPage: false });
  expect(parseAmazonSearch(none)).toEqual([]);
  expect(parseAmazonProduct(none, 'X')).toBeNull();
  expect(parseHomeDepotProduct(none)).toBeNull();
});
it('skips rows without an id', () => {
  expect(parseHomeDepotSearch({ products: [{ title: 'no id' }] }).listings).toEqual([]);
  expect(parseAmazonSearch({ organic_results: [{ title: 'no asin' }] })).toEqual([]);
});
it('cleans brand strings', () => {
  expect(cleanBrand('Brand: DEWALT')).toBe('DEWALT');
  expect(cleanBrand('Visit the RYOBI Store')).toBe('RYOBI');
});
