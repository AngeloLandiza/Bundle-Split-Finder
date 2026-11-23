// Step 15, decisions 1 and 2, in the runner: Keepa's tokens above the reserve pay for the first lookups, SerpApi's
// searches for the next ones, the rest wait, and the job names the real cause. The ratchet bundle's two parts, with the
// recorded SerpApi responses; Keepa is a fake shaped as the recording is: its search rows carry no price (no stats), so
// a matched listing is pulled once more for its price (1 token).

import { describe, expect, it } from 'vitest';

import { replayRecorded } from '../../scripts/replay';
import { serpApiProductBodyFromKeepa } from '../src/keepa/amazon';
import { TokenBudget } from '../src/keepa/budget';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan, whyNot } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, type SearchResult, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';

const T0 = Date.UTC(2026, 10, 23, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }], amazonRefreshViaKeepa: true };

interface Opts {
  /** Keepa's balance at the start, its reserve, and the most the TokenBudget lets this run spend. */
  tokensLeft: number;
  reserve?: number;
  maxPerRun?: number;
  /** Searches this scan may make. */
  searches: number;
  /** Catalog fields Keepa answers a product pull with, by ASIN (from the recorded product pages); none by default. */
  catalog?: Record<string, { partNumber: string; manufacturer: string }>;
}

async function world(o: Opts) {
  const store = new MemoryScanStore();
  const replay = replayRecorded();
  let clock = T0;
  const now = () => (clock += 100);
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: o.searches });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replay.fetchFn, now });
  // Keepa's search, faked from the same recorded Amazon search: the rows without their prices, as Keepa's are.
  const keepaSearches = new SerpApiClient({
    apiKey: 'TEST', budget: new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 50 }), cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now,
  });
  const keepaBudget = new TokenBudget({ reserve: o.reserve ?? 5, maxPerRun: o.maxPerRun ?? Number.POSITIVE_INFINITY }, o.tokensLeft);
  let balance = o.tokensLeft;
  const spend = (n: number) => {
    balance -= n;
    keepaBudget.noteMeta(balance, n, 1);
  };
  const keepaCalls: string[] = [];
  const keepaLookup = async (brand: string, model: string): Promise<SearchResult> => {
    keepaCalls.push(`search ${model}`);
    const r = await keepaSearches.search({ engine: 'amazon', k: `${brand} ${model}`, amazon_domain: 'amazon.com' });
    spend(10);
    const rows = ((r.data as { organic_results?: Record<string, unknown>[] }).organic_results ?? []).map((row) => ({ ...row, price: null, extracted_price: null }));
    return { data: { organic_results: rows }, source: 'network', at: clock, billAs: 'keepa', keepaTokens: 10 };
  };
  const keepaProduct = async (asin: string, label: string): Promise<SearchResult> => {
    keepaCalls.push(`product ${asin} ${label.split(':')[1]}`);
    spend(1);
    const p = { asin, title: 'RYOBI ONE+ HP 18V Brushless Extended Reach Ratchet', brand: 'RYOBI', amazonPrice: 12_345, ...(o.catalog?.[asin] ?? {}) };
    return { data: serpApiProductBodyFromKeepa(p), source: 'network', at: clock, billAs: 'keepa', keepaTokens: 1, keepaProduct: p };
  };
  const job = await runScan({
    client, budget, store, settings: RATCHET, now, keepaBudget, keepaLookup, keepaProduct,
    keepaScale: { tokensPerRun: 0, discoveryShare: 90, reserve: o.reserve ?? 5, mode: 'auto', tokensLeft: o.tokensLeft },
  });
  return { job, store, keepaCalls, balance: () => balance };
}

describe('the scan routes lookups: Keepa first, then SerpApi, then they wait', () => {
  it('16 tokens above the reserve pay for one lookup and its price pull; the other goes to SerpApi; both bundles parts are priced', async () => {
    const { job, store, keepaCalls } = await world({ tokensLeft: 21, searches: 10 });
    expect(job.status).toBe('done');
    expect(job.stopReason).toBeNull();
    expect(job.keepaPlan).toMatchObject({ lookups: 1, discoveryTokens: 11 });
    expect(job.lookupsVia).toEqual({ keepa: 1, serpapi: 1 });
    expect(job.lookupsWaiting).toBe(0);
    expect(job.lookupsBlockedBy).toBeNull();
    // The Keepa search, then the price pull of the listing it matched, as a refresh, right after it; then the catalog
    // check of the SerpApi lookup's title match, from one of the 5 tokens left above the reserve.
    expect(keepaCalls).toHaveLength(3);
    expect(keepaCalls[0]).toMatch(/^search /);
    expect(keepaCalls[1]).toMatch(/^product B\w+ refresh$/);
    expect(keepaCalls[2]).toMatch(/^product B\w+ identify$/);
    // The listing page and the SerpApi lookup.
    expect(job.searchesUsed).toBe(2);
    expect(job.keepaTokensUsed).toBe(12);
    const report = await buildReport(store, RATCHET);
    expect(report.bundles.every((b) => b.parts.every((p) => p.status !== 'waiting'))).toBe(true);
    expect(report.bundles.some((b) => b.estimate !== null)).toBe(true);
  });

  it('catalog check: the SerpApi lookup\'s title match is pulled on Keepa after the lookups and verified from its part number', async () => {
    // The fields the recorded SerpApi product pages show for the two ratchets (fixtures/recorded/amazon-product-*.json).
    const catalog = {
      B0B3JWF5ZV: { partNumber: 'PBLRC25B', manufacturer: 'RYOBI' },
      B0B6Z2ZGVK: { partNumber: 'PBLRC01B', manufacturer: 'RYOBI' },
    };
    const { job, store, keepaCalls } = await world({ tokensLeft: 21, searches: 10, catalog });
    expect(keepaCalls.map((c) => (c.startsWith('search') ? 'search' : c.replace(/ B\w+ /, ' ')))).toEqual(['search', 'product refresh', 'product identify']);
    const verified = (await store.listMatches()).filter((m) => m.verifiedBy === 'keepa_catalog');
    expect(verified.map((m) => [m.model, m.grade, m.verifyEvidence])).toEqual([
      [verified[0]!.model, 'strong', `Amazon's catalog lists brand RYOBI, part number ${verified[0]!.model}: https://www.amazon.com/dp/${verified[0]!.asin}`],
      [verified[1]!.model, 'strong', `Amazon's catalog lists brand RYOBI, part number ${verified[1]!.model}: https://www.amazon.com/dp/${verified[1]!.asin}`],
    ]);
    // Both: the Keepa lookup's price pull carries the same fields, so its title match is verified at no extra token.
    expect(job.matchesVerified).toBe(2);
    expect(job.keepaTokensUsed).toBe(12);
  });

  it('no search left: Keepa does what its tokens cover, the rest waits for Keepa tokens, and the job says so, not "search limit"', async () => {
    const { job } = await world({ tokensLeft: 21, searches: 1 });
    expect(job.lookupsVia).toEqual({ keepa: 1, serpapi: 0 });
    expect(job.lookupsWaiting).toBe(1);
    expect(job.lookupsBlockedBy).toBe('keepa_tokens');
    expect(job.stopReason).toBe('keepa_tokens');
    expect(job.status).toBe('stopped');
    const amazon = job.pipeline!.find((s) => s.id === 'amazon')!;
    expect(amazon.state).toBe('done');
    expect(amazon.note).toBe('1 Keepa, 1 wait');
    expect(whyNot('keepa_tokens')).toBe('waits for Keepa tokens');
    expect(whyNot('run_cap')).toBe('search limit');
  });

  it('nothing above the reserve and no search: the Amazon step is skipped as waiting for Keepa tokens', async () => {
    const { job, keepaCalls } = await world({ tokensLeft: 5, searches: 1 });
    expect(keepaCalls).toEqual([]);
    expect(job.stopReason).toBe('keepa_tokens');
    expect(job.lookupsWaiting).toBe(2);
    expect(job.pipeline!.find((s) => s.id === 'amazon')).toMatchObject({ state: 'skipped', skippedReason: 'waits for Keepa tokens' });
  });

  it('Keepa refusing a planned lookup before it is sent sends it to SerpApi when a search can pay: no failure, no part marked failing', async () => {
    // The plan sees 52 tokens; the run's own Keepa cap is 5, so Keepa refuses each lookup before anything is sent.
    const { job, keepaCalls } = await world({ tokensLeft: 57, maxPerRun: 5, searches: 10 });
    // No lookup on Keepa; a 1-token catalog check of each SerpApi title match fits under the run's cap.
    expect(keepaCalls.filter((c) => !c.endsWith(' identify'))).toEqual([]);
    expect(job.lookupsVia).toEqual({ keepa: 0, serpapi: 2 });
    expect(job.failingParts ?? []).toEqual([]);
    expect(job.stopMessage).toBeNull();
    expect(job.status).toBe('done');
  });

  it('and when no search can pay either, the lookup waits for Keepa (deferred, waiting), not failed', async () => {
    const { job, store } = await world({ tokensLeft: 57, maxPerRun: 5, searches: 1 });
    expect(job.lookupsWaiting).toBe(2);
    expect(job.lookupsBlockedBy).toBe('keepa_tokens');
    expect(job.failingParts ?? []).toEqual([]);
    expect((await store.listMatches()).filter((m) => m.status === 'waiting')).toHaveLength(2);
  });
});
