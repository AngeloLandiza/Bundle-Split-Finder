import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { dealListSections } from '../../core/src/deals/sections';
import { agentDataDir } from '../paths';
import { ingestPanelBody, readPanelSnapshot } from '../panelStore';

const panelFile = `${agentDataDir()}/deals-panel.json`;

afterEach(() => {
  if (existsSync(panelFile)) unlinkSync(panelFile);
});

describe('deals CSV export path', () => {
  it('exports panel bundles in section order', () => {
    ingestPanelBody(
      {
        kind: 'split-finder-panel',
        bundles: [
          {
            key: 'A',
            itemId: '1',
            brand: 'DEWALT',
            model: 'X',
            title: 'Bundle A',
            link: null,
            price: 50,
            regularPrice: 80,
            percentOff: 37,
            seenAt: 1,
            status: 'complete',
            section: 'confirmed',
            parts: [{ model: 'P', status: 'complete', grade: 'strong', availability: 'active' }],
            estimate: { profit: 10, roi: 0.2, cost: 40, netRevenue: 50 },
            uncovered: [],
            answer: null,
            options: [],
            kitsNotRead: [],
            range: { lowest: null, amazonNew: null, highest: null },
          },
        ],
      },
      '2026-01-01T00:00:00.000Z',
    );
    const panel = readPanelSnapshot();
    expect(panel?.bundles.length).toBe(1);
    const groups = dealListSections(panel!.bundles, 'profit');
    expect(groups.flatMap((g) => g.rows).map((r) => r.title)).toEqual(['Bundle A']);
  });
});