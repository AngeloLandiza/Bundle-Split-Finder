import { describe, expect, it } from 'vitest';

import type { ListingIdentity } from '../src/keepa/verify';
import { applyCatalogCheck, catalogChecksWanted, confirmationToReread, LADDER_VERSION } from '../src/scan/catalogCheck';
import { MemoryScanStore } from '../src/scan/memoryStore';
import type { MatchRecord } from '../src/scan/types';
import { wrongExample } from '../../scripts/measure-wrong-confirm';

// The ladder's re-read of stored confirmations (catalogCheck.ts, ladder 4) on the owner's example
// (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json), from its cached pull. No network, no search, no AI.

const ex = wrongExample();
const T = Date.UTC(2026, 10, 24, 12);
const HD_LINK = 'https://www.homedepot.com/p/322961591';

/** The part as the owner's app stored it: confirmed by the catalog rule, switched to from B0C3TN1Z7P. */
const stored = (): MatchRecord => ({
  key: ex.match.key, brand: 'DEWALT', model: 'DWST08017', status: 'matched', asin: ex.match.asin, grade: 'strong', alternatives: ex.match.alternatives,
  decidedBy: 'auto', updatedAt: T - 1000, waitingSince: null, source: 'page', verifiedBy: 'keepa_catalog', verifyEvidence: ex.match.verifyEvidence,
});

async function exampleStore(amazon = ex.amazonPrice, match: MatchRecord = stored()): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  await store.putMatch(match);
  await store.putPrice({ asin: ex.match.asin, price: amazon, reviews: null, seenAt: T - 1000, checkedAt: T - 1000 });
  await store.putPartPrice({
    key: ex.match.key, brand: 'DEWALT', model: 'DWST08017', itemId: '322961591', matchedModel: 'DWST08017', price: ex.homeDepotPrice,
    title: 'Adaptor Plate for TOUGHSYSTEM 2.0', link: HD_LINK, seenAt: T - 1000, checkedAt: T - 1000,
  });
  return store;
}

describe('the ladder re-reads a stored confirmation once (ladder 4)', () => {
  it('the example is queued from its cached pull and held for the owner: unknown, "its title names DWST60122-1, not DWST08017"', async () => {
    expect(LADDER_VERSION).toBe(4);
    const store = await exampleStore(40);
    expect(confirmationToReread(stored())).toBe(true);
    const parts = new Map([[ex.match.key, { saving: 18.1 }]]);
    expect(await catalogChecksWanted(store, parts)).toEqual([{ key: ex.match.key, brand: 'DEWALT', model: 'DWST08017', asin: 'B0DGLWKS9S', holds: 'match', recheck: true }]);
    const out = await applyCatalogCheck({ store, catalog: new Map(), now: () => T }, ex.listing);
    expect(out).toEqual([{ key: ex.match.key, asin: 'B0DGLWKS9S', status: 'unknown', reason: 'its title names DWST60122-1, not DWST08017', change: 'held' }]);
    const m = (await store.getMatch(ex.match.key))!;
    expect(m).toMatchObject({ status: 'review', asin: null, verifyEvidence: 'its title names DWST60122-1, not DWST08017: https://www.amazon.com/dp/B0DGLWKS9S' });
    expect(m.catalogChecks).toEqual([{ asin: 'B0DGLWKS9S', status: 'unknown', reason: 'its title names DWST60122-1, not DWST08017', at: T, ladder: 4 }]);
    expect((await store.getReview(`match:${ex.match.key}`))!.candidates[0]).toMatchObject({ asin: 'B0DGLWKS9S', title: ex.listing.title });
    expect(await catalogChecksWanted(store, parts)).toEqual([]);
  });

  it('a stored confirmation that still holds is recorded at ladder 4 and read no more; a right listing stays confirmed', async () => {
    const right: ListingIdentity = { ...ex.listing, asin: 'B0CHWF4JM9', title: 'DWST08017 Tough System 2.0 Adapter, Toolbox, Connected, Stacked Storage, Outdoors' };
    const store = await exampleStore(40, { ...stored(), asin: 'B0CHWF4JM9', alternatives: [] });
    const out = await applyCatalogCheck({ store, catalog: new Map(), now: () => T }, right);
    expect(out[0]).toMatchObject({ status: 'confirmed', change: 'kept' });
    const m = (await store.getMatch(ex.match.key))!;
    expect(m).toMatchObject({ status: 'matched', asin: 'B0CHWF4JM9', grade: 'strong', verifiedBy: 'keepa_catalog' });
    expect(confirmationToReread(m)).toBe(false);
  });
});
