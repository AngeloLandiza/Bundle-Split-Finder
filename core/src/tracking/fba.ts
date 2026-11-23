// The estimate with Amazon's FBA fee estimate per part (Keepa's fbaFees.pickAndPackFee, recorded in
// fixtures/keepa/product-*.json) in place of the flat fulfillment setting. Shown beside the estimate, never instead:
// it is still an estimate (rule 5), and a part with no Keepa fee keeps the flat setting.
//
// The report prices each part by its own single-part listing (report.ts listingFor), so a way to sell's net revenue
// is the sum of its counted parts' nets: swapping one part's fulfillment fee changes the net by exactly
// (flat fee - Keepa fee) times its quantity. Parts not counted (leftovers) are not touched.

import type { BundleResult, FeeSettings } from '../money';
import type { SaleOption } from '../scan/types';
import type { TrendLookup } from './signals';

export const FBA_FEE_LABEL = "Amazon's FBA fee estimate (Keepa)";

export interface FbaPartFee {
  model: string;
  qty: number;
  fee: number;
  source: 'keepa' | 'settings';
}

export interface FbaEstimate {
  label: string;
  estimate: BundleResult;
  parts: FbaPartFee[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Null when the way to sell has no estimate or no counted part has a Keepa FBA fee stored. */
export function fbaEstimateOf(option: SaleOption | undefined, trend: TrendLookup, fees: FeeSettings): FbaEstimate | null {
  const base = option?.estimate;
  if (!option || !base) return null;
  const left = new Set(option.leftovers.map((l) => l.replace(/ ×\d+$/, '')));
  const parts: FbaPartFee[] = [];
  let delta = 0;
  for (const p of option.parts) {
    if (left.has(p.model) || p.price === null) continue;
    const fee = p.asin ? trend(p.asin)?.fbaFee ?? null : null;
    if (fee === null || fee === undefined) {
      parts.push({ model: p.model, qty: p.qty, fee: fees.fulfillmentFee, source: 'settings' });
      continue;
    }
    parts.push({ model: p.model, qty: p.qty, fee, source: 'keepa' });
    delta += (fees.fulfillmentFee - fee) * p.qty;
  }
  if (!parts.some((p) => p.source === 'keepa')) return null;
  const netRevenue = round2(base.netRevenue + delta);
  const profit = round2(netRevenue - base.cost);
  return {
    label: FBA_FEE_LABEL,
    estimate: { cost: base.cost, netRevenue, profit, roi: base.cost ? Math.round((profit / base.cost) * 10_000) / 10_000 : 0 },
    parts,
  };
}
