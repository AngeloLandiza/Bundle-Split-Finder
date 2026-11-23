import { describe, expect, it } from 'vitest';

import { autoDiscoveryShare, planKeepaItemKeys, planKeepaRun } from '../src/keepa/plan';

describe('planKeepaRun', () => {
  it('shifts toward tracking when discovery work is low', () => {
    const heavy = planKeepaRun(
      { tokensPerRun: 20, discoveryShare: 50, reserve: 5, mode: 'tracking_heavy' },
      { pendingLookups: ['a', 'b', 'c'], staleRefreshes: ['r1', 'r2', 'r3', 'r4', 'r5'], openDiscoveryWork: 0, totalWork: 10 },
    );
    expect(heavy.trackingTokens).toBeGreaterThan(heavy.discoveryTokens);
    expect(heavy.refreshes.length).toBeGreaterThan(0);
  });

  it('discovery_heavy uses most of the cap for lookups', () => {
    const share = autoDiscoveryShare(8, 10, 'discovery_heavy');
    expect(share).toBe(90);
  });

  it('favours discovery when total work is zero but kit lookups remain', () => {
    expect(autoDiscoveryShare(2, 0, 'auto')).toBe(90);
  });

  it('splits cap using kit-aware discovery counts', () => {
    const plan = planKeepaRun(
      { tokensPerRun: 10, discoveryShare: 90, reserve: 0, mode: 'auto' },
      { pendingLookups: ['a'], staleRefreshes: ['r1', 'r2'], openDiscoveryWork: 3, totalWork: 5 },
    );
    expect(plan.discoveryTokens).toBeGreaterThan(0);
    expect(plan.trackingTokens).toBeGreaterThan(0);
  });

  it('respects reserve headroom when tokensLeft is known', () => {
    const tight = planKeepaRun(
      { tokensPerRun: 20, discoveryShare: 50, reserve: 5, mode: 'auto', tokensLeft: 8 },
      { pendingLookups: [], staleRefreshes: ['r1', 'r2', 'r3'], openDiscoveryWork: 0, totalWork: 3 },
    );
    expect(tight.refreshes.length + tight.lookups.length).toBeLessThanOrEqual(3);
  });

  it('plans fewer refreshes when tracking depth costs more', () => {
    const shallow = planKeepaRun(
      { tokensPerRun: 10, discoveryShare: 10, reserve: 0, mode: 'tracking_heavy', trackingDepth: 'price_only' },
      { pendingLookups: [], staleRefreshes: ['a', 'b', 'c', 'd'], openDiscoveryWork: 0, totalWork: 4 },
    );
    const deep = planKeepaRun(
      { tokensPerRun: 10, discoveryShare: 10, reserve: 0, mode: 'tracking_heavy', trackingDepth: 'full' },
      { pendingLookups: [], staleRefreshes: ['a', 'b', 'c', 'd'], openDiscoveryWork: 0, totalWork: 4 },
    );
    expect(deep.refreshes.length).toBeLessThanOrEqual(shallow.refreshes.length);
  });

  it('budgets kit-item keys from discovery and tracking leftovers', () => {
    const kinds = new Map<string, 'lookup' | 'refresh'>([
      ['k1', 'lookup'],
      ['k2', 'refresh'],
    ]);
    const { planned, deferred } = planKeepaItemKeys(['k1', 'k2', 'k3'], (k) => kinds.get(k), 30, 1, 'price_only');
    expect(planned).toEqual(['k1', 'k2']);
    expect(deferred).toEqual(['k3']);
  });

  it('plans lookups by lookup token cost (search plus detail batch), not one per token', () => {
    const plan = planKeepaRun(
      { tokensPerRun: 60, discoveryShare: 50, reserve: 0, mode: 'auto' },
      { pendingLookups: ['a', 'b', 'c'], staleRefreshes: [], openDiscoveryWork: 3, totalWork: 3 },
    );
    expect(plan.lookups).toEqual(['a']);
    expect(plan.deferredLookups).toEqual(['b', 'c']);
  });
});