import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { listingFrom } from '../src/scan/listings';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { runPaid } from '../src/scan/paid';
import { buildReport } from '../src/scan/report';
import { partPricesWanted, runScan, savePartPrices, savePrice } from '../src/scan/runner';
import {
  bundleKey, DEFAULT_SCAN_SETTINGS, type PageOutcome, type PaidAction, type PartPriceReading, partKey, type ReadPartPrices, type ScanSettings,
} from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import { parseAmazonSearch, parseBuyNew } from '../src/serpapi/parsers';
import * as fx from './fixtures';
import { recorded } from './recorded';

// Step 9, Phase 1 (docs/superpowers/plans/2026-11-18-step-9-find-profit.md, Task 1): every price known
// for a part, each labelled, and each way to sell's ROI at its lowest, Amazon New and highest. The PO's
// answer of Nov 18: only New listings count; Home Depot's price and Amazon's list price are shown for
// reference and never counted. Everything here is the replay of fixtures/recorded/ or the validation
// set's recorded responses. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 10, 12);
const MINUTE = 60_000;
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };
const OPEN: BudgetPolicy = { reserve: 0, maxPerRun: 10 };
const FOUNDER = bundleKey('328814689');
const VERIFY_01B: PaidAction = { kind: 'verify', brand: 'RYOBI', model: 'PBLRC01B', asin: 'B0B6Z2ZGVK' };
const VERIFY_25B: PaidAction = { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' };

interface World {
  store: MemoryScanStore;
  cache: MemoryCache;
  replay: Replay;
  clock: number;
}

function clientFor(w: World, policy: BudgetPolicy = OPEN) {
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), policy);
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: w.replay.fetchFn, now: () => w.clock });
  return { budget, client };
}

interface ScanOptions {
  readPartPrices?: ReadPartPrices;
  readPages?: (ids: string[]) => Promise<PageOutcome[]>;
  settings?: ScanSettings;
  shouldStop?: () => boolean;
}

function scan(w: World, opts: ScanOptions = {}) {
  const { budget, client } = clientFor(w);
  return runScan({
    client, budget, store: w.store, settings: opts.settings ?? RATCHET, now: () => w.clock, readPartPrices: opts.readPartPrices, readPages: opts.readPages,
    shouldStop: opts.shouldStop,
  });
}

const paid = (w: World, action: PaidAction) => {
  const { budget, client } = clientFor(w);
  return runPaid({ client, budget, store: w.store, now: () => w.clock, settings: RATCHET }, action);
};

/** The founder's ratchet bundle scanned: PBLRC25B on B0B3JWF5ZV ($169) and PBLRC01B on B0B6Z2ZGVK ($146.94), both probable. */
async function scanned(opts: ScanOptions = {}): Promise<World> {
  const w: World = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), clock: T0 };
  await scan(w, opts);
  return w;
}

/** A reader that answers from `prices` by part key and records what it was asked. */
function fakeReader(prices: Record<string, Omit<PartPriceReading, 'brand' | 'model'>>, asked: string[][] = []): ReadPartPrices {
  return async (parts) => {
    asked.push(parts.map((p) => partKey(p.brand, p.model)));
    return parts.flatMap((p) => {
      const found = prices[partKey(p.brand, p.model)];
      return found ? [{ brand: p.brand, model: p.model, ...found }] : [];
    });
  };
}

const founderRow = async (w: World) => (await buildReport(w.store, RATCHET)).bundles.find((b) => b.key === FOUNDER)!;

// ---------------------------------------------------------------- parsing

describe('the extra figures a response already carries', () => {
  it('a search row keeps its list price (extracted_old_price), and a row with none has none', () => {
    const rows = parseAmazonSearch(recorded('amazon-search-PCL206'));
    // "ONE+ 18V Cordless Reciprocating Saw ... PCL515B": $57.99, struck through $65.00.
    expect(rows.find((r) => r.asin === 'B0B88R7HWB')).toMatchObject({ price: 57.99, listPrice: 65 });
    // "PCL660B ONE+ 18V Cordless LED Flash Light (Tool Only)": $21.99 and no old price.
    expect(rows.find((r) => r.asin === 'B0B1GKJXNB')).not.toHaveProperty('listPrice');
  });

  it("a listing page's Buy New box: price, sold by and ships from; a page with one seller's box (single_offer) has none", () => {
    expect(parseBuyNew(recorded('amazon-product-B0B6Z2ZGVK'))).toEqual({ price: 160, soldBy: 'ArcianCo', shipsFrom: 'Amazon' });
    expect(parseBuyNew(recorded('amazon-product-B0B3JWF5ZV'))).toBeNull();
    expect(parseBuyNew({})).toBeNull();
    expect(parseBuyNew({ purchase_options: { buy_new: { extracted_price: 0 } } })).toBeNull();
  });
});

// ---------------------------------------------------------------- the report's prices

describe("a part's labelled prices", () => {
  it("today: the matched listing's featured price, counted, with a link and the time it was seen", async () => {
    const w = await scanned();
    const row = await founderRow(w);
    expect(row.parts.map((p) => [p.model, p.prices])).toEqual([
      ['PBLRC25B', [{
        kind: 'amazon_new', price: 169, condition: 'new', seller: null, shipsFrom: null, offers: null, asin: 'B0B3JWF5ZV',
        link: 'https://www.amazon.com/dp/B0B3JWF5ZV', seenAt: expect.any(Number), reference: false,
      }]],
      ['PBLRC01B', [expect.objectContaining({ kind: 'amazon_new', price: 146.94, asin: 'B0B6Z2ZGVK', reference: false })]],
    ]);
    expect(row.parts[0]!.prices[0]!.seenAt).toBe(row.parts[0]!.priceSeenAt);
  });

  it('every estimate is unchanged: amazonNew is the estimate, and with one counted price per part each end is it too', async () => {
    const w = await scanned();
    const report = await buildReport(w.store, RATCHET);
    const priced = report.bundles.filter((b) => b.estimate !== null);
    expect(priced.map((b) => b.model)).toEqual(['PBLRC2501SB', 'PBLRC01B-PBLRC25B']);
    for (const b of report.bundles) {
      expect(b.range).toEqual(b.options[0]?.range ?? { lowest: null, amazonNew: null, highest: null });
      for (const o of b.options) {
        expect(o.range.amazonNew).toBe(o.estimate);
        expect(o.range.lowest).toEqual(o.estimate);
        expect(o.range.highest).toEqual(o.estimate);
      }
    }
    expect((await founderRow(w)).range.amazonNew).toEqual({ cost: 189, netRevenue: 268.55, profit: 79.55, roi: 0.4209 });
  });

  it("Verify saves the page's Buy Box on the listing; it is counted, and a later search row keeps it", async () => {
    const w = await scanned();
    w.clock = T0 + MINUTE;
    await paid(w, VERIFY_01B);
    const at = (await w.store.getPrice('B0B6Z2ZGVK'))!.checkedAt;
    expect((await w.store.getListing('B0B6Z2ZGVK'))!.buyBox).toEqual({ price: 160, soldBy: 'ArcianCo', shipsFrom: 'Amazon', seenAt: at });
    const part = (await founderRow(w)).parts.find((p) => p.model === 'PBLRC01B')!;
    expect(part.prices.map((o) => [o.kind, o.price, o.seller, o.shipsFrom, o.reference])).toEqual([
      ['amazon_new', 160, null, null, false],
      ['amazon_buybox', 160, 'ArcianCo', 'Amazon', false],
    ]);

    // A later search row for the listing (the recorded lookup of PBLRC01B shows $146.94) changes the
    // featured price and keeps the page's Buy Box. Now the two ends of the range differ.
    w.clock = T0 + 2 * MINUTE;
    const row = parseAmazonSearch(recorded('amazon-search-PBLRC01B')).find((c) => c.asin === 'B0B6Z2ZGVK')!;
    await savePrice({ store: w.store }, 'B0B6Z2ZGVK', row, w.clock);
    await w.store.putListing(listingFrom(row, RATCHET.brands, w.clock, await w.store.getListing('B0B6Z2ZGVK'))!);
    expect((await w.store.getListing('B0B6Z2ZGVK'))!.buyBox).toMatchObject({ price: 160, soldBy: 'ArcianCo' });
    const b = await founderRow(w);
    expect(b.parts.find((p) => p.model === 'PBLRC01B')!.prices.map((o) => [o.kind, o.price])).toEqual([['amazon_buybox', 160], ['amazon_new', 146.94]]);
    expect(b.range.amazonNew).toEqual({ cost: 189, netRevenue: 268.55, profit: 79.55, roi: 0.4209 });
    expect(b.range.amazonNew).toBe(b.estimate);
    expect(b.range.lowest).toEqual(b.estimate);
    // 160 for PBLRC01B: 169 - 25.35 + 160 - 24 = 279.65.
    expect(b.range.highest).toEqual({ cost: 189, netRevenue: 279.65, profit: 90.65, roi: 0.4796 });
  });

  it('a page with no Buy New box leaves null on the listing, and nothing is counted from it', async () => {
    const w = await scanned();
    w.clock = T0 + MINUTE;
    await paid(w, VERIFY_25B);
    expect((await w.store.getListing('B0B3JWF5ZV'))!.buyBox).toBeNull();
    expect((await founderRow(w)).parts[0]!.prices.map((o) => o.kind)).toEqual(['amazon_new']);
  });

  it("an inactive listing's prices are shown but not counted: no featured price, and its Buy Box is not in the range", async () => {
    const w = await scanned();
    w.clock = T0 + MINUTE;
    await paid(w, VERIFY_01B);
    // A later check that did not see the listing's price: the part is inactive, as the estimate reads it.
    w.clock = T0 + 2 * MINUTE;
    await savePrice({ store: w.store }, 'B0B6Z2ZGVK', { asin: 'B0B6Z2ZGVK', title: 'x', price: null }, w.clock);
    const b = await founderRow(w);
    const part = b.parts.find((p) => p.model === 'PBLRC01B')!;
    expect(part.availability).toBe('inactive');
    expect(part.prices.map((o) => o.kind)).toEqual(['amazon_buybox']);
    expect(b.range.highest).toEqual(b.range.lowest);
  });
});

// ---------------------------------------------------------------- readPartPrices

describe("readPartPrices: Home Depot's price for a part sold alone, free, after the pages and before the lookups", () => {
  // The fake readings are the reader's contract (Task 2 builds the real reader); the prices are made up.
  const HD = {
    'RYOBI:PBLRC25B': { itemId: '320222321', price: 99, title: 'ONE+ HP 18V Brushless Cordless Extended Reach 3/8 in. Ratchet (Tool Only)', link: 'https://www.homedepot.com/p/320222321' },
    'RYOBI:PBLRC01B': { itemId: '320222322', price: 89, title: 'ONE+ HP 18V Brushless Cordless Extended Reach 1/4 in. Ratchet (Tool Only)', link: 'https://www.homedepot.com/p/320222322' },
  };

  it("asks for every part of a resolved split, saves each on the part's catalog entry, and shows it for reference only", async () => {
    const asked: string[][] = [];
    const w = await scanned({ readPartPrices: fakeReader(HD, asked) });
    expect(asked).toEqual([['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']]);
    expect((await w.store.getCatalogEntry('RYOBI:PBLRC25B'))!.hdPrice).toEqual({ ...HD['RYOBI:PBLRC25B'], readAt: T0 });
    const b = await founderRow(w);
    expect(b.parts[0]!.prices.map((o) => [o.kind, o.price, o.seller, o.reference])).toEqual([
      ['amazon_new', 169, null, false],
      ['homedepot', 99, 'Home Depot', true],
    ]);
    expect(b.parts[0]!.prices[1]).toMatchObject({ link: 'https://www.homedepot.com/p/320222321', seenAt: T0, asin: null, condition: 'new' });
    // Never counted: each end of the range is today's estimate.
    expect(b.range).toEqual({ lowest: b.estimate, amazonNew: b.estimate, highest: b.estimate });
  });

  it('within freshnessMs a part read before is not asked again; after it, it is', async () => {
    const asked: string[][] = [];
    const w = await scanned({ readPartPrices: fakeReader(HD, asked) });
    w.clock = T0 + RATCHET.freshnessMs;
    await scan(w, { readPartPrices: fakeReader(HD, asked) });
    expect(asked).toHaveLength(1);
    w.clock = T0 + RATCHET.freshnessMs + 1;
    await scan(w, { readPartPrices: fakeReader(HD, asked) });
    expect(asked).toEqual([['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B'], ['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']]);
  });

  it('partPriceReadsPerScan caps one call; the part left out is asked for next scan', async () => {
    const asked: string[][] = [];
    const settings = { ...RATCHET, partPriceReadsPerScan: 1 };
    const w = await scanned({ readPartPrices: fakeReader(HD, asked), settings });
    await scan(w, { readPartPrices: fakeReader(HD, asked), settings });
    await scan(w, { readPartPrices: fakeReader(HD, asked), settings });
    expect(asked).toEqual([['RYOBI:PBLRC01B'], ['RYOBI:PBLRC25B']]);
  });

  it('a reader that throws is noted, and the scan goes on to its lookups', async () => {
    const w = await scanned({ readPartPrices: async () => { throw new Error('the tab was closed'); } });
    const job = (await w.store.listScans())[0]!;
    expect(job.stopMessage).toContain('Reading Home Depot prices failed: the tab was closed');
    expect(job.counts.lookupsDone).toBe(2);
    expect((await founderRow(w)).estimate).not.toBeNull();
  });

  it('after Home Depot refused a page in the run, no price is read; nor once a stop was asked for', async () => {
    const asked: string[][] = [];
    await scanned({ readPartPrices: fakeReader(HD, asked), readPages: async (ids) => ids.map((itemId) => ({ itemId, kind: 'refused', status: 403 })) });
    let stop = false;
    await scanned({
      readPartPrices: fakeReader(HD, asked),
      readPages: async (ids) => {
        stop = true;
        return ids.map((itemId) => ({ itemId, kind: 'unreadable' }));
      },
      shouldStop: () => stop,
    });
    expect(asked).toEqual([]);
  });

  it('a listing row seen again keeps the price', async () => {
    const w = await scanned({ readPartPrices: fakeReader(HD, []) });
    // A catalog entry from a listing row: a Home Depot row for PBLRC25B, applied by a later scan.
    await w.store.putCatalogEntry({ ...(await w.store.getCatalogEntry('RYOBI:PBLRC25B'))!, seenAt: 0 });
    w.clock = T0 + 2 * 60 * MINUTE;
    await scan(w, { settings: { ...RATCHET, listingMaxAgeMs: 0 } });
    expect((await w.store.getCatalogEntry('RYOBI:PBLRC25B'))!.hdPrice).toMatchObject({ price: 99, readAt: T0 });
  });

  it('savePartPrices takes only parts asked for, once, and only well-formed figures; a part not found gets no new entry', async () => {
    const store = new MemoryScanStore();
    const asked = [{ brand: 'RYOBI', model: 'PCL235' }, { brand: 'RYOBI', model: 'PCL206' }, { brand: 'RYOBI', model: 'PBP004' }];
    await store.putCatalogEntry({ key: 'RYOBI:PBP004', brand: 'RYOBI', model: 'PBP004', title: 'ONE+ 18V Lithium 4.0 Ah Battery', kinds: ['battery'], isKit: false, upc: null, seenAt: 1 });
    const saved = await savePartPrices(store, asked, [
      { brand: 'ryobi', model: 'pcl235', itemId: '318621812', price: 59, title: ' ONE+ 18V Cordless 1/4 in. Impact Driver (Tool Only) ', link: 'javascript:alert(1)' },
      { brand: 'RYOBI', model: 'PCL235', itemId: '1', price: 1, title: 'second', link: null },
      { brand: 'RYOBI', model: 'PCL206', itemId: null, price: null, title: null, link: null },
      { brand: 'RYOBI', model: 'PBP004', itemId: '../x', price: -3, title: '', link: 'https://www.homedepot.com/p/315039435' },
      { brand: 'RYOBI', model: 'PCL515', itemId: '317987585', price: 89, title: 'not asked', link: null },
      'nonsense',
    ], T0);
    expect(saved).toBe(2);
    expect(await store.getCatalogEntry('RYOBI:PCL235')).toMatchObject({
      brand: 'RYOBI', model: 'PCL235', title: 'ONE+ 18V Cordless 1/4 in. Impact Driver (Tool Only)', kinds: ['impact driver'], isKit: false, itemId: '318621812',
      hdPrice: { itemId: '318621812', price: 59, title: 'ONE+ 18V Cordless 1/4 in. Impact Driver (Tool Only)', link: null, readAt: T0 },
    });
    expect(await store.getCatalogEntry('RYOBI:PCL206')).toBeUndefined();
    expect(await store.getCatalogEntry('RYOBI:PCL515')).toBeUndefined();
    expect((await store.getCatalogEntry('RYOBI:PBP004'))!.hdPrice).toEqual({
      itemId: null, price: null, title: null, link: 'https://www.homedepot.com/p/315039435', readAt: T0,
    });
  });

  it('a RYOBI part written two ways is asked for once, and a reading under either form shows for both (Ruling 70)', async () => {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 't', brand: 'RYOBI', model: 'PCL235-PCL235B', upc: null, price: 100, regularPrice: 150,
      percentOff: null, link: null, seenAt: 1, split: { components: ['PCL235', 'PCL235B'], status: 'resolved', notes: [] },
    });
    expect((await partPricesWanted(store, RATCHET, T0)).map((p) => p.key)).toEqual(['RYOBI:PCL235']);
    await savePartPrices(store, [{ brand: 'RYOBI', model: 'PCL235' }], [{ brand: 'RYOBI', model: 'PCL235', itemId: '318621812', price: 59, title: 'Impact Driver', link: null }], T0);
    expect(await partPricesWanted(store, RATCHET, T0)).toEqual([]);
    const row = (await buildReport(store, RATCHET)).bundles[0]!;
    expect(row.parts.map((p) => [p.model, p.prices.map((o) => o.price)])).toEqual([['PCL235', [59]], ['PCL235B', [59]]]);
  });
});
