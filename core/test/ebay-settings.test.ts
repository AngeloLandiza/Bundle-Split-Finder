import { describe, expect, it } from 'vitest';
import { DEFAULT_EBAY_SETTINGS, ebaySettingsProblem, ESTIMATED_TOKENS_PER_LISTING, estimatedJudgeCost } from '../src/settings';

describe('the eBay settings', () => {
  it('start at the cheapest model and 60 listings a scan, not asking about uncertain listings in Review', () => {
    expect(DEFAULT_EBAY_SETTINGS).toEqual({ judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60, askAboutListings: false });
    expect(ebaySettingsProblem(DEFAULT_EBAY_SETTINGS)).toBeNull();
  });

  it('accept a known model and a whole number from 1 to 500, and say what is wrong otherwise', () => {
    expect(ebaySettingsProblem({ judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 500 })).toBeNull();
    expect(ebaySettingsProblem({ judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 1 })).toBeNull();
    expect(ebaySettingsProblem({ judgeModel: 'gpt-4', listingsJudgedPerScan: 60 })).toBe('Choose one of the models offered.');
    expect(ebaySettingsProblem(null)).toBe('Choose one of the models offered.');
    for (const n of [0, 501, 2.5, Number.NaN, '60', null, undefined, -1]) {
      expect(ebaySettingsProblem({ judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: n }), String(n)).toBe('Use a whole number of listings from 1 to 500.');
    }
  });
});

describe('the estimated cost of judging', () => {
  it("is the token estimate at the model's published rate, for each listing", () => {
    expect(ESTIMATED_TOKENS_PER_LISTING).toEqual({ input: 1700, output: 500 });
    // Haiku: $0.10 and $0.50 a million tokens.
    expect(estimatedJudgeCost('claude-haiku-5-5', 60)).toBeCloseTo((60 * (1700 * 0.1 + 500 * 0.5)) / 1_000_000, 10);
    // Opus: $4 and $20.
    expect(estimatedJudgeCost('claude-opus-5-5', 60)).toBeCloseTo((60 * (1700 * 4 + 500 * 20)) / 1_000_000, 10);
    expect(estimatedJudgeCost('claude-haiku-5-5', 0)).toBe(0);
  });

  it('is nothing for a model with no published rate or a count that is not a number', () => {
    expect(estimatedJudgeCost('some-other-model', 60)).toBeNull();
    expect(estimatedJudgeCost('claude-haiku-5-5', Number.NaN)).toBeNull();
    expect(estimatedJudgeCost('claude-haiku-5-5', -1)).toBeNull();
  });
});
