// Turn SerpApi responses into our own types.
//
// IMPORTANT: field names here come from SerpApi's documentation (2026-11-09),
// not from recorded live responses. The first development step is to record
// real responses into fixtures/recorded/ and confirm every field below.
// Parsers are deliberately tolerant: a missing field becomes null, never a crash.

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
    out.push({
      asin,
      title,
      price: num(r.extracted_price) ?? num(r.price),
      reviews: num(r.reviews),
      sponsored: r.sponsored === true,
    });
  }
  return out;
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
