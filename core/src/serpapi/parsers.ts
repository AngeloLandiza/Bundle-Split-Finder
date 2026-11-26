// Turn SerpApi responses into our own types.
//
// Field names are confirmed against the responses recorded in fixtures/recorded/ on 2026-11-09.
// Parsers are deliberately tolerant: a missing field becomes null, never a crash.

import { hdThumbnail, type HdProduct } from '../hdPage';
import { toUpc12 } from '../identifiers';
import type { Candidate } from '../match';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return v.trim() && Number.isFinite(n) ? n : null;
  }
  return null;
};

// ---------------------------------------------------------------- Home Depot search (engine=home_depot)

export interface HdListing {
  itemId: string;
  title: string;
  brand: string | null;
  model: string | null;
  price: number | null;
  regularPrice: number | null;
  percentOff: number | null;
  badge: string | null;
  link: string | null;
  /**
   * Nov 25: the product's picture on images.thdstatic.com: a SerpApi row's `thumbnails` (hdPage.ts hdThumbnail), a Chrome
   * list entry's `media` (hdPicture). Absent or null when the row gives none; a stored one is kept then.
   */
  image?: string | null;
}

export function parseHomeDepotSearch(json: unknown): { listings: HdListing[]; hasNextPage: boolean } {
  const j = obj(json);
  const listings: HdListing[] = [];
  for (const raw of arr(j.products)) {
    const p = obj(raw);
    const itemId = str(p.product_id);
    const title = str(p.title);
    if (!itemId || !title) continue;
    listings.push({
      itemId,
      title,
      brand: str(p.brand),
      model: str(p.model_number),
      price: num(p.price),
      regularPrice: num(p.price_was),
      percentOff: num(p.percentage_off),
      badge: str(p.price_badge),
      link: str(p.link),
      image: hdThumbnail(p.thumbnails),
    });
  }
  const next = obj(j.serpapi_pagination).next ?? obj(j.pagination).next;
  return { listings, hasNextPage: typeof next === 'string' && next.length > 0 };
}

// ---------------------------------------------------------------- Amazon search (engine=amazon)

export function parseAmazonSearch(json: unknown): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of arr(obj(json).organic_results)) {
    const r = obj(raw);
    const asin = str(r.asin);
    const title = str(r.title);
    if (!asin || !title) continue;
    // Step 9: the struck-through list price, only as its extracted number (recorded rows always carry both).
    const listPrice = num(r.extracted_old_price);
    out.push({
      asin,
      title,
      brand: cleanBrand(str(r.brand)),
      price: num(r.extracted_price) ?? num(r.price),
      reviews: num(r.reviews),
      sponsored: r.sponsored === true,
      image: str(r.thumbnail),
      ...(listPrice !== null && listPrice > 0 ? { listPrice } : {}),
    });
  }
  return out;
}

/** True when the response links a next page (serpapi_pagination.next). */
export function amazonHasNextPage(json: unknown): boolean {
  const next = obj(obj(json).serpapi_pagination).next;
  return typeof next === 'string' && next.length > 0;
}

// ---------------------------------------------------------------- Amazon product (engine=amazon_product)

const PART_KEYS = ['item_model_number', 'manufacturer_part_number', 'part_number', 'model_number', 'model_name'];

/** "Brand: RYOBI" and "Visit the RYOBI Store" both become "RYOBI". */
export function cleanBrand(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^brand:\s*/i, '').replace(/^visit the\s+/i, '').replace(/\s+store$/i, '').trim() || null;
}

export function parseAmazonProduct(json: unknown, asin: string): Candidate | null {
  const j = obj(json);
  const product = obj(j.product_results);
  const details = obj(j.product_details);
  const specs = obj(j.item_specifications);
  const title = str(product.title);
  if (!title) return null;

  let partNumber: string | null = null;
  for (const key of PART_KEYS) {
    partNumber = str(details[key]) ?? str(specs[key]);
    if (partNumber) break;
  }
  const upc = str(details.upc) ?? str(specs.upc);
  return {
    asin: str(product.asin) ?? asin,
    title,
    brand: cleanBrand(str(product.brand) ?? str(specs.brand) ?? str(details.brand)),
    partNumber: partNumber?.replace(/^#/, '') ?? null,
    // A detail page can list several barcodes separated by spaces.
    upcs: upc ? upc.split(/[\s,]+/).filter(Boolean) : [],
    price: num(product.extracted_price) ?? num(product.price),
    reviews: num(product.reviews),
  };
}

/** A feature of the "Buy New" box: `{ text }` on recorded pages, a bare string in `buy_used`. */
const featureText = (v: unknown): string | null => str(v) ?? str(obj(v).text);

/**
 * Step 9: the listing page's "Buy New" box (`purchase_options.buy_new`): price, sold by, ships from.
 * Null when the page has none: a page with one seller shows `single_offer` instead (parseBuyBox).
 */
export function parseBuyNew(json: unknown): { price: number; soldBy: string | null; shipsFrom: string | null } | null {
  const box = obj(obj(obj(json).purchase_options).buy_new);
  const price = num(box.extracted_price) ?? num(box.price);
  if (price === null || price <= 0) return null;
  const features = obj(box.features);
  return { price, soldBy: featureText(features.sold_by), shipsFrom: featureText(features.ships_from) };
}

/**
 * Step 9: the page's Buy New box (parseBuyNew), else its only offer (`purchase_options.single_offer`) when it
 * names a price and a seller. The recorded B0B3JWF5ZV page shows one: $169, `features.shipper_seller`
 * "thedealvalley" (heading "Shipper / Seller"), so that seller both sells and ships it. Null when neither.
 */
export function parseBuyBox(json: unknown): { price: number; soldBy: string | null; shipsFrom: string | null; singleOffer?: true } | null {
  const buyNew = parseBuyNew(json);
  if (buyNew !== null) return buyNew;
  const offer = obj(obj(obj(json).purchase_options).single_offer);
  const price = num(offer.extracted_price) ?? num(offer.price);
  const seller = featureText(obj(offer.features).shipper_seller)?.trim() || null;
  if (price === null || price <= 0 || seller === null) return null;
  return { price, soldBy: seller, shipsFrom: seller, singleOffer: true };
}

// ---------------------------------------------------------------- Home Depot product (engine=home_depot_product)

export function parseHomeDepotProduct(json: unknown): HdProduct | null {
  const p = obj(obj(json).product_results);
  const itemId = str(p.product_id);
  const title = str(p.title);
  if (!itemId || !title) return null;
  return {
    retailer: 'homedepot',
    itemId,
    storeSku: str(p.store_sku_number),
    model: str(p.model_number),
    brand: str(obj(p.brand).name) ?? str(p.brand),
    upc: toUpc12(str(p.upc)),
    price: num(p.price),
    regularPrice: num(obj(p.promotion).original),
    title,
  };
}
