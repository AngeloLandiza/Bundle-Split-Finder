import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TokenBudget } from '../src/keepa/budget';
import { KeepaClient } from '../src/keepa/client';
import { productTokenEstimate } from '../src/keepa/estimates';
import { keepaProductSearchResult } from '../src/keepa/fetchStep';
import { parseProductResponse } from '../src/keepa/parse';
import { amazonPriceDelta, partTrendFromProduct, readPartTrend, writePartTrend, type PartTrend } from '../src/keepa/trends';
import { MemoryCache } from '../src/serpapi/client';

describe('keepa trend cache', () => {
  it('round-trips a part trend in the shared cache', async () => {
    const cache = new MemoryCache();
    const trend: PartTrend = { asin: 'B0TEST', amazonPrice: 49.99, salesRank: 1200, offerCount: 3, pulledAt: 1000 };
    await writePartTrend(cache, trend);
    expect(await readPartTrend(cache, 'B0TEST')).toEqual(trend);
  });

  it('amazonPriceDelta is positive when price drops', () => {
    const prev: PartTrend = { asin: 'B0', amazonPrice: 50, salesRank: null, offerCount: null, pulledAt: 1 };
    const next: PartTrend = { asin: 'B0', amazonPrice: 40, salesRank: null, offerCount: null, pulledAt: 2 };
    expect(amazonPriceDelta(prev, next)).toBe(10);
    expect(amazonPriceDelta(undefined, next)).toBeNull();
  });
});

describe('the Keepa fields tracking reads, from the recorded product response', () => {
  const body = JSON.parse(
    readFileSync(new URL('../../fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const products = parseProductResponse(body).products;

  it('keeps monthlySold, the FBA pick-and-pack fee, the referral percentage and the buy-box-eligible offer counts', () => {
    const dcb606 = products.find((p) => p.asin === 'B01H9BL8EO')!;
    expect(dcb606.monthlySold).toBe(1000);
    expect(dcb606.fbaPickAndPackFee).toBe(710);
    expect(dcb606.referralFeePercentage).toBe(13.83);
    expect(dcb606.buyBoxEligibleOfferCounts).toEqual([42, 14, 3, 2, 0, 0, 0, 0]);
    // history=0 and no stats: the recording has no sales rank and no Amazon price.
    expect(dcb606.salesRanks).toBeUndefined();
    expect(dcb606.amazonPrice).toBeNull();
  });

  it('a part trend carries them in dollars and counts, and says null where Keepa gave nothing', () => {
    const t = partTrendFromProduct(products.find((p) => p.asin === 'B09M3TL9BB')!, 5000);
    expect(t).toEqual({
      asin: 'B09M3TL9BB', amazonPrice: null, salesRank: null, offerCount: null, pulledAt: 5000,
      monthlySold: 600, fbaFee: 7.6, buyBoxEligibleOffers: 40,
    });
    const bare = partTrendFromProduct({ asin: 'B0NONE' }, 1);
    expect([bare.monthlySold, bare.fbaFee, bare.buyBoxEligibleOffers]).toEqual([null, null, null]);
  });

  it('a price_only refresh asks for stats (free), so a recorded product with stats.current yields its New price and rank', async () => {
    const urls: string[] = [];
    // The recorded DCF921B product as Keepa answers once stats is asked for: Keepa's documented stats.current
    // (statistics-object.html: 0 AMAZON, 1 NEW, 3 SALES; -1 no offer). Amazon does not sell it; the lowest New offer is $199.00.
    const recorded = (body.products as Record<string, unknown>[]).find((p) => p.asin === 'B09M3TL9BB')!;
    const withStats = { ...body, products: [{ ...recorded, stats: { current: [-1, 19900, -1, 2345] } }] };
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(urls.length === 1 ? withStats : body), { status: 200 });
    }) as typeof fetch;
    const client = new KeepaClient({ apiKey: 'fixture-key', budget: new TokenBudget({ reserve: 0, maxPerRun: 50 }), fetchFn });
    const r = await keepaProductSearchResult(client, 'B09M3TL9BB', { label: 'refresh', trackingDepth: 'price_only' });
    expect(new URL(urls[0]!).searchParams.get('stats')).toBe('180');
    expect(new URL(urls[0]!).searchParams.get('offers')).toBeNull();
    expect((r.data as { product_results: { extracted_price: number } }).product_results.extracted_price).toBe(199);
    expect(r.keepaProduct).toMatchObject({ amazonPrice: 19900, amazonPriceSource: 'new_lowest', statsSalesRank: 2345 });
    expect(partTrendFromProduct(r.keepaProduct!, 1)).toMatchObject({ amazonPrice: 199, salesRank: 2345, monthlySold: 600 });

    // The response recorded on Nov 22 was pulled without stats: it has no price at all, which is why refreshes were blind.
    await client.getProducts(['B09M3TL9BB', 'X'], 1, { trackingDepth: 'full', estimate: 26 });
    expect(new URL(urls[1]!).searchParams.get('offers')).toBe('20');
    expect(parseProductResponse(body).products.every((p) => p.amazonPrice === null)).toBe(true);
  });

  it('tokens per depth: price_only and price_and_rank 1 per ASIN (stats is free), full adds up to two offer pages at 6', () => {
    expect([productTokenEstimate('price_only', 3), productTokenEstimate('price_and_rank', 3), productTokenEstimate('full', 3)]).toEqual([3, 3, 39]);
  });

  it('a negative monthlySold is Keepa saying it has no data, not a figure', () => {
    const p = parseProductResponse({ products: [{ asin: 'B0X', monthlySold: -1, fbaFees: { pickAndPackFee: -1 } }] }).products[0]!;
    expect(p.monthlySold).toBeNull();
    expect(p.fbaPickAndPackFee).toBeNull();
  });
});
