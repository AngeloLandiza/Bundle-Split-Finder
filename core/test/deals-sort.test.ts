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

  it('Nov 23: complete estimates first, then the bundles missing a price, smallest break-even first, then the rest', () => {
    // The break-evens of three of the owner's bundles after his third scan (DCK540D1WCF860B, DCK200D1P1W921B, PCL1201K2-PCL430B).
    const rows = [{ profit: null, breakEven: 117.35 }, { profit: null }, { profit: -0.94 }, { profit: null, breakEven: 158.75 }, { profit: null, breakEven: 47.73 }, { profit: 6.63 }];
    expect(sortDealRows(rows, 'profit')).toEqual([
      { profit: 6.63 }, { profit: -0.94 }, { profit: null, breakEven: 47.73 }, { profit: null, breakEven: 117.35 }, { profit: null, breakEven: 158.75 }, { profit: null },
    ]);
  });
});