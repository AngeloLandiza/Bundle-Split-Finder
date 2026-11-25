// The market around a listing, as each Keepa pull keeps it (core/src/keepa/parse.ts marketOf, trends.ts TrendMarket), on
// the real records of the 83 listings the owner's app counts (fixtures/keepa/stats-sample-2026-11-25.json, stats=180).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseProductResponse } from '../src/keepa/parse';
import { marketsOfBody, partTrendFromProduct } from '../src/keepa/trends';

const SAMPLE = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'keepa', 'stats-sample-2026-11-25.json'), 'utf8')) as { products: Record<string, unknown>[] };
const products = parseProductResponse({ products: SAMPLE.products }).products;
const of = (asin: string) => products.find((p) => p.asin === asin)!;

describe('what a pull keeps of the market (the recorded fields only)', () => {
  it('PCL515B: the averages Keepa recorded, no Amazon offer now, 74 New offers against 33 over 90 days', () => {
    expect(of('B0B88R7HWB')).toMatchObject({
      newAvg30: 5643, newAvg90: 6112,
      market: { newAvg180: 5589, amazonCurrent: null, buyBoxIsAmazon: null, newOffers: 74, newOffersAvg90: 33, outOfStock90: 0, hazmat: null },
    });
  });

  it('PBP004: the lithium-ion hazard from its record, and no Amazon offer', () => {
    expect(of('B09HDZ5MPV').market).toMatchObject({ amazonCurrent: null, hazmat: { unId: 'UN3480', name: 'LITHIUM ION BATTERIES', transportClass: '9' } });
  });

  it('PCG002: Amazon sells it itself at $34.97 (stats.current[0]); DW0737: Amazon also holds the Buy Box', () => {
    expect(of('B0B1QRQYK2').market).toMatchObject({ amazonCurrent: 3497, buyBoxIsAmazon: null });
    expect(of('B000RFRM0O').market).toMatchObject({ amazonCurrent: 8063, buyBoxIsAmazon: true });
  });

  it('a record with no history (FVB02, every average -1) keeps nulls, and its lone class "0" is no hazard', () => {
    expect(of('B0HQT2JYFV')).toMatchObject({ newAvg30: null, newAvg90: null, market: { newAvg180: null, newOffers: null, newOffersAvg90: null, hazmat: null } });
  });

  it('across the 83: buyBoxIsAmazon is only ever true or unstated; 32 have an Amazon offer; 16 name a UN number', () => {
    const m = products.map((p) => p.market!);
    expect(m.filter((x) => x.buyBoxIsAmazon === false)).toHaveLength(0);
    expect(m.filter((x) => x.buyBoxIsAmazon === true)).toHaveLength(20);
    expect(m.filter((x) => x.amazonCurrent !== null)).toHaveLength(32);
    expect(m.filter((x) => x.hazmat !== null)).toHaveLength(16);
    // Every listing Keepa says Amazon holds the Buy Box of has an Amazon offer now.
    expect(m.filter((x) => x.buyBoxIsAmazon === true && x.amazonCurrent === null)).toHaveLength(0);
  });

  it('the trend keeps it in dollars with the time of the pull; a cached answer gives the same', () => {
    const at = Date.parse('2026-11-25T12:00:00Z');
    const t = partTrendFromProduct(of('B0B88R7HWB'), at);
    expect(t.market).toEqual({
      at, newAvg30: 56.43, newAvg90: 61.12, newAvg180: 55.89, amazonPrice: null, buyBoxIsAmazon: null,
      newOffers: 74, newOffersAvg90: 33, outOfStock90: 0, hazmat: null,
    });
    const cached = marketsOfBody({ products: SAMPLE.products.filter((p) => p.asin === 'B0B88R7HWB') }, at);
    expect(cached).toEqual([{ asin: 'B0B88R7HWB', market: t.market }]);
    expect(marketsOfBody({ error: 'x' }, at)).toEqual([]);
  });
});
