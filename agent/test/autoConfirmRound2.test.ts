import { describe, expect, it } from 'vitest';

import type { DealRow } from '../../core/src/api/contract';
import type { KeepaProduct } from '../../core/src/keepa/types';
import { narrowBrandContradiction } from '../../core/src/keepa/verify';
import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import type { ListingRecord, MatchRecord } from '../../core/src/scan/types';
import type { BundleSignals } from '../../core/src/tracking/signals';
import { LIVE_HELD, measureNarrowBrandRule } from '../../scripts/measure-autoconfirm';
import { confirmationQueue, repickTargets, rung2CanRun, unconfirmableOf, type AutoConfirmState } from '../autoConfirm';
import { repickUnconfirmed } from '../verifyMatches';
import { confirmingNote } from '../views';

// The listing ladder, round 2, on the two listings the owner's live deals held (Nov 23): PBP004 on B09HDZ5MPV ("TTI Ryobi
// PBP004 …", brand TTI) and PCG002 on B0B1QRQYK2 ("ONEAND 18V Lithium-ION Charger PCG002", brand ONEAND), with 102
// searches left and a reserve of 100. No network: Keepa is a fake.

const T = Date.UTC(2026, 10, 23, 20);
const titleMatch = (model: string, asin: string): MatchRecord => ({
  key: `RYOBI:${model}`, brand: 'RYOBI', model, status: 'matched', asin, grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: 1, waitingSince: null,
  catalogChecks: [{ asin, status: 'unknown', reason: `Amazon's catalog lists no part number that is ${model}`, at: 1, ladder: 1 }],
});
const listing = (asin: string, brand: string, title: string, models: string[]): ListingRecord => ({
  asin, brand, title, models, image: null, price: null, reviews: null, seenAt: null, checkedAt: 1,
});
const live = (model: string) => LIVE_HELD.find((h) => h.model === model)!.listing;

async function liveStore(): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  for (const model of ['PBP004', 'PCG002']) {
    const l = live(model);
    await store.putMatch(titleMatch(model, l.asin));
    await store.putListing(listing(l.asin, l.brand!, l.title!, [model]));
  }
  return store;
}

const signals: Record<string, BundleSignals> = {
  'hd-psk': {
    bundleKey: 'hd-psk', brand: 'RYOBI', model: 'PSK1212SB-PCL515B', at: T, signals: [], buyNow: null,
    options: [{
      optionId: 'a', label: 'Amazon', profit: 43.19, roiPercent: 43.6, meetsThresholds: true, velocity: {} as never, baseline: {} as never, buyNow: false,
      buyPending: { listings: 2, asins: ['B09HDZ5MPV', 'B0B1QRQYK2'] }, unconfirmed: ['B09HDZ5MPV', 'B0B1QRQYK2'], notBuyNow: null,
    }],
  },
};

describe('round 2: no endless "being confirmed"', () => {
  it('an allowance of 0 (102 searches left, reserve 100) does not queue rung 2, and no other switch does either', () => {
    const base = { enabled: true, hasKey: true, paused: false, serp: { left: 102 }, reserve: 100, perDay: null, state: undefined, now: T };
    expect(rung2CanRun(base)).toBe(false);
    expect(rung2CanRun({ ...base, serp: { left: 140 } })).toBe(true);
    expect(rung2CanRun({ ...base, serp: { left: 140 }, enabled: false })).toBe(false);
    expect(rung2CanRun({ ...base, serp: { left: 140 }, hasKey: false })).toBe(false);
    expect(rung2CanRun({ ...base, serp: { left: 140 }, state: { day: '2026-11-23', spent: 0, tried: [], exhaustedDay: '2026-11-23' } })).toBe(false);
  });

  it('the deal says why each listing could not be confirmed, is blocked, and never says "being confirmed"', async () => {
    const store = await liveStore();
    const q = confirmationQueue({ catalog: [], dripNextAt: T + 60_000, verify: [], verifyNextAt: T, state: undefined, now: T });
    const unconfirmable = await unconfirmableOf(store, signals, q.queue);
    expect(unconfirmable).toEqual({
      B09HDZ5MPV: { key: 'RYOBI:PBP004', model: 'PBP004', reason: 'listed under the brand TTI' },
      B0B1QRQYK2: { key: 'RYOBI:PCG002', model: 'PCG002', reason: 'listed under the brand ONEAND' },
    });
    const row = { id: 'hd-psk', buyPending: { listings: 2 }, signalNote: 'Looks worth buying: +$43.19 (43.6% ROI), sells about 300 a month — 2 listings not confirmed yet.' } as DealRow;
    const state: AutoConfirmState = { day: '', spent: 0, tried: [], ...q, unconfirmable };
    const out = confirmingNote(row, { runtime: { autoConfirm: state } as never, tracking: { signals } as never }, T);
    expect(out.signalNote).not.toContain('being confirmed');
    expect(out.signalNote).toBe('Looks worth buying: +$43.19 (43.6% ROI), sells about 300 a month — 2 listings could not be confirmed: PBP004 is listed under the brand TTI; PCG002 under the brand ONEAND. Confirm or replace them.');
    expect(out.buyPending).toEqual({ listings: 2, blocked: true });
  });

  it('a stored verdict from before ("being confirmed first") is replaced too', () => {
    const row = { id: 'hd-psk', buyPending: { listings: 2 }, signalNote: 'Looks worth buying: +$43.19 (43.6% ROI) — 2 listings are being confirmed first.' } as DealRow;
    const state: AutoConfirmState = { day: '', spent: 0, tried: [], queue: [], nextAt: null, unconfirmable: { B09HDZ5MPV: { key: 'RYOBI:PBP004', model: 'PBP004', reason: 'listed under the brand TTI' }, B0B1QRQYK2: { key: 'RYOBI:PCG002', model: 'PCG002', reason: 'listed under the brand ONEAND' } } };
    expect(confirmingNote(row, { runtime: { autoConfirm: state } as never, tracking: { signals } as never }, T).signalNote)
      .toBe('Looks worth buying: +$43.19 (43.6% ROI) — 2 listings could not be confirmed: PBP004 is listed under the brand TTI; PCG002 under the brand ONEAND. Confirm or replace them.');
  });
});

const keepaProduct = (asin: string, brand: string, title: string, partNumber: string | null): KeepaProduct => ({
  asin, brand, title, manufacturer: null, partNumber, model: partNumber, numberOfItems: 1, packageQuantity: 1,
});

describe('round 2: re-pick before giving up', () => {
  const budget = { blockReason: () => null };

  it('with no other candidate that passes, nothing changes; the Keepa search is made once a week at most', async () => {
    const store = await liveStore();
    const searches: string[] = [];
    let searchedAt: Record<string, number> = {};
    const deps = {
      store, now: () => T, keepaBudget: budget, shouldStop: () => false,
      // The answer key's other PCG002 rows: B096WHWDNB (brand TTI, bulk packaged), and the live listing itself.
      keepaSearch: async (term: string) => { searches.push(term); return [keepaProduct('B0B1QRQYK2', 'ONEAND', live('PCG002').title!, null), keepaProduct('B096WHWDNB', 'TTI', 'TTI Ryobi PCG002 18V Charger (Bulk Packaged)', 'PCG002')]; },
      get searchedAt() { return searchedAt; },
      saveSearched: (key: string, at: number) => { searchedAt = { ...searchedAt, [key]: at }; },
    };
    const targets = [{ key: 'RYOBI:PCG002', model: 'PCG002', asin: 'B0B1QRQYK2', reason: 'listed under the brand ONEAND' }];
    expect((await repickUnconfirmed(deps, targets)).switched).toEqual([]);
    expect(await store.getMatch('RYOBI:PCG002')).toMatchObject({ asin: 'B0B1QRQYK2', grade: 'probable' });
    await repickUnconfirmed(deps, targets);
    expect(searches).toEqual(['RYOBI PCG002']);
    expect(repickTargets({ day: '', spent: 0, tried: [], searchedAt, unconfirmable: { B0B1QRQYK2: { key: 'RYOBI:PCG002', model: 'PCG002', reason: 'x' } } }, T + 60_000)).toEqual([]);
  });

  it('exactly one candidate the catalog confirms: the part moves to it, with the record of the switch', async () => {
    const store = await liveStore();
    // A listing under RYOBI's own brand field with part number PCG002 (shaped as Keepa's search products are).
    const genuine = keepaProduct('B0TESTPCG2', 'RYOBI', 'RYOBI ONE+ 18V Lithium-Ion Charger PCG002', 'PCG002');
    const done = await repickUnconfirmed({
      store, now: () => T, keepaBudget: budget, shouldStop: () => false, searchedAt: {}, saveSearched: () => {},
      keepaSearch: async () => [keepaProduct('B0B1QRQYK2', 'ONEAND', live('PCG002').title!, null), genuine],
    }, [{ key: 'RYOBI:PCG002', model: 'PCG002', asin: 'B0B1QRQYK2', reason: 'brand ONEAND' }]);
    expect(done.switched).toHaveLength(1);
    expect(await store.getMatch('RYOBI:PCG002')).toMatchObject({
      asin: 'B0TESTPCG2', grade: 'strong', verifiedBy: 'keepa_catalog', alternatives: ['B0B1QRQYK2'],
      verifyEvidence: "switched from B0B1QRQYK2 (brand ONEAND) to B0TESTPCG2: Amazon's catalog lists brand RYOBI, part number PCG002: https://www.amazon.com/dp/B0TESTPCG2",
    });
  });

  it('no search while the Keepa tokens are not above the reserve', async () => {
    const store = await liveStore();
    let called = false;
    await repickUnconfirmed({
      store, now: () => T, keepaBudget: { blockReason: () => 'reserve' as never }, shouldStop: () => false, searchedAt: {}, saveSearched: () => {},
      keepaSearch: async () => { called = true; return []; },
    }, [{ key: 'RYOBI:PBP004', model: 'PBP004', asin: 'B09HDZ5MPV', reason: 'listed under the brand TTI' }]);
    expect(called).toBe(false);
  });
});

describe('the narrow brand contradiction, measured', () => {
  it('settles no recorded row and would remove both live listings the answer key says are right: not adopted', () => {
    const n = measureNarrowBrandRule();
    expect(n.recorded).toMatchObject({ right: 0, wrong: 0 });
    expect(n.live).toMatchObject({ wrong: 2 });
    expect(narrowBrandContradiction({ brand: 'RYOBI', model: 'PBP004' }, live('PBP004'))).not.toBeNull();
  });
});
