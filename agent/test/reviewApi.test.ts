import { existsSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { ingestAuditBody, readDealsSnapshot } from '../dealsStore';
import { agentDataDir } from '../paths';

const snapFile = `${agentDataDir()}/deals-snapshot.json`;

afterEach(() => {
  if (existsSync(snapFile)) unlinkSync(snapFile);
});

describe('review API data', () => {
  it('exposes split, match, and eBay open questions from the audit snapshot', () => {
    const at = '2026-01-01T00:00:00.000Z';
    ingestAuditBody(
      {
        kind: 'split-finder-audit',
        bundles: [],
        questions: [
          {
            id: 'match:x',
            kind: 'match',
            subject: 'DEWALT:A',
            brand: 'DEWALT',
            model: 'A',
            title: 'Part',
            reason: 'pick one',
            candidates: [{ asin: 'B001', title: 'Listing', grade: 'probable' }],
            choices: [],
            openedAt: 2,
            answer: null,
            answeredAt: null,
          },
        ],
        ebayQuestions: [
          {
            id: 'DEWALT:A|99',
            key: 'DEWALT:A',
            brand: 'DEWALT',
            model: 'A',
            itemId: '99',
            title: 'eBay tool',
            url: 'https://www.ebay.com/itm/99',
            price: 40,
            soldQuantity: 1,
            reasons: ['title unclear'],
            openedAt: 1,
          },
        ],
      },
      at,
    );
    const snap = readDealsSnapshot();
    expect(snap?.openQuestions.filter((q) => q.answer === null)).toHaveLength(1);
    expect(snap?.openEbayQuestions).toHaveLength(1);
  });
});