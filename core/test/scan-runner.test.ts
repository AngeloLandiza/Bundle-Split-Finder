import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings, type SearchClient } from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import * as fx from './fixtures';
import { recorded } from './recorded';

// Every search here goes through the real SerpApiClient and SearchBudget over the
// replay of fixtures/recorded/. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 9, 12); // one fixed clock for the client and the runner
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const account = (over = {}) => parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, ...over });
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, queries: [{ q: 'ryobi extended reach ratchet' }] };
const OPEN: BudgetPolicy = { reserve: 0, maxPerRun: 10 };

const LISTING = 'engine=home_depot&page=1&q=ryobi extended reach ratchet';
const LOOKUP_01B = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC01B';
const LOOKUP_25B = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC25B';

interface World {
  store: MemoryScanStore;
  cache: MemoryCache;
  replay: Replay;
  clock: number;
  /** Ledger label of every search that counted against the quota. */
  ledger: string[];
}

const world = (): World => ({ store: new MemoryScanStore(), cache: new MemoryCache(), replay: replayRecorded(), clock: T0, ledger: [] });

interface ScanOptions {
  settings?: ScanSettings;
  policy?: BudgetPolicy;
  account?: ReturnType<typeof account>;
  fetchFn?: typeof fetch;
  wrap?: (client: SearchClient) => SearchClient;
}

function scan(w: World, opts: ScanOptions = {}) {
  const budget = new SearchBudget(opts.account ?? account(), opts.policy ?? OPEN);
  const client = new SerpApiClient({
    apiKey: 'TEST',
    budget,
    cache: w.cache,
    fetchFn: opts.fetchFn ?? w.replay.fetchFn,
    now: () => w.clock,
    onSpend: (entry) => {
      w.ledger.push(entry.label);
    },
  });
  return runScan({ client: opts.wrap ? opts.wrap(client) : client, budget, store: w.store, settings: opts.settings ?? RATCHET, now: () => w.clock });
}

/** Its `n`th search completes underneath (paid, cached, in the ledger), then the worker "dies". */
const interruptOn = (n: number) => (client: SearchClient): SearchClient => {
  let calls = 0;
  return {
    async search(params, options) {
      const result = await client.search(params, options);
      if (++calls === n) throw new Error('interrupted');
      return result;
    },
  };
};

describe('runScan: the founder\'s bundle (test A)', () => {
  it('splits the ratchet bundles from one recorded page and matches both parts', async () => {
    const w = world();
    const job = await scan(w, { settings: RATCHET, policy: { reserve: 0, maxPerRun: 10 } });
    expect(job).toMatchObject({ id: String(T0), startedAt: T0, finishedAt: T0, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', searchesUsed: 3, queue: [], deferred: [] });
    expect(job.counts).toEqual({ pagesFetched: 1, productsSeen: 18, bundlesSeen: 8, bundlesResolved: 2, reviewsOpened: 6, lookupsDone: 2, refreshesDone: 0, partsMatched: 2 });
    // PBLRC25B is in two bundles (328814689 and 318045287): one lookup, not two.
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B]);
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'scan:lookup:PBLRC01B', 'scan:lookup:PBLRC25B']);
    expect((await w.store.getBundle('homedepot:328814689'))!.split).toMatchObject({ status: 'resolved', components: ['PBLRC25B', 'PBLRC01B'] });
    expect(await w.store.getBundle('homedepot:328814689')).toMatchObject({
      retailer: 'homedepot', itemId: '328814689', brand: 'RYOBI', model: 'PBLRC2501SB', upc: null, price: 189, regularPrice: 338, percentOff: 44, seenAt: T0,
    });
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', grade: 'probable', decidedBy: 'auto' });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK', grade: 'probable' });
    expect(await w.store.getPrice('B0B3JWF5ZV')).toEqual({ asin: 'B0B3JWF5ZV', price: 169, reviews: 221, seenAt: T0, checkedAt: T0 });
    // The PBLRC25B search shows this ASIN at 160; only the chosen listing of a lookup is priced from it.
    expect(await w.store.getPrice('B0B6Z2ZGVK')).toMatchObject({ price: 146.94, reviews: 212 });
    // PCL280K1 is listed under two item ids (323337329, 339375658): one catalog entry.
    // Milwaukee and RIDGID rows are ignored.
    expect((await w.store.listCatalog()).map((c) => c.key)).toEqual([
      'DEWALT:DCF512EB', 'DEWALT:DCF513EB', 'RYOBI:PBLRC01B', 'RYOBI:PBLRC01K1', 'RYOBI:PBLRC25B', 'RYOBI:PBLRC25K1', 'RYOBI:PCL280B', 'RYOBI:PCL280K1', 'RYOBI:PSBRC02K1',
    ]);
    expect(await w.store.getCatalogEntry('RYOBI:PBLRC25B')).toEqual({
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', title: 'ONE+ HP 18V Brushless Cordless 3/8 in. Extended Reach Ratchet (Tool Only)',
      kinds: ['ratchet'], isKit: false, upc: null, seenAt: T0,
    });
    expect((await w.store.listReview()).map((r) => r.id)).toEqual([
      'split:homedepot:320683876', 'split:homedepot:320684261', 'split:homedepot:327939252', 'split:homedepot:327939313', 'split:homedepot:335849279', 'split:homedepot:345174262',
    ]);
    expect(await w.store.getReview('split:homedepot:320683876')).toMatchObject({
      kind: 'split', subject: 'homedepot:320683876', brand: 'RYOBI', model: 'PBLRC25B-PBP004', reason: 'hyphen split, but a part is not in the catalog',
      candidates: [], openedAt: T0, answer: null, answeredAt: null,
    });
    // The store holds the finished job.
    expect(await w.store.listScans()).toEqual([job]);
  });
});

describe('runScan: a page of kits and unresolved bundles (test B)', () => {
  it('saves kits to the catalog, sends every unresolved bundle to review, and looks nothing up', async () => {
    const w = world();
    const job = await scan(w, { settings: { ...DEFAULT_SCAN_SETTINGS, queries: [{ q: 'dewalt 20v combo kit' }] } });
    expect(job).toMatchObject({ status: 'done', stopReason: null, searchesUsed: 1, queue: [], deferred: [] });
    expect(job.counts).toEqual({ pagesFetched: 1, productsSeen: 24, bundlesSeen: 4, bundlesResolved: 0, reviewsOpened: 4, lookupsDone: 0, refreshesDone: 0, partsMatched: 0 });
    expect(await w.store.listCatalog()).toHaveLength(20);
    expect((await w.store.listReview()).map((r) => r.id)).toEqual([
      'split:homedepot:337440459', 'split:homedepot:337440461', 'split:homedepot:343992132', 'split:homedepot:343992133',
    ]);
    expect(await w.store.listMatches()).toEqual([]);
    expect(w.replay.calls).toEqual(['engine=home_depot&page=1&q=dewalt 20v combo kit']);
  });
});

describe('runScan: the three limits (tests C and D)', () => {
  it('stops at the run cap, keeps the rest waiting, and the next scan does it first', async () => {
    const w = world();
    const first = await scan(w, { policy: { reserve: 0, maxPerRun: 2 } });
    expect(first).toMatchObject({ status: 'stopped', stopReason: 'run_cap', stopMessage: null, phase: 'finish', searchesUsed: 2, queue: [] });
    expect(first.deferred).toEqual([{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' }]);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'waiting', asin: null, waitingSince: T0, decidedBy: 'auto' });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched' });

    w.clock = T0 + 10 * MINUTE;
    const second = await scan(w, { policy: { reserve: 0, maxPerRun: 10 } });
    expect(second).toMatchObject({ id: String(T0 + 10 * MINUTE), status: 'done', stopReason: null, searchesUsed: 1, deferred: [] });
    expect(second.counts).toMatchObject({ pagesFetched: 1, lookupsDone: 1, partsMatched: 1, reviewsOpened: 0 });
    // The listing page came from the cache.
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B]);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', waitingSince: null });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK' });
    expect((await w.store.listScans()).map((j) => j.status)).toEqual(['done', 'stopped']);
  });

  it('stops at the reserve', async () => {
    const w = world();
    const job = await scan(w, { account: account({ total_searches_left: 101 }), policy: { reserve: 100, maxPerRun: 10 } });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'reserve', searchesUsed: 1, queue: [] });
    expect(job.deferred).toEqual([
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' },
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' },
    ]);
    expect((await w.store.listMatches()).map((m) => [m.key, m.status, m.waitingSince])).toEqual([
      ['RYOBI:PBLRC01B', 'waiting', T0],
      ['RYOBI:PBLRC25B', 'waiting', T0],
    ]);
    expect(w.replay.calls).toEqual([LISTING]);
  });

  it('stops at the hourly limit', async () => {
    const w = world();
    const job = await scan(w, { account: account({ this_hour_searches: 49 }), policy: { reserve: 0, maxPerRun: 10 } });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'hourly_limit', searchesUsed: 1 });
    expect(job.deferred).toHaveLength(2);
  });
});

describe('runScan: an interruption is continued without paying twice (test E)', () => {
  it('continues the running job and answers the repeated step from the cache', async () => {
    const w = world();
    // The second search (the PBLRC01B lookup) is paid, then the runner never sees it.
    await expect(scan(w, { wrap: interruptOn(2) })).rejects.toThrow('interrupted');
    const [saved] = await w.store.listScans();
    expect(saved).toMatchObject({ id: String(T0), status: 'running', phase: 'parts', searchesUsed: 1, finishedAt: null });
    expect(saved!.queue).toEqual([
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' },
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' },
    ]);
    expect(w.ledger).toHaveLength(2);

    w.clock = T0 + 5 * MINUTE;
    const job = await scan(w);
    expect(job).toMatchObject({ id: String(T0), startedAt: T0, status: 'done', stopReason: null, finishedAt: T0 + 5 * MINUTE, queue: [], deferred: [] });
    // 3 searches were paid, but the one in flight at the interruption belongs to a step
    // that was never saved, so the job counts 2.
    expect(job.searchesUsed).toBe(2);
    expect(w.ledger).toHaveLength(3);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B]);
    expect(new Set(w.replay.calls).size).toBe(3);
    expect(job.counts).toEqual({ pagesFetched: 1, productsSeen: 18, bundlesSeen: 8, bundlesResolved: 2, reviewsOpened: 6, lookupsDone: 2, refreshesDone: 0, partsMatched: 2 });
    expect(await w.store.listScans()).toHaveLength(1);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK' });
  });

  it('continues a job interrupted during the listing phase, without fetching the page again', async () => {
    const w = world();
    await expect(scan(w, { wrap: interruptOn(1) })).rejects.toThrow('interrupted');
    expect((await w.store.listScans())[0]).toMatchObject({ status: 'running', phase: 'listing', searchesUsed: 0, queue: [{ kind: 'listing', page: 1 }] });

    // Two hours later the page is older than listingMaxAgeMs, but it belongs to this job.
    w.clock = T0 + 120 * MINUTE;
    const job = await scan(w);
    expect(job).toMatchObject({ id: String(T0), status: 'done', searchesUsed: 2 });
    expect(job.counts).toMatchObject({ pagesFetched: 1, bundlesResolved: 2, lookupsDone: 2 });
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B]);
  });

  it('writes a step\'s result to the store before it saves the job (rule 3)', async () => {
    // A store whose 4th job save fails: the one after the PBLRC01B lookup (saves are:
    // start, listing page, parts plan, lookup, lookup, finish).
    class FailingSave extends MemoryScanStore {
      saves = 0;
      override async putScan(job: Parameters<MemoryScanStore['putScan']>[0]) {
        if (++this.saves === 4) throw new Error('interrupted');
        return super.putScan(job);
      }
    }
    const w = { ...world(), store: new FailingSave() };
    await expect(scan(w)).rejects.toThrow('interrupted');
    // The lookup's result is already in the store; the saved job still has the step queued.
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK' });
    expect((await w.store.listScans())[0]).toMatchObject({ status: 'running', searchesUsed: 1, queue: [{ model: 'PBLRC01B' }, { model: 'PBLRC25B' }] });

    const job = await scan(w);
    expect(job).toMatchObject({ id: String(T0), status: 'done', searchesUsed: 2 });
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B]);
    expect(job.counts).toMatchObject({ lookupsDone: 2, partsMatched: 2 });
  });

  it('finishes a continued job whose parts queue is empty', async () => {
    const w = world();
    await w.store.putScan({
      id: '1', startedAt: T0 - MINUTE, finishedAt: null, status: 'running', stopReason: null, stopMessage: null,
      phase: 'parts', queue: [], deferred: [], searchesUsed: 4, counts: { pagesFetched: 1, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 3, refreshesDone: 0, partsMatched: 0 },
    });
    const job = await scan(w);
    expect(job).toMatchObject({ id: '1', status: 'done', phase: 'finish', searchesUsed: 4, finishedAt: T0 });
    expect(job.counts.lookupsDone).toBe(3);
    expect(w.replay.calls).toEqual([]);
  });
});

describe('runScan: time (tests F and G)', () => {
  it('a day later pays for the listing page again and nothing else', async () => {
    const w = world();
    await scan(w);
    w.clock = T0 + DAY;
    const job = await scan(w);
    expect(job).toMatchObject({ status: 'done', searchesUsed: 1 });
    expect(job.counts).toMatchObject({ pagesFetched: 1, lookupsDone: 0, refreshesDone: 0, reviewsOpened: 0, bundlesResolved: 2 });
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B, LISTING]);
    expect(w.ledger.slice(3)).toEqual(['scan:listing:ryobi extended reach ratchet:p1']);
    expect(await w.store.getBundle('homedepot:328814689')).toMatchObject({ seenAt: T0 + DAY, split: { status: 'resolved' } });
  });

  it('four days later refreshes both stale prices', async () => {
    const w = world();
    await scan(w);
    const later = T0 + 4 * DAY;
    w.clock = later;
    const job = await scan(w);
    expect(job).toMatchObject({ status: 'done', searchesUsed: 3, deferred: [] });
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 2, partsMatched: 0 });
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B, LISTING, LOOKUP_01B, LOOKUP_25B]);
    expect(w.ledger.slice(3)).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'scan:refresh:PBLRC01B', 'scan:refresh:PBLRC25B']);
    expect(await w.store.getPrice('B0B3JWF5ZV')).toEqual({ asin: 'B0B3JWF5ZV', price: 169, reviews: 221, seenAt: later, checkedAt: later });
    expect(await w.store.getPrice('B0B6Z2ZGVK')).toEqual({ asin: 'B0B6Z2ZGVK', price: 146.94, reviews: 212, seenAt: later, checkedAt: later });
    // A refresh reads the price; it does not change the match.
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', updatedAt: T0 });
  });

  it('defers a stale refresh that does not fit and names the limit', async () => {
    const w = world();
    await scan(w);
    w.clock = T0 + 4 * DAY;
    const job = await scan(w, { policy: { reserve: 0, maxPerRun: 2 } });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 2 });
    expect(job.deferred).toEqual([{ kind: 'refresh', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' }]);
    // A deferred refresh is not a waiting lookup: the match stays as it was.
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', waitingSince: null });
  });
});

/** The replay, except that requests whose URL contains `match` get an HTTP `status` reply. */
function failing(w: World, match: string, status: number) {
  const failed: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(match)) {
      failed.push(url);
      return new Response(JSON.stringify({ error: 'refused' }), { status });
    }
    return w.replay.fetchFn(input);
  }) as typeof fetch;
  return { fetchFn, failed };
}

describe('runScan: stopping on errors (test H)', () => {
  it.each([
    [500, 'error', /HTTP 500/],
    [429, 'rate_limited', /hourly limit reached or no searches left/],
  ] as const)('an Amazon HTTP %i stops the scan after one request and keeps both parts waiting', async (status, reason, message) => {
    const w = world();
    const amazon = failing(w, 'engine=amazon', status);
    const job = await scan(w, { fetchFn: amazon.fetchFn });
    expect(job).toMatchObject({ status: 'stopped', stopReason: reason, phase: 'finish', searchesUsed: 1, queue: [] });
    expect(job.stopMessage).toMatch(message);
    expect(amazon.failed).toHaveLength(1);
    expect(job.deferred).toEqual([
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' },
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' },
    ]);
    expect((await w.store.listMatches()).map((m) => [m.key, m.status, m.waitingSince])).toEqual([
      ['RYOBI:PBLRC01B', 'waiting', T0],
      ['RYOBI:PBLRC25B', 'waiting', T0],
    ]);
    expect(job.counts).toMatchObject({ lookupsDone: 0, bundlesResolved: 2 });
  });

  it('an error on a listing page still splits what was fetched, with nothing left to spend', async () => {
    const w = world();
    const settings = { ...RATCHET, queries: [{ q: 'ryobi extended reach ratchet' }, { q: 'dewalt 20v combo kit' }] };
    const hd = failing(w, 'dewalt', 500);
    const job = await scan(w, { settings, fetchFn: hd.fetchFn });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'error', searchesUsed: 1, queue: [] });
    expect(job.stopMessage).toMatch(/HTTP 500/);
    expect(job.deferred).toEqual([
      { kind: 'listing', q: 'dewalt 20v combo kit', page: 1, filterTokens: null, bundlesOnly: false },
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' },
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' },
    ]);
    expect(job.counts).toMatchObject({ pagesFetched: 1, bundlesResolved: 2, reviewsOpened: 6, lookupsDone: 0 });
    expect(hd.failed).toHaveLength(1);
    expect(w.replay.calls).toEqual([LISTING]);
    expect((await w.store.listMatches()).map((m) => m.status)).toEqual(['waiting', 'waiting']);
  });

  it('a continued job whose budget refuses stops cleanly instead of staying running', async () => {
    const w = world();
    await expect(scan(w, { wrap: interruptOn(2) })).rejects.toThrow('interrupted');

    // No searches allowed: PBLRC01B comes from the cache, PBLRC25B is refused.
    const job = await scan(w, { policy: { reserve: 0, maxPerRun: 0 } });
    expect(job).toMatchObject({ id: String(T0), status: 'stopped', stopReason: 'run_cap', stopMessage: null, searchesUsed: 1, queue: [] });
    expect(job.deferred).toEqual([{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' }]);
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 1 });
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'waiting', waitingSince: T0 });
    expect((await w.store.listScans())[0]!.status).toBe('stopped');
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
  });
});

describe('runScan: brands, the user\'s decision, a listing that disappeared (tests I, J, K)', () => {
  it('ignores rows of a brand outside the settings (test I)', async () => {
    const w = world();
    const job = await scan(w, { settings: { ...RATCHET, brands: ['RYOBI'] } });
    const catalog = await w.store.listCatalog();
    expect(catalog).toHaveLength(7);
    expect(catalog.filter((c) => c.brand === 'DEWALT')).toEqual([]);
    expect(job.counts).toMatchObject({ productsSeen: 16, bundlesSeen: 8 });
  });

  it('never changes a match the user decided, and never looks it up (test J)', async () => {
    const w = world();
    const decided = {
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'matched' as const, asin: 'B0USERPICK0', grade: null,
      alternatives: [], decidedBy: 'user' as const, updatedAt: T0 - DAY, waitingSince: null,
    };
    await w.store.putMatch(decided);
    const job = await scan(w);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(decided);
    expect(w.ledger).not.toContain('scan:lookup:PBLRC25B');
    // The user's listing has no price yet, so it is refreshed (rule 5); it is not in the
    // results, so the check is recorded and no price is invented.
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'scan:lookup:PBLRC01B', 'scan:refresh:PBLRC25B']);
    expect(job.counts).toMatchObject({ lookupsDone: 1, refreshesDone: 1, partsMatched: 1 });
    expect(await w.store.getPrice('B0USERPICK0')).toEqual({ asin: 'B0USERPICK0', price: null, reviews: null, seenAt: null, checkedAt: T0 });
  });

  it('keeps a decision the user made while a job was interrupted (test J, continued)', async () => {
    const w = world();
    await expect(scan(w, { wrap: interruptOn(2) })).rejects.toThrow('interrupted');
    const user = (model: string, asin: string) => ({
      key: `RYOBI:${model}`, brand: 'RYOBI', model, status: 'matched' as const, asin, grade: null,
      alternatives: [], decidedBy: 'user' as const, updatedAt: T0, waitingSince: null,
    });
    await w.store.putMatch(user('PBLRC01B', 'B0USERPICK1'));
    await w.store.putMatch(user('PBLRC25B', 'B0USERPICK2'));

    // The saved queue still holds both lookups: PBLRC01B is answered from the cache,
    // PBLRC25B is refused by the budget and deferred. Neither changes the user's match.
    const job = await scan(w, { policy: { reserve: 0, maxPerRun: 0 } });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'run_cap' });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toEqual(user('PBLRC01B', 'B0USERPICK1'));
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(user('PBLRC25B', 'B0USERPICK2'));
  });

  it('keeps the old price of a listing missing at refresh time and records the check (test K)', async () => {
    const w = world();
    const later = T0 + 4 * DAY;
    w.clock = later;
    const gone = {
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'matched' as const, asin: 'B0GONE00000', grade: 'probable' as const,
      alternatives: [], decidedBy: 'auto' as const, updatedAt: T0, waitingSince: null,
    };
    const none = { ...gone, key: 'RYOBI:PBLRC01B', model: 'PBLRC01B', status: 'none' as const, asin: null, grade: null };
    await w.store.putMatch(gone);
    await w.store.putMatch(none);
    await w.store.putPrice({ asin: 'B0GONE00000', price: 150, reviews: 5, seenAt: T0, checkedAt: T0 });

    const job = await scan(w);
    expect(job).toMatchObject({ status: 'done', searchesUsed: 2 });
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 1 });
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'scan:refresh:PBLRC25B']);
    expect(await w.store.getPrice('B0GONE00000')).toEqual({ asin: 'B0GONE00000', price: 150, reviews: 5, seenAt: T0, checkedAt: later });
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(gone);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toEqual(none);

    // Two hours on, the check is fresh: only the listing page is paid for.
    w.clock = later + 120 * MINUTE;
    const next = await scan(w);
    expect(next).toMatchObject({ status: 'done', searchesUsed: 1 });
    expect(w.ledger.slice(2)).toEqual(['scan:listing:ryobi extended reach ratchet:p1']);
  });
});

describe('runScan: a lookup with no certain listing (rule 6)', () => {
  // A real DEWALT bundle (model and title from a Home Depot listing, core/test/fixtures.ts)
  // whose bonus tool DCF891B has a recorded Amazon search. Its only confirmed DEWALT listing
  // is B09YXXFPBJ; the other rows that show the model number are aftermarket parts
  // ("Gearcase for DeWalt DCF891N, DCF891B") whose brand Amazon does not confirm.
  const [bundleModel, bundleTitle] = fx.HD_DEWALT_BUNDLES[0]!;

  async function dewaltWorld(keep: (row: { asin: string; title: string }) => boolean) {
    const w = world();
    await w.store.putBundle({
      key: 'homedepot:seeded', retailer: 'homedepot', itemId: 'seeded', title: bundleTitle, brand: 'DEWALT', model: bundleModel,
      upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0, split: null,
    });
    await w.store.putCatalogEntry({
      key: 'DEWALT:DCF891B', brand: 'DEWALT', model: 'DCF891B', title: 'DCF891B (catalog entry seeded for this test)',
      kinds: ['impact wrench'], isKit: false, upc: null, seenAt: T0,
    });
    // The kit is not what this test is about: it was looked up before and nothing was found.
    await w.store.putMatch({
      key: 'DEWALT:DCK940D2', brand: 'DEWALT', model: 'DCK940D2', status: 'none', asin: null, grade: null,
      alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null,
    });
    const data = recorded('amazon-search-DCF891B') as { organic_results: { asin: string; title: string }[] };
    const response = { ...data, organic_results: data.organic_results.filter(keep) };
    const fetchFn = (async (input: string | URL | Request) =>
      String(input).includes('k=DEWALT+DCF891B') ? new Response(JSON.stringify(response), { status: 200 }) : w.replay.fetchFn(input)) as typeof fetch;
    const job = await scan(w, { settings: { ...DEFAULT_SCAN_SETTINGS, queries: [] }, fetchFn });
    return { w, job };
  }

  it('opens a review item when only unconfirmed listings show the model number', async () => {
    const { w, job } = await dewaltWorld((row) => row.asin !== 'B09YXXFPBJ');
    expect(job).toMatchObject({ status: 'done', searchesUsed: 1 });
    expect(job.counts).toMatchObject({ pagesFetched: 0, bundlesResolved: 1, lookupsDone: 1, partsMatched: 0, reviewsOpened: 1 });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toMatchObject({ status: 'review', asin: null, grade: null, alternatives: [], decidedBy: 'auto' });
    const item = await w.store.getReview('match:DEWALT:DCF891B');
    expect(item).toMatchObject({
      kind: 'match', subject: 'DEWALT:DCF891B', brand: 'DEWALT', model: 'DCF891B', title: 'DCF891B (catalog entry seeded for this test)',
      reason: '7 listing(s) show the model number, but the brand is not confirmed', openedAt: T0, answer: null, answeredAt: null,
    });
    expect(item!.candidates.map((c) => c.asin)).toEqual(['B0HQGDLWH9', 'B0HQG2WS5V', 'B0DXK936XN', 'B0FB3N5CN2', 'B0HQNL1PKM', 'B0FMXY44N7', 'B0G4QZ6X8T']);
    expect(item!.candidates[0]).toEqual({
      asin: 'B0HQGDLWH9', title: 'NA020584 Impact Wrench Gearcase for DeWalt DCF891N, DCF891B', price: 100.83, reviews: null,
      reasons: ['model number in the title, brand not confirmed'],
    });
    // Nothing is chosen, so nothing is priced.
    expect(await w.store.getPrice('B0HQGDLWH9')).toBeUndefined();
  });

  it('records "none" when no listing shows the model number', async () => {
    const { w, job } = await dewaltWorld((row) => !row.title.includes('DCF891'));
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 0, reviewsOpened: 0 });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toMatchObject({ status: 'none', asin: null, grade: null });
    expect(await w.store.listReview()).toEqual([]);
  });

  it('matches the confirmed listing when the full recorded response is answered', async () => {
    const { w, job } = await dewaltWorld(() => true);
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 1, reviewsOpened: 0 });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toMatchObject({ status: 'matched', asin: 'B09YXXFPBJ', grade: 'probable', alternatives: [] });
    expect(await w.store.getPrice('B09YXXFPBJ')).toEqual({ asin: 'B09YXXFPBJ', price: 185.73, reviews: 2200, seenAt: T0, checkedAt: T0 });
  });
});

describe('runScan: the label prefix', () => {
  it('starts every ledger label with the given prefix (test A shows the default, "scan")', async () => {
    const w = world();
    const budget = new SearchBudget(account(), OPEN);
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: w.cache, fetchFn: w.replay.fetchFn, now: () => w.clock, onSpend: (e) => void w.ledger.push(e.label) });
    await runScan({ client, budget, store: w.store, settings: RATCHET, now: () => w.clock, labelPrefix: 'demo' });
    expect(w.ledger).toEqual(['demo:listing:ryobi extended reach ratchet:p1', 'demo:lookup:PBLRC01B', 'demo:lookup:PBLRC25B']);
  });
});
