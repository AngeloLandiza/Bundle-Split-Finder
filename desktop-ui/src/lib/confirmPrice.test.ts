import { describe, expect, it } from 'vitest';
import type { DealPart } from '../api/types';
import type { PriceFromLinkFound } from '@core/api/contract';
import { confirmRequest, enterAction, foundLine, foundPriceText, IDLE, initialForm, priceOf, readableLink, readSourceLine, sheetLine, TYPED, type ConfirmForm } from './confirmPrice';

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

describe('a pasted link read for its price', () => {
  const found = (over: Partial<PriceFromLinkFound> = {}): PriceFromLinkFound => ({
    found: true, price: 74.99, currency: 'USD', title: 'DEWALT DCF887B 20V MAX XR Brushless Impact Driver Tool Only', condition: 'New', shipping: 8.5,
    source: 'eBay', url: L1, readAt: '2026-11-23T12:00:00.000Z', ...over,
  });

  it('reads only a web link without spaces', () => {
    expect(readableLink(` ${L1} `)).toBe(L1);
    expect(readableLink('not a link')).toBeNull();
    expect(readableLink('')).toBeNull();
    expect(readableLink('ftp://example.com/x')).toBeNull();
    expect(readableLink(`${L1} and more`)).toBeNull();
  });
  it('says what was found, with the shipping the listing states and the title cut short', () => {
    expect(foundLine(found())).toBe("Found on eBay: $74.99 + $8.50 shipping · New · 'DEWALT DCF887B 20V MAX XR Brushless Impa…'");
    expect(foundLine(found({ shipping: 0, title: 'DEWALT DCF887B' }))).toBe("Found on eBay: $74.99 + free shipping · New · 'DEWALT DCF887B'");
    expect(foundLine(found({ shipping: null, title: 'DEWALT DCF887B' }))).toBe("Found on eBay: $74.99 · shipping not stated · New · 'DEWALT DCF887B'");
    expect(foundLine(found({ source: 'Amazon (Keepa)', shipping: undefined, title: 'X' }))).toBe("Found on Amazon (Keepa): $74.99 · New · 'X'");
    expect(foundLine({ ...found({ shipping: undefined, title: 'X' }), condition: undefined, source: 'Home Depot' })).toBe("Found on Home Depot: $74.99 · 'X'");
  });
  it('fills the price field with the price to the cent, and says when and from where it was read', () => {
    expect(foundPriceText(found({ price: 75 }))).toBe('75.00');
    const at = Date.parse('2026-11-23T12:00:00.000Z');
    expect(readSourceLine(found(), at + 20_000)).toBe('read just now from eBay');
    expect(readSourceLine(found({ source: 'Amazon (Keepa)' }), at + 5 * 60_000)).toBe('read 5 min ago from Amazon (Keepa)');
    expect(readSourceLine(found(), at + 3 * 3_600_000)).toBe('read 3 h ago from eBay');
  });
  it('lets a found price fill the form that Save then sends as a typed price, with the pasted link', () => {
    const r = confirmRequest(form({ choice: TYPED, price: foundPriceText(found()), link: L1 }), part({ ebay: [] }));
    expect(r).toEqual({ ok: true, body: { kind: 'typed', price: 74.99, url: L1 } });
  });
  it('makes Enter wait while reading, read a pasted link that has no price yet, and save once a price is there', () => {
    const typed = (over: Partial<ConfirmForm> = {}) => form({ choice: TYPED, link: L1, ...over });
    expect(enterAction(typed(), IDLE)).toBe('read');
    expect(enterAction(typed(), { state: 'reading', url: L1 })).toBe('wait');
    expect(enterAction(typed({ price: '74.99' }), { state: 'found', url: L1, found: found() })).toBe('save');
    // A read that found nothing is not asked for again by Enter; the form says what is missing (the price).
    expect(enterAction(typed(), { state: 'missed', url: L1, reason: 'Split Finder cannot read this site. Type the price you see.' })).toBe('save');
    // A site that cannot be read, with the price typed, saves as before.
    expect(enterAction(typed({ link: 'https://www.facebook.com/marketplace/item/1', price: '60' }), IDLE)).toBe('save');
    // No link yet, or a stored eBay listing chosen: nothing to read.
    expect(enterAction(typed({ link: '' }), IDLE)).toBe('save');
    expect(enterAction(form({ choice: L1 }), IDLE)).toBe('save');
  });
});
