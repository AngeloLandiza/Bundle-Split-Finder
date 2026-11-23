import { describe, expect, it } from 'vitest';

import { sortDealRows } from '../src/deals/sort';

describe('sortDealRows', () => {
  it('sorts by profit with nulls last', () => {
    const rows = [{ profit: 1 }, { profit: null }, { profit: 5 }];
    expect(sortDealRows(rows, 'profit').map((r) => r.profit)).toEqual([5, 1, null]);
  });

  it('sorts discount without estimate', () => {
    const rows = [{ percentOff: 10 }, { percentOff: 40 }, { percentOff: null }];
    expect(sortDealRows(rows, 'discount').map((r) => r.percentOff)).toEqual([40, 10, null]);
  });
});