import { describe, expect, it } from 'vitest';
import { DEALS } from '../api/mockData';
import type { DealRow } from '../api/types';
import { byBestProfit, estimateRank } from './order';
import { bestDeal } from './popover';
import { sortRows } from './sort';
import { bestDeals, buyNowDeals } from './today';

const make = (id: string, profit: number | null, patch: Partial<DealRow> = {}): DealRow => ({ ...DEALS[0]!, id, profit, roi: profit === null ? null : profit / 100, needsAnswer: false, buyNow: false, beforeFulfillment: null, ...patch });
const full = (id: string, profit: number, patch: Partial<DealRow> = {}) => make(id, profit, patch);
const before = (id: string, profit: number, patch: Partial<DealRow> = {}) => make(id, profit, { beforeFulfillment: { parts: 1, of: 2 }, ...patch });

describe('estimate order', () => {
  it('a before-fulfillment estimate never outranks a full one of the same sign', () => {
    const rows = [before('b-high', 90), full('f-low', 5), before('b-neg', -1), full('f-neg', -40), before('b-mid', 30)];
    expect([...rows].sort(byBestProfit).map((r) => r.id)).toEqual(['f-low', 'b-high', 'b-mid', 'f-neg', 'b-neg']);
  });
  it('the table sort uses the same rank in both directions and keeps rows with no figure last', () => {
    const rows = [before('b', 50), full('f', 10), make('none', null), full('loss', -3)];
    const value = (r: DealRow) => estimateRank(r, 'profit');
    expect(sortRows(rows, { key: 'p', dir: 'desc' }, value).map((r) => r.id)).toEqual(['f', 'b', 'loss', 'none']);
    expect(sortRows(rows, { key: 'p', dir: 'asc' }, value).map((r) => r.id)).toEqual(['loss', 'b', 'f', 'none']);
  });
  it('Today lists only full estimates as best, the popover agrees, and a before-fulfillment row is never worth buying now', () => {
    const rows = [before('b', 99), full('f', 4), before('bn', 80, { buyNow: true }), full('fn', 20, { buyNow: true })];
    expect(bestDeals(rows).map((r) => r.id)).toEqual(['fn', 'f']);
    expect(bestDeal(rows)?.id).toBe('fn');
    expect(buyNowDeals(rows).map((r) => r.id)).toEqual(['fn']);
  });
});
