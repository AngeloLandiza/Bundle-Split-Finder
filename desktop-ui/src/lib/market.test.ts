import { describe, expect, it } from 'vitest';

import type { DealSignals, OptionMarket, PartMarket } from '../api/types';
import { marketAside, marketDealNotes } from './market';
import { verdictOf } from './signals';

// PSK1212SB-PCL515B as the agent judged it with the Nov 23 prices and the Keepa records of Nov 25
// (core/test/market.test.ts): PCG002 and PCL515B unusually priced, PBP004 a lithium battery.
const part = (p: Partial<PartMarket> & Pick<PartMarket, 'model' | 'asin' | 'price'>): PartMarket => ({
  qty: 1, at: Date.parse('2026-11-25T14:24:26Z'), avg30: null, avg90: null, avg180: null, aboveAvg90: null, unusual: false, notes: [], ...p,
});
const MARKET: OptionMarket = {
  parts: [
    part({ model: 'PBP004', asin: 'B09HDZ5MPV', price: 53.99, avg90: 54.59, hazmat: { unId: 'UN3480', name: 'LITHIUM ION BATTERIES', lithium: true } }),
    part({ model: 'PCG002', asin: 'B0B1QRQYK2', price: 34.97, avg90: 17.47, aboveAvg90: 1.0017, unusual: true, amazon: { price: 34.97, buyBox: false } }),
    part({ model: 'PCL515B', asin: 'B0B88R7HWB', price: 79.99, avg30: 56.43, avg90: 61.12, avg180: 55.89, aboveAvg90: 0.3087, unusual: true }),
  ],
  usual: { profit: 12.28, roiPercent: 12.4, meets: false, parts: [{ model: 'PCG002', price: 34.97, usual: 17.47 }, { model: 'PCL515B', price: 79.99, usual: 61.12 }] },
};

describe('the Market block', () => {
  it('names what needs a look in the fold, and the lithium battery once for the deal', () => {
    expect(marketAside(MARKET)).toBe('2 unusual prices, 1 hazard note');
    expect(marketDealNotes(MARKET)).toEqual(['This deal holds a lithium battery: PBP004 (UN3480). Amazon treats it as dangerous goods; check it is approved in your FBA account before buying.']);
    expect(marketAside({ parts: [MARKET.parts[0]!, MARKET.parts[0]!], usual: null })).toBe('2 hazard notes');
  });

  it('a deal held back by its usual prices alone reads "Worth buying at today\'s prices only", with the reason', () => {
    const notBuyNow = 'At the 90-day averages of $17.47 for PCG002 and $61.12 for PCL515B it is +$12.28 (12% ROI), below your $20 and 20%.';
    const s: DealSignals = {
      at: '2026-11-23T20:00:00Z', buyNow: null, signals: [],
      options: [{
        optionId: 'split:PSK1212SB', label: 'PSK1212SB split into its parts', profit: 43.19, roiPercent: 43.63, meetsThresholds: true,
        velocity: { status: 'pass', reason: '', minMonthlySold: 50, slowest: { model: 'PCG002', monthlySold: 100 }, parts: [] },
        baseline: { last: null, rolling7d: null }, buyNow: false, notBuyNow, market: MARKET,
      }],
    };
    expect(verdictOf(s)).toMatchObject({ buyNow: false, headline: "Worth buying at today's prices only", sentence: notBuyNow });
  });
});
