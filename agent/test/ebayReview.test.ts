import { describe, expect, it } from 'vitest';

import type { EbayQuestion } from '../../core/src/scan/types';
import { DEFAULT_EBAY_SETTINGS } from '../../core/src/settings';
import { openReviewCount, reviewResponse } from '../views';

// Nov 23: the first real scan with eBay added 20 "Is this eBay listing the same product?" questions to Review (DCF921B ×6,
// DCF860B ×6, ...). They are about reference listings that count in no estimate, so by default they leave Review: the
// listing is simply not in the part's eBay range, and the question stays stored, answerable by its id.

const question: EbayQuestion = {
  id: 'DEWALT:DCF921B|123456789012', key: 'DEWALT:DCF921B', brand: 'DEWALT', model: 'DCF921B', itemId: '123456789012',
  title: 'DEWALT DCF921B 20V MAX 1/2 in. Impact Wrench (Tool Only)', url: 'https://www.ebay.com/itm/123456789012', price: 139, soldQuantity: 4,
  reasons: ['The title does not say whether it is the tool only.'], openedAt: 1,
};

const data = (ebaySettings: object) =>
  ({
    review: { at: null, questions: [], ebayQuestions: [question] }, suggestions: [], deals: { bundles: [] },
    settings: { ai: {}, ebaySettings },
  }) as never;

describe('eBay identity questions (Nov 23)', () => {
  it('leave Review and its count by default, and a stored install without the setting is off', () => {
    const { judgeModel, listingsJudgedPerScan } = DEFAULT_EBAY_SETTINGS;
    for (const s of [DEFAULT_EBAY_SETTINGS, { judgeModel, listingsJudgedPerScan }]) {
      expect(reviewResponse(data(s)).questions).toEqual([]);
    }
    expect(openReviewCount({ at: null, questions: [], ebayQuestions: [question] })).toBe(0);
  });

  it('are in Review and counted when the owner asks about them', () => {
    expect(reviewResponse(data({ ...DEFAULT_EBAY_SETTINGS, askAboutListings: true })).questions.map((q) => q.id)).toEqual([question.id]);
    expect(openReviewCount({ at: null, questions: [], ebayQuestions: [question] }, true)).toBe(1);
  });
});
