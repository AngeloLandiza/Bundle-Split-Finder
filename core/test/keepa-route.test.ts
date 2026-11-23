// Step 15, decision 1: a lookup never waits when any budget can pay for it. The routing rule on its own, then replayed on
// the owner's real second scan (fixtures/e2e-2026-11-23): 18 lookups waited, 57 Keepa tokens were on the account and
// 17 of the 18 searches allowed went unused.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { KEEPA_LOOKUP_TOKEN_ESTIMATE, KEEPA_SEARCH_TOKEN_ESTIMATE } from '../src/keepa/estimates';
import { keepaTokensForScan, lookupBlockOf, routeAmazonWork, type SerpRoom } from '../src/keepa/route';
import { plannedWork } from '../src/scan/runner';
import { MemoryScanStore } from '../src/scan/memoryStore';
import type { ScanJob, ScanStore } from '../src/scan/types';
import { DEFAULT_SETTINGS, toScanSettings } from '../src/settings';
import type { BlockReason } from '../src/serpapi/budget';

const keys = (n: number, p = 'k') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

/** SerpApi with `n` searches left, refused then for `why`. */
const serp = (n: number, why: BlockReason = 'run_cap'): SerpRoom => ({ spendable: n, blockReason: (k) => (k > n ? why : null) });

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));

describe('the recorded Keepa lookup cost', () => {
  it('is the search (10 tokens, 20 products) and one price pull: the search products carry no price', () => {
    const search = fixture('keepa/search-RYOBI-PCL235B.json') as { tokensConsumed: number; refillRate: number; tokensLeft: number; products: Record<string, unknown>[] };
    expect(search.tokensConsumed).toBe(KEEPA_SEARCH_TOKEN_ESTIMATE);
    expect(search.refillRate).toBe(1);
    expect(search.products).toHaveLength(20);
    // Title, brand and part number to match on, but no stats and no csv: no current price.
    expect(search.products.every((p) => p.stats == null && (p.csv == null || (p.csv as unknown[]).length === 0))).toBe(true);
    expect(search.products[0]).toMatchObject({ brand: 'RYOBI', partNumber: 'PCL235B' });
    // A product pull with stats costs one token an ASIN (3 for 3) and has the price.
    const pull = fixture('keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json') as { tokensConsumed: number; products: { stats: { current: number[] } }[] };
    expect(pull.tokensConsumed).toBe(3);
    expect(pull.products[0]!.stats.current[1]).toBeGreaterThan(0);
    expect(KEEPA_LOOKUP_TOKEN_ESTIMATE).toBe(11);
  });
});

describe('keepaTokensForScan', () => {
  it('is what the account has above the reserve; 0 per scan means no cap of its own', () => {
    expect(keepaTokensForScan({ tokensLeft: 57, reserve: 5, tokensPerScan: 0 })).toBe(52);
    expect(keepaTokensForScan({ tokensLeft: 57, reserve: 5, tokensPerScan: 20 })).toBe(20);
    expect(keepaTokensForScan({ tokensLeft: 3, reserve: 5, tokensPerScan: 0 })).toBe(0);
  });

  it('an unknown balance plans nothing on Keepa: never a guess', () => {
    expect(keepaTokensForScan({ tokensLeft: null, reserve: 0, tokensPerScan: 0 })).toBe(0);
    expect(keepaTokensForScan({ tokensLeft: undefined, reserve: 0, tokensPerScan: 100 })).toBe(0);
  });
});

describe('routeAmazonWork', () => {
  it('Keepa first while its tokens cover a lookup, then SerpApi, then the rest waits for Keepa', () => {
    const plan = routeAmazonWork({ lookups: keys(10) }, { tokens: 35 }, serp(4));
    expect(plan.keepaLookups).toEqual(['k1', 'k2', 'k3']);
    expect(plan.serpLookups).toEqual(['k4', 'k5', 'k6', 'k7']);
    expect(plan.deferredLookups).toEqual(['k8', 'k9', 'k10']);
    expect(plan.keepaTokens).toBe(33);
    expect(plan.searches).toBe(4);
    expect(plan.blockedBy).toBe('keepa_tokens');
  });

  it('refreshes come after every lookup, on Keepa only, one token each', () => {
    const plan = routeAmazonWork({ lookups: keys(2), refreshes: keys(5, 'r') }, { tokens: 25 }, serp(10));
    expect(plan.keepaLookups).toEqual(['k1', 'k2']);
    expect(plan.keepaRefreshes).toEqual(['r1', 'r2', 'r3']);
    expect(plan.deferredRefreshes).toEqual(['r4', 'r5']);
    expect(plan.serpRefreshes).toEqual([]);
    expect(plan.searches).toBe(0);
    expect(plan.blockedBy).toBeNull();
  });

  it('without Keepa, SerpApi pays in order and the block is SerpApi’s own', () => {
    const plan = routeAmazonWork({ lookups: keys(3), refreshes: ['r1'] }, null, serp(2, 'reserve'));
    expect(plan.serpLookups).toEqual(['k1', 'k2']);
    expect(plan.deferredLookups).toEqual(['k3']);
    expect(plan.deferredRefreshes).toEqual(['r1']);
    expect(plan.blockedBy).toBe('reserve');
    expect(routeAmazonWork({ lookups: keys(2) }, null, serp(1)).blockedBy).toBe('search_cap');
    expect(routeAmazonWork({ lookups: keys(2) }, null, serp(1, 'hourly_limit')).blockedBy).toBe('hourly_limit');
    expect(lookupBlockOf('run_cap')).toBe('search_cap');
  });

  it('Keepa that can pull products but not search sends lookups to SerpApi, and names SerpApi as the block', () => {
    const plan = routeAmazonWork({ lookups: keys(3) }, { tokens: 100, lookups: false }, serp(1));
    expect(plan.keepaLookups).toEqual([]);
    expect(plan.serpLookups).toEqual(['k1']);
    expect(plan.blockedBy).toBe('search_cap');
  });
});

/** The owner's scan store after the second real scan, read into memory. */
function realStore(): ScanStore {
  const store = new MemoryScanStore();
  const load = <T>(name: string, put: (r: T) => Promise<void>) => {
    const pairs = fixture(`e2e-2026-11-23/scan/${name}.json`) as [string, T][];
    return Promise.all(pairs.map(([, r]) => put(r)));
  };
  return Object.assign(store, {
    ready: Promise.all([
      load('bundles', (r) => store.putBundle(r as never)), load('catalog', (r) => store.putCatalogEntry(r as never)),
      load('matches', (r) => store.putMatch(r as never)), load('prices', (r) => store.putPrice(r as never)),
      load('listings', (r) => store.putListing(r as never)), load('partPrices', (r) => store.putPartPrice(r as never)),
      load('reviews', (r) => store.putReview(r as never)), load('scans', (r) => store.putScan(r as never)),
    ]),
  });
}

describe('replayed on the real second scan (fixtures/e2e-2026-11-23)', () => {
  it('the 18 lookups that waited: 4 run on Keepa at 57 tokens (reserve 5) and 14 on SerpApi within the 17 searches left; none waits', async () => {
    const store = realStore() as ScanStore & { ready: Promise<unknown> };
    await store.ready;
    const job = (await store.listScans())[0] as ScanJob;
    expect(job.deferred.filter((s) => s.kind === 'lookup')).toHaveLength(18);
    expect(job.keepaPlan).toEqual({ discoveryTokens: 4, trackingTokens: 1, lookups: 0, refreshes: 0 });
    const waited = job.deferred.flatMap((s) => (s.kind === 'lookup' ? [`${s.brand}:${s.model}`] : []));
    // Every one of them is still wanted from the saved data. (Without the agent's BOGO pair list, which is not in the
    // fixture, the pairs' free tools are wanted too: the scan held them back, PAIR_LOOKUPS_PER_GROUP a group.)
    const { work } = await plannedWork(store, toScanSettings(DEFAULT_SETTINGS), job.finishedAt!);
    expect(work.lookups.slice(0, 18)).toEqual(waited);
    // The scan had 18 searches; the brand page used 1. The account had 57 tokens; the default reserve is 5.
    const tokens = keepaTokensForScan({ tokensLeft: 57, reserve: DEFAULT_SETTINGS.keepaReserve, tokensPerScan: 0 });
    const plan = routeAmazonWork({ lookups: waited }, { tokens }, serp(18 - job.searchesUsed));
    expect(plan.keepaLookups).toHaveLength(4);
    expect(plan.serpLookups).toHaveLength(14);
    expect(plan.deferredLookups).toEqual([]);
    expect(plan.blockedBy).toBeNull();
    // With no searches at all, Keepa still does 4 and the 14 others wait for its tokens, which the drip spends.
    const keepaOnly = routeAmazonWork({ lookups: waited }, { tokens }, serp(0));
    expect([keepaOnly.keepaLookups.length, keepaOnly.deferredLookups.length, keepaOnly.blockedBy]).toEqual([4, 14, 'keepa_tokens']);
  });
});
