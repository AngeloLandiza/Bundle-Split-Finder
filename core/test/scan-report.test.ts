import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { csvLine, REVIEW_COLUMNS, reviewCsv, RUN_COLUMNS, runCsv } from '../src/scan/csv';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type BundleRecord, type ScanSettings } from '../src/scan/types';
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

  it('calls a bundle partial when a part has no priced listing', async () => {
    const store = await scanWorld({ reserve: 0, maxPerRun: 2 });
    const report = await buildReport(store, RATCHET);
    const first = report.bundles.find((b) => b.model === 'PBLRC2501SB')!;
    expect(first.status).toBe('partial');
    expect(first.uncovered).toEqual(['PBLRC25B']);
    expect(first.estimate!.netRevenue).toBe(124.9);
    expect(first.parts.find((p) => p.model === 'PBLRC25B')).toMatchObject({ status: 'waiting', asin: null });
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
});

describe('CSV', () => {
  it('writes the run file', async () => {
    const report = await buildReport(await scanWorld(), RATCHET);
    const lines = runCsv(report).split('\n');
    expect(lines[0]).toBe(RUN_COLUMNS.join(','));
    expect(lines[1]).toBe('complete,RYOBI,PBLRC2501SB,ONE+ HP 18V Brushless Cordless 1/4 in. and 3/8 in. Extended Reach Ratchets (Tools Only),328814689,189,338,44,PBLRC25B | PBLRC01B,B0B3JWF5ZV | B0B6Z2ZGVK,probable | probable,169 | 146.94,268.55,189,79.55,0.4209,,https://www.homedepot.com/p/RYOBI-ONE-HP-18V-Brushless-Cordless-1-4-in-and-3-8-in-Extended-Reach-Ratchets-Tools-Only-PBLRC2501SB/328814689');
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
