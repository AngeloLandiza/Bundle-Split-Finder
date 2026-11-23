/**
 * Plan §8 acceptance hooks (fixture-only, no network).
 */

import { describe, expect, it } from 'vitest';

import { reportDiscoveryPressure } from '../src/keepa/discovery';
import { autoDiscoveryShare, planKeepaRun } from '../src/keepa/plan';
import type { BundleRow, ScanReport } from '../src/scan/types';

const confirmedRow = (): BundleRow =>
  ({
    key: 'homedepot:1',
    itemId: '1',
    brand: 'RYOBI',
    model: 'KIT',
    title: 't',
    link: null,
    price: 99,
    regularPrice: null,
    percentOff: null,
    seenAt: 1,
    status: 'complete',
    section: 'confirmed',
    parts: [
      {
        model: 'P1',
        qty: 1,
        status: 'matched',
        availability: 'active',
        asin: 'B0X',
        grade: 'exact',
        price: 10,
        priceSeenAt: 1,
        image: null,
        title: null,
        prices: [],
      },
    ],
    estimate: { profit: 10, roi: 0.2, cost: 80, netRevenue: 90 },
    uncovered: [],
    answer: null,
    options: [
      {
        id: 'whole',
        label: 'whole',
        splitKits: [],
        parts: [],
        estimate: { profit: 10, roi: 0.2, cost: 80, netRevenue: 90 },
        leftovers: [],
        loose: false,
        range: { lowest: null, amazonNew: null, highest: null },
      },
    ],
    kitsNotRead: [],
    range: { lowest: null, amazonNew: null, highest: null },
  }) as BundleRow;

describe('plan §8.2 discovery share falls when universe is mapped', () => {
  it('auto mode uses min discovery share when no work remains', () => {
    expect(autoDiscoveryShare(0, 0, 'auto')).toBe(10);
  });

  it('plans fewer lookup slots when tracking-heavy', () => {
    const heavy = planKeepaRun(
      { tokensPerRun: 30, discoveryShare: 90, reserve: 0, mode: 'tracking_heavy' },
      { pendingLookups: ['a', 'b', 'c', 'd'], staleRefreshes: ['r1', 'r2'], openDiscoveryWork: 0, totalWork: 6 },
    );
    const light = planKeepaRun(
      { tokensPerRun: 30, discoveryShare: 90, reserve: 0, mode: 'discovery_heavy' },
      { pendingLookups: ['a', 'b', 'c', 'd'], staleRefreshes: ['r1', 'r2'], openDiscoveryWork: 0, totalWork: 6 },
    );
    expect(heavy.trackingTokens).toBeGreaterThan(light.trackingTokens);
  });

  it('reportDiscoveryPressure is lower when bundles are confirmed', () => {
    const open: ScanReport = {
      bundles: [
        { ...confirmedRow(), section: 'split', status: 'needs_review', estimate: null, options: [], kitsNotRead: ['K1'] },
      ],
      review: [],
    };
    const ready: ScanReport = { bundles: [confirmedRow()], review: [] };
    expect(reportDiscoveryPressure(ready, 0)).toBeLessThan(reportDiscoveryPressure(open, 0));
  });
});