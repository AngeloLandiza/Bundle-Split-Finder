import { describe, expect, it } from 'vitest';

import { amazonNet, bundleProfit, priceForNet } from '../src/money';
import { bundlesCsv, RUN_COLUMNS } from '../src/scan/csv';
import { confirmedSourceName, confirmState, ebayListingChoices, parseConfirmedPrice } from '../src/scan/confirmed';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { bundleKey, DEFAULT_SCAN_SETTINGS, partKey, type BundleRecord, type MatchRecord } from '../src/scan/types';

const T0 = Date.UTC(2026, 10, 20, 12);
const LINK = 'https://www.ebay.com/itm/1';

const bundle = (): BundleRecord => ({
  key: bundleKey('1'),
  retailer: 'homedepot',
  itemId: '1',
  title: 'T',
  brand: 'RYOBI',
  model: 'KIT',
  upc: null,
  price: 100,
  regularPrice: null,
  percentOff: null,
  link: null,
  seenAt: T0,
  split: { components: ['A', 'B'], status: 'resolved', notes: [] },
});

const none = (model: string): MatchRecord => ({
  key: partKey('RYOBI', model),
  brand: 'RYOBI',
  model,
  status: 'none',
  asin: null,
  grade: null,
  alternatives: [],
  decidedBy: 'auto',
  updatedAt: T0,
  waitingSince: null,
});

describe('parseConfirmedPrice', () => {
  it('keeps a New price and an http(s) link, and stamps the time it is given', () => {
    expect(parseConfirmedPrice({ brand: ' ryobi ', model: ' pcl206 ', price: '80.005', link: ` ${LINK} ` }, T0)).toEqual({
      key: 'RYOBI:PCL206', brand: 'RYOBI', model: 'PCL206', price: 80.01, link: LINK, confirmedAt: T0,
    });
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price: 12, link: 'http://example.com/a' }, T0)).toMatchObject({ link: 'http://example.com/a' });
  });

  it('refuses a price that is not above $0, and a link that is not a web page', () => {
    for (const price of [0, -1, 100_000, '0.001', '', 'nope']) {
      expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price, link: LINK }, T0)).toBe('Enter a price above $0.');
    }
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price: 80, link: 'javascript:alert(1)' }, T0)).toBe('Enter a link that starts with http or https.');
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price: 80, link: 'https://user:secret@example.com/a' }, T0)).toBe('Enter a link to the listing, with no password in it.');
    expect(parseConfirmedPrice({ brand: ' ', model: 'A', price: 80, link: LINK }, T0)).toBe('Name the brand.');
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: ' ', price: 80, link: LINK }, T0)).toBe('Name the part.');
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price: 80, link: '' }, T0)).toBe('Enter a link to the listing.');
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: `~${'A'.repeat(120)}`, price: 10, link: LINK }, T0)).toBe('That name is too long to store.');
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: '~18V Charger', price: 15, link: 'https://www.facebook.com/marketplace/item/1' }, T0)).toMatchObject({
      key: 'RYOBI:~18V CHARGER', model: '~18V CHARGER', price: 15,
    });
  });
});

describe('the owner’s price form, as rules', () => {
  it('keeps a trimmed note, drops a blank one, and refuses a long one', () => {
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price: 5, link: LINK, note: '  at the store ' }, T0)).toMatchObject({ note: 'at the store' });
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price: 5, link: LINK, note: '   ' }, T0)).not.toHaveProperty('note');
    expect(parseConfirmedPrice({ brand: 'RYOBI', model: 'A', price: 5, link: LINK, note: 'x'.repeat(201) }, T0)).toBe('That note is too long to store.');
  });

  it('names where a link points without reading it', () => {
    expect(confirmedSourceName('https://www.ebay.com/itm/1')).toBe('eBay');
    expect(confirmedSourceName('https://m.facebook.com/marketplace/item/1')).toBe('Facebook');
    expect(confirmedSourceName('https://offerup.com/item/1')).toBe('offerup.com');
    expect(confirmedSourceName(null)).toBe('a link');
  });

  it('offers only stored eBay listings that carry their own price and a web link', () => {
    const option = (links: string[], linkPrices?: number[]) =>
      ({ prices: [{ kind: 'ebay_sold_new', ebay: { listings: 2, unitsSold: 2, low: 1, high: 2, medianPrice: 1, links, linkPrices } }] }) as never;
    expect(ebayListingChoices(option(['https://www.ebay.com/itm/1', 'javascript:x'], [60, 70]))).toEqual([{ url: 'https://www.ebay.com/itm/1', price: 60 }]);
    expect(ebayListingChoices(option(['https://www.ebay.com/itm/1']))).toEqual([]);
  });

  it('opens the form only when the part has been looked up and no Amazon price counts', () => {
    const part = (over: object) => ({ status: 'none', availability: 'missing', asin: null, price: null, prices: [], ...over }) as never;
    expect(confirmState(part({ status: 'review' }))).toBe('answer-first');
    expect(confirmState(part({ status: 'waiting' }))).toBe('look-up-first');
    expect(confirmState(part({ status: 'unmatched' }))).toBe('look-up-first');
    expect(confirmState(part({}))).toBe('open');
    expect(confirmState(part({ status: 'matched', availability: 'inactive', asin: 'B1', price: null }))).toBe('open');
    expect(confirmState(part({ status: 'matched', availability: 'active', asin: 'B1', price: 50 }))).toBe('amazon-counts');
  });
});

describe('a confirmed price in the report', () => {
  it('counts until an Amazon New price exists, does not apply to another part, and is written at the end of the run file', async () => {
    const store = new MemoryScanStore();
    await store.putBundle(bundle());
    await store.putMatch(none('A'));
    await store.putMatch(none('B'));
    await store.putConfirmedPrice({ key: partKey('RYOBI', 'A'), brand: 'RYOBI', model: 'A', price: 80, link: LINK, confirmedAt: T0 });

    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === bundleKey('1'))!;
    const [a, b] = row.parts;
    expect(row.section).toBe('missing_listing');
    expect(row.uncovered).toEqual(['B']);
    expect(a).toMatchObject({ model: 'A', price: 80, availability: 'missing' });
    expect(a!.prices.find((o) => o.kind === 'confirmed')).toMatchObject({ price: 80, link: LINK, reference: false });
    expect(b).toMatchObject({ model: 'B', price: null });
    expect(b!.prices.some((o) => o.kind === 'confirmed')).toBe(false);
    // Nov 23: B has no price, so there is no estimate; A's confirmed price is what the priced part brings.
    expect(row.estimate).toBeNull();
    expect(row.incomplete).toEqual({
      priced: 1, total: 2, cost: 100, pricedNet: amazonNet(80), breakEvenNet: 32, breakEvenPrice: priceForNet(32), unpriced: [{ model: 'B', qty: 1, state: 'no_listing' }],
    });

    const cells = bundlesCsv([row]).trimEnd().split('\n')[1]!.split(',');
    expect(cells).toHaveLength(RUN_COLUMNS.length);
    expect(cells.slice(-2)).toEqual([
      row.parts.map((p) => (p.model === 'A' ? '80' : '?')).join(' | '),
      row.parts.map((p) => (p.model === 'A' ? LINK : '?')).join(' | '),
    ]);

    await store.putMatch({ ...none('A'), status: 'matched', asin: 'B000000001', grade: 'exact' });
    await store.putPrice({ asin: 'B000000001', price: 50, reviews: null, seenAt: T0, checkedAt: T0 });
    const priced = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles.find((b) => b.key === bundleKey('1'))!;
    const part = priced.parts.find((p) => p.model === 'A')!;
    expect(part.price).toBe(50);
    expect(part.prices.find((o) => o.kind === 'confirmed')).toMatchObject({ reference: true });
    expect(priced.uncovered).toEqual(['B']);
    expect(priced.estimate).toBeNull();
    expect(priced.incomplete).toMatchObject({ priced: 1, pricedNet: amazonNet(50), breakEvenNet: 100 - amazonNet(50) });
  });

  it('counts a confirmed price while the Amazon listing is inactive, and the Amazon price when it is for sale again', async () => {
    const store = new MemoryScanStore();
    await store.putBundle({ ...bundle(), split: { components: ['A'], status: 'resolved', notes: [] } });
    await store.putMatch({ ...none('A'), status: 'matched', asin: 'B000000001', grade: 'exact' });
    await store.putPrice({ asin: 'B000000001', price: 50, reviews: null, seenAt: T0, checkedAt: T0 + 1 });
    await store.putConfirmedPrice({ key: partKey('RYOBI', 'A'), brand: 'RYOBI', model: 'A', price: 70, link: LINK, confirmedAt: T0 });

    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles[0]!;
    expect(row.section).toBe('inactive_listing');
    expect(row.parts[0]).toMatchObject({ availability: 'inactive', price: 70 });
    expect(row.parts[0]!.prices.find((o) => o.kind === 'confirmed')).toMatchObject({ reference: false, price: 70 });
    expect(row.estimate).toEqual(bundleProfit(100, amazonNet(70)));

    await store.putPrice({ asin: 'B000000001', price: 50, reviews: null, seenAt: T0, checkedAt: T0 });
    const active = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles[0]!;
    expect(active.parts[0]).toMatchObject({ availability: 'active', price: 50 });
    expect(active.parts[0]!.prices.find((o) => o.kind === 'confirmed')).toMatchObject({ reference: true });
    expect(active.estimate).toEqual(bundleProfit(100, amazonNet(50)));
  });

  it('counts a confirmed price for a kit item with no model number, and does not invent one', async () => {
    const store = new MemoryScanStore();
    await store.putCatalogEntry({
      key: partKey('RYOBI', 'PCLKIT'), brand: 'RYOBI', model: 'PCLKIT', title: 'Kit', kinds: [], isKit: true, upc: null, seenAt: T0, itemId: '9',
      page: { bullets: ['Includes: (1) PCL206, (1) 18V Charger'], description: null, readAt: T0 },
    });
    await store.putBundle({ ...bundle(), split: { components: ['PCLKIT'], status: 'resolved', notes: [] } });
    await store.putMatch(none('PCL206'));

    const open = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles[0]!;
    const split = open.options.find((o) => o.id === 'split:PCLKIT')!;
    expect(split.parts.map((p) => p.model)).toEqual(['PCL206']);
    expect(split.leftovers).toEqual(['PCL206', '18V Charger']);
    // Nov 23: PCL206 has no price: no estimate (before, $0 for the bundle). The charger has no model number and is no reason.
    expect(split.estimate).toBeNull();
    expect(split.incomplete).toMatchObject({ priced: 0, total: 1, pricedNet: 0, breakEvenNet: 100, unpriced: [{ model: 'PCL206', state: 'no_listing' }] });

    await store.putConfirmedPrice({ key: partKey('RYOBI', '~18V Charger'), brand: 'RYOBI', model: '~18V CHARGER', price: 40, link: LINK, confirmedAt: T0 });
    const row = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles[0]!;
    const way = row.options.find((o) => o.id === 'split:PCLKIT')!;
    expect(way.leftovers).toEqual(['PCL206']);
    expect(way.unnamed).toEqual([{ model: '~18V Charger', name: '18V Charger', qty: 1, price: 40, link: LINK }]);
    // The confirmed charger counts in what the priced parts bring; PCL206 must bring the rest.
    expect(way.estimate).toBeNull();
    expect(way.incomplete).toMatchObject({ priced: 0, total: 1, pricedNet: amazonNet(40), breakEvenNet: 100 - amazonNet(40), breakEvenPrice: priceForNet(100 - amazonNet(40)) });
    expect(way.range.lowest).toBeNull();

    await store.putMatch({ ...none('PCL206'), status: 'matched', asin: 'B000000002', grade: 'exact' });
    await store.putPrice({ asin: 'B000000002', price: 50, reviews: null, seenAt: T0, checkedAt: T0 });
    const both = (await buildReport(store, DEFAULT_SCAN_SETTINGS)).bundles[0]!;
    expect(both.section).toBe('missing_listing');
    expect(both.status).toBe('partial');
    expect(both.uncovered).toEqual([]);
    expect(both.estimate).toEqual(bundleProfit(100, amazonNet(50) + amazonNet(40)));
    expect(both.incomplete).toBeUndefined();
  });
});
