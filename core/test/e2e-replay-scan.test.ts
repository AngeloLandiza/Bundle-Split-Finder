// Step 15, the loop closed on the owner's real data (fixtures/e2e-2026-11-23): the stored bundles, pages and part prices
// go through a whole scan at the account's 57 Keepa tokens (reserve 5) and an 18-search cap. Fakes for every reader:
// Home Depot part prices answer from the stored readings, then from Home Depot's recorded readings of Nov 18
// (fixtures/validation/hd-part-prices-2026-11-18.json: P553, PBP003, ... which the waiting splits need); Keepa and SerpApi answer each lookup with one listing that
// names the part (Keepa's without a price, as recorded; its price pull with one). No listing page or brand page is read,
// so all 18 searches are free for lookups. Nothing reaches the network.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { serpApiProductBodyFromKeepa } from '../src/keepa/amazon';
import { TokenBudget } from '../src/keepa/budget';
import { KEEPA_LOOKUP_TOKEN_ESTIMATE } from '../src/keepa/estimates';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { partPricesWanted, plannedWork, runScan, settleWaitingSplits, splitOne } from '../src/scan/runner';
import { knownModels } from '../src/scan/split';
import type { PartPriceReading, PartPriceRecord, ScanJob, ScanStore, SearchClient } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import type { SearchResult } from '../src/serpapi/client';
import { DEFAULT_SETTINGS, toScanSettings } from '../src/settings';
import * as fx from './fixtures';

const NOV18 = (JSON.parse(readFileSync(new URL('../../fixtures/validation/hd-part-prices-2026-11-18.json', import.meta.url), 'utf8')) as {
  prices: Record<string, { brand: string; model: string; itemId: string | null; matchedModel?: string | null; price: number | null; title: string | null }>;
}).prices;

const fixture = <T>(name: string): [string, T][] => JSON.parse(readFileSync(new URL(`../../fixtures/e2e-2026-11-23/scan/${name}.json`, import.meta.url), 'utf8')) as [string, T][];

async function realStore(): Promise<ScanStore> {
  const store = new MemoryScanStore();
  for (const [, r] of fixture<never>('bundles')) await store.putBundle(r);
  for (const [, r] of fixture<never>('catalog')) await store.putCatalogEntry(r);
  for (const [, r] of fixture<never>('matches')) await store.putMatch(r);
  for (const [, r] of fixture<never>('prices')) await store.putPrice(r);
  for (const [, r] of fixture<never>('listings')) await store.putListing(r);
  for (const [, r] of fixture<PartPriceRecord>('partPrices')) await store.putPartPrice(r);
  for (const [, r] of fixture<never>('reviews')) await store.putReview(r);
  for (const [, r] of fixture<never>('scans')) await store.putScan(r);
  return store;
}

/** One listing that names the part, as a search row; Keepa's carries no price. */
const row = (k: string, priced: boolean) => {
  const [brand, model] = k.split(' ') as [string, string];
  const asin = `B0${model.replace(/[^A-Z0-9]/gi, '').slice(0, 8).padEnd(8, 'X')}`.toUpperCase();
  return { asin, title: `${brand} ${model} Tool Only`, brand, price: priced ? 99 : null, extracted_price: priced ? 99 : null, reviews: null };
};

/** One scan on the real data at 57 Keepa tokens (reserve 5) and `searches` searches. */
async function scanWith(searches: number) {
    const store = await realStore();
    const old = (await store.listScans())[0] as ScanJob;
    let clock = old.finishedAt! + 60 * 60_000;
    const now = () => (clock += 200);
    const settings = { ...toScanSettings(DEFAULT_SETTINGS), queries: [], catalogPagesPerScan: 0, amazonRefreshViaKeepa: true };
    const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: searches });
    const serpCalls: string[] = [];
    const client: SearchClient = {
      async search(params): Promise<SearchResult> {
        const why = budget.blockReason(1);
        if (why) throw new Error(`budget: ${why}`);
        budget.record(1);
        serpCalls.push(`${params.engine} ${params.k ?? params.asin}`);
        order.push(`lookup ${params.k}`);
        return { data: { organic_results: params.k ? [row(String(params.k), true)] : [] }, source: 'network', at: clock };
      },
    };
    let tokens = 57;
    const keepaBudget = new TokenBudget({ reserve: 5, maxPerRun: Number.POSITIVE_INFINITY }, tokens);
    const spend = (n: number) => keepaBudget.noteMeta((tokens -= n), n, 1);
    const keepaCalls: string[] = [];
    /** What ran, in order: a part-price read, or a lookup (either budget). */
    const order: string[] = [];
    const prices = new Map(fixture<PartPriceRecord>('partPrices').map(([k, r]) => [k, r]));
    // Every save of the job, to check the step list only moves forward (a step may run again: done to now, never to next).
    const backwards: string[] = [];
    const last = new Map<string, string>();
    const watched = Object.assign(Object.create(store) as ScanStore, {
      putScan: async (j: ScanJob) => {
        for (const st of j.pipeline ?? []) {
          const was = last.get(st.id);
          if (was && was !== 'next' && st.state === 'next') backwards.push(`${st.id}: ${was} to next`);
          last.set(st.id, st.state);
        }
        return store.putScan(j);
      },
    });
    const job = await runScan({
      client, budget, store: watched, settings, now, waitForPages: true,
      readPages: async (ids) => ids.map((itemId) => ({ itemId, kind: 'unreadable' as const })),
      readPartPrices: async (parts) => parts.map((p): PartPriceReading => {
        order.push(`price ${p.brand} ${p.model}`);
        const r = prices.get(`${p.brand}:${p.model}`);
        if (r && r.price !== null) return { brand: p.brand, model: p.model, status: 'found', itemId: r.itemId, matchedModel: r.matchedModel, price: r.price, title: r.title, link: r.link };
        const n = NOV18[p.model];
        if (n && n.brand === p.brand && n.price !== null && n.itemId) {
          return { brand: p.brand, model: p.model, status: 'found', itemId: n.itemId, matchedModel: n.matchedModel ?? n.model, price: n.price, title: n.title, link: `https://www.homedepot.com/p/${n.itemId}` };
        }
        return { brand: p.brand, model: p.model, status: 'not_found', itemId: null, matchedModel: null, price: null, title: null, link: null };
      }),
      keepaBudget,
      keepaScale: { tokensPerRun: 0, discoveryShare: 90, reserve: 5, mode: 'auto', tokensLeft: 57 },
      keepaLookup: async (brand, model) => {
        keepaCalls.push(`search ${model}`);
        order.push(`lookup ${brand} ${model}`);
        spend(10);
        return { data: { organic_results: [row(`${brand} ${model}`, false)] }, source: 'network', at: clock, billAs: 'keepa', keepaTokens: 10 };
      },
      keepaProduct: async (asin) => {
        keepaCalls.push(`product ${asin}`);
        spend(1);
        const p = { asin, title: 'x', brand: 'RYOBI', amazonPrice: 9_900 };
        return { data: serpApiProductBodyFromKeepa(p), source: 'network', at: clock, billAs: 'keepa', keepaTokens: 1, keepaProduct: p };
      },
    });

    const report = await buildReport(store, settings);
    const looked = report.bundles.filter((b) => b.parts.length > 0 && b.parts.every((p) => p.status !== 'waiting' && p.status !== 'unmatched'));
    const estimated = report.bundles.filter((b) => b.estimate !== null);
    const steps = job.pipeline!.map((s) => `${s.id}:${s.state}${s.note ? ` (${s.note})` : s.skippedReason ? ` (${s.skippedReason})` : ''}`);
    const numbers = {
      bundles: report.bundles.length, everyPartLookedUp: looked.length, estimated: estimated.length,
      lookupsVia: job.lookupsVia, waiting: job.lookupsWaiting, blockedBy: job.lookupsBlockedBy, stopReason: job.stopReason,
      searches: serpCalls.length, keepaSearches: keepaCalls.filter((c) => c.startsWith('search')).length, keepaPulls: keepaCalls.filter((c) => c.startsWith('product')).length,
      tokensLeft: tokens, resolved: job.counts.bundlesResolved, steps,
      partPricesRead: order.filter((o) => o.startsWith('price')).length,
      lookupsAfterPrices: order.slice(order.findIndex((o) => o.startsWith('price')) + 1).filter((o) => o.startsWith('lookup')).length,
      stillWaitingSplits: (await store.listBundles()).filter((b) => (b.split?.waitingFor ?? []).length > 0 && b.split?.status !== 'resolved').length,
    };
    return { job, numbers, serpCalls, keepaCalls, tokens, budget, looked, estimated, order, backwards };
}

describe('one scan on the real second scan’s data, 57 Keepa tokens', () => {
  it('18 searches: looks up what the budgets pay for, leaves nothing waiting a budget could pay, and ends every step', async () => {
    const { job, numbers, serpCalls, keepaCalls, tokens, budget, looked, estimated, backwards } = await scanWith(18);
    expect(backwards).toEqual([]);
    // The recorded numbers: 53 bundles; 29 with every part looked up, and estimated; 4 lookups on Keepa, 18 on SerpApi,
    // 10 waiting for Keepa tokens (3 of them the parts of the 3 splits the part prices settled); 12 part prices read.
    expect(numbers).toMatchObject({ bundles: 53, everyPartLookedUp: 29, estimated: 29, waiting: 10, partPricesRead: 12, lookupsAfterPrices: 0 });
    expect(numbers.steps).toEqual([
      'hdPages:skipped (none found)', 'bundlePages:skipped (none found)', 'kitPages:done', 'amazon:done (4 Keepa, 18 searches, 10 wait)',
      'partPrices:done', 'ebay:skipped (not in this run)', 'judge:skipped (not in this run)', 'finish:done',
    ]);
    // Keepa: 52 tokens above the reserve pay for 4 lookups (each 10 + a 1-token price pull); SerpApi: all 18 searches.
    expect(job.lookupsVia).toEqual({ keepa: 4, serpapi: 18 });
    expect(serpCalls).toHaveLength(18);
    expect(keepaCalls.filter((c) => c.startsWith('search'))).toHaveLength(4);
    // No lookup waits while a budget could pay: Keepa is under a lookup above its reserve and no search is left.
    if ((job.lookupsWaiting ?? 0) > 0) {
      expect(tokens - 5).toBeLessThan(KEEPA_LOOKUP_TOKEN_ESTIMATE);
      expect(budget.spendable).toBe(0);
      expect(job.lookupsBlockedBy).toBe('keepa_tokens');
      expect(job.stopReason).toBe('keepa_tokens');
    }
    // Every step ended: none still "now" or "next" but the finish, which is done.
    expect(job.pipeline!.every((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'failed')).toBe(true);
    expect(job.pipeline!.find((s) => s.id === 'amazon')!.state).toBe('done');
    expect(looked.length).toBeGreaterThan(0);
    expect(estimated.length).toBeGreaterThan(0);
  });

  it('with searches to spare, a split the part prices settle is looked up in the same scan, in the same Amazon step', async () => {
    const { job, numbers, backwards } = await scanWith(60);
    // The 3 splits the part prices settled (P553 and the others Home Depot sells alone) are looked up after them.
    expect(numbers.lookupsAfterPrices).toBe(3);
    expect(numbers.everyPartLookedUp).toBe(42);
    expect(backwards).toEqual([]);
    expect(job.lookupsWaiting).toBe(0);
    expect(job.pipeline!.find((s) => s.id === 'amazon')).toMatchObject({ state: 'done' });
  });
});

describe('the waiting splits, between scans (the drip) and in the part-price order', () => {
  /** The real store with PCL1600K2-P553 (320243741) split as the agent does: it waits for Home Depot's P553 page. */
  async function waiting() {
    const store = await realStore();
    const at = ((await store.listScans())[0] as ScanJob).finishedAt!;
    const b = (await store.getBundle('homedepot:320243741'))!;
    const { split } = await splitOne(store, b, await knownModels(store), at, true);
    expect(split.waitingFor).toEqual(['P553']);
    return { store, at };
  }

  it('the parts a waiting split needs are read first, then by saving', async () => {
    const { store, at } = await waiting();
    const wanted = await partPricesWanted(store, toScanSettings(DEFAULT_SETTINGS), at, true);
    expect(wanted[0]!.key).toBe('RYOBI:P553');
  });

  it('a reading saved between scans settles the split (settleWaitingSplits, as the drip calls it), and its parts join the lookups', async () => {
    const { store, at } = await waiting();
    const settings = toScanSettings(DEFAULT_SETTINGS);
    expect((await plannedWork(store, settings, at)).work.lookups).not.toContain('RYOBI:P553');
    const n = NOV18.P553!;
    await store.putPartPrice({
      key: 'RYOBI:P553', brand: 'RYOBI', model: 'P553', itemId: n.itemId, matchedModel: n.matchedModel ?? 'P553', price: n.price, title: n.title,
      link: `https://www.homedepot.com/p/${n.itemId}`, seenAt: at, checkedAt: at,
    });
    const out = await settleWaitingSplits(store, at);
    expect(out.resolved).toBeGreaterThanOrEqual(1);
    expect(out.parts).toContain('RYOBI:P553');
    expect((await store.getBundle('homedepot:320243741'))!.split).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'P553'] });
    expect((await plannedWork(store, settings, at)).work.lookups).toContain('RYOBI:P553');
  });
});
