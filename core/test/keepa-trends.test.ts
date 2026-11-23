import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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

  it('a negative monthlySold is Keepa saying it has no data, not a figure', () => {
    const p = parseProductResponse({ products: [{ asin: 'B0X', monthlySold: -1, fbaFees: { pickAndPackFee: -1 } }] }).products[0]!;
    expect(p.monthlySold).toBeNull();
    expect(p.fbaPickAndPackFee).toBeNull();
  });
});
