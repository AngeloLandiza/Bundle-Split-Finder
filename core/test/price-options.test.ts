import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { listingFrom } from '../src/scan/listings';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { runPaid } from '../src/scan/paid';
import { buildReport } from '../src/scan/report';
import { partPricesWanted, runScan, savePartPrices, savePrice } from '../src/scan/runner';
import {
  bundleKey, DEFAULT_SCAN_SETTINGS, type PageOutcome, type PaidAction, PART_PRICE_READS_MAX, type PartPriceReading, partKey, type ReadPartPrices,
  type ScanSettings,
} from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import { parseAmazonSearch, parseBuyBox, parseBuyNew } from '../src/serpapi/parsers';
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
  policy?: BudgetPolicy;
  readPages?: (ids: string[]) => Promise<PageOutcome[]>;
  settings?: ScanSettings;
  shouldStop?: () => boolean;
}

function scan(w: World, opts: ScanOptions = {}) {
  const { budget, client } = clientFor(w, opts.policy);
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

type Answer = Omit<PartPriceReading, 'brand' | 'model'>;
const NOT_FOUND: Answer = { status: 'not_found', itemId: null, matchedModel: null, price: null, title: null, link: null };
const NOT_READ: Answer = { status: 'not_read', itemId: null, matchedModel: null, price: null, title: null, link: null };
/** A found reading of a RYOBI part whose page names its own model. */
const found = (model: string, itemId: string, price: number, title: string): PartPriceReading => ({
  brand: 'RYOBI', model, status: 'found', itemId, matchedModel: model, price, title, link: `https://www.homedepot.com/p/${itemId}`,
});

/**
 * A reader with the real reader's shape (extension/lib/hdReader.ts): one reading per part asked, in order; a part
 * `prices` does not hold comes back not_read with every figure null, as after a refusal or past the reader's cap.
 * Records what it was asked.
 */
function fakeReader(prices: Record<string, Answer>, asked: string[][] = []): ReadPartPrices {
  return async (parts) => {
    asked.push(parts.map((p) => partKey(p.brand, p.model)));
    return parts.map((p) => ({ ...(prices[partKey(p.brand, p.model)] ?? NOT_READ), brand: p.brand, model: p.model }));
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

  it("the page's Buy Box: its Buy New box, else its only offer (single_offer) when it names a price and a seller", () => {
    expect(parseBuyBox(recorded('amazon-product-B0B6Z2ZGVK'))).toEqual({ price: 160, soldBy: 'ArcianCo', shipsFrom: 'Amazon' });
    // Recorded: "$169.00", features.shipper_seller "thedealvalley" (heading "Shipper / Seller").
    expect(parseBuyBox(recorded('amazon-product-B0B3JWF5ZV'))).toEqual({ price: 169, soldBy: 'thedealvalley', shipsFrom: 'thedealvalley', singleOffer: true });
    expect(parseBuyBox({ purchase_options: { single_offer: { extracted_price: 169, features: {} } } })).toBeNull();
    expect(parseBuyBox({ purchase_options: { single_offer: { extracted_price: 0, features: { shipper_seller: { text: 'x' } } } } })).toBeNull();
    expect(parseBuyBox({})).toBeNull();
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

  it("a part matched to a bulk-packaged New listing says so (packaging: 'bulk'), so the panel can label it; its price counts as any New price", async () => {
    const w = await scanned();
    // Hand-made: the saved B0B3JWF5ZV row given the recorded P102 row's packaging words (B00S022L2A).
    const saved = (await w.store.getListing('B0B3JWF5ZV'))!;
    await w.store.putListing({ ...saved, title: `${saved.title} (Bulk Packaged)` });
    const row = await founderRow(w);
    const p25 = row.parts.find((p) => p.model === 'PBLRC25B')!;
    expect(p25).toMatchObject({ packaging: 'bulk', availability: 'active' });
    expect(p25.prices).toEqual([expect.objectContaining({ kind: 'amazon_new', condition: 'new', price: 169, reference: false })]);
    // A retail-boxed listing carries no packaging field.
    expect(row.parts.find((p) => p.model === 'PBLRC01B')).not.toHaveProperty('packaging');
    expect(row.range.amazonNew).toEqual({ cost: 189, netRevenue: 268.55, profit: 79.55, roi: 0.4209 });
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

  it("Verify saves the page's Buy Box on the listing; it is counted while no older than the featured price, and a later search row keeps it", async () => {
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
    // featured price and keeps the page's Buy Box, now older than it: shown for reference, not counted.
    w.clock = T0 + 2 * MINUTE;
    const row = parseAmazonSearch(recorded('amazon-search-PBLRC01B')).find((c) => c.asin === 'B0B6Z2ZGVK')!;
    await savePrice({ store: w.store }, 'B0B6Z2ZGVK', row, w.clock);
    await w.store.putListing(listingFrom(row, RATCHET.brands, w.clock, await w.store.getListing('B0B6Z2ZGVK'))!);
    expect((await w.store.getListing('B0B6Z2ZGVK'))!.buyBox).toMatchObject({ price: 160, soldBy: 'ArcianCo' });
    let b = await founderRow(w);
    expect(b.parts.find((p) => p.model === 'PBLRC01B')!.prices.map((o) => [o.kind, o.price, o.reference])).toEqual([
      ['amazon_buybox', 160, true],
      ['amazon_new', 146.94, false],
    ]);
    expect(b.range).toEqual({ lowest: b.estimate, amazonNew: b.estimate, highest: b.estimate });
    expect(b.range.amazonNew).toEqual({ cost: 189, netRevenue: 268.55, profit: 79.55, roi: 0.4209 });

    // Hand-made: the same box seen again with the featured price (as a second Verify would save it). Now it counts,
    // and the two ends of the range differ.
    const listing = (await w.store.getListing('B0B6Z2ZGVK'))!;
    await w.store.putListing({ ...listing, buyBox: { ...listing.buyBox!, seenAt: w.clock } });
    b = await founderRow(w);
    expect(b.parts.find((p) => p.model === 'PBLRC01B')!.prices.map((o) => [o.kind, o.price, o.reference])).toEqual([
      ['amazon_buybox', 160, false],
      ['amazon_new', 146.94, false],
    ]);
    expect(b.range.amazonNew).toBe(b.estimate);
    expect(b.range.lowest).toEqual(b.estimate);
    // 160 for PBLRC01B: 169 - 25.35 + 160 - 24 = 279.65.
    expect(b.range.highest).toEqual({ cost: 189, netRevenue: 279.65, profit: 90.65, roi: 0.4796 });
  });

  it("a page with one seller: its only offer is saved as the Buy Box and labelled so (singleOffer), sold and shipped by that seller", async () => {
    const w = await scanned();
    w.clock = T0 + MINUTE;
    await paid(w, VERIFY_25B);
    const at = (await w.store.getPrice('B0B3JWF5ZV'))!.checkedAt;
    expect((await w.store.getListing('B0B3JWF5ZV'))!.buyBox).toEqual({ price: 169, soldBy: 'thedealvalley', shipsFrom: 'thedealvalley', singleOffer: true, seenAt: at });
    const b = await founderRow(w);
    expect(b.parts[0]!.prices.map((o) => [o.kind, o.price, o.seller, o.shipsFrom, o.reference, o.singleOffer ?? null])).toEqual([
      ['amazon_new', 169, null, null, false, null],
      ['amazon_buybox', 169, 'thedealvalley', 'thedealvalley', false, true],
    ]);
    // The same price as the featured one: the range does not move.
    expect(b.range).toEqual({ lowest: b.estimate, amazonNew: b.estimate, highest: b.estimate });
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

describe("readPartPrices: Home Depot's price for a part sold alone, free, after the lookups (step 15), one part a call", () => {
  // The fake readings have the real reader's shape (extension/lib/hdReader.ts): one per part asked, in order, with a
  // status; the prices are made up.
  const HD = {
    'RYOBI:PBLRC25B': found('PBLRC25B', '320222321', 99, 'ONE+ HP 18V Brushless Cordless Extended Reach 3/8 in. Ratchet (Tool Only)'),
    'RYOBI:PBLRC01B': found('PBLRC01B', '320222322', 89, 'ONE+ HP 18V Brushless Cordless Extended Reach 1/4 in. Ratchet (Tool Only)'),
  };

  it("asks for every part of a resolved split, saves each in the part price store, never the catalog, and shows it for reference only", async () => {
    const asked: string[][] = [];
    const w = await scanned({ readPartPrices: fakeReader(HD, asked) });
    // Step 15: one part a call, so the step counts each part as it is read and the time limit holds between parts.
    expect(asked).toEqual([['RYOBI:PBLRC01B'], ['RYOBI:PBLRC25B']]);
    expect(await w.store.getPartPrice('RYOBI:PBLRC25B')).toEqual({
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', itemId: '320222321', matchedModel: 'PBLRC25B', price: 99,
      title: HD['RYOBI:PBLRC25B'].title, link: 'https://www.homedepot.com/p/320222321', seenAt: T0, checkedAt: T0,
    });
    // A price is not a splitting fact: the catalog is exactly what a scan with no reader leaves.
    expect(await w.store.listCatalog()).toEqual(await (await scanned()).store.listCatalog());
    expect((await w.store.listScans())[0]!.counts.partPricesRead).toBe(2);
    const b = await founderRow(w);
    expect(b.parts[0]!.prices.map((o) => [o.kind, o.price, o.seller, o.reference])).toEqual([
      ['amazon_new', 169, null, false],
      ['homedepot', 99, 'Home Depot', true],
    ]);
    expect(b.parts[0]!.prices[1]).toEqual({
      kind: 'homedepot', price: 99, condition: 'new', seller: 'Home Depot', shipsFrom: null, offers: null, asin: null,
      link: 'https://www.homedepot.com/p/320222321', seenAt: T0, reference: true,
    });
    // Never counted: each end of the range is today's estimate.
    expect(b.range).toEqual({ lowest: b.estimate, amazonNew: b.estimate, highest: b.estimate });
  });

  it('within freshnessMs a part read before is not asked again; after it, it is', async () => {
    const asked: string[][] = [];
    const w = await scanned({ readPartPrices: fakeReader(HD, asked) });
    w.clock = T0 + RATCHET.freshnessMs;
    await scan(w, { readPartPrices: fakeReader(HD, asked) });
    expect(asked).toHaveLength(2);
    w.clock = T0 + RATCHET.freshnessMs + 1;
    await scan(w, { readPartPrices: fakeReader(HD, asked) });
    expect(asked.flat()).toEqual(['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B', 'RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']);
  });

  it("not_read (the reader's nulls after a refusal, or past its cap) is never saved: a stored price stays, and the part is asked again", async () => {
    const asked: string[][] = [];
    const w = await scanned({ readPartPrices: fakeReader(HD, asked) });
    const before = await w.store.listPartPrices();
    w.clock = T0 + RATCHET.freshnessMs + 1;
    // The real reader's answer when Home Depot refused the first search: every part, every figure null, not_read.
    await scan(w, { readPartPrices: fakeReader({}, asked) });
    expect(await w.store.listPartPrices()).toEqual(before);
    expect((await w.store.listScans())[0]!.counts.partPricesRead).toBe(0);
    expect((await founderRow(w)).parts[0]!.prices.find((o) => o.kind === 'homedepot')).toMatchObject({ price: 99, seenAt: T0 });
    // The refusal came back on the first part, so nothing more was asked in that scan.
    expect(asked).toHaveLength(3);
    // Nothing was checked, so the next scan asks for both again.
    w.clock += MINUTE;
    await scan(w, { readPartPrices: fakeReader(HD, asked) });
    expect(asked.slice(3).flat()).toEqual(['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']);
  });

  it('not_found keeps a price read before, with its own time, and moves only the check', async () => {
    const w = await scanned({ readPartPrices: fakeReader(HD, []) });
    const later = T0 + RATCHET.freshnessMs + 1;
    w.clock = later;
    const asked: string[][] = [];
    await scan(w, { readPartPrices: fakeReader({ 'RYOBI:PBLRC25B': NOT_FOUND, 'RYOBI:PBLRC01B': NOT_FOUND }, asked) });
    expect(await w.store.getPartPrice('RYOBI:PBLRC25B')).toMatchObject({ price: 99, itemId: '320222321', seenAt: T0, checkedAt: later });
    expect((await founderRow(w)).parts[0]!.prices.find((o) => o.kind === 'homedepot')).toMatchObject({ price: 99, seenAt: T0 });
    // Checked, so not asked again within freshnessMs.
    w.clock = later + MINUTE;
    await scan(w, { readPartPrices: fakeReader(HD, asked) });
    expect(asked).toHaveLength(2);
  });

  it('partPriceReadsPerScan caps one call; the part left out is asked for next scan', async () => {
    const asked: string[][] = [];
    const settings = { ...RATCHET, partPriceReadsPerScan: 1 };
    const w = await scanned({ readPartPrices: fakeReader(HD, asked), settings });
    await scan(w, { readPartPrices: fakeReader(HD, asked), settings });
    await scan(w, { readPartPrices: fakeReader(HD, asked), settings });
    expect(asked).toEqual([['RYOBI:PBLRC01B'], ['RYOBI:PBLRC25B']]);
  });

  it("one cap: never more than PART_PRICE_READS_MAX parts in one scan, the most the extension's reader reads", async () => {
    expect(DEFAULT_SCAN_SETTINGS.partPriceReadsPerScan).toBe(PART_PRICE_READS_MAX);
    const w: World = { store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), clock: T0 };
    // Hand-made: one resolved bundle of 45 distinct tools, more than one call may ask for.
    const models = Array.from({ length: 45 }, (_, i) => `P${100 + i}`);
    await w.store.putBundle({
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 't', brand: 'RYOBI', model: 'PBIG', upc: null, price: 100, regularPrice: 150,
      percentOff: null, link: null, seenAt: T0, split: { components: models, status: 'resolved', notes: [] },
    });
    // The owner's answer keeps the split when the scan splits the bundle again.
    await w.store.putReview({
      id: `split:${bundleKey('1')}`, kind: 'split', subject: bundleKey('1'), brand: 'RYOBI', model: 'PBIG', title: 't', reason: 'r', candidates: [],
      choices: [models], openedAt: T0, answer: models.join(','), answeredAt: T0,
    });
    const asked: string[][] = [];
    // No search may be made: only the free passes run.
    const none = Object.fromEntries(models.map((m) => [partKey('RYOBI', m), NOT_FOUND]));
    await scan(w, { readPartPrices: fakeReader(none, asked), settings: { ...RATCHET, partPriceReadsPerScan: 100 }, policy: { reserve: 0, maxPerRun: 0 } });
    expect(asked.flat()).toHaveLength(PART_PRICE_READS_MAX);
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

  it('savePartPrices takes only parts asked for, once, with a known status and well-formed figures, and makes no catalog entry', async () => {
    const store = new MemoryScanStore();
    const asked = ['PCL235', 'PCL206', 'PBP004', 'PCG002', 'PCL265B', 'P119'].map((model) => ({ brand: 'RYOBI', model }));
    const saved = await savePartPrices(store, asked, [
      // Real readings (hd-part-prices-2026-11-18.json), one with an unsafe link and padded title.
      { ...found('pcl235', '318621812', 59, ' ONE+ 18V Cordless 1/4 in. Impact Driver (Tool Only) '), brand: 'ryobi', matchedModel: 'pcl235b', link: 'javascript:alert(1)' },
      { ...found('PCL235', '1', 1, 'second'), matchedModel: 'PCL235' },
      // Not found: a link or id it carries is not stored.
      { brand: 'RYOBI', model: 'PCL206', ...NOT_FOUND, itemId: '317987588', link: 'https://www.homedepot.com/p/317987588' },
      // Found with no price, or a page whose model is not the part's: says nothing.
      { ...found('PBP004', '315039435', 129, 'ONE+ 18V Lithium 4.0 Ah Battery'), price: -3 },
      { ...found('PCG002', '317225006', 34.97, 'ONE+ 18V Lithium-Ion Charger'), matchedModel: 'PCG002K' },
      // No status (an older reader), and not_read.
      { brand: 'RYOBI', model: 'PCL265B', itemId: '320222321', matchedModel: 'PCL265B', price: 99, title: 'x', link: null },
      { brand: 'RYOBI', model: 'P119', ...NOT_READ },
      { ...found('PCL515', '317987585', 89, 'not asked'), matchedModel: 'PCL515B' },
      'nonsense',
    ], T0);
    expect(saved).toBe(2);
    expect(await store.listPartPrices()).toEqual([
      {
        key: 'RYOBI:PCL206', brand: 'RYOBI', model: 'PCL206', itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: T0,
      },
      {
        key: 'RYOBI:PCL235', brand: 'RYOBI', model: 'PCL235', itemId: '318621812', matchedModel: 'PCL235B', price: 59,
        title: 'ONE+ 18V Cordless 1/4 in. Impact Driver (Tool Only)', link: null, seenAt: T0, checkedAt: T0,
      },
    ]);
    expect(await store.listCatalog()).toEqual([]);
  });

  it("a RYOBI part written two ways is asked for once; a price read from the twin's page says so (soldAs), an exact one is plain", async () => {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 't', brand: 'RYOBI', model: 'PCL235-PCL235B', upc: null, price: 100, regularPrice: 150,
      percentOff: null, link: null, seenAt: 1, split: { components: ['PCL235', 'PCL235B'], status: 'resolved', notes: [] },
    });
    expect((await partPricesWanted(store, RATCHET, T0)).map((p) => p.key)).toEqual(['RYOBI:PCL235']);
    // The validation set's reading of PCL235: Home Depot sells it alone as PCL235B (item 318621812, $59).
    await savePartPrices(store, [{ brand: 'RYOBI', model: 'PCL235' }], [
      { ...found('PCL235', '318621812', 59, 'ONE+ 18V Cordless 1/4 in. Impact Driver (Tool Only)'), matchedModel: 'PCL235B' },
    ], T0);
    expect(await partPricesWanted(store, RATCHET, T0)).toEqual([]);
    const row = (await buildReport(store, RATCHET)).bundles[0]!;
    expect(row.parts.map((p) => [p.model, p.prices.map((o) => [o.price, o.soldAs ?? null])])).toEqual([
      ['PCL235', [[59, 'PCL235B']]],
      ['PCL235B', [[59, null]]],
    ]);
  });
});
