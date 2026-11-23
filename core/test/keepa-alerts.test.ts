import { describe, expect, it } from 'vitest';

import { bundlesNewlyConfirmed, partPriceDropMessage, reviewDigestMessage, trendCrosses } from '../src/keepa/alerts';

describe('keepa alerts', () => {
  it('writes a review digest when count is positive', () => {
    expect(reviewDigestMessage({ match: 0, split: 0 })).toBeNull();
    expect(reviewDigestMessage({ match: 2, split: 0 })).toBe('2 match questions need you.');
    expect(reviewDigestMessage({ match: 4, split: 1 })).toBe('4 match questions, 1 split question need you.');
  });

  it('names bundles that just reached Confirmed', () => {
    const rows = [
      { key: 'a', model: 'M1', section: 'confirmed', estimate: { profit: 1 } },
      { key: 'b', model: 'M2', section: 'split', estimate: null },
    ];
    expect(bundlesNewlyConfirmed(rows, new Map(), false)).toEqual([]);
    expect(bundlesNewlyConfirmed(rows, new Map([['a', 'split']]), true).map((r) => r.model)).toEqual(['M1']);
    expect(bundlesNewlyConfirmed(rows, new Map([['a', 'confirmed']]), true)).toEqual([]);
  });

  it('formats a part price drop alert', () => {
    expect(partPriceDropMessage('PCL235B', 3.5)).toBe('PCL235B: Amazon price is $3.50 lower than the last Keepa refresh.');
  });

  it('detects margin crossing up vs baseline', () => {
    const alerts = { enabled: true, minProfit: 20, minRoiPercent: 20, reviewDigest: true };
    const msg = trendCrosses('MODEL-X', 25, 22, { bundleKey: 'k', profit: 10, roiPercent: 10, notifiedAt: 1 }, alerts);
    expect(msg).toContain('MODEL-X');
    expect(msg).toContain('crossed');
  });
});