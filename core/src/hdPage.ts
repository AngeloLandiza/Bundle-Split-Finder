// Read the fields we need from a Home Depot product page the user has open.
//
// Checked against the live page for item 328814689 on 2026-11-09: the page
// carries a schema.org Product block (JSON-LD) with price, model, store SKU and
// barcode, and its review data names the item ids of the component products.
//
// Reading the page the user is looking at costs no SerpApi searches.

import { toUpc12 } from './identifiers';
import type { PageSections, PageSpecification } from './research/types';

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
  const product = productState(text, itemId);
  return product === null ? null : contentOf(product);
}

/** The page's parsed `window.__APOLLO_STATE__=` object; null when there is none or it does not parse. */
function pageState(text: string): Json | null {
  const mark = text.indexOf(STATE_MARK);
  if (mark < 0) return null;
  const start = mark + STATE_MARK.length;
  if (text[start] !== '{') return null;
  const end = objectEnd(text, start);
  if (end < 0) return null;
  try {
    return asObj(JSON.parse(text.slice(start, end)));
  } catch {
    return null;
  }
}

/** The `base-catalog-<itemId>` object of the page's `window.__APOLLO_STATE__=` object; null when there is none or it does not parse. */
function productState(text: string, itemId: string): Json | null {
  const state = pageState(text);
  const product = state === null ? null : state[`base-catalog-${itemId}`];
  return product && typeof product === 'object' ? (product as Json) : null;
}

/** The bullets and description of a product object, as parseBundlePage gives them. */
function contentOf(product: Json): PageContent {
  const details = asObj(product.details);
  const attrs = Array.isArray(details.descriptiveAttributes) ? details.descriptiveAttributes : [];
  const bullets: string[] = [];
  for (const a of attrs) {
    const v = asObj(a).value;
    if (typeof v === 'string') bullets.push(v);
  }
  return { bullets, description: typeof details.description === 'string' ? details.description : null };
}

/** A Home Depot product page the owner has open, read from its embedded data (step 7). Never a search. */
export interface ProductPage {
  itemId: string;
  /** identifiers.brandName, trimmed. */
  brand: string;
  /** identifiers.modelNumber, trimmed. */
  model: string;
  /** identifiers.productLabel, trimmed; '' when the page gives none. */
  title: string;
  /** The pricing entry's `value`; null when the page gives none, or two pricing entries disagree. */
  price: number | null;
  /** The pricing entry's `original`, the was-price; null when the page gives none, or when `price` is null. */
  wasPrice: number | null;
  /** As parseBundlePage reads them. */
  bullets: string[];
  description: string | null;
}

/** A price as a pricing entry holds it: a positive number. Anything else is no price. */
const priceOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The price and was-price of a product object, from its keys that start with `pricing(` (captured
 * Nov 17: `pricing({"isBrandPricingPolicyCompliant":false,"storeId":"8119"})` holding `value` and
 * `original`). Entries that disagree give no price rather than a guess between them.
 */
function pricingOf(product: Json): { price: number | null; wasPrice: number | null } {
  const seen = Object.keys(product)
    .filter((k) => k.startsWith('pricing('))
    .map((k) => asObj(product[k]))
    .map((p) => ({ price: priceOf(p.value), wasPrice: priceOf(p.original) }));
  const first = seen[0];
  if (!first || first.price === null || seen.some((p) => p.price !== first.price || p.wasPrice !== first.wasPrice)) {
    return { price: null, wasPrice: null };
  }
  return first;
}

/** Trimmed, as the scan's parser reads a listing row's text; null when empty. */
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * What a product page says about itself, from the embedded data parseBundlePage reads. Null when that
 * data is missing or does not parse, holds no `base-catalog-<itemId>`, or names no brand or model.
 */
export function parseProductPage(text: string, itemId: string): ProductPage | null {
  const product = productState(text, itemId);
  if (product === null) return null;
  const ids = asObj(product.identifiers);
  const brand = nonEmpty(ids.brandName);
  const model = nonEmpty(ids.modelNumber);
  if (brand === null || model === null) return null;
  return { itemId, brand, model, title: nonEmpty(ids.productLabel) ?? '', ...pricingOf(product), ...contentOf(product) };
}

/**
 * The sections of the product in an Apollo state object (`window.__APOLLO_STATE__`, parsed), as the research contract
 * (research/types.ts) shapes them. Specifications are `specificationGroup[].specifications[].{specName, specValue}`
 * flattened in page order (checked against fixtures/homedepot-pages/research-2026-11-20.json); a page without the group
 * gives none. A page with no description gives ''. `itemId` names the product
 * to read; without it, the first `base-catalog-<itemId>` object is read. Null when the state holds no such product.
 */
export function parsePageState(state: unknown, itemId?: string): PageSections | null {
  const s = asObj(state);
  const key = itemId !== undefined ? `base-catalog-${itemId}` : Object.keys(s).find((k) => /^base-catalog-\d+$/.test(k));
  const product = key === undefined ? undefined : s[key];
  if (!product || typeof product !== 'object') return null;
  const ids = asObj((product as Json).identifiers);
  const groups = (product as Json).specificationGroup;
  const specifications: PageSpecification[] = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    const list = asObj(g).specifications;
    for (const sp of Array.isArray(list) ? list : []) {
      const name = nonEmpty(asObj(sp).specName);
      const value = asStr(asObj(sp).specValue)?.trim() ?? '';
      if (name !== null && value !== '') specifications.push({ name, value });
    }
  }
  const content = contentOf(product as Json);
  return {
    title: nonEmpty(ids.productLabel) ?? '',
    model: nonEmpty(ids.modelNumber) ?? '',
    bullets: content.bullets,
    description: content.description ?? '',
    specifications,
  };
}

/** As parsePageState, on the page text from `window.__APOLLO_STATE__=` on. Null when the data is missing or does not parse. */
export function parsePageSections(text: string, itemId?: string): PageSections | null {
  const state = pageState(text);
  return state === null ? null : parsePageState(state, itemId);
}

/** One product of a Home Depot search page. */
export interface SearchProduct { itemId: string; brand: string; model: string; title: string; url: string }

/**
 * The products of a search page's Apollo state: its `base-searchNav-<itemId>` entries, in page order (checked against
 * research-2026-11-20.json, where each holds `identifiers` brandName, productLabel, modelNumber and canonicalUrl).
 * Home Depot also returns unrelated products for a query it cannot answer; they are returned as they come, relevance
 * is the reader's to judge. An entry with no item id or no model is left out.
 */
export function parseSearchState(state: unknown, origin = 'https://www.homedepot.com'): SearchProduct[] {
  const out: SearchProduct[] = [];
  for (const [key, value] of Object.entries(asObj(state))) {
    const m = /^base-searchNav-(\d+)$/.exec(key);
    if (!m || !value || typeof value !== 'object') continue;
    const ids = asObj(asObj(value).identifiers);
    const model = nonEmpty(ids.modelNumber);
    if (model === null) continue;
    const itemId = m[1] as string;
    const path = nonEmpty(ids.canonicalUrl);
    out.push({
      itemId,
      brand: nonEmpty(ids.brandName) ?? '',
      model,
      title: nonEmpty(ids.productLabel) ?? '',
      url: `${origin}${path !== null && path.startsWith('/p/') ? path : `/p/${itemId}`}`,
    });
  }
  return out;
}

/** parseSearchState on a search page's text from `window.__APOLLO_STATE__=` on; null when the data is missing or does not parse. */
export function parseSearchText(text: string, origin?: string): SearchProduct[] | null {
  const state = pageState(text);
  return state === null ? null : parseSearchState(state, origin);
}
