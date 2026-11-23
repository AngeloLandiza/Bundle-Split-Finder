import { describe, expect, it } from 'vitest';

import { keepaQueuePressure, reportDiscoveryPressure } from '../src/keepa/discovery';
import type { BundleRow, PartRow, ScanReport } from '../src/scan/types';

const row = (over: Partial<BundleRow>): BundleRow =>
  ({
    key: 'homedepot:1',
    itemId: '1',
    brand: 'RYOBI',
    model: 'M',
    title: 't',
    link: null,
    price: 100,
    regularPrice: null,
    percentOff: null,
    seenAt: 1,
    status: 'partial',
    section: 'waiting',
    parts: [],
    estimate: null,
    uncovered: [],
    answer: null,
    options: [],
    kitsNotRead: [],
    range: { lowest: null, amazonNew: null, highest: null },
    ...over,
  }) as BundleRow;

describe('keepaQueuePressure', () => {
  it('counts each kit-item step once in totalWork and includes identify in discovery', () => {
    const kinds = new Map([
      ['i1', 'lookup'],
      ['i2', 'refresh'],
      ['i3', 'identify'],
    ]);
    const pressure = keepaQueuePressure({
      partLookups: 2,
      partRefreshes: 4,
      itemKeys: ['i1', 'i2', 'i3'],
      stepKind: (k) => kinds.get(k),
      structural: 1,
    });
    expect(pressure.totalWork).toBe(2 + 4 + 3 + 1);
    expect(pressure.openDiscoveryWork).toBe(2 + 2 + 1);
  });
});

describe('reportDiscoveryPressure', () => {
  it('counts review, split bundles, unread kits, and unestimated options', () => {
    const report: ScanReport = {
      bundles: [
        row({ section: 'split', options: [] }),
        row({
          section: 'confirmed',
          kitsNotRead: ['K1', 'K2'],
          options: [
            {
              id: 'whole',
              label: 'Whole',
              splitKits: [],
              parts: [],
              estimate: null,
              leftovers: [],
              loose: false,
              range: { lowest: null, amazonNew: null, highest: null },
            },
          ],
          parts: [
            {
              model: 'P1',
              qty: 1,
              status: 'waiting',
              availability: 'missing',
              asin: null,
              grade: null,
              price: null,
              priceSeenAt: null,
              image: null,
              title: null,
              prices: [],
            } satisfies PartRow,
          ],
        }),
      ],
      review: [],
    };
    expect(reportDiscoveryPressure(report, 3)).toBe(3 + 1 + 2 + 1 + 1);
  });
});