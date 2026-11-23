// Phase 0: compare SerpApi searches per part vs Keepa tokens on recorded validation ASINs.

import type { CatalogModel } from '../decompose';
import { grade } from '../match';
import { wantedFor } from '../scan/classify';
import { parseProductResponse } from './parse';

export interface KeepaMeasureRow {
  asin: string;
  partNumber: string | null;
  keepaTokensPerProduct: number;
  serpApiSearchesTypical: number;
  gradeWithPartNumber: string | null;
}

const SEARCH_PLUS_PRODUCT = 2;

/** Tokens for a batch product request (1 per ASIN, base plan). */
export function keepaTokensForProducts(asinCount: number): number {
  return Math.max(0, asinCount);
}

/**
 * On a recorded Keepa product fixture, show part numbers and what grade the matcher would assign
 * when only the Keepa title and partNumber are known (no SerpApi page).
 */
export function measureKeepaFixture(
  body: Record<string, unknown>,
  catalog: { brand: string; model: string },
): KeepaMeasureRow[] {
  const parsed = parseProductResponse(body);
  const tokensEach = parsed.meta.tokensConsumed > 0
    ? parsed.meta.tokensConsumed / Math.max(1, parsed.products.length)
    : 1;
  const cat = new Map<string, CatalogModel>([[catalog.model, { model: catalog.model, brand: catalog.brand, kinds: [] }]]);
  const want = wantedFor(catalog.brand, catalog.model, cat);
  return parsed.products.map((p) => {
    const cand = {
      asin: p.asin,
      title: p.title ?? '',
      brand: p.brand ?? null,
      partNumber: p.partNumber ?? null,
      upcs: [] as string[],
      price: null,
      reviews: null,
    };
    const g = grade(want, cand);
    return {
      asin: p.asin,
      partNumber: p.partNumber ?? null,
      keepaTokensPerProduct: tokensEach,
      serpApiSearchesTypical: SEARCH_PLUS_PRODUCT,
      gradeWithPartNumber: g.grade,
    };
  });
}