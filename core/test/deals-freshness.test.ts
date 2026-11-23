import { describe, expect, it } from 'vitest';

import { staleBundleDays } from '../src/deals/freshness';
import type { BundleRow } from '../src/scan/types';

const day = 86_400_000;

function row(seenAt: number | null): BundleRow {
  return {
    key: 'K',
    itemId: '1',
    brand: 'DEWALT',
    model: 'M',
    title: 'T',
    link: null,
    price: 10,
    regularPrice: null,
    percentOff: null,
    seenAt: 1,
    status: 'complete',
    section: 'confirmed',
    parts: [{ model: 'A', status: 'matched', grade: 'strong', availability: 'active', priceSeenAt: seenAt } as BundleRow['parts'][0]],
    estimate: null,
    uncovered: [],
    answer: null,
    options: [],
    kitsNotRead: [],
    range: { lowest: null, amazonNew: null, highest: null },
  };
}

describe('staleBundleDays', () => {
  it('returns null when prices are fresh', () => {
    const now = 10 * day;
    expect(staleBundleDays([row(now - day)], now, 3 * day)).toBeNull();
  });

  it('returns days when oldest price is stale', () => {
    const now = 10 * day;
    expect(staleBundleDays([row(now - 5 * day)], now, 3 * day)).toBe(5);
  });
});