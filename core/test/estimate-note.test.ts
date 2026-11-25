// What a profit estimate says while the owner has not answered his sales tax and inbound shipping (core/src/estimateNote.ts),
// and a figure below its own number never rounding up to it (core/src/money.ts pctVs, usdVs). Real figures: the owner's
// $20 and 20% numbers and the 90-day average of $17.47 for PCG002 (fixtures/keepa/stats-sample-2026-11-25.json).

import { describe, expect, it } from 'vitest';

import { costsPromptSentence, profitQualifier, unansweredCosts, withProfitQualifier } from '../src/estimateNote';
import { DEFAULT_FEES, pctVs, usdVs } from '../src/money';
import { usualFailWords, type UsualEstimate } from '../src/tracking/market';

const T = { minProfit: 20, minRoiPercent: 20 };
const usual = (profit: number, roiPercent: number): UsualEstimate => ({ profit, roiPercent, meets: false, parts: [{ model: 'PCG002', price: 17.47, usual: 17.47 }] });

describe('what the estimate leaves out', () => {
  it('a store with both at 0 and no mark has answered neither', () => {
    expect(unansweredCosts(DEFAULT_FEES)).toEqual(['salesTax', 'inbound']);
    expect(profitQualifier(DEFAULT_FEES)).toBe('before sales tax and inbound shipping');
  });
  it('a stored value other than 0, with no mark, is an answer; a stored 0 is not', () => {
    expect(profitQualifier({ salesTaxRate: 0.0825, inboundCost: 0 })).toBe('before inbound shipping');
    expect(profitQualifier({ salesTaxRate: 0, inboundCost: 3.5 })).toBe('before sales tax');
    expect(profitQualifier({ salesTaxRate: 0.0825, inboundCost: 3.5 })).toBeNull();
  });
  it('an explicit 0 the owner confirmed settles it', () => {
    expect(profitQualifier({ salesTaxRate: 0, inboundCost: 0, salesTaxAnswered: true, inboundAnswered: true })).toBeNull();
    expect(profitQualifier({ salesTaxRate: 0, inboundCost: 0, salesTaxAnswered: true })).toBe('before inbound shipping');
    expect(costsPromptSentence({ salesTaxRate: 0, inboundCost: 0, salesTaxAnswered: true, inboundAnswered: true })).toBeNull();
  });
  it('the words, in one place', () => {
    expect(withProfitQualifier('est. profit $34.62', DEFAULT_FEES)).toBe('est. profit $34.62 before sales tax and inbound shipping');
    expect(withProfitQualifier('est. profit $34.62', { ...DEFAULT_FEES, salesTaxAnswered: true, inboundAnswered: true })).toBe('est. profit $34.62');
    expect(costsPromptSentence(DEFAULT_FEES)).toBe('Your sales tax and inbound shipping are not set, so profit estimates leave them out. Enter them in Settings, or confirm that they are 0.');
    expect(costsPromptSentence({ ...DEFAULT_FEES, salesTaxAnswered: true })).toBe('Your inbound shipping is not set, so profit estimates leave it out. Enter it in Settings, or confirm that it is 0.');
  });
});

describe('a figure below its number never reads as the number', () => {
  it("+$19.74 with a 19.9% ROI reads 19.9%, not 20%, against the owner's $20 and 20%", () => {
    expect(usualFailWords(usual(19.74, 19.9), T)).toBe('at the 90-day average of $17.47 for PCG002 it is +$19.74 (19.9% ROI), below your $20 and 20%');
  });
  it('the real Nov 25 case keeps its whole number', () => {
    expect(usualFailWords(usual(8.48, 9), T)).toBe('at the 90-day average of $17.47 for PCG002 it is +$8.48 (9% ROI), below your $20 and 20%');
  });
  it('percent and dollars, at the edges', () => {
    expect(pctVs(19.96, 20)).toBe('19.9%');
    expect(pctVs(19.4, 20)).toBe('19%');
    expect(pctVs(20, 20)).toBe('20%');
    expect(pctVs(24.6, 20)).toBe('25%');
    expect(usdVs(19.996, 20)).toBe('$19.99');
    expect(usdVs(19.74, 20)).toBe('$19.74');
    expect(usdVs(20, 20)).toBe('$20.00');
    expect(usdVs(-3.5, 20)).toBe('-$3.50');
  });
});
