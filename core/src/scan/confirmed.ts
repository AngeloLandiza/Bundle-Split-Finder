// A sell price the owner confirms by hand, with a link to the listing that shows it.
// The worker stores only what this accepts. Nothing here searches or guesses a price.

import { partKey, type ConfirmedPrice } from './types';

const PRICE_MAX = 100_000;
/** A model number. A leftover's page text is longer, so the model field has its own cap. */
export const CONFIRMED_BRAND_MAX = 40;
export const CONFIRMED_MODEL_MAX = 120;
const LINK_MAX = 2_000;

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
  input: { brand: unknown; model: unknown; price: unknown; link: unknown },
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
  const brandUp = brand.toUpperCase();
  const modelUp = model.toUpperCase();
  return { key: partKey(brandUp, modelUp), brand: brandUp, model: modelUp, price, link: url.toString(), confirmedAt };
}
