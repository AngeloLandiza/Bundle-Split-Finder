import { describe, expect, it } from 'vitest';
import { scanSearchCeiling, scanSpend } from './scanSpend';

const b = (serpLeft: number | null, serpReserve = 100, serpPerScan = 18) => ({ serpLeft, serpReserve, serpPerScan });

describe('what a scan may spend, said before it starts', () => {
  it('above the reserve: up to the per-scan limit, for Amazon prices; Home Depot is free', () => {
    expect(scanSpend(b(250))).toEqual({ cost: 'up to 18 searches', sentence: 'May use up to 18 searches for Amazon prices; reading Home Depot is free.' });
  });
  it('never more than what the account holds above the reserve', () => {
    expect(scanSearchCeiling(b(105))).toBe(5);
    expect(scanSpend(b(105)).sentence).toBe('May use up to 5 searches for Amazon prices; reading Home Depot is free.');
    expect(scanSpend(b(101, 100, 18)).cost).toBe('up to 1 search');
  });
  it('at or below the reserve: no searches, and the sentence says why (the owner\'s real 97 left against a reserve of 100)', () => {
    expect(scanSpend(b(97))).toEqual({ cost: 'no searches', sentence: 'Uses no searches: 97 searches left, at your reserve of 100. Reading Home Depot is free.' });
    expect(scanSpend(b(100)).cost).toBe('no searches');
  });
  it('with a limit of 0 per scan: no searches; before the first account check the limit alone', () => {
    expect(scanSpend(b(250, 100, 0)).sentence).toBe('Uses no searches: the limit per scan is 0. Reading Home Depot is free.');
    expect(scanSpend(b(null)).cost).toBe('up to 18 searches');
  });
});
