// Rows for the tracking tests. The bundle is the recorded DCK200D1P1W921B listing (fixtures/recorded/hd-bundles-dewalt-p1.json:
// $299, was $538, 44% off, item 337440459); the Keepa figures are the recorded product response
// (fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json: DCF921B is B09M3TL9BB, monthlySold 600, pick-and-pack
// $7.60; DCB606 is B01H9BL8EO, monthlySold 1000, $7.10). Amazon prices are the scenario's: Keepa's recording has none
// (history=0, no stats).

import { readFileSync } from 'node:fs';

import { parseProductResponse } from '../src/keepa/parse';
import { partTrendFromProduct, type PartTrend } from '../src/keepa/trends';
import { amazonNet, bundleProfit, DEFAULT_FEES } from '../src/money';
import type { BundleRow, PartRow, ReportSection, SaleOption } from '../src/scan/types';
import type { TrendLookup } from '../src/tracking/signals';

const body = JSON.parse(readFileSync(new URL('../../fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB.json', import.meta.url), 'utf8')) as Record<string, unknown>;
export const RECORDED_TRENDS: Map<string, PartTrend> = new Map(parseProductResponse(body).products.map((p) => [p.asin, partTrendFromProduct(p, 1_000)]));
export const recordedTrend: TrendLookup = (asin) => RECORDED_TRENDS.get(asin);

export const ASIN = { DCF921B: 'B09M3TL9BB', DCB606: 'B01H9BL8EO' } as const;

export function part(model: string, asin: string | null, price: number | null, qty = 1, status: PartRow['status'] = 'matched'): PartRow {
  return {
    model, qty, status, availability: asin && price !== null ? 'active' : asin ? 'inactive' : 'missing', asin, grade: null, price,
    priceSeenAt: price === null ? null : 1_000, image: null, title: null, packaging: undefined,
    prices: price === null ? [] : [{ kind: 'amazon_new', price, condition: 'new', seller: null, shipsFrom: null, offers: null, asin, link: null, seenAt: 1_000, reference: false }],
  } as PartRow;
}

export function option(id: string, bundlePrice: number | null, parts: PartRow[], leftovers: string[] = []): SaleOption {
  const priced = parts.filter((p) => p.price !== null);
  const estimate = bundlePrice === null ? null : bundleProfit(bundlePrice, priced.reduce((a, p) => a + amazonNet(p.price!, DEFAULT_FEES) * p.qty, 0), DEFAULT_FEES);
  return { id, label: id === 'whole' ? '' : id, splitKits: [], parts, estimate, leftovers, loose: false, range: { lowest: estimate, amazonNew: estimate, highest: estimate } };
}

/** DCK200D1P1W921B with the given ways to sell; the first is the primary. */
export function bundle(options: SaleOption[], over: Partial<BundleRow> = {}): BundleRow {
  const primary = options[0];
  const section: ReportSection = over.section ?? 'confirmed';
  return {
    key: 'DEWALT:DCK200D1P1W921B', itemId: '337440459', brand: 'DEWALT', model: 'DCK200D1P1W921B',
    title: 'ATOMIC 20-Volt Lithium-Ion Cordless 2-Tool Combo Kit, Brushless 1/2 in. Impact Wrench', link: 'https://www.homedepot.com/p/337440459',
    price: 299, regularPrice: 538, percentOff: 44, seenAt: 1_000, status: 'complete', section,
    parts: primary?.parts ?? [], estimate: primary?.estimate ?? null, uncovered: [], answer: null, options, kitsNotRead: [],
    range: primary?.range ?? { lowest: null, amazonNew: null, highest: null },
    ...over,
  };
}
