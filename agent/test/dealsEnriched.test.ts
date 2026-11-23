import { describe, expect, it } from 'vitest';

import { ingestAuditBody } from '../dealsStore';
import { enrichedDealRows } from '../panelStore';
import { ingestPanelBody } from '../panelStore';

describe('deals enriched from panel', () => {
  it('merges profit on GET deals path', () => {
    const at = '2026-01-01T00:00:00.000Z';
    ingestAuditBody(
      {
        kind: 'split-finder-audit',
        bundles: [{ key: 'K', brand: 'DEWALT', model: 'M', title: 'T', section: 'confirmed', itemId: 9 }],
        questions: [],
      },
      at,
    );
    ingestPanelBody(
      {
        kind: 'split-finder-panel',
        bundles: [
          {
            key: 'K',
            itemId: '9',
            brand: 'DEWALT',
            model: 'M',
            title: 'T',
            link: null,
            price: 50,
            regularPrice: 80,
            percentOff: 37,
            seenAt: 1,
            status: 'complete',
            section: 'confirmed',
            parts: [{ model: 'A', status: 'complete', grade: 'strong', availability: 'active' }],
            estimate: { profit: 10, roi: 0.25, cost: 40, netRevenue: 50 },
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
    const snap = ingestAuditBody(
      {
        kind: 'split-finder-audit',
        bundles: [{ key: 'K', brand: 'DEWALT', model: 'M', title: 'T', section: 'confirmed', itemId: 9 }],
        questions: [],
      },
      at,
    )!;
    const rows = enrichedDealRows(snap.bundles);
    expect(rows[0]?.profit).toBe(10);
    expect(rows[0]?.matchLine).toBe('1 part matched');
  });
});