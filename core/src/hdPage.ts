// Read the fields we need from a Home Depot product page the user has open.
//
// Checked against the live page for item 328814689 on 2026-11-09: the page
// carries a schema.org Product block (JSON-LD) with price, model, store SKU and
// barcode, and its review data names the item ids of the component products.
//
// Reading the page the user is looking at costs no SerpApi searches.

import { toUpc12 } from './identifiers';

export interface HdProduct {
  retailer: 'homedepot';
  itemId: string | null;
  storeSku: string | null;
  model: string | null;
  brand: string | null;
  upc: string | null;
  price: number | null;
  regularPrice: number | null;
  title: string | null;
}

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const asStr = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
const asNum = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseProductJsonLd(product: unknown): HdProduct {
  const p = asObj(product);
  const offers = asObj(Array.isArray(p.offers) ? p.offers[0] : p.offers);
  const spec = asObj(offers.priceSpecification);
  const brand = typeof p.brand === 'object' ? asStr(asObj(p.brand).name) : asStr(p.brand);
  return {
    retailer: 'homedepot',
    itemId: asStr(p.productID),
    storeSku: asStr(p.sku),
    model: asStr(p.model),
    brand,
    upc: toUpc12(asStr(p.gtin13) ?? asStr(p.gtin12) ?? asStr(p.gtin)),
    price: asNum(offers.price),
    regularPrice: asNum(spec.price),
    title: asStr(p.name),
  };
}

/** Find the Product block among all JSON-LD blocks on a page. */
export function findProductBlock(jsonLdBlocks: unknown[]): unknown | null {
  for (const block of jsonLdBlocks.flat()) {
    const type = asObj(block)['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) return block;
  }
  return null;
}

const REVIEW_PRODUCT_ID = /\\?"ProductId\\?":\\?"(\d{6,12})\\?"/g;

/** Item ids of other products whose reviews are shown on this page. */
export function componentItemIds(pageHtml: string, ownItemId: string): string[] {
  const ids = new Set<string>();
  for (const m of pageHtml.matchAll(REVIEW_PRODUCT_ID)) if (m[1]) ids.add(m[1]);
  ids.delete(ownItemId);
  return [...ids].sort();
}
