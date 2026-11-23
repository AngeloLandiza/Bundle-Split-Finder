import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { parseProductResponse } from '../src/keepa/parse';
import { partTrendFromProduct } from '../src/keepa/trends';
import { DEFAULT_FEES } from '../src/money';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport, estimateBasis, type KeepaFees } from '../src/scan/report';
import { bundleKey, DEFAULT_SCAN_SETTINGS } from '../src/scan/types';
import { fbaEstimateOf } from '../src/tracking/fba';

// Signals round 2: every estimate on the owner's app left out Amazon's fulfillment fee (fees.fulfillmentFee was the $0
// default). With fees.fulfillmentSource 'keepa' (the default), a part's fee is Amazon's FBA pick-and-pack fee Keepa stored
// for its listing, else the flat fee. Replayed on the owner's third real scan (fixtures/e2e-2026-11-23/after-scan3) with the
// FBA fees his app had stored from Keepa (store/tracking.json `derived.fba`, source 'keepa'), and on the recorded product
// response (fixtures/keepa/product-…-stats.json). No network.

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan3');
const FLAT = { ...DEFAULT_SCAN_SETTINGS, fees: { ...DEFAULT_FEES, fulfillmentSource: 'flat' as const } };

/** The Keepa FBA fees the owner's app had stored, by ASIN (through the stored matches: model -> ASIN). */
async function storedFees(): Promise<Map<string, number>> {
  const tracking = JSON.parse(readFileSync(join(DIR, 'store', 'tracking.json'), 'utf8')) as { derived: { fba: Record<string, { parts: { model: string; fee: number; source: string }[] }> } };
  const asinOf = new Map((await (await loadScanFolder(DIR)).listMatches()).flatMap((m) => (m.asin ? [[m.model, m.asin] as const] : [])));
  const out = new Map<string, number>();
  for (const f of Object.values(tracking.derived.fba)) for (const p of f.parts) if (p.source === 'keepa' && asinOf.has(p.model)) out.set(asinOf.get(p.model)!, p.fee);
  return out;
}

describe("Keepa's FBA fee in the main estimate, on the owner's third real scan", () => {
  it('3 estimates above zero at a flat $0 fulfillment become 0 with the 3 FBA fees Keepa had stored', async () => {
    const fees = await storedFees();
    expect([...fees]).toEqual([['B0DSCG26GL', 15.01], ['B0BSJ97BSR', 7.6], ['B09SNK2SBL', 41.53]]);
    const store = await loadScanFolder(DIR);
    const before = (await buildReport(store, FLAT)).bundles.filter((b) => b.estimate !== null);
    const after = (await buildReport(store, DEFAULT_SCAN_SETTINGS, { trend: (a): KeepaFees | undefined => (fees.has(a) ? { fbaFee: fees.get(a)! } : undefined) })).bundles.filter((b) => b.estimate !== null);
    expect(before.filter((b) => b.estimate!.profit > 0).map((b) => b.model)).toEqual(['PCL1201K2-PCL424B', 'PCL1201K2-P755', 'PCL1201K2-PCL445B']);
    expect(after.filter((b) => b.estimate!.profit > 0)).toEqual([]);
    expect(after).toHaveLength(before.length);

    // The best before: $179, +$6.63 at $0 fulfillment. PCL1201K2's listing takes Keepa's $15.01; PCL424B has none stored.
    const row = after.find((b) => b.model === 'PCL1201K2-PCL424B')!;
    expect(row.estimate!.profit).toBe(-8.38);
    expect(row.parts.map((p) => [p.model, p.fees])).toEqual([
      ['PCL1201K2', { fulfillment: 15.01, fulfillmentFrom: 'keepa', referralRate: 0.15, referralFrom: 'flat' }],
      ['PCL424B', { fulfillment: 0, fulfillmentFrom: 'flat', referralRate: 0.15, referralFrom: 'flat' }],
    ]);
    expect(estimateBasis(DEFAULT_SCAN_SETTINGS.fees, row.parts)).toBe(
      "15% referral (at least $0.30); Amazon's FBA fee from Keepa for 1 of 2 parts ($15.01), your flat $0.00 for PCL424B; 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.",
    );
    // The "FBA estimate (Keepa)" line beside it adds nothing: the estimate already used the one fee stored.
    expect(fbaEstimateOf(row.options[0], (a) => (fees.has(a) ? { asin: a, amazonPrice: null, salesRank: null, offerCount: null, pulledAt: 1, fbaFee: fees.get(a)! } : undefined), DEFAULT_SCAN_SETTINGS.fees)).toBeNull();
  });

  it('with the flat choice the basis is the settings in words, as before', async () => {
    const row = (await buildReport(await loadScanFolder(DIR), FLAT)).bundles.find((b) => b.model === 'PCL1201K2-PCL424B')!;
    expect(row.estimate!.profit).toBe(6.63);
    expect(estimateBasis(FLAT.fees, row.parts)).toBe('15% referral (at least $0.30), $0.00 fulfillment, 0% tax, $0.00 inbound. An estimate from your fee settings, not your real Amazon fees.');
  });
});

describe("Keepa's referral rate, only when the owner chooses it", () => {
  // The recorded stats pull: B0BGYFTPGK (RYOBI PCL235B) at $44.89 lowest New, referralFeePercentage 12, pick-and-pack $8.02.
  const body = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'keepa', 'product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json'), 'utf8')) as Record<string, unknown>;
  const trend = partTrendFromProduct(parseProductResponse(body).products.find((p) => p.asin === 'B0BGYFTPGK')!, 1_000);

  async function pcl235b(): Promise<MemoryScanStore> {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('318621812'), retailer: 'homedepot', itemId: '318621812', title: 'RYOBI ONE+ 18V Impact Driver', brand: 'RYOBI', model: 'PCL235B',
      upc: null, price: 9, regularPrice: 79, percentOff: 89, link: null, seenAt: 1_000, split: { components: ['PCL235B'], status: 'resolved', notes: [] },
    });
    await store.putMatch({ key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', status: 'matched', asin: 'B0BGYFTPGK', grade: 'strong', alternatives: [], decidedBy: 'auto', updatedAt: 1_000, waitingSince: null });
    await store.putPrice({ asin: 'B0BGYFTPGK', price: 44.89, reviews: null, seenAt: 1_000, checkedAt: 1_000 });
    return store;
  }

  it("the owner's 15% stays unless he picks Keepa's; then 12% for this listing", async () => {
    const store = await pcl235b();
    const own = (await buildReport(store, DEFAULT_SCAN_SETTINGS, { trend: () => trend })).bundles[0]!;
    // $44.89 - $6.73 (15%) - $8.02 = $30.14; - $9 = $21.14.
    expect(own.estimate!.profit).toBe(21.14);
    const keepaRef = { ...DEFAULT_SCAN_SETTINGS, fees: { ...DEFAULT_FEES, referralSource: 'keepa' as const } };
    const row = (await buildReport(store, keepaRef, { trend: () => trend })).bundles[0]!;
    // $44.89 - $5.39 (12%) - $8.02 = $31.48; - $9 = $22.48.
    expect(row.estimate!.profit).toBe(22.48);
    expect(estimateBasis(keepaRef.fees, row.parts)).toBe(
      "Keepa's referral rate for 1 of 1 part (12%), at least $0.30; Amazon's FBA fee from Keepa for 1 of 1 part ($8.02); 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.",
    );
  });

  it('no trend stored: every part takes the flat settings, and the basis says none was stored', async () => {
    const row = (await buildReport(await pcl235b(), DEFAULT_SCAN_SETTINGS)).bundles[0]!;
    expect(row.estimate!.profit).toBe(29.16);
    expect(estimateBasis(DEFAULT_SCAN_SETTINGS.fees, row.parts)).toBe(
      '15% referral (at least $0.30); no FBA fee from Keepa stored for the 1 part yet, so your flat $0.00 fulfillment; 0% tax; $0.00 inbound. An estimate, not your real Amazon fees.',
    );
  });
});
