// Step 15, decision 3: Home Depot's part prices are read one part a call and for at most PART_PRICE_MS a scan; the parts
// not read are asked for again next time. The real Nov 23 scan read 40 parts in 529.55 s (13.2 s each) before any lookup.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MemoryScanStore } from '../src/scan/memoryStore';
import { failStep, MIN_TIMED_UNITS, newPipeline, pipelineView, estimate } from '../src/scan/pipeline';
import { PART_PRICE_MS, partPricesWanted, readPartPricesFor } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type PartPriceReading, type ScanJob } from '../src/scan/types';

const T0 = Date.UTC(2026, 10, 23, 12);
const SECONDS_EACH = 529_550 / 40;

async function storeWith(models: string[]): Promise<MemoryScanStore> {
  const store = new MemoryScanStore();
  await store.putBundle({
    key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 't', brand: 'RYOBI', model: 'PBIG', upc: null, price: 100, regularPrice: 150,
    percentOff: null, link: null, seenAt: T0, split: { components: models, status: 'resolved', notes: [] },
  });
  await store.putReview({
    id: `split:${bundleKey('1')}`, kind: 'split', subject: bundleKey('1'), brand: 'RYOBI', model: 'PBIG', title: 't', reason: 'r', candidates: [],
    choices: [models], openedAt: T0, answer: models.join(','), answeredAt: T0,
  });
  return store;
}

const notFound = (parts: { brand: string; model: string }[]): PartPriceReading[] =>
  parts.map((p) => ({ brand: p.brand, model: p.model, status: 'not_found', itemId: null, matchedModel: null, price: null, title: null, link: null }));

describe('the part-price time limit', () => {
  it('is 4 minutes: at the recorded rate, 19 parts', () => {
    expect(PART_PRICE_MS).toBe(240_000);
    const scan = JSON.parse(readFileSync(new URL('../../fixtures/e2e-2026-11-23/scan/scans.json', import.meta.url), 'utf8')) as [string, ScanJob][];
    const step = scan.find(([, j]) => j.stopReason === 'run_cap')![1].pipeline!.find((s) => s.id === 'partPrices')!;
    expect(step.activeMs! / step.unitsMeasured!).toBeCloseTo(SECONDS_EACH, 5);
    expect(Math.ceil(PART_PRICE_MS / SECONDS_EACH)).toBe(19);
  });

  it('a part at the recorded 13 s each: 19 parts read, then it stops for time; the next run carries on with the rest', async () => {
    const models = Array.from({ length: 30 }, (_, i) => `P${100 + i}`);
    const store = await storeWith(models);
    let clock = T0;
    const calls: number[] = [];
    const reader = async (parts: { brand: string; model: string }[]) => {
      calls.push(parts.length);
      clock += SECONDS_EACH;
      return notFound(parts);
    };
    const out = await readPartPricesFor({ store, settings: DEFAULT_SCAN_SETTINGS, readPartPrices: reader, now: () => clock, shouldStop: () => false });
    expect(out).toEqual({ asked: 30, saved: 19, stopped: 'time' });
    expect(calls.every((n) => n === 1)).toBe(true);
    // The 11 not read are still wanted; the 19 read are checked and are not.
    expect(await partPricesWanted(store, DEFAULT_SCAN_SETTINGS, clock)).toHaveLength(11);
    const again = await readPartPricesFor({ store, settings: DEFAULT_SCAN_SETTINGS, readPartPrices: reader, now: () => clock, shouldStop: () => false });
    expect(again).toEqual({ asked: 11, saved: 11, stopped: null });
  });

  it('a refusal (not_read) ends the reads at once; a stop before the next part does too', async () => {
    const store = await storeWith(['P1', 'P2', 'P3']);
    const refused = await readPartPricesFor({
      store, settings: DEFAULT_SCAN_SETTINGS, now: () => T0, shouldStop: () => false,
      readPartPrices: async (parts) => parts.map((p) => ({ ...notFound([p])[0]!, status: 'not_read' })),
    });
    expect(refused).toEqual({ asked: 3, saved: 0, stopped: 'refused' });
    let n = 0;
    const stopped = await readPartPricesFor({ store, settings: DEFAULT_SCAN_SETTINGS, now: () => T0, shouldStop: () => n >= 1, readPartPrices: async (parts) => (n++, notFound(parts)) });
    expect(stopped).toEqual({ asked: 3, saved: 1, stopped: 'stop' });
  });
});

describe('the running step and its time (step 15)', () => {
  const job = (): ScanJob => ({
    id: '1', startedAt: T0, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'parts', queue: [], deferred: [], searchesUsed: 0,
    counts: { pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0 },
    pipeline: newPipeline(0).map((s) => (s.id === 'finish' ? s : { ...s, state: 'skipped' as const })),
  });

  it("the step's own rate counts once it has timed MIN_TIMED_UNITS units; before that the earlier scans' rate does", () => {
    const j = job();
    const step = j.pipeline!.find((s) => s.id === 'partPrices')!;
    Object.assign(step, { state: 'now', unitsDone: 2, unitsTotal: 20, activeMs: 2 * 30_000, unitsMeasured: 2 });
    // Two parts at 30 s each are not yet a rate: 18 left at the stored 13 s.
    expect(MIN_TIMED_UNITS).toBe(3);
    expect(estimate(j, { hdPageRead: [13] }).seconds).toBeCloseTo(18 * 13, 5);
    Object.assign(step, { unitsDone: 3, activeMs: 3 * 30_000, unitsMeasured: 3 });
    expect(estimate(j, { hdPageRead: [13] }).seconds).toBeCloseTo(17 * 30, 5);
  });

  it('the view gives each running or finished step its units, and a failed step its reason', () => {
    const j = job();
    Object.assign(j.pipeline!.find((s) => s.id === 'amazon')!, { state: 'now', unitsDone: 6, unitsTotal: 18 });
    const prices = j.pipeline!.find((s) => s.id === 'partPrices')!;
    Object.assign(prices, { state: 'now', unitsDone: 4, unitsTotal: 19 });
    failStep(j, 'partPrices', 'price reader failed', T0);
    const v = pipelineView(j, {}, T0, { unknown: '' });
    expect(v.steps.find((s) => s.label === 'Amazon lookups')).toEqual({ label: 'Amazon lookups', state: 'now', figure: '6 of 18', done: 6, total: 18 });
    expect(v.steps.find((s) => s.label === 'Home Depot part prices')).toEqual({ label: 'Home Depot part prices', state: 'failed', figure: 'price reader failed', done: 4, total: 4 });
    expect(v.steps.find((s) => s.label === 'Bundle pages')).toEqual({ label: 'Bundle pages', state: 'skipped', figure: '' });
  });
});
