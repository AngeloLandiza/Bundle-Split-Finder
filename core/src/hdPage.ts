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
  /**
   * Nov 25: the product's barcode as the page's own state gives it (barcodeOf), a 12-digit UPC-A. Absent when the page
   * gives none, or none that is a valid barcode. A way to find the product's Amazon listing, never proof of one.
   */
  upc?: string;
  /**
   * Nov 25: what the page states about buying the product (buyingOf). Absent when the page states none of it, and on a page
   * read before this existed.
   */
  buying?: BuyingFacts;
}

/**
 * Nov 25 (fixtures/homedepot-pages/availability-344305163-2026-11-25.json, read on the owner's Chrome): what a product
 * page's own first state says about buying it. Every field is null when the page does not state it; none is worked out.
 * What the page does NOT state, so the app must never say it: stock at a store and a delivery estimate (the page loads
 * them later, outside its first state).
 * - `buyable`, `discontinued`, `availability`: `availabilityType { buyable, discontinued, type }` (type "Online" in the record).
 * - `quantityLimit`: `info.quantityLimit` (3; the page shows "Limit 3 per order").
 * - `returnable`: `info.returnable` ("90-Day").
 * - `promotionStart`, `promotionEnd`: `pricing(...).promotion.dates` (MM/DD/YYYY on the page) as YYYY-MM-DD; null for a value
 *   that is not a real date in that form, and when the page's pricing entries disagree.
 */
export interface BuyingFacts {
  buyable: boolean | null;
  discontinued: boolean | null;
  availability: string | null;
  quantityLimit: number | null;
  returnable: string | null;
  promotionStart: string | null;
  promotionEnd: string | null;
}

/** "01/31/2027" -> "2027-01-31" when it is a real calendar date in Home Depot's MM/DD/YYYY form; anything else null. */
export function usDateOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  return m ? realDay(`${m[3]}-${m[1]}-${m[2]}`) : null;
}

/** A YYYY-MM-DD that is a real calendar date, else null. */
function realDay(v: unknown): string | null {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? (v as string) : null;
}

const NO_BUYING: BuyingFacts = { buyable: null, discontinued: null, availability: null, quantityLimit: null, returnable: null, promotionStart: null, promotionEnd: null };
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const shortText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v.trim().length <= 40 ? v.trim() : null);
const limitOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 9999 ? v : null);
const hasBuying = (b: BuyingFacts): boolean => (Object.keys(NO_BUYING) as (keyof BuyingFacts)[]).some((k) => b[k] !== null);

/**
 * What a product object states about buying it (BuyingFacts), from its `availabilityType`, `info` and the `promotion.dates` of
 * its `pricing(` entries. Undefined when it states none of them. A promotion's dates are read only when every pricing entry
 * names the same ones (as pricingOf reads the price); entries that disagree give none rather than a guess between them.
 */
export function buyingOf(product: Json): BuyingFacts | undefined {
  const a = asObj(product.availabilityType);
  const info = asObj(product.info);
  const dates = Object.keys(product)
    .filter((k) => k.startsWith('pricing('))
    .map((k) => asObj(asObj(asObj(product[k]).promotion).dates))
    .map((d) => ({ start: usDateOf(d.start), end: usDateOf(d.end) }));
  const first = dates[0];
  const agree = first !== undefined && dates.every((d) => d.start === first.start && d.end === first.end);
  const out: BuyingFacts = {
    buyable: boolOrNull(a.buyable), discontinued: boolOrNull(a.discontinued), availability: shortText(a.type),
    quantityLimit: limitOf(info.quantityLimit), returnable: shortText(info.returnable),
    promotionStart: agree ? first.start : null, promotionEnd: agree ? first.end : null,
  };
  return hasBuying(out) ? out : undefined;
}

/**
 * A BuyingFacts as a message or a stored record gives it (untrusted): each field of its kind or null, dates real
 * YYYY-MM-DD. Undefined when it is not an object or states nothing.
 */
export function cleanBuying(v: unknown): BuyingFacts | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Json;
  const out: BuyingFacts = {
    buyable: boolOrNull(o.buyable), discontinued: boolOrNull(o.discontinued), availability: shortText(o.availability),
    quantityLimit: limitOf(o.quantityLimit), returnable: shortText(o.returnable),
    promotionStart: realDay(o.promotionStart), promotionEnd: realDay(o.promotionEnd),
  };
  return hasBuying(out) ? out : undefined;
}

/**
 * Nov 25 (fixtures/homedepot-pages/identifiers-upc-316627328-2026-11-25.json): a product object's `identifiers.upc`
 * ("885911758215") and `identifiers.upcGtin13` ("0885911758215"), each normalised by toUpc12. Null when neither is a valid
 * barcode, or when the two disagree (no guess between them).
 */
export function barcodeOf(product: Json): string | null {
  const ids = asObj(product.identifiers);
  const codes = [toUpc12(asStr(ids.upc)), toUpc12(asStr(ids.upcGtin13))].filter((c): c is string => c !== null);
  const first = codes[0];
  return first !== undefined && codes.every((c) => c === first) ? first : null;
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
  const upc = barcodeOf(product);
  const buying = buyingOf(product);
  return { bullets, description: typeof details.description === 'string' ? details.description : null, ...(upc !== null ? { upc } : {}), ...(buying ? { buying } : {}) };
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
  /** As parseBundlePage reads it (barcodeOf); absent when the page gives no valid barcode. */
  upc?: string;
  /** As parseBundlePage reads it (buyingOf); absent when the page states none of it. */
  buying?: BuyingFacts;
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
 * gives none. Bullets are `details.highlights` (328690510: "Includes: 18V ONE+ 5-1/2 in. Circular Saw and 18V ONE+ Jig
 * Saw"), then the descriptive bullets parseBundlePage reads. A page with no description gives ''. `itemId` names the product
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
  // details.highlights first, as the page shows them above the descriptive bullets; a highlight that is also a bullet is read once.
  const raw = asObj((product as Json).details).highlights;
  const highlights = (Array.isArray(raw) ? raw : []).filter((h): h is string => typeof h === 'string' && h.trim() !== '' && !content.bullets.includes(h));
  return {
    title: nonEmpty(ids.productLabel) ?? '',
    model: nonEmpty(ids.modelNumber) ?? '',
    bullets: [...new Set(highlights), ...content.bullets],
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
export interface SearchProduct {
  itemId: string; brand: string; model: string; title: string; url: string;
  /**
   * Free scan, fix round (Nov 23, read live in the owner's Chrome): a listing entry carries the same `pricing(...)` entry a
   * product page does (`value`, `original`, `conditionalPromotions`). Present only when the entry has one: its price and
   * was-price as pricingOf reads them, and its BOGO promotions as bogoPromotionsOf reads them.
   */
  price?: number | null;
  wasPrice?: number | null;
  promotions?: PagePromotion[];
}

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
    const entry = asObj(value);
    const priced = Object.keys(entry).some((k) => k.startsWith('pricing('));
    const pricing = priced ? pricingOf(entry) : null;
    const promotions = priced ? Object.keys(entry).filter((k) => k.startsWith('pricing(')).flatMap((k) => bogoPromotionsOf(asObj(entry[k]).conditionalPromotions)) : [];
    out.push({
      itemId,
      brand: nonEmpty(ids.brandName) ?? '',
      model,
      title: nonEmpty(ids.productLabel) ?? '',
      url: `${origin}${path !== null && path.startsWith('/p/') ? path : `/p/${itemId}`}`,
      ...(pricing ? { price: pricing.price, wasPrice: pricing.wasPrice, promotions: promotions.filter((p, i) => promotions.findIndex((q) => q.promotionId === p.promotionId) === i) } : {}),
    });
  }
  return out;
}

/**
 * What a listing state held when it held no product we know how to read (fix round 2, Nov 23: the helper's answer for the
 * RYOBI query list held 36 entries of kinds such as "BundleI…", ROOT_QUERY and bare numeric ids). Not parsed for products:
 * kept so the real shape can be recorded as a fixture and read from that, never guessed. `kinds`: each key's kind (a run of
 * 5 or more digits written `#`, cut at its first `(` or `:`) with its count; `entries`: for up to SAMPLE_KINDS kinds, most
 * entries first, the first entry as JSON cut to SAMPLE_CHARS, with any property whose name looks like a credential dropped.
 */
export interface ListingSample {
  kinds: Record<string, number>;
  entries: { kind: string; key: string; text: string }[];
}

export const SAMPLE_KINDS = 3;
export const SAMPLE_CHARS = 1500;
const SECRET_NAME = /token|cookie|session|auth|secret|password|csrf/i;

const kindOf = (key: string): string => key.replace(/\d{5,}/g, '#').split(/[(:]/)[0]!.slice(0, 60);

/** Strings, numbers, booleans and nulls as they are; objects and arrays walked; a credential-looking property dropped. */
function scrubbed(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrubbed(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Json).filter(([k]) => !SECRET_NAME.test(k)).map(([k, x]) => [k, scrubbed(x, depth + 1)]));
  return null;
}

/** The sample of a state (ListingSample). */
export function sampleOf(state: Json): ListingSample {
  const kinds: Record<string, number> = {};
  const first = new Map<string, string>();
  for (const key of Object.keys(state)) {
    if (SECRET_NAME.test(key)) continue;
    const k = kindOf(key);
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (!first.has(k)) first.set(k, key);
  }
  const top = Object.entries(kinds).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, SAMPLE_KINDS);
  const entries = top.map(([kind]) => {
    const key = first.get(kind)!;
    return { kind, key: key.slice(0, 200), text: JSON.stringify(scrubbed(state[key])).slice(0, SAMPLE_CHARS) };
  });
  return { kinds, entries };
}

/**
 * A listing page's products from every `window.__APOLLO_STATE__=` block in its text (a page may carry more than one; the
 * first is not always the listing's), merged in page order, each item once. `stateKeys` and `kinds` say what the states
 * held when no product was found: the entries counted, and up to six distinct key kinds (the key up to its first `-` or
 * `(`), so an empty answer is said with what came back. Null when the text has no state that parses.
 */
export function parseListingText(text: string, origin?: string): {
  products: ListingProduct[]; stateKeys: number; kinds: string[];
  /** The first `"totalProducts":<n>` in the states (read live: the list's own count); null when there is none. */
  total: number | null;
  /** Only when the states held entries and no product. */
  sample?: ListingSample;
} | null {
  const kinds = new Set<string>();
  const merged: Json = {};
  let stateKeys = 0;
  let parsed = false;
  for (let at = text.indexOf(STATE_MARK); at >= 0; at = text.indexOf(STATE_MARK, at + STATE_MARK.length)) {
    const state = pageState(text.slice(at));
    if (state === null) continue;
    parsed = true;
    Object.assign(merged, state);
    for (const k of Object.keys(state)) {
      stateKeys += 1;
      if (kinds.size < 6) kinds.add(k.split(/[-(]/)[0] ?? k);
    }
  }
  if (!parsed) return null;
  // Parsed once over every block, so a set's BundleItems references resolve wherever they are.
  const products = parseListingState(merged, origin);
  const t = /"totalProducts":(\d{1,6})\b/.exec(text);
  const total = t ? Number(t[1]) : null;
  return { products, stateKeys, kinds: [...kinds], total, ...(products.length === 0 && stateKeys > 0 ? { sample: sampleOf(merged) } : {}) };
}

/** One item of a Home Depot set (`bundleItems`): its own item id and how many of it the set holds. */
export interface SetItemRef { itemId: string; quantity: number }

/**
 * A product of a listing page, model number or not (free scan, fix round 3). Home Depot's Bundle filter lists "sets"
 * (recorded: fixtures/homedepot-pages/bundle-list-ryobi-2026-11-23.json): `identifiers.productType` "CONFIGURABLE_BUNDLE",
 * `modelNumber` null (brandName sometimes null), canonicalUrl `/p/sets/<slug>/<itemId>`, `bundleFlag` true and
 * `bundleItems`: references to `BundleItems:<id>` entries `{id, quantity}`, Home Depot's own list of the set's items.
 */
export interface ListingProduct {
  itemId: string;
  /** identifiers.brandName, trimmed; '' when null. */
  brand: string;
  /** identifiers.modelNumber, trimmed; null when the entry has none (a set). */
  model: string | null;
  title: string;
  url: string;
  productType: string | null;
  bundleFlag: boolean;
  /** The set's items, resolved, in the entry's order; null when the entry lists none or one cannot be resolved. */
  bundleItems: SetItemRef[] | null;
  /** The entry's pricing (pricingOf), when it has a pricing entry. */
  price?: number | null;
  wasPrice?: number | null;
  /** The pricing entry's `promotion.dollarOff` and `percentageOff` (recorded: 41 and 24 on 344978523); null when absent. */
  dollarOff?: number | null;
  percentageOff?: number | null;
  promotions?: PagePromotion[];
}

const ITEM_ID = /^\d{6,12}$/;

/** A set's items from `bundleItems`: each a `{__ref: "BundleItems:<id>"}` resolved in the state, or the entry inline. */
function setItemsOf(raw: unknown, state: Json): SetItemRef[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: SetItemRef[] = [];
  for (const r of raw) {
    const ref = asObj(r).__ref;
    const e = typeof ref === 'string' ? asObj(state[ref]) : asObj(r);
    const id = asStr(e.id);
    const q = e.quantity;
    if (id === null || !ITEM_ID.test(id) || typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 20) return null;
    out.push({ itemId: id, quantity: q });
  }
  return out;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Every `base-searchNav-<itemId>` entry of a listing state, in state order, with or without a model number. */
export function parseListingState(state: unknown, origin = 'https://www.homedepot.com'): ListingProduct[] {
  const st = asObj(state);
  const out: ListingProduct[] = [];
  for (const [key, value] of Object.entries(st)) {
    const m = /^base-searchNav-(\d+)$/.exec(key);
    if (!m || !value || typeof value !== 'object') continue;
    const itemId = m[1] as string;
    const entry = asObj(value);
    const ids = asObj(entry.identifiers);
    const path = nonEmpty(ids.canonicalUrl);
    const pricingKeys = Object.keys(entry).filter((k) => k.startsWith('pricing('));
    const pricing = pricingKeys.length > 0 ? pricingOf(entry) : null;
    const promo = pricingKeys.length > 0 ? asObj(asObj(entry[pricingKeys[0]!]).promotion) : {};
    const promotions = pricingKeys.flatMap((k) => bogoPromotionsOf(asObj(entry[k]).conditionalPromotions));
    out.push({
      itemId,
      brand: nonEmpty(ids.brandName) ?? '',
      model: nonEmpty(ids.modelNumber),
      title: nonEmpty(ids.productLabel) ?? '',
      url: `${origin}${path !== null && path.startsWith('/p/') ? path : `/p/${itemId}`}`,
      productType: nonEmpty(ids.productType),
      bundleFlag: entry.bundleFlag === true,
      bundleItems: setItemsOf(entry.bundleItems, st),
      ...(pricing ? {
        price: pricing.price, wasPrice: pricing.wasPrice, dollarOff: numOrNull(promo.dollarOff), percentageOff: numOrNull(promo.percentageOff),
        promotions: promotions.filter((p, i) => promotions.findIndex((q) => q.promotionId === p.promotionId) === i),
      } : {}),
    });
  }
  return out;
}

/** parseSearchState on a search page's text from `window.__APOLLO_STATE__=` on; null when the data is missing or does not parse. */
export function parseSearchText(text: string, origin?: string): SearchProduct[] | null {
  const state = pageState(text);
  return state === null ? null : parseSearchState(state, origin);
}

// ---------------------------------------------------------------- BOGO promotions (Nov 23 recording)

/**
 * A "buy one, get one free" promotion on a product's pricing entry. Recorded Nov 23 (fixtures/homedepot-pages/
 * bogo-2026-11-23.json): `pricing(...).conditionalPromotions[]` with `experienceTag` "BOGO", `subExperienceTag`
 * "buyOneGetOne", a reward tier with `rewardPercent` 100, `dates.start`/`dates.end` as MM/DD/YYYY and
 * `description.shortDesc`. The eligible free tools are not on the page (`omsSkus` null).
 */
export interface PagePromotion {
  promotionId: string;
  /** dates.start as YYYY-MM-DD; null when the page gives none in the recorded form. */
  startsAt: string | null;
  /** dates.end as YYYY-MM-DD; null likewise. */
  endsAt: string | null;
  /** description.shortDesc, trimmed; null when absent. */
  description: string | null;
}

/** A product page with the BOGO promotions its pricing carries. */
export interface PromoPage extends ProductPage {
  promotions: PagePromotion[];
}

/** "01/31/2027" -> "2027-01-31"; anything else null. */
export function isoDateOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * The free-item promotions of one conditionalPromotions list: a BOGO tag, the buyOneGetOne sub-tag and a 100% reward,
 * all three, as recorded. Any other promotion (a percentage off, a "buy 2 save", a BOGO at less than 100%) is not one.
 */
export function bogoPromotionsOf(list: unknown): PagePromotion[] {
  const out: PagePromotion[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = asObj(raw);
    if (p.experienceTag !== 'BOGO' || p.subExperienceTag !== 'buyOneGetOne') continue;
    const tiers = asObj(p.reward).tiers;
    if (!Array.isArray(tiers) || !tiers.some((t) => asObj(t).rewardPercent === 100)) continue;
    const id = asStr(p.promotionId);
    if (id === null || !/^\d{1,12}$/.test(id) || out.some((o) => o.promotionId === id)) continue;
    const dates = asObj(p.dates);
    out.push({ promotionId: id, startsAt: isoDateOf(dates.start), endsAt: isoDateOf(dates.end), description: nonEmpty(asObj(p.description).shortDesc) });
  }
  return out;
}

/** parsePromoState on the page text from `window.__APOLLO_STATE__=` on. */
export function parsePromoPage(text: string, itemId: string): PromoPage | null {
  const state = pageState(text);
  return state === null ? null : parsePromoState(state, itemId);
}

/**
 * What parseProductPage reads, plus the page's BOGO promotions, from a parsed Apollo state. Every pricing entry must name
 * the same promotions; entries that disagree give none rather than a guess between them (as pricingOf does for the price).
 * Null as parseProductPage.
 */
export function parsePromoState(state: unknown, itemId: string): PromoPage | null {
  const raw = asObj(state)[`base-catalog-${itemId}`];
  if (!raw || typeof raw !== 'object') return null;
  const product = raw as Json;
  const ids = asObj(product.identifiers);
  const brand = nonEmpty(ids.brandName);
  const model = nonEmpty(ids.modelNumber);
  if (brand === null || model === null) return null;
  const lists = Object.keys(product)
    .filter((k) => k.startsWith('pricing('))
    .map((k) => bogoPromotionsOf(asObj(product[k]).conditionalPromotions));
  const first = lists[0] ?? [];
  const idsOf = (l: PagePromotion[]) => l.map((p) => p.promotionId).sort().join(',');
  const agree = lists.every((l) => idsOf(l) === idsOf(first));
  return {
    itemId, brand, model, title: nonEmpty(ids.productLabel) ?? '', ...pricingOf(product), ...contentOf(product),
    promotions: agree ? first : [],
  };
}
