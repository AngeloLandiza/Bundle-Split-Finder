import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { autoConfirmSentence, autoConfirmTargets, beingConfirmedWords, daysLeftInPlan, verifyAllowanceToday } from '../../core/src/scan/autoConfirm';
import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import type { MatchRecord } from '../../core/src/scan/types';
import { DEFAULT_SETTINGS } from '../../core/src/settings';
import type { AccountInfo } from '../../core/src/serpapi/budget';
import type { BundleSignals } from '../../core/src/tracking/signals';
import type { DealRow } from '../../core/src/api/contract';
import { autoConfirmWanted, confirmationQueue, runAutoConfirm, type AutoConfirmState } from '../autoConfirm';
import { confirmingNote } from '../views';

// The listing ladder, rung 2: the owner's Confirm listing click done by the agent. No network: the account check and the
// read are fakes. The parts and listings are the owner's third scan's (fixtures/e2e-2026-11-23/after-scan3): PSK1212SB's
// bundle with PCL515B on B0B88R7HWB and PCL633B, both title matches.

const scan3 = new Map(
  (JSON.parse(readFileSync('fixtures/e2e-2026-11-23/after-scan3/scan/matches.json', 'utf8')) as [string, MatchRecord][]),
);
const T = Date.UTC(2026, 10, 23, 18);
const account = (left: number): AccountInfo => ({
  planName: 'Free Plan', status: 'Active', searchesPerMonth: 250, totalSearchesLeft: left, thisMonthUsage: 250 - left, thisHourSearches: 0, rateLimitPerHour: 50,
  renewalDate: '2026-12-01T00:00:00Z',
});

const signal = (key: string, asins: string[], o: { profit: number; roi: number; pending: boolean }): BundleSignals => ({
  bundleKey: key, brand: 'RYOBI', model: 'PSK1212SB-PCL515B', at: T, signals: [], buyNow: null,
  options: [{
    optionId: 'a', label: 'Amazon', profit: o.profit, roiPercent: o.roi, meetsThresholds: o.pending, velocity: {} as never, baseline: {} as never, buyNow: false,
    ...(o.pending ? { buyPending: { listings: asins.length, asins } } : {}), unconfirmed: asins, notBuyNow: null,
  }],
});

const ALERTS = { minProfit: 20, minRoiPercent: 15 };

async function storeWith(checked: boolean): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  const m = scan3.get('RYOBI:PCL515B')!;
  expect(m).toMatchObject({ asin: 'B0B88R7HWB', grade: 'probable' });
  await store.putMatch({ ...m, ...(checked ? { catalogChecks: [{ asin: 'B0B88R7HWB', status: 'unknown', reason: "Amazon's catalog lists no part number that is PCL515B", at: T, ladder: 1 }] } : {}) });
  return store;
}
const bundles = [{ key: 'hd-1', brand: 'RYOBI', parts: [{ model: 'PCL515B', asin: 'B0B88R7HWB' }] }];

describe('rung 2: which listings, and how many searches', () => {
  it('reads a buy before a deal within reach, and nothing out of reach', () => {
    const t = autoConfirmTargets({
      signals: {
        a: signal('a', ['A1'], { profit: 18, roi: 14, pending: false }),
        b: signal('b', ['B1'], { profit: 30, roi: 20, pending: true }),
        c: signal('c', ['C1'], { profit: 5, roi: 3, pending: false }),
      },
      alerts: ALERTS, partOf: (_k, asin) => ({ brand: 'RYOBI', model: asin }), eligible: () => true,
    });
    expect(t.map((x) => [x.asin, x.why])).toEqual([['B1', 'buy'], ['A1', 'reach']]);
  });

  it('the automatic allowance: what lies above the reserve per remaining day, at most 5; the owner number when set', () => {
    expect(daysLeftInPlan(account(100), T)).toBe(8);
    expect(verifyAllowanceToday(account(100), 50, null, 0, T)).toBe(5);
    expect(verifyAllowanceToday(account(60), 50, null, 0, T)).toBe(1);
    expect(verifyAllowanceToday(account(60), 50, null, 1, T)).toBe(0);
    expect(verifyAllowanceToday(account(100), 50, 2, 0, T)).toBe(2);
    expect(verifyAllowanceToday(account(51), 50, 9, 0, T)).toBe(1);
    expect(verifyAllowanceToday(account(40), 50, 9, 0, T)).toBe(0);
  });

  it('says what it spent and why', () => {
    const t = [{ bundleKey: 'b', brand: 'RYOBI', model: 'PCL515B', asin: 'B0B88R7HWB', why: 'buy' as const, profit: 30 }];
    expect(autoConfirmSentence(t, 1, 1)).toBe('Confirmed 1 of 1 Amazon listing automatically (1 search: 1 for a buy waiting on it).');
    expect(beingConfirmedWords(2, T + 4 * 60_000, T)).toBe('2 listings are being confirmed — next check in about 4 min');
  });
});

describe('rung 2 in the agent', () => {
  it('waits for the catalog check when Keepa reads listings, then reads a buy-pending listing once', async () => {
    const signals = { 'hd-1': signal('hd-1', ['B0B88R7HWB'], { profit: 30, roi: 20, pending: true }) };
    expect(await autoConfirmWanted({ store: await storeWith(false), signals, alerts: ALERTS, bundles, keepaReads: true, state: undefined })).toEqual([]);
    const store = await storeWith(true);
    let state: AutoConfirmState | undefined;
    const reads: string[] = [];
    const done = await runAutoConfirm({
      store, signals, alerts: ALERTS, bundles, keepaReads: true, state: undefined, saveState: (s) => { state = s; },
      ext: { ...DEFAULT_SETTINGS, reserve: 50, searchesPerScan: 10 }, perDay: null, mode: 'drip', now: () => T, shouldStop: () => false,
      account: async () => account(100),
      verify: async (t, budget) => {
        reads.push(t.asin);
        budget.record(1);
        const m = (await store.getMatch('RYOBI:PCL515B'))!;
        await store.putMatch({ ...m, grade: 'strong', verifiedBy: 'serpapi_product' });
      },
    });
    expect(reads).toEqual(['B0B88R7HWB']);
    expect(done).toMatchObject({ confirmed: 1 });
    expect(state).toMatchObject({ tried: ['B0B88R7HWB'] });
    expect(await autoConfirmWanted({ store, signals, alerts: ALERTS, bundles, keepaReads: true, state })).toEqual([]);
  });

  it('spends nothing when the allowance is used up, and marks the day', async () => {
    const signals = { 'hd-1': signal('hd-1', ['B0B88R7HWB'], { profit: 30, roi: 20, pending: true }) };
    let state: AutoConfirmState | undefined;
    const done = await runAutoConfirm({
      store: await storeWith(true), signals, alerts: ALERTS, bundles, keepaReads: true, state: undefined, saveState: (s) => { state = s; },
      ext: { ...DEFAULT_SETTINGS, reserve: 50, searchesPerScan: 10 }, perDay: 0, mode: 'drip', now: () => T, shouldStop: () => false,
      account: async () => account(100), verify: async () => { throw new Error('must not read'); },
    });
    expect(done).toMatchObject({ searches: 0, waiting: 1 });
    expect(state?.exhaustedDay).toBe('2026-11-23');
    expect(confirmationQueue({ catalog: [], dripNextAt: null, verify: ['B0B88R7HWB'], verifyNextAt: T + 60_000, state, now: T }).nextAt).toBe(Date.UTC(2026, 10, 24));
  });
});

describe("the deal's words come from what will really happen", () => {
  const row = { id: 'hd-1', signalNote: 'Looks worth buying: +$30.00 (20% ROI), sells about 500 a month — 1 listing not confirmed yet.' } as DealRow;
  const tracking = { signals: { 'hd-1': signal('hd-1', ['B0B88R7HWB'], { profit: 30, roi: 20, pending: true }) } } as never;

  it('a pending deal whose catalog check said unknown, with rung 2 off, does not say "being confirmed"', () => {
    const q = confirmationQueue({ catalog: [], dripNextAt: T + 60_000, verify: [], verifyNextAt: T, state: undefined, now: T });
    const out = confirmingNote(row, { runtime: { autoConfirm: { day: '', spent: 0, tried: [], ...q } } as never, tracking }, T);
    expect(out.signalNote).not.toContain('being confirmed');
    expect(out.signalNote).toBe("Looks worth buying: +$30.00 (20% ROI), sells about 500 a month — 1 listing could not be confirmed from Amazon's data — Confirm it (1 search each).");
  });

  it('queued for rung 2 at a known time, it says so with the next check', () => {
    const q = confirmationQueue({ catalog: [], dripNextAt: null, verify: ['B0B88R7HWB'], verifyNextAt: T + 4 * 60_000, state: undefined, now: T });
    const out = confirmingNote(row, { runtime: { autoConfirm: { day: '', spent: 0, tried: [], ...q } } as never, tracking }, T);
    expect(out.signalNote).toBe('Looks worth buying: +$30.00 (20% ROI), sells about 500 a month — 1 listing is being confirmed — next check in about 4 min.');
  });
});
