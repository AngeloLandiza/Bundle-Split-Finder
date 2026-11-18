import { describe, expect, it } from 'vitest';

import { MemoryScanStore } from '../src/scan/memoryStore';
import { OverlayStore } from '../src/scan/overlayStore';
import type { ListingRecord, ScanJob } from '../src/scan/types';
import { storeConformance } from './storeConformance';

// Hand-made records: these tests are about the layer's bookkeeping, not about any page or listing.

storeConformance('OverlayStore over an empty MemoryScanStore', async () => new OverlayStore(new MemoryScanStore()));

const listing = (asin: string, price: number): ListingRecord => ({
  asin, brand: 'RYOBI', title: `RYOBI ${asin}`, models: [], image: null, price, reviews: null, seenAt: 1, checkedAt: 1,
});

describe('OverlayStore over a store with records', () => {
  it('reads fall through, its own writes win, lists keep the store order, and the store underneath is never written', async () => {
    const base = new MemoryScanStore();
    await base.putListing(listing('B2', 20));
    await base.putListing(listing('B4', 40));
    const job = { id: '1', startedAt: 1 } as ScanJob;
    await base.putScan(job);
    const before = JSON.stringify([await base.listListings(), await base.listScans()]);

    const layer = new OverlayStore(base);
    expect(await layer.getListing('B2')).toEqual(listing('B2', 20));
    await layer.putListing(listing('B4', 41));
    await layer.putListing(listing('B1', 10));
    await layer.putScan({ id: '2', startedAt: 2 } as ScanJob);

    expect((await layer.listListings()).map((l) => [l.asin, l.price])).toEqual([['B1', 10], ['B2', 20], ['B4', 41]]);
    expect((await layer.listScans()).map((s) => s.id)).toEqual(['2', '1']);
    expect(await layer.getListing('B4')).toEqual(listing('B4', 41));
    expect(JSON.stringify([await base.listListings(), await base.listScans()])).toBe(before);
  });

  it('a record read or written is a copy: changing it changes nothing stored', async () => {
    const layer = new OverlayStore(new MemoryScanStore());
    const l = listing('B1', 10);
    await layer.putListing(l);
    l.price = 99;
    const got = (await layer.getListing('B1'))!;
    got.price = 98;
    expect((await layer.getListing('B1'))!.price).toBe(10);
  });
});
