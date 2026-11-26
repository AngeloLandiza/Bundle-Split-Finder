// Nov 25: a Home Depot product's picture, kept from data the app already reads (no page read for it). The shapes are the
// recorded ones: a list entry's `media` (fixtures/homedepot-pages/bundle-listing-sample-2026-11-23.json), SerpApi's
// `thumbnails` / `images` (fixtures/recorded/hd-bundles-ryobi-p1.json, hd-product-328814689.json) and a product page's state
// (fixtures/homedepot-pages/pages-2026-11-10.json, whose recording dropped `media`; the product's own picture from SerpApi's
// recording of the same item is put back in the recorded list-entry shape).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { HD_PICTURE_SIZE, hdPicture, hdThumbnail, parseBundlePage, parseListingState, parseProductPage, parsePromoPage } from '../src/hdPage';
import { listedOf } from '../src/scan/listingSource';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { readSetItemsFor, savePartPrices } from '../src/scan/runner';
import { bundleKey } from '../src/scan/types';
import { itemOf, pairBundleRecord, type BogoPair } from '../src/tracking/bogoPairs';

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), 'utf8')) as Record<string, unknown>;

/** The `media` object of the recorded list entry, cut out of the sample's text (the sample keeps 1500 characters of it). */
function recordedMedia(): Record<string, unknown> {
  const sample = (fixture('homedepot-pages/bundle-listing-sample-2026-11-23.json').result as { sample: { entries: { kind: string; text: string }[] } }).sample;
  const text = sample.entries.find((e) => e.kind === 'base-searchNav-#')!.text;
  const start = text.indexOf('"media":') + '"media":'.length;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
  }
  throw new Error('no media in the sample');
}

const MEDIA = recordedMedia();
const RECORDED_145 = 'https://images.thdstatic.com/productImages/1efa1410-45b1-42af-8fd5-80fa9ae69c8b/svn/ryobi-power-drills-64_145.jpg';
const PRODUCT = (fixture('recorded/hd-product-328814689.json').product_results as { images: string[][] }).images;
const PAGE = (fixture('homedepot-pages/pages-2026-11-10.json').pages as { itemId: string; text: string }[]).find((p) => p.itemId === '328814689')!;
const PAGE_145 = 'https://images.thdstatic.com/productImages/ce04bc06-2150-444a-be18-a8f75506a1e9/svn/ryobi-cordless-ratchets-pblrc2501sb-64_145.jpg';

/** The recorded page with the item's own picture as `media`, in the recorded list-entry shape. */
function pageWithMedia(asRef = false): string {
  const mark = 'window.__APOLLO_STATE__=';
  const at = PAGE.text.indexOf(mark) + mark.length;
  let depth = 0;
  let end = at;
  for (let i = at, inString = false; i < PAGE.text.length; i++) {
    const c = PAGE.text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i + 1; break; }
  }
  const state = JSON.parse(PAGE.text.slice(at, end)) as Record<string, Record<string, unknown>>;
  const media = { __typename: 'Media', images: [{ __typename: 'Image', url: PRODUCT[0]![0]!.replace(/_65\.jpg$/, '_<SIZE>.jpg'), type: 'IMAGE', subType: 'PRIMARY', sizes: ['65', '100', '145', '300', '400', '600', '1000'] }] };
  if (asRef) {
    state['Media:328814689'] = media;
    state['base-catalog-328814689']!.media = { __ref: 'Media:328814689' };
  } else state['base-catalog-328814689']!.media = media;
  return `${mark}${JSON.stringify(state)}`;
}

describe('a Home Depot picture', () => {
  it('is the recorded list entry’s first image at 145 px, a size the entry itself lists', () => {
    expect((MEDIA.images as { sizes: string[] }[])[0]!.sizes).toContain(String(HD_PICTURE_SIZE));
    expect(hdPicture(MEDIA)).toBe(RECORDED_145);
  });

  it('is SerpApi’s 145 px address of the first picture of a row', () => {
    const row = (fixture('recorded/hd-bundles-ryobi-p1.json').products as { thumbnails: string[][] }[])[0]!;
    expect(hdThumbnail(row.thumbnails)).toBe(row.thumbnails[0]!.find((u) => u.endsWith('_145.jpg')));
    expect(hdThumbnail(PRODUCT)).toBe(PAGE_145);
  });

  it('takes the largest listed size when none reaches 145, and follows an Apollo reference', () => {
    const img = (MEDIA.images as Record<string, unknown>[])[0]!;
    expect(hdPicture({ images: [{ ...img, sizes: ['65', '100'] }] })).toBe(RECORDED_145.replace('_145', '_100'));
    expect(hdPicture({ __ref: 'Media:1' }, { 'Media:1': MEDIA })).toBe(RECORDED_145);
  });

  it.each([
    ['no media', undefined],
    ['no images', { images: [] }],
    ['a <SIZE> address and no sizes', { images: [{ url: 'https://images.thdstatic.com/productImages/x/svn/y-64_<SIZE>.jpg', type: 'IMAGE' }] }],
    ['a video first and no image', { images: [{ url: 'https://images.thdstatic.com/productImages/x/svn/y.jpg', type: 'VIDEO' }] }],
    ['another host', { images: [{ url: 'https://inlinecontent.thdstatic.com/25H/x.jpg', type: 'IMAGE' }] }],
    ['plain http', { images: [{ url: 'http://images.thdstatic.com/productImages/x/svn/y_145.jpg', type: 'IMAGE' }] }],
    ['a script address', { images: [{ url: 'javascript:alert(1)', type: 'IMAGE' }] }],
  ])('is none for %s', (_n, media) => expect(hdPicture(media)).toBeNull());

  it('rides on every reading of a product page: bundle page, product page, promo page, inline or by reference', () => {
    for (const text of [pageWithMedia(), pageWithMedia(true)]) {
      expect(parseBundlePage(text, '328814689')!.image).toBe(PAGE_145);
      expect(parseProductPage(text, '328814689')!.image).toBe(PAGE_145);
      expect(parsePromoPage(text, '328814689')!.image).toBe(PAGE_145);
    }
    // The recording as it is (no media): no picture, and no field.
    expect(parseBundlePage(PAGE.text, '328814689')).not.toHaveProperty('image');
  });

  it('rides on a list entry and on the item the helper hands on', () => {
    const state = { 'base-searchNav-339857091': { itemId: '339857091', identifiers: { brandName: 'RYOBI', productLabel: 'Drill kit', modelNumber: 'PCL201K1', canonicalUrl: '/p/x/339857091' }, media: MEDIA } };
    const [product] = parseListingState(state);
    expect(product!.image).toBe(RECORDED_145);
    expect(listedOf(product!).image).toBe(RECORDED_145);
  });
});

describe('a part’s Home Depot picture', () => {
  const ITEM = '328814689';
  const found = (over: Record<string, unknown> = {}) => ({
    brand: 'RYOBI', model: 'PBLRC2501SB', status: 'found', itemId: ITEM, matchedModel: 'PBLRC2501SB', price: 149, title: 't', link: `https://www.homedepot.com/p/${ITEM}`, image: PAGE_145, ...over,
  });
  const asked = [{ brand: 'RYOBI', model: 'PBLRC2501SB' }];

  it('is kept on its part price record; a later reading without one keeps it; one not on the image host is dropped', async () => {
    const store = new MemoryScanStore();
    await savePartPrices(store, asked, [found()], 1);
    expect((await store.getPartPrice('RYOBI:PBLRC2501SB'))!.image).toBe(PAGE_145);
    await savePartPrices(store, asked, [found({ image: undefined, price: 139 })], 2);
    expect(await store.getPartPrice('RYOBI:PBLRC2501SB')).toMatchObject({ price: 139, image: PAGE_145 });
    await savePartPrices(store, asked, [found({ status: 'not_found', price: null, image: undefined })], 3);
    expect((await store.getPartPrice('RYOBI:PBLRC2501SB'))!.image).toBe(PAGE_145);
    const other = new MemoryScanStore();
    await savePartPrices(other, asked, [found({ image: 'https://evil.example/x.jpg' })], 1);
    expect(await other.getPartPrice('RYOBI:PBLRC2501SB')).not.toHaveProperty('image');
  });

  it('comes from a set item’s own page when the set’s items are read', async () => {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('339857091'), retailer: 'homedepot', itemId: '339857091', title: 'Set', brand: 'RYOBI', model: '', upc: null, price: 74.94, regularPrice: 99,
      percentOff: 24, link: null, seenAt: 1, split: null, set: { items: [{ itemId: ITEM, quantity: 1 }], dollarOff: null, percentageOff: null },
    });
    // The recorded page names no price (its pricing was not recorded); the item's price sold alone is given here.
    const page = { ...parsePromoPage(pageWithMedia(), ITEM)!, price: 149 };
    await readSetItemsFor({ store, read: async () => [{ itemId: ITEM, kind: 'read', page }], itemIds: [ITEM], now: () => 5 });
    expect((await store.getPartPrice('RYOBI:PBLRC2501SB'))!.image).toBe(PAGE_145);
  });
});

describe('a BOGO pair’s picture', () => {
  it('is its item page’s, else the one stored', () => {
    const page = parsePromoPage(pageWithMedia(), '328814689')!;
    const item = itemOf(page, undefined, 5);
    expect(item.image).toBe(PAGE_145);
    const pair = { key: bundleKey('328814689'), itemId: '328814689', brand: 'RYOBI', model: 'PBLRC2501SB', title: 't', price: 149, wasPrice: null, link: 'https://www.homedepot.com/p/328814689', promotionId: '1', starterItemId: '328814689', starterModel: 'PBLRC2501SB', freeModel: 'PBP005', endsAt: null, description: null } as unknown as BogoPair;
    expect(pairBundleRecord(pair, item, undefined, 5).image).toBe(PAGE_145);
    const kept = pairBundleRecord(pair, { ...item, image: undefined }, { ...pairBundleRecord(pair, item, undefined, 5) }, 6);
    expect(kept.image).toBe(PAGE_145);
  });
});
