// Nov 25: the seller account's lines and day's use as the window reads them from the agent. Amazon's apply link is shown
// and opened only when it is https on sellercentral.amazon.com, whatever the agent sent.

import { describe, expect, it } from 'vitest';

import { sellerOf, sellerUsageOf } from './map';

const APPLY = 'https://sellercentral.amazon.com/hz/approvalrequest/restrictions/approve?asin=B09HDZ5MPV';
const line = (over: Record<string, unknown> = {}) => ({ model: 'PBP004', asin: 'B09HDZ5MPV', text: "You need Amazon's approval to list it.", tone: 'attention', link: APPLY, canSelfShip: true, selfShip: false, ...over });

describe('sellerOf', () => {
  it('keeps each line and its Seller Central link', () => {
    expect(sellerOf({ connected: true, note: null, parts: [line()] })).toEqual({ connected: true, note: null, parts: [line()] });
  });

  it('drops a link to any other host, and a line without its text', () => {
    const out = sellerOf({ connected: true, note: null, parts: [line({ link: 'https://sellercentral.amazon.com.evil.example/x' }), line({ link: 'javascript:alert(1)' }), { asin: 'X' }] });
    expect(out?.parts.map((p) => p.link)).toEqual([null, null]);
  });

  it('not connected: the quiet line only', () => {
    expect(sellerOf({ connected: false, note: 'Not checked against your Amazon account: connect it in Settings to see whether you may list these.', parts: [] }))
      .toEqual({ connected: false, note: 'Not checked against your Amazon account: connect it in Settings to see whether you may list these.', parts: [] });
    expect(sellerOf(undefined)).toBeNull();
  });
});

describe('sellerUsageOf', () => {
  it('reads the four counts and caps; anything else is left out', () => {
    const u = { used: { restrictions: 12, eligibility: 12, fees: 1, sales: 0 }, caps: { restrictions: 400, eligibility: 400, fees: 40, sales: 100 } };
    expect(sellerUsageOf(u)).toEqual(u);
    expect(sellerUsageOf({ used: { ...u.used, fees: -1 }, caps: u.caps })).toBeUndefined();
    expect(sellerUsageOf(null)).toBeUndefined();
  });
});
