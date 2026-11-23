import { describe, expect, it } from 'vitest';
import type { DealPart } from '../api/types';
import { confirmRequest, initialForm, priceOf, sheetLine, TYPED, type ConfirmForm } from './confirmPrice';

const L1 = 'https://www.ebay.com/itm/235482930111';
const L2 = 'https://www.ebay.com/itm/235482930222';
const part = (over: Partial<DealPart['confirm']> = {}): Pick<DealPart, 'confirm'> => ({
  confirm: { state: 'open', ebay: [{ url: L1, price: 44 }, { url: L2, price: 31 }], confirmed: null, inactive: false, ...over },
});
const form = (over: Partial<ConfirmForm> = {}): ConfirmForm => ({ choice: null, price: '', link: '', note: '', ...over });

describe('what he typed as a price', () => {
  it('reads dollars and commas, and leaves anything else for the check to refuse', () => {
    expect(priceOf('$1,064.50')).toBe(1064.5);
    expect(priceOf(' 64 ')).toBe(64);
    expect(priceOf('sixty')).toBe('sixty');
    expect(priceOf('-5')).toBe('-5');
  });
});

describe('the confirm-price form', () => {
  it('sends a chosen eBay listing by its link, with his note', () => {
    expect(confirmRequest(form({ choice: L2, note: ' pickup ' }), part())).toEqual({ ok: true, body: { kind: 'ebay-listing', url: L2, note: 'pickup' } });
  });
  it('sends a typed price with its link, and a Facebook link is enough', () => {
    const r = confirmRequest(form({ choice: TYPED, price: '$64.50', link: 'https://www.facebook.com/marketplace/item/1' }), part());
    expect(r).toEqual({ ok: true, body: { kind: 'typed', price: 64.5, url: 'https://www.facebook.com/marketplace/item/1' } });
  });
  it('asks him to choose before it sends anything', () => {
    expect(confirmRequest(form(), part())).toEqual({ ok: false, problem: 'Choose an eBay listing, or enter a price and a link.' });
    expect(confirmRequest(form(), part({ ebay: [] }))).toEqual({ ok: false, problem: 'Enter a price and a link.' });
  });
  it("refuses a typed price with no link, a price of $0 or less, and a link that is not a web page, in core's words", () => {
    expect(confirmRequest(form({ choice: TYPED, price: '50' }), part())).toEqual({ ok: false, problem: 'Enter a link to the listing.' });
    expect(confirmRequest(form({ choice: TYPED, price: '0', link: L1 }), part())).toEqual({ ok: false, problem: 'Enter a price above $0.' });
    expect(confirmRequest(form({ choice: TYPED, price: 'abc', link: L1 }), part())).toEqual({ ok: false, problem: 'Enter a price above $0.' });
    expect(confirmRequest(form({ choice: TYPED, price: '5', link: 'ftp://example.com/a' }), part())).toEqual({ ok: false, problem: 'Enter a link that starts with http or https.' });
    expect(confirmRequest(form({ choice: TYPED, price: '5', link: L1, note: 'x'.repeat(201) }), part())).toEqual({ ok: false, problem: 'That note is too long to store.' });
  });
  it('never sends a listing the part does not hold', () => {
    expect(confirmRequest(form({ choice: 'https://www.ebay.com/itm/999' }), part()).ok).toBe(false);
  });
});

describe('the form as it opens', () => {
  it('opens empty: choosing is the decision, nothing is preselected', () => {
    expect(initialForm(part())).toEqual({ choice: null, price: '', link: '', note: '' });
  });
  it('opens on a stored listing when that is the price he confirmed, and on his typed price otherwise', () => {
    expect(initialForm(part({ confirmed: { price: 44, link: L1, note: 'a' } }))).toEqual({ choice: L1, price: '', link: '', note: 'a' });
    expect(initialForm(part({ confirmed: { price: 40, link: 'https://www.facebook.com/marketplace/item/9', note: null } }))).toEqual({
      choice: TYPED, price: '40', link: 'https://www.facebook.com/marketplace/item/9', note: '',
    });
  });
});

describe('what the sheet says first', () => {
  it('gives no form for a part still in Review: answer its question first, linking to Review', () => {
    expect(sheetLine(part({ state: 'answer-first' }))).toEqual({ kind: 'blocked', text: 'Answer its question first. A price counts only after its Amazon listing is chosen.', toReview: true });
  });
  it('gives no form for a part not looked up, or one an Amazon price already counts', () => {
    expect(sheetLine(part({ state: 'look-up-first' }))).toMatchObject({ kind: 'blocked', toReview: false });
    expect(sheetLine(part({ state: 'amazon-counts' }))).toMatchObject({ kind: 'blocked' });
    expect(sheetLine(part({ state: 'amazon-counts', confirmed: { price: 5, link: L1, note: null } })).kind).toBe('form');
  });
  it('says a confirmed price counts until an inactive listing is for sale again', () => {
    expect((sheetLine(part({ inactive: true })) as { text: string }).text).toMatch(/^A price you confirm counts until this listing is for sale again\./);
    expect((sheetLine(part()) as { text: string }).text).toMatch(/^Count one of the eBay prices/);
    expect((sheetLine(part({ ebay: [] })) as { text: string }).text).toMatch(/^Enter the price you saw/);
  });
});
