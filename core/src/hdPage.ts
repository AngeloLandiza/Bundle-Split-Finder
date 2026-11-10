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

/** What a bundle's own Home Depot page says, read from its embedded data. */
export interface PageContent {
  /** details.descriptiveAttributes[].value, in page order, exactly as the page gives them. */
  bullets: string[];
  /** details.description; null when absent. Stored for review; not used to split. */
  description: string | null;
}

const STATE_MARK = 'window.__APOLLO_STATE__=';

/** End index (exclusive) of the JSON object starting at `start`, matching braces outside strings; -1 if it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Null when the text has no `window.__APOLLO_STATE__=` object, it does not parse, or it has no `base-catalog-<itemId>`. */
export function parseBundlePage(text: string, itemId: string): PageContent | null {
  const mark = text.indexOf(STATE_MARK);
  if (mark < 0) return null;
  const start = mark + STATE_MARK.length;
  if (text[start] !== '{') return null;
  const end = objectEnd(text, start);
  if (end < 0) return null;
  let state: unknown;
  try {
    state = JSON.parse(text.slice(start, end));
  } catch {
    return null;
  }
  const product = asObj(state)[`base-catalog-${itemId}`];
  if (!product || typeof product !== 'object') return null;
  const details = asObj(asObj(product).details);
  const attrs = Array.isArray(details.descriptiveAttributes) ? details.descriptiveAttributes : [];
  const bullets: string[] = [];
  for (const a of attrs) {
    const v = asObj(a).value;
    if (typeof v === 'string') bullets.push(v);
  }
  return { bullets, description: typeof details.description === 'string' ? details.description : null };
}
