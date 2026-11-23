// The Bought screen's forms and words (lib/outcomes.ts). No network.

import { describe, expect, it } from 'vitest';
import type { PartResult, PurchaseView } from '@core/api/contract';
import { boughtWords, formOfPurchase, initialPurchaseForm, parseMoney, partWords, patchRequest, progressWords, purchaseRequest, resultWords, returnRequest, saleRequest } from './outcomes';

const NOON = new Date(2026, 10, 23, 12).getTime();
const part = (over: Partial<PartResult>): PartResult => ({ partId: 'p0', model: 'PCL1201K2', units: 1, status: 'open', date: null, salePrice: null, netReceived: null, netFrom: null, estimatedNet: 131.27, costShare: null, profit: null, ...over });

describe('reading money the way he types it', () => {
  it('takes a dollar amount with cents, a dollar sign or thousands separators, and nothing it would have to guess', () => {
    expect(parseMoney('179')).toBe(179);
    expect(parseMoney(' $1,179.5 ')).toBe(1179.5);
    expect(parseMoney('12,5')).toBeNull();
    expect(parseMoney('1,17')).toBeNull();
    expect(parseMoney('twelve')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
});

describe('the purchase sheet', () => {
  it('starts on today, the deal\'s Home Depot price and one bundle', () => {
    expect(initialPurchaseForm(179, NOON)).toEqual({ date: '2026-11-23', price: '179.00', quantity: '1' });
    expect(initialPurchaseForm(null, NOON).price).toBe('');
  });
  it('builds the request, or says in a sentence what is wrong', () => {
    expect(purchaseRequest({ date: '2026-11-22', price: '171.50', quantity: '3' }, 'homedepot:1')).toEqual({ ok: true, body: { dealId: 'homedepot:1', boughtAt: '2026-11-22', pricePaid: 171.5, quantity: 3 } });
    expect(purchaseRequest({ date: '', price: '179', quantity: '1' }, 'd')).toMatchObject({ ok: false, problem: 'Enter the date you bought it.' });
    expect(purchaseRequest({ date: '2026-11-22', price: '0', quantity: '1' }, 'd')).toMatchObject({ ok: false });
    expect(purchaseRequest({ date: '2026-11-22', price: '179', quantity: '1.5' }, 'd')).toMatchObject({ ok: false, problem: 'Enter how many bundles you bought, a whole number.' });
  });
  it('a correction sends only what changed, and nothing when nothing did', () => {
    const p = { boughtAt: '2026-11-23', pricePaid: 179, quantity: 1 } as PurchaseView;
    expect(patchRequest(formOfPurchase(p), p)).toEqual({ ok: true, patch: null });
    expect(patchRequest({ date: '2026-11-23', price: '170.00', quantity: '2' }, p)).toEqual({ ok: true, patch: { pricePaid: 170, quantity: 2 } });
  });
});

describe('a part\'s sheets', () => {
  it('a sale needs the price of one unit; the net payout is optional and, when typed, must be a dollar amount', () => {
    expect(saleRequest({ date: '2026-11-25', price: '150', payout: '' })).toEqual({ ok: true, body: { status: 'sold', date: '2026-11-25', salePrice: 150 } });
    expect(saleRequest({ date: '2026-11-25', price: '150', payout: '118.40' })).toEqual({ ok: true, body: { status: 'sold', date: '2026-11-25', salePrice: 150, netPayout: 118.4 } });
    expect(saleRequest({ date: '2026-11-25', price: '', payout: '' })).toMatchObject({ ok: false });
    expect(saleRequest({ date: '2026-11-25', price: '150', payout: 'about 120' })).toMatchObject({ ok: false });
  });
  it('a return may carry the money back, and says nothing about it when none came', () => {
    expect(returnRequest({ date: '2026-11-24', back: '' })).toEqual({ ok: true, body: { status: 'returned', date: '2026-11-24' } });
    expect(returnRequest({ date: '2026-11-24', back: '60' })).toEqual({ ok: true, body: { status: 'returned', date: '2026-11-24', recovered: 60 } });
    expect(returnRequest({ date: '2026-11-24', back: 'some' })).toMatchObject({ ok: false });
  });
});

describe('what a part and a deal say', () => {
  it('words each state, and labels net worked out from the sale price', () => {
    expect(partWords(part({}))).toBe('Not recorded yet');
    expect(partWords(part({ status: 'holding' }))).toBe('Still holding');
    expect(partWords(part({ status: 'sold', date: '2026-11-25', salePrice: 150, netReceived: 127.5, netFrom: 'fees_estimated' }))).toBe('Sold Nov 25 for $150.00 · net $127.50 (fees estimated)');
    expect(partWords(part({ status: 'sold', units: 2, date: '2026-11-25', salePrice: 150, netReceived: 236.8, netFrom: 'payout' }))).toBe('Sold Nov 25 for $150.00 each · net $236.80');
    expect(partWords(part({ status: 'returned', date: '2026-11-24', netReceived: 60, netFrom: 'refund' }))).toBe('Returned or not sold Nov 24 · $60.00 back');
  });
  it('says where a deal stands, and what it made against what was estimated', () => {
    expect(boughtWords({ boughtAt: '2026-11-23', pricePaid: 179, quantity: 2 })).toBe('Bought Nov 23 · 2 × $179.00');
    const r = (over: Partial<PurchaseView['result']>) => ({ cost: 179, estimatedProfit: 6.63, partsTotal: 2, partsSettled: 0, partsSold: 0, partsHolding: 0, parts: [], complete: false, realisedProfit: null, actualProfit: null, accuracy: null, feesEstimated: false, ...over }) as PurchaseView['result'];
    expect(progressWords(r({}))).toBe('Nothing sold yet');
    expect(progressWords(r({ partsHolding: 2 }))).toBe('Holding 2 parts');
    expect(progressWords(r({ partsSettled: 1, partsSold: 1 }))).toBe('1 of 2 parts sold');
    expect(progressWords(r({ partsSettled: 2, partsSold: 1, complete: true }))).toBe('Complete');
    expect(resultWords(r({}))).toBe('Estimated +$6.63 when you bought (an estimate).');
    expect(resultWords(r({ partsSettled: 1, partsSold: 1, realisedProfit: 0.93 }))).toBe('Realised so far +$0.93 on the part settled (recorded by you).');
    expect(resultWords(r({ complete: true, actualProfit: -9 }))).toBe('Made −$9.00 (recorded by you) against +$6.63 estimated.');
    expect(resultWords(r({ estimatedProfit: null }))).toBeNull();
  });
});
