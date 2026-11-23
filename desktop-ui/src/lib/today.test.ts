import { describe, expect, it } from 'vitest';
import { DEALS } from '../api/mockData';
import { bestDeals, buyNowDeals } from './today';

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
