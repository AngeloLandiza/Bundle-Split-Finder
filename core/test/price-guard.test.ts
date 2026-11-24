import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkIdentity, type ListingIdentity } from '../src/keepa/verify';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { applyPriceGuard, PRICE_RATIO_LIMIT, priceFarAbove, priceGuardReason } from '../src/scan/priceGuard';
import type { MatchRecord } from '../src/scan/types';
import { loadScanFolder } from '../../scripts/data-folder';
import { priceRatios, replayScan5, wrongExample } from '../../scripts/measure-wrong-confirm';

// The price guard (core/src/scan/priceGuard.ts) and the ladder's re-read of stored confirmations (catalogCheck.ts, ladder 4)
// on the owner's example (fixtures/keepa/catalog-wrong-part-number-B0DGLWKS9S.json) and the owner's fifth scan
// (fixtures/e2e-2026-11-23/after-scan5). No network, no search, no AI.

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

describe('the price guard', () => {
  it('holds the example: the part goes to "Which listing" with the plain reason and both links, nothing rejected', async () => {
    const store = await exampleStore();
    const out = await applyPriceGuard(store, T);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("Amazon's price is 9.7× Home Depot's price for this part: check the listing");
    const m = (await store.getMatch(ex.match.key))!;
    expect(m).toMatchObject({ status: 'review', asin: null, grade: null, decidedBy: 'auto' });
    expect(m.verifiedBy).toBeUndefined();
    expect(m.rejectedAsins).toBeUndefined();
    expect(m.verifyEvidence).toBe(`Amazon's price is 9.7× Home Depot's price for this part: check the listing ($389 on Amazon, $39.99 at Home Depot): https://www.amazon.com/dp/B0DGLWKS9S ${HD_LINK}`);
    const q = (await store.getReview(`match:${ex.match.key}`))!;
    expect(q).toMatchObject({ kind: 'match', answer: null, reason: "Amazon's price is 9.7× Home Depot's price for this part: check the listing" });
    expect(q.candidates.map((c) => c.asin)).toEqual(['B0DGLWKS9S', 'B0C3TN1Z7P', 'B0HMV5V9L7', 'B0HQQZWYTX']);
    expect(q.candidates[0]).toMatchObject({ price: 389, reasons: ["Amazon's price is 9.7× Home Depot's price for this part: check the listing"] });
    // Run again: nothing more happens (the part waits for the owner).
    expect(await applyPriceGuard(store, T + 1)).toEqual([]);
  });

  it('holds it even if the title were silent: the catalog rule would confirm, the price still says look', async () => {
    const silent: ListingIdentity = { ...ex.listing, title: 'Dewalt Pro Backpack x McLaren F1 Team, Limited Edition' };
    expect(checkIdentity(ex.want, silent).status).toBe('confirmed');
    const store = await exampleStore();
    expect((await applyPriceGuard(store, T)).map((o) => o.key)).toEqual(['DEWALT:DWST08017']);
  });

  it('a right listing at 2.8× is untouched (A98401 on B09V1PG5R1, confirmed, $27.93 against $9.97), and so is every stored match', async () => {
    const store = await loadScanFolder(join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan5'));
    const before = await store.getMatch('RYOBI:A98401');
    expect(before).toMatchObject({ status: 'matched', asin: 'B09V1PG5R1', grade: 'strong' });
    expect(await applyPriceGuard(store, T)).toEqual([]);
    expect(await store.getMatch('RYOBI:A98401')).toEqual(before);
    // The example's ratio scaled to 2.8× is kept too.
    expect(await applyPriceGuard(await exampleStore(2.8 * ex.homeDepotPrice), T)).toEqual([]);
  });

  it("never touches the owner's decision, nor a part whose question he answered", async () => {
    expect(await applyPriceGuard(await exampleStore(ex.amazonPrice, { ...stored(), decidedBy: 'user' }), T)).toEqual([]);
    const store = await exampleStore();
    await store.putReview({
      id: `match:${ex.match.key}`, kind: 'match', subject: ex.match.key, brand: 'DEWALT', model: 'DWST08017', title: null, reason: 'x',
      candidates: [], choices: [], openedAt: 1, answer: 'B0DGLWKS9S', answeredAt: 2,
    });
    expect(await applyPriceGuard(store, T)).toEqual([]);
    expect((await store.getMatch(ex.match.key))!.status).toBe('matched');
  });

  it('the threshold, from the measured ratios: every right listing at or below 1.63×, every counted one at or below 2.80×, only wrong ones above', () => {
    expect(PRICE_RATIO_LIMIT).toBe(4);
    const ratios = priceRatios();
    expect(ratios.length).toBeGreaterThan(250);
    expect(Math.max(...ratios.filter((r) => r.key === 'is').map((r) => r.ratio))).toBeLessThan(1.7);
    expect(Math.max(...ratios.filter((r) => r.from.startsWith('after-scan5')).map((r) => r.ratio))).toBeCloseTo(2.8, 2);
    expect(ratios.filter((r) => r.ratio > PRICE_RATIO_LIMIT).map((r) => [r.asin, r.key])).toEqual([['B0DGLWKS9S', 'not'], ['B0F3N79KTM', 'not'], ['B0F3N79KTM', 'not']]);
    expect(priceFarAbove(389, 39.99)).toBeCloseTo(9.73, 2);
    expect(priceFarAbove(27.93, 9.97)).toBeNull();
    expect(priceFarAbove(10, 0)).toBeNull();
    expect(priceGuardReason(9.727)).toBe("Amazon's price is 9.7× Home Depot's price for this part: check the listing");
  });
});

describe('the replay: the owner\'s fifth scan and the set the example came from', () => {
  it('no stored match changes under either rule; the set loses its estimate and asks "Which listing"', async () => {
    const r = await replayScan5();
    expect(r.familyChanged).toEqual([]);
    expect(r.guardHeld).toEqual([]);
    expect(r.highestKept).toMatchObject({ key: 'RYOBI:A98401', asin: 'B09V1PG5R1' });
    expect(r.set.before).toEqual({
      section: 'confirmed', profit: 288.43, priced: null,
      part: 'DWST08017 matched B0DGLWKS9S strong $389; DWST14925 matched B0799RHJ7W strong $14.88',
    });
    expect(r.set.after).toEqual({
      section: 'missing_listing', profit: null, priced: '1 of 2 priced: DWST08017 review',
      part: 'DWST08017 review no listing; DWST14925 matched B0799RHJ7W strong $14.88',
    });
    expect(r.set.question).toEqual({ reason: "Amazon's price is 9.7× Home Depot's price for this part: check the listing", candidates: ['B0DGLWKS9S', 'B0C3TN1Z7P', 'B0HMV5V9L7', 'B0HQQZWYTX'] });
  });

});
