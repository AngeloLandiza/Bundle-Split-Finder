import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { amazonNet, priceForNet } from '../src/money';
import { buildReport } from '../src/scan/report';
import { DEFAULT_SCAN_SETTINGS } from '../src/scan/types';

// Nov 23, the owner's third real scan (fixtures/e2e-2026-11-23/after-scan3): 34 bundles had an "estimate", 26 of them in
// Losing money, many at -100%, because a part with no counted price was counted at $0. A part with no price is not a
// part worth $0: the bundle has no estimate, only what its priced parts bring and the break-even. Replayed from the
// owner's own store; nothing reaches the network.

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3');
const report = async () => (await buildReport(await loadScanFolder(DIR), DEFAULT_SCAN_SETTINGS)).bundles;

describe('incomplete estimates, on the owner\'s third real scan', () => {
  it('an estimate only where every model part has a counted price: 13 complete, 39 incomplete, none counted at zero', async () => {
    const rows = await report();
    const complete = rows.filter((b) => b.estimate !== null);
    const incomplete = rows.filter((b) => b.incomplete !== undefined);
    expect(complete).toHaveLength(13);
    expect(incomplete).toHaveLength(39);
    expect(complete.filter((b) => b.estimate!.profit > 0).map((b) => b.model)).toEqual(['PCL1201K2-PCL424B', 'PCL1201K2-P755', 'PCL1201K2-PCL445B']);
    // Every complete estimate's model parts are priced; what it leaves uncounted can only be an item with no model number.
    for (const b of complete) {
      expect(b.parts.every((p) => p.price !== null)).toBe(true);
      expect(b.incomplete).toBeUndefined();
    }
    for (const b of incomplete) {
      expect(b.estimate).toBeNull();
      expect(b.range.amazonNew).toBeNull();
      expect(b.incomplete!.unpriced.length).toBeGreaterThan(0);
    }
  });

  it('DCK200D1P1W921B: the DEWALT starter kit has no Amazon listing, so the bundle says what the kit must sell for to break even', async () => {
    const row = (await report()).find((b) => b.model === 'DCK200D1P1W921B')!;
    // Before: "-$158.75 est." in Losing money, the kit counted at $0.
    expect(row.estimate).toBeNull();
    const dcf921b = row.parts.find((p) => p.model === 'DCF921B')!;
    expect(row.incomplete).toEqual({
      priced: 1, total: 2, cost: 299, pricedNet: amazonNet(dcf921b.price!), breakEvenNet: 158.75, breakEvenPrice: 186.76,
      unpriced: [{ model: 'DCK200D1P1', qty: 1, state: 'no_listing' }],
    });
    // The break-even price nets the gap after the fee settings' referral, and a cent less does not.
    expect(amazonNet(186.76)).toBeGreaterThanOrEqual(158.75);
    expect(amazonNet(186.75)).toBeLessThan(158.75);
    expect(priceForNet(158.75)).toBe(186.76);
  });

  it('every reason a part has no price is its state: waiting, in Review, no listing, inactive', async () => {
    const rows = await report();
    const state = (model: string, part: string) => rows.find((b) => b.model === model)!.incomplete!.unpriced.find((u) => u.model === part)!.state;
    expect(state('PCL1201K2-PCL430B', 'PCL430B')).toBe('waiting');
    expect(state('DCK540D1WCF860B', 'DCF860B')).toBe('review');
    expect(state('PCL406B-PCL416B', 'PCL416B')).toBe('no_listing');
    expect(state('PBT01B-P321', 'P321')).toBe('inactive');
  });

  it('a bundle with no estimate is never below zero: none of the 26 "Losing money" rows of the scan that are incomplete has a profit', async () => {
    const rows = await report();
    const losing = rows.filter((b) => b.estimate !== null && b.estimate.profit < 0).map((b) => b.model);
    // Only complete estimates below zero are losses: 10 of them, all with every part priced.
    expect(losing).toHaveLength(10);
    expect(losing).not.toContain('DCK200D1P1W860B');
    expect(losing).not.toContain('PCL1600K2-P553');
  });
});
