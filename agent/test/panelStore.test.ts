import { describe, expect, it } from 'vitest';

import { mergeDealRowsFromPanel, type DealRow } from '../dealsStore';
import { ingestPanelBody, readPanelBundle } from '../panelStore';

describe('panelStore', () => {
  it('merges estimates into deal rows and serves detail', () => {
    const at = '2026-01-01T00:00:00.000Z';
    ingestPanelBody(
      {
        kind: 'split-finder-panel',
        bundles: [
          {
            key: 'DEWALT:X',
            itemId: '1',
            brand: 'DEWALT',
            model: 'X',
            title: 'Kit',
            link: null,
            price: 100,
            regularPrice: 150,
            percentOff: 33,
            seenAt: 1,
            status: 'complete',
            section: 'confirmed',
            parts: [],
            estimate: { profit: 25, roi: 25, cost: 75, netRevenue: 100 },
            uncovered: [],
            answer: null,
            options: [],
            kitsNotRead: [],
            range: { lowest: null, amazonNew: null, highest: null },
          },
        ],
      },
      at,
    );
    const base: DealRow[] = [
      { key: 'DEWALT:X', brand: 'DEWALT', model: 'X', title: 'Kit', section: 'confirmed', itemId: 1 },
    ];
    const merged = mergeDealRowsFromPanel(base, readPanelBundle('DEWALT:X') ? [readPanelBundle('DEWALT:X')!] : []);
    expect(merged[0]?.profit).toBe(25);
    expect(readPanelBundle('DEWALT:X')?.title).toBe('Kit');
  });
});