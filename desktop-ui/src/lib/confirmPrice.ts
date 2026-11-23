// The "Confirm a price" sheet's rules, apart from the screen. A price counts only because he chose it: a stored eBay
// listing, or a price and a link he typed. This module turns his form into the body the agent takes, or into the one
// sentence that says what is missing. It never makes up a figure (CLAUDE.md rule 4).

import { AMAZON_COUNTS, ANSWER_FIRST, LOOK_UP_FIRST, parseConfirmedPrice } from '@core/scan/confirmed';
import type { PriceFromLinkFound } from '@core/api/contract';
import type { ConfirmPriceRequest, DealPart } from '../api/types';
import { money } from './format';

/** The choice that means "a price I have seen": the other choices are the part's stored eBay listings, by link. */
export const TYPED = '__typed';

export interface ConfirmForm {
  /** TYPED, or the link of one stored eBay listing; null before he chooses. */
  choice: string | null;
  price: string;
  link: string;
  note: string;
}

/** What he typed as a price: "$1,064.50" reads 1064.5. Anything that is not a number stays text for the check to refuse. */
export function priceOf(text: string): number | string {
  const cleaned = text.replace(/[$,\s]/g, '');
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : text.trim();
}

/** The form as the sheet opens: his own confirmed price when he has one (to change), else nothing chosen. */
export function initialForm(part: Pick<DealPart, 'confirm'>): ConfirmForm {
  const own = part.confirm.confirmed;
  if (!own) return { choice: null, price: '', link: '', note: '' };
  const listing = part.confirm.ebay.find((c) => c.url === own.link && c.price === own.price);
  return { choice: listing ? listing.url : TYPED, price: listing ? '' : String(own.price), link: listing ? '' : own.link, note: own.note ?? '' };
}

export type FormResult = { ok: true; body: ConfirmPriceRequest } | { ok: false; problem: string };

/** The agent's body for the form, or the sentence that says why not. The link and the price are checked as core checks them. */
export function confirmRequest(form: ConfirmForm, part: Pick<DealPart, 'confirm'>): FormResult {
  const note = form.note.trim();
  if (form.choice === null) return { ok: false, problem: part.confirm.ebay.length ? 'Choose an eBay listing, or enter a price and a link.' : 'Enter a price and a link.' };
  if (form.choice !== TYPED) {
    const listing = part.confirm.ebay.find((c) => c.url === form.choice);
    if (!listing) return { ok: false, problem: 'That is not one of this part’s stored eBay listings.' };
    const checked = parseConfirmedPrice({ brand: 'X', model: 'X', price: listing.price, link: listing.url, note }, 0);
    if (typeof checked === 'string') return { ok: false, problem: checked };
    return { ok: true, body: { kind: 'ebay-listing', url: listing.url, ...(note ? { note } : {}) } };
  }
  const checked = parseConfirmedPrice({ brand: 'X', model: 'X', price: priceOf(form.price), link: form.link, note }, 0);
  if (typeof checked === 'string') return { ok: false, problem: checked };
  return { ok: true, body: { kind: 'typed', price: checked.price, url: checked.link, ...(note ? { note } : {}) } };
}

/** What the sheet says above the form, from the part's own state; null when the form itself says it. */
export function sheetLine(part: Pick<DealPart, 'confirm'>): { kind: 'blocked'; text: string; toReview: boolean } | { kind: 'form'; text: string } {
  const c = part.confirm;
  if (c.state === 'answer-first') return { kind: 'blocked', text: ANSWER_FIRST, toReview: true };
  if (c.state === 'look-up-first') return { kind: 'blocked', text: LOOK_UP_FIRST, toReview: false };
  if (c.state === 'amazon-counts' && !c.confirmed) return { kind: 'blocked', text: AMAZON_COUNTS, toReview: false };
  const until = 'A price you confirm counts until this listing is for sale again.';
  const choose = 'Count one of the eBay prices below, or enter a price and a link you have seen. A Facebook link is enough.';
  const enter = 'Enter the price you saw and a link to the listing. An eBay or Facebook link is enough.';
  const body = c.ebay.length ? choose : enter;
  return { kind: 'form', text: c.inactive ? `${until} ${body}` : body };
}

// ---------------------------------------------------------------- a pasted link, read for its price

/**
 * What the sheet knows about the link he pasted. A found price only fills the price field; it counts when he presses
 * Save price (docs/decisions.md, "A price counts when he confirms it"). `url` is the link the read was made for, so an
 * answer for a link he has since changed is dropped.
 */
export type LinkRead =
  | { state: 'idle' }
  | { state: 'reading'; url: string }
  | { state: 'found'; url: string; found: PriceFromLinkFound }
  | { state: 'missed'; url: string; reason: string };

export const IDLE: LinkRead = { state: 'idle' };

/** The pasted text as a link worth reading (http or https, no spaces), or null. */
export function readableLink(text: string): string | null {
  const t = text.trim();
  if (t === '' || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? t : null;
  } catch {
    return null;
  }
}

const TITLE_MAX = 40;

/** "Found on eBay: $74.99 + $8.50 shipping · New · 'DEWALT DCF887B…'". Shipping is said only when the source gave it; null is "shipping not stated". */
export function foundLine(f: PriceFromLinkFound): string {
  const ship = f.shipping === undefined ? '' : f.shipping === null ? ' · shipping not stated' : f.shipping > 0 ? ` + ${money(f.shipping)} shipping` : ' + free shipping';
  const title = f.title.length > TITLE_MAX ? `${f.title.slice(0, TITLE_MAX).trimEnd()}…` : f.title;
  return `Found on ${f.source}: ${money(f.price)}${ship}${f.condition ? ` · ${f.condition}` : ''} · '${title}'`;
}

/** "read just now from eBay", "read 3 min ago from Amazon (Keepa)". */
export function readSourceLine(f: PriceFromLinkFound, nowMs: number): string {
  const mins = Math.floor((nowMs - Date.parse(f.readAt)) / 60_000);
  const when = !(mins >= 1) ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
  return `read ${when} from ${f.source}`;
}

/** The price field's text for a found price: "74.99". */
export const foundPriceText = (f: PriceFromLinkFound): string => f.price.toFixed(2);

/**
 * What Enter does in the form. While a read is under way: nothing. With a link he has not had read and no price yet: read
 * it (that is what pasting then pressing Enter means). Otherwise: save, and the form's own checks say what is missing.
 */
export function enterAction(form: Pick<ConfirmForm, 'choice' | 'price' | 'link'>, read: LinkRead): 'wait' | 'read' | 'save' {
  if (read.state === 'reading') return 'wait';
  const link = readableLink(form.link);
  if (form.choice === TYPED && link !== null && form.price.trim() === '' && !(read.state !== 'idle' && read.url === link)) return 'read';
  return 'save';
}
