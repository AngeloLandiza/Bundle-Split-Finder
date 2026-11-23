// A sell price the owner confirms by hand, with a link to the listing that shows it.
// The worker stores only what this accepts. Nothing here searches or guesses a price.

import { partKey, type BundleRow, type ConfirmedPrice, type PartRow, type PriceSuggestion, type UnnamedItem } from './types';

const PRICE_MAX = 100_000;
/** A model number. A leftover's page text is longer, so the model field has its own cap. */
export const CONFIRMED_BRAND_MAX = 40;
export const CONFIRMED_MODEL_MAX = 120;
const LINK_MAX = 2_000;
export const CONFIRMED_NOTE_MAX = 200;

const named = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > max) return null;
  return text;
};

/**
 * The record to store, or one sentence when the price or the link cannot be kept.
 * `confirmedAt` is the worker's clock. The link is kept as the URL parsed it: http or https, no password in it.
 */
export function parseConfirmedPrice(
  input: { brand: unknown; model: unknown; price: unknown; link: unknown; note?: unknown },
  confirmedAt: number,
): ConfirmedPrice | string {
  const brand = named(input.brand, CONFIRMED_BRAND_MAX);
  if (brand === null) return 'Name the brand.';
  const modelText = typeof input.model === 'string' ? input.model.trim() : '';
  if (modelText === '') return 'Name the part.';
  if (modelText.length > CONFIRMED_MODEL_MAX) return 'That name is too long to store.';
  const model = modelText;
  const raw = typeof input.price === 'number' ? input.price : typeof input.price === 'string' && input.price.trim() !== '' ? Number(input.price) : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0 || raw >= PRICE_MAX) return 'Enter a price above $0.';
  const price = Math.round(raw * 100) / 100;
  if (!(price > 0)) return 'Enter a price above $0.';
  if (typeof input.link !== 'string' || input.link.trim() === '' || input.link.trim().length > LINK_MAX) return 'Enter a link to the listing.';
  let url: URL;
  try {
    url = new URL(input.link.trim());
  } catch {
    return 'Enter a link that starts with http or https.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Enter a link that starts with http or https.';
  if (url.username !== '' || url.password !== '') return 'Enter a link to the listing, with no password in it.';
  if (url.hostname === '') return 'Enter a link to the listing.';
  let note: string | undefined;
  if (input.note !== undefined && input.note !== null && input.note !== '') {
    if (typeof input.note !== 'string') return 'Write the note as text.';
    const trimmed = input.note.trim();
    if (trimmed.length > CONFIRMED_NOTE_MAX) return 'That note is too long to store.';
    if (trimmed !== '') note = trimmed;
  }
  const brandUp = brand.toUpperCase();
  const modelUp = model.toUpperCase();
  return { key: partKey(brandUp, modelUp), brand: brandUp, model: modelUp, price, link: url.toString(), confirmedAt, ...(note ? { note } : {}) };
}

/** Where a confirmed price came from, in a word the owner knows: "eBay", "Facebook", else the site's name. Never reads the page. */
export function confirmedSourceName(link: string | null | undefined): string {
  if (!link) return 'a link';
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'ebay.com' || host.endsWith('.ebay.com')) return 'eBay';
    if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com' || host === 'fb.me') return 'Facebook';
    return host === '' ? 'a link' : host;
  } catch {
    return 'a link';
  }
}

// ---------------------------------------------------------------- the owner's price form, as rules

export interface EbayListingChoice {
  url: string;
  price: number;
}

const webLink = (link: string): boolean => {
  try {
    const url = new URL(link);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.hostname !== '';
  } catch {
    return false;
  }
};

/** The stored eBay listings of a part that carry their own price and a web link: the ones he may choose. A range with no per-listing price offers none. */
export function ebayListingChoices(part: Pick<PartRow, 'prices'>): EbayListingChoice[] {
  const ebay = part.prices.find((o) => o.kind === 'ebay_sold_new')?.ebay;
  if (!ebay?.linkPrices) return [];
  const out: EbayListingChoice[] = [];
  ebay.links.forEach((url, i) => {
    const price = ebay.linkPrices?.[i];
    if (typeof price === 'number' && Number.isFinite(price) && price > 0 && webLink(url)) out.push({ url, price });
  });
  return out;
}

/**
 * Whether the owner may confirm a price for a part now.
 * answer-first  the part's Amazon match is still a question in Review: no form, the question is the way forward
 * look-up-first the part has not been looked up on Amazon yet
 * amazon-counts an active Amazon New price counts already (a price may only be changed or removed when he has one)
 * open          the form is open
 */
export type ConfirmState = 'answer-first' | 'look-up-first' | 'amazon-counts' | 'open';

export function confirmState(part: Pick<PartRow, 'status' | 'availability' | 'asin' | 'price' | 'prices'>): ConfirmState {
  if (part.status === 'review') return 'answer-first';
  if (part.status === 'waiting' || part.status === 'unmatched') return 'look-up-first';
  const amazonCounts =
    part.availability === 'active' && part.asin !== null && part.price !== null && !part.prices.some((o) => o.kind === 'confirmed' && !o.reference);
  return amazonCounts ? 'amazon-counts' : 'open';
}

export const ANSWER_FIRST = 'Answer its question first. A price counts only after its Amazon listing is chosen.';
export const LOOK_UP_FIRST = 'Look this part up on Amazon first.';
export const AMAZON_COUNTS = 'This part counts at its Amazon price. A price you confirm counts only when the listing is not for sale.';

export type ConfirmTarget = { kind: 'part'; part: PartRow } | { kind: 'unnamed'; item: UnnamedItem };

/** A part of the bundle by model, or an item its kits list with no model number (its model starts with '~'). Case does not matter. */
export function confirmTarget(bundle: BundleRow, model: string): ConfirmTarget | null {
  const want = model.trim().toUpperCase();
  if (want === '') return null;
  const part = bundle.parts.find((p) => p.model.trim().toUpperCase() === want);
  if (part) return { kind: 'part', part };
  for (const option of bundle.options) {
    const item = option.unnamed?.find((u) => u.model.trim().toUpperCase() === want);
    if (item) return { kind: 'unnamed', item };
  }
  return null;
}

export interface ConfirmPriceInput {
  kind?: unknown;
  price?: unknown;
  url?: unknown;
  note?: unknown;
  /** kind 'suggested': the suggestion as the owner was shown it (PartRow.priceSuggestion). */
  suggestion?: unknown;
}

export type ConfirmPlan =
  | { ok: true; record: ConfirmedPrice }
  | { ok: false; code: 'bad_request' | 'not_found' | 'conflict'; message: string };

const refuse = (code: 'bad_request' | 'not_found' | 'conflict', message: string): ConfirmPlan => ({ ok: false, code, message });

/**
 * What the agent stores when the owner confirms a price on one part of a deal, or why it will not. Two kinds:
 * 'ebay-listing' takes a stored eBay listing of this part, by its link, and the price is that listing's own (a price
 * sent beside it must match); 'typed' takes a price and a link he typed. Nothing here makes up a figure (rule 4).
 */
export function planConfirmedPrice(bundle: BundleRow, model: string, input: ConfirmPriceInput, now: number): ConfirmPlan {
  const target = confirmTarget(bundle, model);
  if (!target) return refuse('not_found', 'No such part in this deal.');
  if (target.kind === 'part') {
    const state = confirmState(target.part);
    const holds = target.part.prices.some((o) => o.kind === 'confirmed');
    if (state === 'answer-first') return refuse('conflict', ANSWER_FIRST);
    if (state === 'look-up-first') return refuse('conflict', LOOK_UP_FIRST);
    if (state === 'amazon-counts' && !holds) return refuse('conflict', AMAZON_COUNTS);
  }
  const partModel = target.kind === 'part' ? target.part.model : target.item.model;
  if (input.kind === 'suggested') return planSuggested(bundle, target, input, now);
  if (input.kind !== 'ebay-listing' && input.kind !== 'typed') return refuse('bad_request', 'kind must be ebay-listing, typed or suggested.');
  let price = input.price;
  let link = input.url;
  if (input.kind === 'ebay-listing') {
    const wanted = typeof link === 'string' ? link.trim() : null;
    const chosen = wanted !== null && target.kind === 'part' ? ebayListingChoices(target.part).find((c) => c.url === wanted) : undefined;
    if (!chosen) return refuse('bad_request', 'That is not one of this part’s stored eBay listings.');
    if (price !== undefined && price !== null && price !== '') {
      const sent = typeof price === 'number' ? price : Number(price);
      if (!Number.isFinite(sent) || Math.round(sent * 100) !== Math.round(chosen.price * 100)) return refuse('bad_request', 'That price is not the one on the eBay listing.');
    }
    price = chosen.price;
    link = chosen.url;
  }
  const parsed = parseConfirmedPrice({ brand: bundle.brand, model: partModel, price, link, note: input.note }, now);
  if (typeof parsed === 'string') return refuse('bad_request', parsed);
  return { ok: true, record: parsed };
}

export const SUGGESTION_GONE = 'That suggestion is not the one the agent has for this part now. Look at the part again.';

/**
 * Suggested prices (Nov 23): the owner confirms the agent's one suggestion for a part. The suggestion is the one the part
 * carries now (PartRow.priceSuggestion, built from stored data), never the figure the client sends: the kind and the price
 * he was shown must equal it to the cent, or it is refused (a scan may have changed it). The record is an ordinary confirmed
 * price whose link is the suggestion's first linked evidence (the Amazon listing, or the eBay listing nearest the middle) and
 * whose `source` keeps what it rested on. It counts because he chose it, as any confirmed price (the PO, Nov 20).
 */
function planSuggested(bundle: BundleRow, target: ConfirmTarget, input: ConfirmPriceInput, now: number): ConfirmPlan {
  const live: PriceSuggestion | undefined = target.kind === 'part' ? target.part.priceSuggestion : undefined;
  if (!live) return refuse('conflict', 'This part has no suggested price now.');
  const sent = input.suggestion && typeof input.suggestion === 'object' ? (input.suggestion as Record<string, unknown>) : null;
  const sentPrice = typeof sent?.price === 'number' ? sent.price : Number.NaN;
  if (!sent || sent.kind !== live.kind || !Number.isFinite(sentPrice) || Math.round(sentPrice * 100) !== Math.round(live.price * 100)) {
    return refuse('conflict', SUGGESTION_GONE);
  }
  const link = live.evidence.find((e) => typeof e.url === 'string' && e.url !== '' && !/^Context:/.test(e.text))?.url;
  if (!link) return refuse('conflict', 'This suggestion has no listing to link the price to.');
  const parsed = parseConfirmedPrice({ brand: bundle.brand, model: (target as { part: PartRow }).part.model, price: live.price, link, note: input.note }, now);
  if (typeof parsed === 'string') return refuse('bad_request', parsed);
  return { ok: true, record: { ...parsed, source: { kind: live.kind, label: live.label, evidence: live.evidence.map((e) => ({ ...e })) } } };
}

/** The key to delete when the owner removes a part's confirmed price, or why not. */
export function planRemoveConfirmedPrice(bundle: BundleRow, model: string): { ok: true; key: string } | { ok: false; code: 'not_found'; message: string } {
  const target = confirmTarget(bundle, model);
  if (!target) return { ok: false, code: 'not_found', message: 'No such part in this deal.' };
  const holds = target.kind === 'part' ? target.part.prices.some((o) => o.kind === 'confirmed') : target.item.price !== null;
  if (!holds) return { ok: false, code: 'not_found', message: 'This part has no confirmed price.' };
  return { ok: true, key: partKey(bundle.brand, target.kind === 'part' ? target.part.model : target.item.model) };
}
