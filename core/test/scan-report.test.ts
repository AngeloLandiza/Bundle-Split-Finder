import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { bundlesCsv, csvLine, REVIEW_COLUMNS, reviewCsv, RUN_COLUMNS, runCsv } from '../src/scan/csv';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type BundleRecord, partKey, type ReviewItem, type ScanSettings } from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

// Every search here goes through the real SerpApiClient and SearchBudget over the
// replay of fixtures/recorded/. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 9, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, queries: [{ q: 'ryobi extended reach ratchet' }] };
const OPEN: BudgetPolicy = { reserve: 0, maxPerRun: 10 };

async function scanWorld(policy: BudgetPolicy = OPEN) {
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), policy);
  const client = new SerpApiClient({
    apiKey: 'TEST',
    budget,
    cache: new MemoryCache(),
    fetchFn: replayRecorded().fetchFn,
    now: () => T0,
  });
  await runScan({ client, budget, store, settings: RATCHET, now: () => T0 });
  return store;
}

describe('buildReport', () => {
  it("ranks the founder's bundle first with an estimate", async () => {
    const store = await scanWorld();
    const report = await buildReport(store, RATCHET);
    expect(report.bundles.map((b) => [b.model, b.status])).toEqual([
      ['PBLRC2501SB', 'complete'], ['PBLRC01B-PBLRC25B', 'complete'],
      ['PBLRC25B-PBP004', 'needs_review'], ['PBLRC01B-PBP004', 'needs_review'], ['PCL280B-PSK005', 'needs_review'],
      ['PCL280B-PSK014', 'needs_review'], ['PBLRC2501SB-A13401', 'needs_review'], ['PCL280B-RHMTS12601', 'needs_review'],
    ]);
    expect(report.bundles.map((b) => [b.model, b.section])).toEqual([
      ['PBLRC2501SB', 'confirmed'], ['PBLRC01B-PBLRC25B', 'confirmed'],
      ['PBLRC25B-PBP004', 'split'], ['PBLRC01B-PBP004', 'split'], ['PCL280B-PSK005', 'split'],
      ['PCL280B-PSK014', 'split'], ['PBLRC2501SB-A13401', 'split'], ['PCL280B-RHMTS12601', 'split'],
    ]);
    expect(report.bundles[0]!.parts.map((p) => p.availability)).toEqual(['active', 'active']);
    expect(report.bundles[0]).toMatchObject({
      itemId: '328814689', price: 189, regularPrice: 338, uncovered: [],
      estimate: { cost: 189, netRevenue: 268.55, profit: 79.55, roi: 0.4209 },
      parts: [
        { model: 'PBLRC25B', qty: 1, status: 'matched', asin: 'B0B3JWF5ZV', grade: 'probable', price: 169 },
        { model: 'PBLRC01B', qty: 1, status: 'matched', asin: 'B0B6Z2ZGVK', grade: 'probable', price: 146.94 },
      ],
    });
    expect(report.bundles[1]!.estimate).toMatchObject({ cost: 348, profit: -79.45 });
    expect(report.review).toHaveLength(6);
  });

  it("shows the picture of each part's saved listing", async () => {
    const store = await scanWorld();
    const report = await buildReport(store, RATCHET);
    const parts = report.bundles[0]!.parts;
    expect(parts.map((p) => p.asin)).toEqual(['B0B3JWF5ZV', 'B0B6Z2ZGVK']);
    for (const p of parts) {
      expect(p.image).toEqual(expect.any(String));
      expect(p.image!.length).toBeGreaterThan(0);
      expect(p.image).toBe((await store.getListing(p.asin!))!.image);
    }
  });

  it('writes one bundle as the run file does: the same header and the same row', async () => {
    const report = await buildReport(await scanWorld(), RATCHET);
    const lines = runCsv(report).split('\n');
    expect(bundlesCsv(report.bundles)).toBe(runCsv(report));
    expect(bundlesCsv([report.bundles[1]!])).toBe(`${lines[0]}\n${lines[2]}\n`);
  });

  it("shows the title of each part's saved listing, and none when the listing is not saved", async () => {
    const store = await scanWorld();
    const parts = (await buildReport(store, RATCHET)).bundles[0]!.parts;
    for (const p of parts) {
      expect(p.title).toEqual(expect.any(String));
      expect(p.title!.length).toBeGreaterThan(0);
      expect(p.title).toBe((await store.getListing(p.asin!))!.title);
    }
    const waiting = (await buildReport(await scanWorld({ reserve: 0, maxPerRun: 2 }), RATCHET)).bundles.find((b) => b.model === 'PBLRC2501SB')!;
    expect(waiting.parts.find((p) => p.model === 'PBLRC25B')!.title).toBeNull();
  });

  it('gives a part no picture when its listing is not saved, or it has no listing', async () => {
    const report = await buildReport(await scanWorld({ reserve: 0, maxPerRun: 2 }), RATCHET);
    const first = report.bundles.find((b) => b.model === 'PBLRC2501SB')!;
    expect(first.parts.find((p) => p.model === 'PBLRC25B')).toMatchObject({ asin: null, image: null });
    // A matched ASIN that no saved listing holds.
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 'T', brand: 'RYOBI', model: 'A', upc: null,
      price: 100, regularPrice: 200, percentOff: 50, link: null, seenAt: T0,
      split: { components: ['A'], status: 'resolved', notes: [] },
    });
    await store.putMatch({ key: partKey('RYOBI', 'A'), brand: 'RYOBI', model: 'A', status: 'matched', asin: 'B000000001', grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
    expect((await buildReport(store, RATCHET)).bundles[0]!.parts[0]).toMatchObject({ asin: 'B000000001', image: null });
  });

  it('calls a bundle partial when a part has no priced listing', async () => {
    const store = await scanWorld({ reserve: 0, maxPerRun: 2 });
    const report = await buildReport(store, RATCHET);
    const first = report.bundles.find((b) => b.model === 'PBLRC2501SB')!;
    expect(first.status).toBe('partial');
    expect(first.uncovered).toEqual(['PBLRC25B']);
    // The waiting part has not been looked up, so there is no estimate (it used to be valued at the liquidation rate).
    expect(first.estimate).toBeNull();
    expect(first.parts.find((p) => p.model === 'PBLRC25B')).toMatchObject({ status: 'waiting', asin: null });
    expect(first.section).toBe('missing_listing');
    expect(first.parts.find((p) => p.model === 'PBLRC25B')!.availability).toBe('missing');
    expect(first.parts.find((p) => p.model === 'PBLRC01B')!.availability).toBe('active');
  });

  it('puts a bundle in inactive_listing when the last check did not see a part', async () => {
    const store = await scanWorld();
    await store.putPrice({ asin: 'B0B3JWF5ZV', price: 169, reviews: 221, seenAt: T0, checkedAt: T0 + 86_400_000 });
    const report = await buildReport(store, RATCHET);
    const first = report.bundles.find((b) => b.model === 'PBLRC2501SB')!;
    expect(first).toMatchObject({ section: 'inactive_listing', status: 'partial', uncovered: ['PBLRC25B'] });
    expect(first.estimate!.netRevenue).toBe(124.9);
    expect(first.parts.find((p) => p.model === 'PBLRC25B')).toMatchObject({ availability: 'inactive', price: 169, asin: 'B0B3JWF5ZV' });
    expect(report.bundles.some((b) => b.section === 'confirmed')).toBe(false);
    expect(report.bundles.slice(0, 2).map((b) => b.model)).toEqual(['PBLRC2501SB', 'PBLRC01B-PBLRC25B']);
  });

  async function oneBundleStore(price: { asin: string; price: number | null; reviews: number | null; seenAt: number | null; checkedAt: number } | null) {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 'T', brand: 'RYOBI', model: 'A', upc: null,
      price: 100, regularPrice: 200, percentOff: 50, link: null, seenAt: T0,
      split: { components: ['A'], status: 'resolved', notes: [] },
    });
    await store.putMatch({ key: partKey('RYOBI', 'A'), brand: 'RYOBI', model: 'A', status: 'matched', asin: 'B000000001', grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
    if (price) await store.putPrice(price);
    return store;
  }

  async function nullPriceStore(matchB: boolean) {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('2'), retailer: 'homedepot', itemId: '2', title: 'T', brand: 'RYOBI', model: 'A-B', upc: null,
      price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0,
      split: { components: ['A', 'B'], status: 'resolved', notes: [] },
    });
    const models = matchB ? ['A', 'B'] : ['A'];
    for (const [i, m] of models.entries()) {
      const asin = `B00000000${i}`;
      await store.putMatch({ key: partKey('RYOBI', m), brand: 'RYOBI', model: m, status: 'matched', asin, grade: 'probable', alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null });
      await store.putPrice({ asin, price: 50, reviews: 10, seenAt: T0, checkedAt: T0 });
    }
    return store;
  }

  it('never shows a resolved bundle with no parts as confirmed', async () => {
    const store = new MemoryScanStore();
    await store.putBundle({
      key: bundleKey('3'), retailer: 'homedepot', itemId: '3', title: 'T', brand: 'RYOBI', model: 'X', upc: null,
      price: 100, regularPrice: 200, percentOff: 50, link: null, seenAt: T0,
      split: { components: [], status: 'resolved', notes: [] },
    });
    const report = await buildReport(store, RATCHET);
    expect(report.bundles[0]!.section).toBe('split');
    expect(report.bundles.some((b) => b.section === 'confirmed')).toBe(false);
    const cells = runCsv(report).split('\n')[1]!;
    expect(cells.startsWith('split,RYOBI,X,T,3,100,200,50,,,,,,,,,,')).toBe(true);
  });

  it('is inactive_listing, not confirmed, when every part is active but the bundle has no price', async () => {
    const report = await buildReport(await nullPriceStore(true), RATCHET);
    expect(report.bundles[0]).toMatchObject({ section: 'inactive_listing', status: 'partial', estimate: null });
    expect(report.bundles[0]!.parts.map((p) => p.availability)).toEqual(['active', 'active']);
  });

  it('is missing_listing when a part is missing and the bundle has no price', async () => {
    const report = await buildReport(await nullPriceStore(false), RATCHET);
    expect(report.bundles[0]).toMatchObject({ section: 'missing_listing', status: 'partial', estimate: null });
  });

  it('makes a part inactive when its price record has a null price', async () => {
    const store = await oneBundleStore({ asin: 'B000000001', price: null, reviews: null, seenAt: null, checkedAt: T0 });
    const report = await buildReport(store, RATCHET);
    expect(report.bundles[0]).toMatchObject({ section: 'inactive_listing', uncovered: ['A'] });
    expect(report.bundles[0]!.parts[0]!.availability).toBe('inactive');
  });

  it('makes a matched part with no price record inactive', async () => {
    const store = await oneBundleStore(null);
    const report = await buildReport(store, RATCHET);
    expect(report.bundles[0]).toMatchObject({ section: 'inactive_listing', uncovered: ['A'] });
    expect(report.bundles[0]!.parts[0]!.availability).toBe('inactive');
  });

  it('is partial with no estimate when a resolved bundle has no price', async () => {
    const store = new MemoryScanStore();
    const record: BundleRecord = {
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 'T', brand: 'RYOBI', model: 'A-B', upc: null,
      price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0,
      split: { components: ['A', 'B', 'A'], status: 'resolved', notes: [] },
    };
    await store.putBundle(record);
    const report = await buildReport(store, RATCHET);
    expect(report.bundles).toHaveLength(1);
    expect(report.bundles[0]).toMatchObject({ status: 'partial', estimate: null, uncovered: ['A', 'B'] });
    expect(report.bundles[0]!.parts.map((p) => [p.model, p.qty, p.status])).toEqual([['A', 2, 'unmatched'], ['B', 1, 'unmatched']]);
  });

  it('reads a review item saved before choices existed as having none', async () => {
    const store = await scanWorld();
    // Test A's question about PCL280B-PSK005, as the version before step 5 saved it.
    const { choices, ...old } = (await store.getReview('split:homedepot:327939252'))!;
    expect(choices).toEqual([]);
    await store.putReview(old as ReviewItem);
    const review = (await buildReport(store, RATCHET)).review;
    expect(review.find((r) => r.id === old.id)).toEqual({ ...old, choices: [] });
    expect(review.every((r) => Array.isArray(r.choices))).toBe(true);
  });
});

describe('CSV', () => {
  it('writes the run file', async () => {
    const report = await buildReport(await scanWorld(), RATCHET);
    const lines = runCsv(report).split('\n');
    expect(lines[0]).toBe(RUN_COLUMNS.join(','));
    expect(RUN_COLUMNS[0]).toBe('section');
    expect(lines[0]!.startsWith('section,brand,')).toBe(true);
    expect(lines[1]).toBe('confirmed,RYOBI,PBLRC2501SB,ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only),328814689,189,338,44,PBLRC25B | PBLRC01B,B0B3JWF5ZV | B0B6Z2ZGVK,probable | probable,169 | 146.94,268.55,189,79.55,0.4209,,https://www.homedepot.com/p/RYOBI-ONE-HP-18V-Brushless-Cordless-1-4-in-and-3-8-in-Extended-Reach-Ratchets-Tools-Only-PBLRC2501SB/328814689');
    expect(lines).toHaveLength(10); // header, 8 bundles, and the empty string after the last \n
  });

  it('escapes third-party text', () => {
    expect(csvLine(['a,b', 'say "hi"', 'two\nlines', null, -79.45, '=SUM(A1)', '+1', '-x', '@y'])).toBe('"a,b","say ""hi""","two\nlines",,-79.45,\'=SUM(A1),\'+1,\'-x,\'@y');
  });

  it('writes the review file', async () => {
    const report = await buildReport(await scanWorld(), RATCHET);
    const lines = reviewCsv(report).split('\n');
    expect(lines[0]).toBe(REVIEW_COLUMNS.join(','));
    expect(lines).toHaveLength(8);
    expect(lines[1]!.startsWith('split,RYOBI,PBLRC25B-PBP004,')).toBe(true);
    expect(lines[1]).toContain('"hyphen split, but a part is not in the catalog"');
  });
});
