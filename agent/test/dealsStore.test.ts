import { describe, expect, it } from 'vitest';

import { ingestAuditBody } from '../dealsStore';

describe('dealsStore', () => {
  it('ingests audit bundles and open questions', () => {
    const snap = ingestAuditBody(
      {
        kind: 'split-finder-audit',
        bundles: [
          { key: 'DEWALT:X', brand: 'DEWALT', model: 'X', title: 'Kit', section: 'confirmed', itemId: 1 },
        ],
        questions: [
          {
            id: 'split:RYOBI:Y',
            kind: 'split',
            subject: 'RYOBI:Y',
            brand: 'RYOBI',
            model: 'Y',
            title: 'Kit',
            reason: 'ambiguous',
            candidates: [],
            choices: [['A', 'B']],
            openedAt: 1,
            answer: null,
            answeredAt: null,
          },
        ],
      },
      '2026-01-01T00:00:00.000Z',
    );
    expect(snap?.bundles).toHaveLength(1);
    expect(snap?.reviewOpen).toHaveLength(1);
  });

  it('ingests open eBay listing questions', () => {
    const snap = ingestAuditBody(
      {
        kind: 'split-finder-audit',
        bundles: [],
        questions: [],
        ebayQuestions: [
          {
            id: 'DEWALT:M|1',
            key: 'DEWALT:M',
            brand: 'DEWALT',
            model: 'M',
            itemId: '1',
            title: 'Tool',
            url: 'https://www.ebay.com/itm/1',
            price: 50,
            soldQuantity: 2,
            reasons: ['unsure'],
            openedAt: 3,
          },
        ],
      },
      '2026-01-01T00:00:00.000Z',
    );
    expect(snap?.openEbayQuestions).toHaveLength(1);
  });
});