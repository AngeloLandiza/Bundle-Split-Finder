import { describe, expect, it } from 'vitest';

import { buildResults, CacheOnlyClient, loadInputs, ResponsesCache, runValidationPipeline, validationFiles } from '../../scripts/validate-cli';

// Step 9, Phase 1: the validation set replayed with Home Depot's own prices for the parts sold alone,
// read in the owner's Chrome on Nov 18 (hd-part-prices-2026-11-18.json). No network.

async function replay() {
  const dir = 'fixtures/validation';
  const cache = new ResponsesCache(validationFiles(dir).responses);
  return runValidationPipeline({ inputs: loadInputs(dir), scanClient: new CacheOnlyClient(cache), lookupClient: new CacheOnlyClient(cache), continuePastMisses: true });
}

describe('the validation set, replayed with the Home Depot prices read on Nov 18', () => {
  it('every way to sell: amazonNew is its estimate, lowest <= amazonNew <= highest, and prices run highest first', async () => {
    const run = await replay();
    let options = 0;
    for (const b of run.report.bundles) {
      for (const o of b.options) {
        options += 1;
        expect(o.range.amazonNew).toBe(o.estimate);
        for (const p of o.parts) expect(p.prices.map((x) => x.price)).toEqual([...p.prices.map((x) => x.price)].sort((x, y) => y - x));
        if (o.estimate === null) {
          expect(o.range).toEqual({ lowest: null, amazonNew: null, highest: null });
          continue;
        }
        expect(o.range.lowest!.profit).toBeLessThanOrEqual(o.estimate.profit);
        expect(o.range.highest!.profit).toBeGreaterThanOrEqual(o.estimate.profit);
      }
    }
    expect(options).toBeGreaterThan(31);
  });

  it("PSK0114-PCL265B ($79): Home Depot's own prices of its parts are shown for reference and change no ROI", async () => {
    const run = await replay();
    const b = run.report.bundles.find((x) => x.model === 'PSK0114-PCL265B')!;
    const hd = new Map(b.options.flatMap((o) => o.parts).map((p) => [p.model, p.prices.filter((x) => x.kind === 'homedepot').map((x) => [x.price, x.reference, x.link])]));
    expect(hd.get('PCL265B')).toEqual([[99, true, 'https://www.homedepot.com/p/320222321']]);
    expect(hd.get('PSK0114')).toEqual([[153.97, true, 'https://www.homedepot.com/p/337695226']]);
    for (const o of b.options) expect([o.range.lowest, o.range.highest]).toEqual([o.estimate, o.estimate]);
  });

  it('the summary counts positive bundles at each end, and the parts with a Home Depot price', async () => {
    const results = await buildResults(await replay());
    expect(results.summary.positive).toEqual({ lowest: 1, amazonNew: 1, highest: 1 });
    expect(results.summary.hdPrices).toBe(136);
    expect(results.bundles.filter((b) => (b.roiRange.amazonNew ?? 0) > 0).map((b) => b.model)).toHaveLength(1);
  });
});
