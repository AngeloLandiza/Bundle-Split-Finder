import { describe, expect, it } from 'vitest';
import { breakEvenOrder, breakEvenWords, incompleteLine, kitWords, pricedCount } from './incomplete';

// The owner's bundles after his third real scan (fixtures/e2e-2026-11-23/after-scan3), as the agent's views give them.
const DCK200D1P1W921B = { priced: 1, total: 2, pricedNet: 140.25, breakEvenNet: 158.75, breakEvenPrice: 186.76, unpriced: ['DCK200D1P1'] };
const DCK200D1P1W860B = { priced: 0, total: 2, pricedNet: 0, breakEvenNet: 299, breakEvenPrice: null, unpriced: ['DCK200D1P1', 'DCF860B'] };
const PCL1600K2_P553 = { priced: 4, total: 9, pricedNet: 166.9, breakEvenNet: 221.1, breakEvenPrice: null, unpriced: ['PCL206', 'PCL500', 'PCL430', 'PCL660', 'P553'] };

describe('the words for a bundle missing a price', () => {
  it('one unpriced model: the Amazon price it needs to break even', () => {
    expect(incompleteLine(DCK200D1P1W921B)).toBe('1 of 2 parts priced · DCK200D1P1 needs about $186.76 to break even');
  });
  it('several: what they must bring together after fees', () => {
    expect(incompleteLine(DCK200D1P1W860B)).toBe('0 of 2 parts priced · DCK200D1P1 and DCF860B need about $299.00 after fees to break even');
    expect(breakEvenWords(PCL1600K2_P553)).toBe('PCL206, PCL500, PCL430, PCL660 and P553 need about $221.10 after fees to break even');
  });
  it('the priced parts already cover the cost: no amount is needed', () => {
    expect(breakEvenWords({ breakEvenNet: 0, breakEvenPrice: null, unpriced: ['PCG002'] })).toBe('the priced parts already cover the cost');
    expect(pricedCount({ priced: 0, total: 1 })).toBe('0 of 1 part priced');
  });
  it('a kit says whether its page is read and how it sells', () => {
    expect(kitWords({ state: 'no_listing', kit: { pageRead: false, parts: null, waiting: 0 } })).toBe('A kit. Its Home Depot page is read next, free, to find its parts.');
    expect(kitWords({ state: 'inactive', kit: { pageRead: true, parts: 19, waiting: 3 } })).toBe('A kit with no listing for sale: sold as its 19 parts once they are looked up (3 wait).');
    expect(kitWords({ state: 'no_listing', kit: { pageRead: true, parts: 19, waiting: 0 } })).toBe('A kit with no listing for sale: sold as its 19 parts.');
    expect(kitWords({ state: 'review', kit: { pageRead: true, parts: 7, waiting: 0 } })).toBe('A kit. Its page lists its 7 parts.');
    expect(kitWords({ state: 'waiting' })).toBeNull();
  });
  it('orders estimates first, then the smallest break-even, then the rest; ties keep their order', () => {
    const rows = [
      { id: 'q', profit: null },
      { id: 'big', profit: null, incomplete: DCK200D1P1W860B },
      { id: 'est', profit: -0.94 },
      { id: 'small', profit: null, incomplete: DCK200D1P1W921B },
      { id: 'est2', profit: 6.63 },
    ];
    expect(breakEvenOrder(rows).map((r) => r.id)).toEqual(['est', 'est2', 'small', 'big', 'q']);
  });
});
