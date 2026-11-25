// Nov 25: a part's barcode as a way to FIND its Amazon listing, never as proof of one. Pure.
//
// Home Depot's own page states each product's barcode (hdPage.ts barcodeOf), and Keepa's Product request takes `code` in
// place of `asin` (Keepa's Java client, Request.getProductByCodeRequest: "We currently allow UPC, EAN and ISBN-13 codes",
// "Multiple ASINs can have the same product code, so requesting a product code can return multiple products"). The
// products a code request returns are candidates exactly as a term search's are: the matcher and the listing ladder judge
// each, unchanged. Whether a product's own catalog barcodes (upcList / eanList) hold the part's is recorded beside that
// judgement (scan/barcodeLookup.ts), so the rule "same barcode" can be measured later from real data before it decides
// anything: the answer keys hold too few Home Depot barcodes to measure it at zero wrong now.
//
// What a code request costs is not documented in anything read; it is learned from each response's `tokensConsumed`
// (learnCodeCost), never assumed. What a no-match response looks like is not documented either: no `products`, or an empty
// list, is no product.

import { toUpc12 } from '../identifiers';
import type { KeepaProduct } from './types';

/** Whether one of the product's catalog barcodes (upcList, eanList, gtinList), normalised, is `code` (a 12-digit UPC-A). */
export function holdsBarcode(p: Pick<KeepaProduct, 'upcList' | 'eanList' | 'gtinList'>, code: string): boolean {
  const want = toUpc12(code);
  if (want === null) return false;
  return [...(p.upcList ?? []), ...(p.eanList ?? []), ...(p.gtinList ?? [])].some((c) => toUpc12(c) === want);
}

/**
 * What one lookup's code request found (SearchResult.barcode). `via` says what supplied the candidates the lookup returned:
 * 'code' when the code's products left something the matcher keeps, 'search' when the term search ran after it.
 */
export interface BarcodeLookup {
  /** The part's barcode as asked, a 12-digit UPC-A. */
  code: string;
  via: 'code' | 'search';
  /** Each product the code request returned, and whether its own catalog barcodes hold the part's (holdsBarcode). */
  products: { asin: string; sameBarcode: boolean }[];
  /** Tokens Keepa counted for the code request (0 from the cache), and for the term search after it. */
  codeTokens: number;
  searchTokens: number;
}

/** What code requests have cost, from their responses: requests, codes asked, tokens consumed, the most one code cost. */
export interface KeepaCodeCost {
  requests: number;
  codes: number;
  tokens: number;
  /** The highest tokens-per-code of any one response: what the next request is held to (KeepaClient.codeEstimate). */
  maxPerCode: number;
}

/** The cost learned so far plus one response of `codes` codes that consumed `tokens`. */
export function learnCodeCost(prev: KeepaCodeCost | null, codes: number, tokens: number): KeepaCodeCost {
  const n = Math.max(1, codes);
  const t = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  return {
    requests: (prev?.requests ?? 0) + 1,
    codes: (prev?.codes ?? 0) + n,
    tokens: (prev?.tokens ?? 0) + t,
    maxPerCode: Math.max(prev?.maxPerCode ?? 0, t / n),
  };
}

/** How many code answers are kept as samples: the first ones, so the next fix is written from real data. */
export const CODE_SAMPLES_MAX = 3;
/** The products a sample keeps, and the characters of a title in it. */
export const CODE_SAMPLE_PRODUCTS = 3;
const TITLE_CHARS = 200;
const LIST_MAX = 10;
const KEYS_MAX = 80;
/** A property whose name looks like a credential is never kept (as hdPage.ts sampleOf). */
const SECRET_NAME = /key|token(?!sLeft|sConsumed)|cookie|session|auth|secret|password|csrf/i;

/**
 * One code answer as kept for later reading (runtime, the audit export): what was asked, what it cost, the answer's
 * top-level field names, and up to CODE_SAMPLE_PRODUCTS products with their identity fields only, each bounded. Never the
 * request's address (it carries the key) and never a field whose name looks like a credential.
 */
export interface KeepaCodeSample {
  at: string;
  codes: string[];
  tokensConsumed: number | null;
  tokensLeft: number | null;
  refillRate: number | null;
  /** The answer's top-level field names. */
  fields: string[];
  /** How many products came back; null when the answer had no `products` field at all. */
  productCount: number | null;
  /** The first product's field names (what a code answer's product carries). */
  productFields: string[];
  products: {
    asin: string | null; title: string | null; brand: string | null; manufacturer: string | null; partNumber: string | null; model: string | null;
    upcList: string[]; eanList: string[];
  }[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const short = (v: unknown, n = 80): string | null => (typeof v === 'string' ? v.slice(0, n) : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, LIST_MAX).map((x) => x.slice(0, 20)) : []);
const names = (o: Record<string, unknown>): string[] => Object.keys(o).filter((k) => !SECRET_NAME.test(k)).slice(0, KEYS_MAX).map((k) => k.slice(0, 40));

/** The bounded sample of one code answer (KeepaCodeSample). */
export function codeSampleOf(body: Record<string, unknown>, codes: readonly string[], at: number): KeepaCodeSample {
  const raw = Array.isArray(body.products) ? body.products.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object') : null;
  return {
    at: new Date(at).toISOString(),
    codes: codes.slice(0, LIST_MAX).map((c) => c.slice(0, 20)),
    tokensConsumed: num(body.tokensConsumed),
    tokensLeft: num(body.tokensLeft),
    refillRate: num(body.refillRate),
    fields: names(body),
    productCount: raw === null ? null : raw.length,
    productFields: raw && raw[0] ? names(raw[0]) : [],
    products: (raw ?? []).slice(0, CODE_SAMPLE_PRODUCTS).map((p) => ({
      asin: short(p.asin, 20), title: short(p.title, TITLE_CHARS), brand: short(p.brand), manufacturer: short(p.manufacturer),
      partNumber: short(p.partNumber, 40), model: short(p.model, 40), upcList: list(p.upcList), eanList: list(p.eanList),
    })),
  };
}

/** The samples kept: the first CODE_SAMPLES_MAX answers; later ones are not added. */
export const keepCodeSample = (kept: readonly KeepaCodeSample[] | undefined, s: KeepaCodeSample): KeepaCodeSample[] =>
  (kept ?? []).length >= CODE_SAMPLES_MAX ? [...(kept ?? [])] : [...(kept ?? []), s];
