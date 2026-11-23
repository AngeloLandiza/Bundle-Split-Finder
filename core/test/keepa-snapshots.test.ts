import { describe, expect, it } from 'vitest';

import { readOptionSnapshot, writeOptionSnapshots, type OptionSnapshot } from '../src/keepa/snapshots';
import type { ScanReport } from '../src/scan/types';
import { MemoryCache } from '../src/serpapi/client';

const report: ScanReport = {
  bundles: [
    {
      key: 'homedepot:1',
      itemId: '1',
      brand: 'RYOBI',
      model: 'KIT',
      title: 'Kit',
      link: null,
      price: 99,
      regularPrice: null,
      percentOff: null,
      seenAt: 1,
      status: 'complete',
      section: 'confirmed',
      parts: [],
      estimate: { profit: 10, roi: 0.25, cost: 80, netRevenue: 90 },
      uncovered: [],
      answer: null,
      options: [
        {
          id: 'whole',
          label: 'whole',
          splitKits: [],
          parts: [],
          estimate: { profit: 10, roi: 0.25, cost: 80, netRevenue: 90 },
          leftovers: [],
          loose: false,
          range: { lowest: null, amazonNew: null, highest: null },
        },
      ],
      kitsNotRead: [],
      range: { lowest: null, amazonNew: null, highest: null },
    },
  ],
  review: [],
  ebayQuestions: [],
};

describe('option snapshots', () => {
  it('persists every bundle with options to the cache', async () => {
    const cache = new MemoryCache();
    expect(await writeOptionSnapshots(cache, report, 100)).toBe(1);
    const snap = await readOptionSnapshot(cache, 'homedepot:1');
    expect(snap).toMatchObject({ bundleKey: 'homedepot:1', model: 'KIT', options: [{ id: 'whole', profit: 10, roiPercent: 25 }] });
  });
});