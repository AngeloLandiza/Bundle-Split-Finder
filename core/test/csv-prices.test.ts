import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { bundlesCsv, RUN_COLUMNS } from '../src/scan/csv';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan, savePrice } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, partKey, type PartPriceReading, type ReadPartPrices, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import * as fx from './fixtures';
import { recorded } from './recorded';

// Step 9, Task 3: the run file gains the ROI range and the parts' Home Depot total. Replayed data; no network.

const T0 = Date.UTC(2026, 10, 10, 12);
const MINUTE = 60_000;
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };
const FOUNDER = bundleKey('328814689');

const HD: Record<string, Omit<PartPriceReading, 'brand' | 'model'>> = {
  'RYOBI:PBLRC25B': { status: 'found', matchedModel: 'PBLRC25B', itemId: '320222321', price: 99, title: 'Ratchet 3/8 (Tool Only)', link: 'https://www.homedepot.com/p/320222321' },
  'RYOBI:PBLRC01B': { status: 'found', matchedModel: 'PBLRC01B', itemId: '320222322', price: 89, title: 'Ratchet 1/4 (Tool Only)', link: 'https://www.homedepot.com/p/320222322' },
};
const reader =
  (prices: typeof HD): ReadPartPrices =>
  async (parts) =>
    parts.flatMap((p) => {
      const found = prices[partKey(p.brand, p.model)];
      return found ? [{ brand: p.brand, model: p.model, ...found }] : [];
    });

async function world(readPartPrices?: ReadPartPrices) {
  const w = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), clock: T0 };
  const clientFor = () => {
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 10 });
    return { budget, client: new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: w.replay.fetchFn, now: () => w.clock }) };
  };
  await runScan({ ...clientFor(), store: w.store, settings: RATCHET, now: () => w.clock, readPartPrices });
  return { ...w, clientFor };
}

/** The last four cells of the first row: numbers or empty, so none holds a comma. */
const newCells = (csv: string): string[] => csv.trimEnd().split('\n')[1]!.split(',').slice(-4);
const founderOf = async (store: MemoryScanStore) => (await buildReport(store, RATCHET)).bundles.find((b) => b.key === FOUNDER)!;

describe('CSV: roi_lowest, roi_amazon_new, roi_highest, hd_price_total', () => {
  it('are the last four columns, and the columns before them are the ones the file always had, in order', () => {
    expect(RUN_COLUMNS.slice(-4)).toEqual(['roi_lowest', 'roi_amazon_new', 'roi_highest', 'hd_price_total']);
    expect(RUN_COLUMNS.slice(0, -4)).toEqual([
      'section', 'brand', 'bundle_model', 'bundle_title', 'hd_item_id', 'hd_price', 'hd_was_price', 'hd_percent_off',
      'parts', 'asins', 'match_grades', 'amazon_prices', 'est_net_revenue', 'est_cost', 'est_profit', 'est_roi',
      'uncovered_parts', 'hd_link', 'sold_as', 'other_options',
    ]);
  });

  it("writes the range's three ROIs and the sum of the parts' Home Depot prices", async () => {
    const w = await world(reader(HD));
    // A Buy Box read after PBLRC01B's last featured price ($146.94) counts: here $160, so the two ends now differ.
    w.clock = T0 + MINUTE;
    const row = parseAmazonSearch(recorded('amazon-search-PBLRC01B')).find((c) => c.asin === 'B0B6Z2ZGVK')!;
    await savePrice({ store: w.store }, 'B0B6Z2ZGVK', row, w.clock);
    const listing = (await w.store.getListing('B0B6Z2ZGVK'))!;
    await w.store.putListing({ ...listing, buyBox: { price: 160, soldBy: 'ArcianCo', shipsFrom: 'Amazon', seenAt: T0 + 2 * MINUTE } });

    const founder = await founderOf(w.store);
    const csv = bundlesCsv([founder]);
    // est_roi (the Amazon New figure) is unchanged, and equal to roi_amazon_new.
    expect(newCells(csv)).toEqual(['0.4209', '0.4209', '0.4796', '188']);
    expect(csv.split('\n')[1]).toContain(',79.55,0.4209,');
  });

  it('counts a part sold twice twice in the total', async () => {
    const w = await world(reader(HD));
    const founder = await founderOf(w.store);
    const twice = { ...founder, parts: founder.parts.map((p, i) => (i === 0 ? { ...p, qty: 2 } : p)) };
    // PBLRC25B is first: 2 x 99 + 89.
    expect(newCells(bundlesCsv([twice]))[3]).toBe('287');
  });

  it("leaves the total empty when any part has no Home Depot price: a sum of some parts would read as the bundle's", async () => {
    const w = await world(reader({ 'RYOBI:PBLRC25B': HD['RYOBI:PBLRC25B']! }));
    expect(newCells(bundlesCsv([await founderOf(w.store)]))).toEqual(['0.4209', '0.4209', '0.4209', '']);
  });

  it('leaves the total empty with no reader, and the three ROIs empty without an estimate', async () => {
    const w = await world();
    const report = await buildReport(w.store, RATCHET);
    const founder = report.bundles.find((b) => b.key === FOUNDER)!;
    expect(newCells(bundlesCsv([founder]))).toEqual(['0.4209', '0.4209', '0.4209', '']);
    const none = { ...founder, estimate: null, range: { lowest: null, amazonNew: null, highest: null } };
    expect(newCells(bundlesCsv([none]))).toEqual(['', '', '', '']);
    const unknown = report.bundles.find((b) => b.section === 'split');
    if (unknown) expect(newCells(bundlesCsv([unknown]))).toEqual(['', '', '', '']);
  });
});
