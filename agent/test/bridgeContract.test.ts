import { describe, expect, it } from 'vitest';

import { ingestAuditBody, readDealsSnapshot } from '../dealsStore';
import { ingestPanelBody } from '../panelStore';
import { enrichedDealRows } from '../panelStore';
import { writeHelperState } from '../stateStore';

describe('Lane D bridge contract', () => {
  it('panel + audit + state produce app-ready payloads', () => {
    const at = '2026-01-02T12:00:00.000Z';
    ingestAuditBody(
      {
        kind: 'split-finder-audit',
        bundles: [{ key: 'B', brand: 'DEWALT', model: 'X', title: 'Kit', section: 'confirmed', itemId: 1 }],
        questions: [],
      },
      at,
    );
    ingestPanelBody(
      {
        kind: 'split-finder-panel',
        bundles: [
          {
            key: 'B',
            itemId: '1',
            brand: 'DEWALT',
            model: 'X',
            title: 'Kit',
            link: null,
            price: 100,
            regularPrice: 120,
            percentOff: 17,
            seenAt: 1,
            status: 'complete',
            section: 'confirmed',
            parts: [],
            estimate: { profit: 20, roi: 0.2, cost: 80, netRevenue: 100 },
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
    writeHelperState({
      hasKey: true,
      hasAnthropicKey: false,
      askAiAllRunning: false,
      scanRunning: false,
      searchesLeft: 40,
      searchesPerMonth: 250,
      keepaTokensLeft: null,
      keepaRefillMin: null,
      searchesPerScan: 5,
      rateLimitPerHour: 50,
      lastJob: null,
    });
    const deals = readDealsSnapshot();
    expect(deals?.bundles).toHaveLength(1);
    expect(enrichedDealRows(deals!.bundles)[0]?.profit).toBe(20);
  });
});