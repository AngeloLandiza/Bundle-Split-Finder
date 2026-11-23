import { describe, expect, it } from 'vitest';

import { amazonPriceDelta, readPartTrend, writePartTrend, type PartTrend } from '../src/keepa/trends';
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