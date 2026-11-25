import { describe, expect, it } from 'vitest';

import { profitQualifier } from '@core/estimateNote';
import { estimateWords } from './Figure';

describe('the sentence under a list of estimates', () => {
  it('says what the estimates leave out while a cost is unanswered, in the shared words, and nothing extra once both are', () => {
    const fees = { salesTaxRate: 0, inboundCost: 0 };
    expect(estimateWords(profitQualifier(fees))).toBe(
      'Profit and ROI are estimates from your fee settings, before sales tax and inbound shipping, not your real Amazon fees.',
    );
    expect(estimateWords(profitQualifier({ ...fees, salesTaxAnswered: true }))).toBe(
      'Profit and ROI are estimates from your fee settings, before inbound shipping, not your real Amazon fees.',
    );
    expect(estimateWords(profitQualifier({ ...fees, salesTaxAnswered: true, inboundAnswered: true }))).toBe(
      'Profit and ROI are estimates from your fee settings, not your real Amazon fees.',
    );
  });
});
