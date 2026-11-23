import { describe, expect, it } from 'vitest';
import { DEALS } from '../api/mockData';
import { bestDeals, buyNowDeals, dealVerdict } from './today';

describe('a deal\'s one-line verdict on Today', () => {
  const row = (patch: Record<string, unknown>) => ({ ...DEALS[0]!, matchKind: null, lookup: null, ...patch }) as (typeof DEALS)[number];
  it('says the agent\'s own note when it sent one', () => {
    expect(dealVerdict(row({ signalNote: ' Sells about 40 a month, above your floor ', matchState: '2 title matches' }))).toEqual({ text: 'Sells about 40 a month, above your floor', fromAgent: true });
  });
  it('otherwise says how far the parts are confirmed, in the owner\'s words', () => {
    expect(dealVerdict(row({ matchState: '2 parts matched' }))).toEqual({ text: 'All 2 parts on confirmed listings', fromAgent: false });
    expect(dealVerdict(row({ matchState: '1 title match' }))?.text).toBe('1 listing not confirmed yet');
    expect(dealVerdict(row({ matchState: '1 part with no listing · 1 to verify' }))?.text).toBe('1 part has no Amazon listing · 1 listing not confirmed yet');
  });
  it('says what a waiting row waits for, and nothing for a row with no state', () => {
    expect(dealVerdict(row({ matchKind: 'waiting_page', matchState: null }))?.text).toBe('Waiting for its Home Depot page');
    expect(dealVerdict(row({ matchState: null }))).toBeNull();
  });
});

describe('Today\'s lists', () => {
  it('never lists a loss among the best deals, nor a bundle that waits for an answer', () => {
    const loss = DEALS.find((r) => r.model === 'PCL1600K2-A983002')!;
    expect(loss.profit).toBeLessThan(0); // the recorded 7-tool kit costs more than its parts sell for
    const best = bestDeals(DEALS);
    expect(best.every((r) => r.profit! >= 0 && !r.needsAnswer)).toBe(true);
    expect(best.map((r) => r.id)).not.toContain(loss.id);
    expect(best.map((r) => r.profit)).toEqual([...best.map((r) => r.profit)].sort((a, b) => b! - a!));
  });
  it('lists what the last scan found worth buying now, best estimate first, and only that', () => {
    const buy = buyNowDeals(DEALS);
    expect(buy.map((r) => r.model).sort()).toEqual(['DCK225D2', 'DCK240C2']);
    expect(buy[0]!.profit!).toBeGreaterThanOrEqual(buy[1]!.profit!);
  });
  it('falls back to nothing when no bundle is worth buying, so Today shows Best deals', () => {
    expect(buyNowDeals(DEALS.map((r) => ({ ...r, buyNow: false })))).toEqual([]);
  });
});
