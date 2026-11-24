// Outcomes (core/src/outcomes): the frozen snapshot, net from a sale price, partial sales, the scorecard and the CSV. Built on the
// owner's real third scan (fixtures/e2e-2026-11-23, as the desktop UI's mockReal.json holds it): real bundles, real listings, real
// estimates. No network.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Purchase } from '../src/api/contract';
import { DEFAULT_FEES } from '../src/money';
import {
  applyPartOutcome, newPurchase, OutcomeRefused, outcomesCsv, partSentence, patchPurchase, percentOf, purchaseCost, purchaseResult, scorecardOf, snapshotOf,
} from '../src/outcomes/outcomes';
import type { BundleRow } from '../src/scan/types';

const real = JSON.parse(readFileSync(new URL('../../desktop-ui/src/api/mockReal.json', import.meta.url), 'utf8')) as {
  scan3: { details: Record<string, { bundle: BundleRow; estimate: { basis: string } | null }> };
};
// The recorded RYOBI BOGO pair PCL1201K2 + PCL424B: $179, estimated +$6.63 (a 3.7% ROI), parts on real Amazon listings.
const PAIR = real.scan3.details['homedepot:337486530']!;
const NOV23 = Date.UTC(2026, 10, 23, 12);
const at = (iso: string) => new Date(`${iso}T12:00:00`).getTime();

const snap = (b: BundleRow = PAIR.bundle, buyNow = true) => snapshotOf(b, { fees: DEFAULT_FEES, basis: PAIR.estimate!.basis, buyNow, at: new Date(NOV23).toISOString() });
const buy = (o: { pricePaid?: number; quantity?: number; boughtAt?: string } = {}): Purchase =>
  newPurchase({ id: 'pur-1', dealId: PAIR.bundle.key, snapshot: snap(), now: NOV23, ...o });

describe('the snapshot freezes the estimate at purchase', () => {
  it('copies each part with its listing, estimated price, fees and net, and the bundle estimate, from the real recorded deal', () => {
    const s = snap();
    expect(s.estimate).toEqual({ profit: 6.63, roi: 0.037, cost: 179, partsSellFor: 218.39, afterFees: 185.63 });
    expect(s.parts.map((p) => [p.model, p.asin, p.sellPrice, p.netEach])).toEqual([
      ['PCL1201K2', 'B0DSCG26GL', 154.44, 131.27],
      ['PCL424B', 'B0BNFBL5PR', 63.95, 54.36],
    ]);
    expect(s.parts[0]).toMatchObject({ id: 'p0', counted: true, qty: 1, referralRate: 0.15, referralFee: 23.17, fulfillmentFee: 0, listingLink: 'https://www.amazon.com/dp/B0DSCG26GL' });
    // The parts' nets add up to the estimate's own net revenue: the snapshot is the estimate, not a second opinion.
    expect(Math.round(s.parts.reduce((n, p) => n + p.netEach! * p.qty, 0) * 100) / 100).toBe(s.estimate!.afterFees);
    expect(s.basis).toMatch(/estimate/i);
    expect(s.buyNow).toBe(true);
  });

  it('is a copy: changing the bundle or the settings afterwards cannot reach it', () => {
    const bundle = structuredClone(PAIR.bundle);
    const s = snap(bundle);
    const frozen = structuredClone(s);
    bundle.parts[0]!.price = 1;
    bundle.estimate = { cost: 179, netRevenue: 1, profit: -178, roi: -1 };
    bundle.price = 120;
    expect(s).toEqual(frozen);
  });

  it('marks a part the estimate did not count, and keeps the deal without an estimate', () => {
    const missing = Object.values(real.scan3.details).find((d) => d.bundle.estimate === null && d.bundle.price !== null && d.bundle.parts.some((p) => p.price === null) && d.bundle.parts.length > 1);
    expect(missing).toBeTruthy();
    const s = snap(missing!.bundle, false);
    expect(s.estimate).toBeNull();
    expect(s.parts.some((p) => !p.counted && p.sellPrice === null && p.netEach === null)).toBe(true);
  });
});

describe('recording a purchase', () => {
  it('defaults to today, the deal\'s Home Depot price and one bundle', () => {
    const p = buy();
    expect(p).toMatchObject({ boughtAt: '2026-11-23', pricePaid: 179, quantity: 1 });
    expect(p.parts.map((x) => x.status)).toEqual(['open', 'open']);
    expect(purchaseCost(p)).toBe(179);
  });

  it('refuses a deal with no split, a bad date, a price at or below zero and a quantity that is not a whole number', () => {
    const none = snapshotOf({ ...PAIR.bundle, parts: [], estimate: null }, { fees: DEFAULT_FEES, basis: 'x', buyNow: false, at: 'now' });
    expect(() => newPurchase({ id: 'x', dealId: 'd', snapshot: none, now: NOV23 })).toThrow(/no split yet/);
    expect(() => buy({ boughtAt: '2026-02-30' })).toThrow(OutcomeRefused);
    expect(() => buy({ boughtAt: '2026-12-25' })).toThrow(/future/);
    expect(() => buy({ pricePaid: 0 })).toThrow(/price paid/);
    expect(() => buy({ pricePaid: Number.NaN })).toThrow(/number/);
    expect(() => buy({ quantity: 0 })).toThrow(/whole number/);
    expect(() => buy({ quantity: 1.5 })).toThrow(/whole number/);
  });

  it('can be corrected, and the snapshot is not one of the things that can be', () => {
    const p = buy();
    const next = patchPurchase(p, { pricePaid: 170, quantity: 2, boughtAt: '2026-11-22' }, NOV23);
    expect(next).toMatchObject({ pricePaid: 170, quantity: 2, boughtAt: '2026-11-22' });
    expect(next.snapshot).toEqual(p.snapshot);
    expect(() => patchPurchase(p, { snapshot: {} }, NOV23)).toThrow(/cannot be changed/);
    expect(() => patchPurchase(p, { parts: [] }, NOV23)).toThrow(/cannot be changed/);
    expect(() => patchPurchase(p, {}, NOV23)).toThrow(/Nothing to change/);
  });
});

describe('what he recorded about each part', () => {
  it('computes net from the sale price with the snapshot\'s fees and says the fees were estimated', () => {
    const sold = applyPartOutcome(buy(), 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' }, at('2026-11-25'));
    const part = purchaseResult(sold).parts[0]!;
    expect(part).toMatchObject({ status: 'sold', netReceived: 127.5, netFrom: 'fees_estimated', units: 1 });
    expect(purchaseResult(sold).feesEstimated).toBe(true);
    expect(partSentence(sold, 'p0')).toBe('Recorded PCL1201K2 from PCL1201K2-PCL424B as sold for $150.00 on Nov 25 (net $127.50, fees estimated).');
  });

  it('uses the fees of the moment he bought: they are in the snapshot, so a later change of settings cannot move them', () => {
    const at20 = snapshotOf(PAIR.bundle, { fees: { ...DEFAULT_FEES, referralRate: 0.2 }, basis: 'x', buyNow: false, at: 'now' });
    const p = newPurchase({ id: 'pur-1', dealId: PAIR.bundle.key, snapshot: at20, now: NOV23 });
    const sold = applyPartOutcome(p, 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' }, at('2026-11-25'));
    expect(p.snapshot.fees.referralRate).toBe(0.2);
    expect(purchaseResult(sold).parts[0]!.netReceived).toBe(120);
  });

  it('takes the payout he knows over the fees, and then says nothing about estimated fees', () => {
    const sold = applyPartOutcome(buy(), 'p0', { status: 'sold', salePrice: 150, netPayout: 118.4, date: '2026-11-25' }, at('2026-11-25'));
    expect(purchaseResult(sold).parts[0]).toMatchObject({ netReceived: 118.4, netFrom: 'payout' });
    expect(purchaseResult(sold).feesEstimated).toBe(false);
    expect(partSentence(sold, 'p0')).toContain('(net $118.40)');
  });

  it('multiplies by the units: two bundles of one-unit parts are two units each', () => {
    const p = applyPartOutcome(buy({ quantity: 2 }), 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' }, at('2026-11-25'));
    expect(purchaseResult(p).parts[0]).toMatchObject({ units: 2, netReceived: 255 });
    expect(purchaseResult(p).cost).toBe(358);
  });

  it('a partial sale is a realised profit on the sold part only, with the cost shared by estimated net', () => {
    const p = applyPartOutcome(buy(), 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' }, at('2026-11-25'));
    const r = purchaseResult(p);
    expect(r).toMatchObject({ partsTotal: 2, partsSettled: 1, partsSold: 1, complete: false, actualProfit: null, accuracy: null });
    expect(r.parts[0]!.costShare).toBeCloseTo((179 * 131.27) / 185.63, 2);
    expect(r.realisedProfit).toBeCloseTo(127.5 - (179 * 131.27) / 185.63, 2);
    expect(r.parts[1]).toMatchObject({ status: 'open', netReceived: null, profit: null });
  });

  it('still holding is not sold: it settles nothing', () => {
    const p = applyPartOutcome(buy(), 'p1', { status: 'holding' }, NOV23);
    expect(purchaseResult(p)).toMatchObject({ partsHolding: 1, partsSettled: 0, realisedProfit: null, complete: false });
  });

  it('a returned part brings back what he got (or nothing) and settles the part', () => {
    const none = applyPartOutcome(buy(), 'p1', { status: 'returned', date: '2026-11-24' }, NOV23);
    expect(purchaseResult(none).parts[1]).toMatchObject({ status: 'returned', netReceived: 0, netFrom: 'none' });
    const refunded = applyPartOutcome(buy(), 'p1', { status: 'returned', date: '2026-11-24', recovered: 60 }, NOV23);
    expect(purchaseResult(refunded).parts[1]).toMatchObject({ netReceived: 60, netFrom: 'refund' });
  });

  it('a completed deal compares the estimate with what was made, in dollars and percent', () => {
    let p = applyPartOutcome(buy(), 'p0', { status: 'sold', salePrice: 150, netPayout: 120, date: '2026-11-25' }, at('2026-11-25'));
    p = applyPartOutcome(p, 'p1', { status: 'sold', salePrice: 60, netPayout: 50, date: '2026-11-26' }, at('2026-11-26'));
    expect(purchaseResult(p)).toMatchObject({ complete: true, actualProfit: -9, estimatedProfit: 6.63, accuracy: { estimated: 6.63, actual: -9, diff: -15.63, diffPercent: -235.7 } });
  });

  it('refuses a sale with no price, a date before the purchase or in the future, an unknown part or a negative payout', () => {
    const p = buy();
    expect(() => applyPartOutcome(p, 'p0', { status: 'sold' }, NOV23)).toThrow(/sale price/);
    expect(() => applyPartOutcome(p, 'p0', { status: 'sold', salePrice: 10, date: '2026-11-01' }, NOV23)).toThrow(/before the purchase date/);
    expect(() => applyPartOutcome(p, 'p0', { status: 'sold', salePrice: 10, date: '2027-01-01' }, NOV23)).toThrow(/future/);
    expect(() => applyPartOutcome(p, 'p9', { status: 'holding' }, NOV23)).toThrow(/no such part/);
    expect(() => applyPartOutcome(p, 'p0', { status: 'sold', salePrice: 10, netPayout: -1, date: '2026-11-23' }, NOV23)).toThrow(/net payout/);
  });
});

describe('the scorecard', () => {
  it('has nothing to say with no purchases, and says nothing it cannot back', () => {
    expect(scorecardOf([], NOV23)).toEqual({ month: '2026-11', purchases: 0, boughtThisMonth: 0, flaggedWhenBought: 0, realised: null, accuracy: null });
  });

  it('counts a month\'s realised profit from sold parts only, with "N of M parts" for a partial deal', () => {
    const partial = applyPartOutcome(buy(), 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' }, at('2026-11-25'));
    const card = scorecardOf([partial], at('2026-11-26'));
    expect(card).toMatchObject({ purchases: 1, boughtThisMonth: 1, flaggedWhenBought: 1, accuracy: null });
    expect(card.realised).toMatchObject({ partsSettled: 1, partsSold: 1, partsOfThoseDeals: 2, deals: 1, feesEstimated: true });
    expect(card.realised!.profit).toBeCloseTo(127.5 - (179 * 131.27) / 185.63, 2);
    // A sale in another month is not this month's.
    expect(scorecardOf([partial], at('2026-12-02')).realised).toBeNull();
  });

  it('adds up accuracy over completed deals only, with each deal listed', () => {
    let done = applyPartOutcome(buy(), 'p0', { status: 'sold', salePrice: 150, netPayout: 120, date: '2026-11-25' }, at('2026-11-25'));
    done = applyPartOutcome(done, 'p1', { status: 'sold', salePrice: 60, netPayout: 50, date: '2026-11-26' }, at('2026-11-26'));
    const open = { ...buy(), id: 'pur-2' };
    const card = scorecardOf([done, open], at('2026-11-27'));
    expect(card.accuracy).toMatchObject({ deals: 1, estimated: 6.63, actual: -9, diff: -15.63, diffPercent: -235.7 });
    expect(card.accuracy!.perDeal).toHaveLength(1);
    expect(card.purchases).toBe(2);
  });
});

describe('the CSV', () => {
  it('has one row per part with the frozen estimate beside what was recorded, and starts with a header', () => {
    const p = applyPartOutcome(buy(), 'p0', { status: 'sold', salePrice: 150, date: '2026-11-25' }, at('2026-11-25'));
    const lines = outcomesCsv([p]).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('est_profit_per_bundle');
    expect(lines[1]).toContain('PCL1201K2,1,B0DSCG26GL');
    expect(lines[1]).toContain('sold,2026-11-25,150,127.5,fees_estimated');
    expect(lines[2]).toContain(',open,');
  });
});

describe('the accuracy percent', () => {
  it('is not shown against an estimate within $5 of zero (the first sample read +1079.8%)', () => {
    expect(percentOf(10.69, -0.99)).toBeNull();
    expect(percentOf(3, 0)).toBeNull();
    expect(percentOf(-15.63, 6.63)).toBe(-235.7);
    expect(percentOf(10, 43.19)).toBe(23.2);
  });
});
