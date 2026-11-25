// The market around a listing (Nov 25): a trend stored before it gets its figures once from the Keepa answers already in the
// agent's cache (agent/marketBackfill.ts). On the real records (fixtures/keepa/stats-sample-2026-11-25.json); no network.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readPartTrend, writePartTrend, type PartTrend } from '../../core/src/keepa/trends';
import { backfillMarkets, cachedMarkets } from '../marketBackfill';
import { DirCache } from '../scanStore';

const SAMPLE = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'keepa', 'stats-sample-2026-11-25.json'), 'utf8')) as { products: Record<string, unknown>[] };
const rec = (asin: string) => SAMPLE.products.find((p) => p.asin === asin)!;

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('filling the market of stored trends from cached Keepa answers', () => {
  it('PCL515B and PBP004: the newest cached answer fills each trend without one; a trend that has one keeps it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'market-'));
    const cacheDir = join(dir, 'cache');
    const cache = new DirCache(cacheDir);
    const t0 = Date.parse('2026-11-23T14:00:00Z');
    const t1 = Date.parse('2026-11-25T14:00:00Z');
    // Two answers for PCL515B (the older one with a made-up average, to see the newest win), one batch with PBP004.
    const older = { ...rec('B0B88R7HWB'), stats: { ...(rec('B0B88R7HWB').stats as object), avg90: [-1, 9999] } };
    await cache.set('keepa:product?asin=B0B88R7HWB&domain=1&history=0&stats=180', { at: t0, data: { products: [older] } });
    await cache.set('keepa:product?asin=B0B88R7HWB,B09HDZ5MPV&domain=1&history=0&stats=180', { at: t1, data: { products: [rec('B0B88R7HWB'), rec('B09HDZ5MPV')] } });
    const base = (asin: string): PartTrend => ({ asin, amazonPrice: 53, salesRank: null, offerCount: null, pulledAt: t1, monthlySold: 700 });
    await writePartTrend(cache, base('B0B88R7HWB'));
    await writePartTrend(cache, base('B09HDZ5MPV'));
    // A trend already stored with a market (a pull after this change) is not touched.
    const kept = { ...base('B0B1QRQYK2'), market: { at: t1, newAvg30: 1, newAvg90: 1, newAvg180: 1, amazonPrice: null, buyBoxIsAmazon: null, newOffers: null, newOffersAvg90: null, outOfStock90: null, hazmat: null } };
    await writePartTrend(cache, kept);
    await cache.set('keepa:product?asin=B0B1QRQYK2&domain=1&history=0&stats=180', { at: t1, data: { products: [rec('B0B1QRQYK2')] } });

    const markets = cachedMarkets(cacheDir);
    expect(markets.get('B0B88R7HWB')).toMatchObject({ at: t1, newAvg90: 61.12 });
    expect(await backfillMarkets(cache, markets)).toBe(2);
    expect((await readPartTrend(cache, 'B0B88R7HWB'))!).toMatchObject({ monthlySold: 700, market: { at: t1, newAvg90: 61.12, newOffers: 74 } });
    expect((await readPartTrend(cache, 'B09HDZ5MPV'))!.market!.hazmat).toEqual({ unId: 'UN3480', name: 'LITHIUM ION BATTERIES', transportClass: '9' });
    expect((await readPartTrend(cache, 'B0B1QRQYK2'))!.market).toEqual(kept.market);
    // Done: a second run fills nothing.
    expect(await backfillMarkets(cache, cachedMarkets(cacheDir))).toBe(0);
  });

  it('no cache folder: nothing to fill', async () => {
    expect(cachedMarkets(join(tmpdir(), 'no-such-cache-dir-market'))).toEqual(new Map());
  });
});
