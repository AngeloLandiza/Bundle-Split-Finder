import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ebayLabel, ebayPriceOption, ebayValue } from '../src/ebay/value';
import { preFilter } from '../src/ebay/filter';
import { parseItem, parseSearch, stripHtml } from '../src/ebay/parse';
import type { EbayListing } from '../src/ebay/types';

const load = (f: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/ebay/${f}`, import.meta.url), 'utf8'));
const search = parseSearch(load('browse-search-PCL206B-2026-11-19.json'));
const item = parseItem(load('browse-item-237179711800-2026-11-19.json'));
const PART = { brand: 'RYOBI', model: 'PCL206B' };
const first = search[0]!;

const listing = (over: Partial<EbayListing>): EbayListing => ({ ...item, ...over });

describe('parse (recorded Browse responses)', () => {
  it('reads the search summaries in order, with price, condition and categories', () => {
    expect(search).toHaveLength(10);
    expect(first).toMatchObject({
      itemId: 'v1|237179711800|0', title: 'RYOBI 18V 1/2 in. Drill/Driver (PCL206B) TOOL ONLY', price: 38.5, currency: 'USD', conditionId: '1000', epid: '13054315447',
      url: 'https://www.ebay.com/itm/237179711800',
    });
    expect(first.categoryIds).toContain('3247');
    expect(search[3]!.categoryIds).not.toContain('3247');
  });

  it('reads the item: aspects, sold count, revision, a stripped description', () => {
    expect(item).toMatchObject({ itemId: 'v1|237179711800|0', brand: 'Ryobi', mpn: 'PCL206', price: 38.5, soldQuantity: 13, revision: '2', conditionId: '1000' });
    expect(item.categoryIds).toEqual(['11700', '631', '3247', '184655']);
    expect(item.aspects).toContainEqual({ name: 'Set Includes', value: 'Battery, tool only' });
    expect(item.descriptionText).toMatch(/^The RYOBI 18V 1\/2 in\. Drill\/Driver \(PCL206B\)/);
    expect(item.descriptionText).not.toMatch(/<|&nbsp;|\s{2}/);
    expect(item.descriptionText.length).toBeLessThanOrEqual(4000);
  });

  it('keeps no seller, buyer or feedback data', () => {
    const dirty = {
      ...(load('browse-item-237179711800-2026-11-19.json') as { response: object }).response,
      seller: { username: 'x_seller', feedbackPercentage: '99.1' }, buyerProtection: 'x', sellerFeedback: 5,
    };
    const parsed = parseItem(dirty);
    const json = JSON.stringify(parsed);
    expect(json).not.toMatch(/x_seller|feedback|"seller"|buyer/i);
    expect(Object.keys(parsed).sort()).toEqual(
      ['aspects', 'brand', 'categoryIds', 'conditionId', 'currency', 'descriptionText', 'itemId', 'mpn', 'price', 'revision', 'soldQuantity', 'title', 'url'].sort(),
    );
    const summary = parseSearch({ itemSummaries: [{ itemId: 'v1|1|0', title: 'T', price: { value: '1', currency: 'USD' }, seller: { username: 'z' } }] });
    expect(JSON.stringify(summary)).not.toMatch(/seller|"z"/);
  });

  it('strips HTML, decodes entities, collapses space and caps at 4000', () => {
    expect(stripHtml('<p>A&nbsp;&amp; B</p>\n<script>x()</script><style>p{}</style><br/>  C&#39;s &lt;D&gt;')).toBe("A & B C's <D>");
    expect(stripHtml('<b>' + 'ab '.repeat(3000) + '</b>').length).toBeLessThanOrEqual(4000);
  });
});

describe('preFilter on the PCL206B search', () => {
  const { kept, dropped } = preFilter(PART, search);
  const id = (n: string): string => `v1|${n}|0`;

  it('drops the 3D-printed bit holder, the toolbox insert and the bit holder mount', () => {
    for (const n of ['236637525086', '206403539440', '800875926218']) {
      expect(dropped.find((d) => d.itemId === id(n))?.reason).toBe('not in Power Tools');
    }
  });

  it('passes the drills and the hard cases that name the model on to the judge, in search order', () => {
    expect(kept.map((l) => l.itemId)).toEqual(
      ['237179711800', '307277091818', '168866627985', '168746651736', '920080659249', '227583400448'].map(id),
    );
    expect(dropped.find((d) => d.itemId === id('840115329271'))?.reason).toBe('model not named');
    expect(kept.length + dropped.length).toBe(10);
  });

  it('accepts the RYOBI one-trailing-B twin: PCL206 listings pass for PCL206B and the other way round', () => {
    expect(preFilter({ brand: 'RYOBI', model: 'PCL206' }, search).kept).toHaveLength(6);
    const bare = search.filter((l) => l.itemId === id('920080659249'));
    expect(preFilter(PART, bare).kept).toHaveLength(1);
    expect(preFilter({ brand: 'RYOBI', model: 'PCL206BB' }, bare).kept).toHaveLength(0);
  });

  it('drops what is not New, has no price, is not USD, names another brand or never names the model', () => {
    const base = first;
    const run = (over: object): string | undefined => preFilter(PART, [{ ...base, ...over }]).dropped[0]?.reason;
    expect(run({ conditionId: '3000' })).toBe('not New');
    expect(run({ conditionId: null })).toBe('not New');
    expect(run({ price: null })).toBe('no price');
    expect(run({ currency: 'CAD' })).toBe('not priced in USD');
    expect(run({ brand: 'Milwaukee' })).toBe('names another brand');
    expect(run({ aspects: [{ name: 'Brand', value: 'DEWALT' }] })).toBe('names another brand');
    expect(run({ title: 'RYOBI 18V drill PCL2060' })).toBe('model not named');
    expect(run({ brand: 'Unbranded' })).toBeUndefined();
    expect(run({ title: 'RYOBI 18V drill', mpn: 'PCL206' })).toBeUndefined();
  });

  it('never accepts: a listing the rules cannot place is passed on, not marked', () => {
    expect(Object.keys(kept[0]!).sort()).toEqual(Object.keys(first).sort());
  });

  it('keeps at most 8, in search order, and says why the rest went', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...first, itemId: `v1|${i}|0` }));
    const r = preFilter(PART, many);
    expect(r.kept.map((l) => l.itemId)).toEqual(many.slice(0, 8).map((l) => l.itemId));
    expect(r.dropped).toHaveLength(4);
    expect(r.dropped[0]!.reason).toMatch(/beyond the first 8/);
  });
});

describe('ebayValue', () => {
  const l = (itemId: string, price: number, soldQuantity: number | null): EbayListing =>
    listing({ itemId, price, soldQuantity, url: `https://www.ebay.com/itm/${itemId}` });
  const m = (x: EbayListing) => ({ listing: x, verdict: 'match' as const });

  it('is null with no verified match that has sold, so the part has no eBay line', () => {
    expect(ebayValue([])).toBeNull();
    expect(ebayValue([{ listing: l('a', 40, 5), verdict: 'unsure' }, { listing: l('b', 40, 5), verdict: 'not_match' }])).toBeNull();
    expect(ebayValue([m(l('a', 40, 0)), m(l('b', 40, null))])).toBeNull();
  });

  it('one listing: the label reads "$38.50 · 1 listing, 13 sold" (the recorded item)', () => {
    const v = ebayValue([m(item)])!;
    expect(v).toMatchObject({ listings: 1, unitsSold: 13, low: 38.5, high: 38.5, medianPrice: 38.5, links: ['https://www.ebay.com/itm/237179711800'] });
    expect(ebayLabel(v)).toBe('eBay · New · $38.50 · 1 listing, 13 sold');
  });

  it('counts only verified matches that sold: range, units, weighted median, up to 3 links', () => {
    const v = ebayValue([
      m(l('a', 38.5, 13)), m(l('b', 54.99, 3)), m(l('c', 45, 25)), m(l('d', 99, 9)), m(l('zero', 1, 0)),
      { listing: l('x', 10, 50), verdict: 'unsure' as const },
    ])!;
    expect(v.listings).toBe(4);
    expect(v.unitsSold).toBe(50);
    expect([v.low, v.high]).toEqual([38.5, 99]);
    expect(v.medianPrice).toBe(45);
    expect(v.links).toEqual(['c', 'a', 'd'].map((x) => `https://www.ebay.com/itm/${x}`));
  });

  it('labels a range with the sold-weighted counts', () => {
    const v = ebayValue([m(l('a', 38.5, 13)), m(l('b', 54.99, 3)), m(l('c', 45, 25))])!;
    expect(ebayLabel(v)).toBe('eBay · New · $38.50–$54.99 · 3 listings, 41 sold');
  });

  it('becomes a reference ebay_sold_new price option', () => {
    const v = ebayValue([m(l('a', 38.5, 13)), m(l('c', 45, 25))])!;
    expect(ebayPriceOption(v, 1000)).toEqual({
      kind: 'ebay_sold_new', price: 45, condition: 'new', seller: null, shipsFrom: null, offers: 2, asin: null,
      link: 'https://www.ebay.com/itm/c', seenAt: 1000, reference: true,
    });
  });
});
