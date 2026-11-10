import { describe, expect, it } from 'vitest';

import { replayRecorded, type Replay } from '../../scripts/replay';
import { catalogEntry } from '../src/decompose';
import { listingFrom } from '../src/scan/listings';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { bundleKey, DEFAULT_SCAN_SETTINGS, type ScanJob, type ScanSettings, type ScanStore } from '../src/scan/types';
import { type BudgetPolicy, parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import { parseAmazonSearch } from '../src/serpapi/parsers';
import * as fx from './fixtures';
import { recorded, type RecordedName } from './recorded';

// Every search here goes through the real SerpApiClient and SearchBudget over the
// replay of fixtures/recorded/. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 9, 12); // one fixed clock for the client and the runner
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const account = (over = {}) => parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE, ...over });
// The step 2 tests (A to M and rule 6) run with the Amazon catalog phase off, so their pinned
// request lists stay exactly as recorded; the catalog tests (N1 to N7) turn it on.
const STEP2: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0 };
const RATCHET: ScanSettings = { ...STEP2, queries: [{ q: 'ryobi extended reach ratchet' }] };
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
  /** Default: the world's store. */
  store?: ScanStore;
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
  return runScan({ client, budget, store: opts.store ?? w.store, settings: opts.settings ?? RATCHET, now: () => w.clock });
}

/**
 * The world's store, except that the first job save matching `when` throws, as when the
 * service worker dies: the step's result is in the store, the save that records the step
 * never happens. Every other call goes to the world's store unchanged.
 */
function interruptSave(w: World, when: (job: ScanJob) => boolean): ScanStore {
  let thrown = false;
  return new Proxy(w.store, {
    get(target, prop) {
      if (prop === 'putScan') {
        return async (job: ScanJob) => {
          if (!thrown && when(job)) {
            thrown = true;
            throw new Error('interrupted');
          }
          return target.putScan(job);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Interrupted at the save after the first lookup (PBLRC01B): the job keeps both lookups queued. */
const afterFirstLookup = (w: World) => interruptSave(w, (job) => job.counts.lookupsDone === 1);

describe('runScan: the founder\'s bundle (test A)', () => {
  it('splits the ratchet bundles from one recorded page and matches both parts', async () => {
    const w = world();
    const job = await scan(w, { settings: RATCHET, policy: { reserve: 0, maxPerRun: 10 } });
    expect(job).toMatchObject({ id: String(T0), startedAt: T0, finishedAt: T0, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', searchesUsed: 3, queue: [], deferred: [] });
    expect(job.counts).toEqual({
      pagesFetched: 1, productsSeen: 18, bundlesSeen: 8, bundlesResolved: 2, reviewsOpened: 6, lookupsDone: 2, refreshesDone: 0, partsMatched: 2,
      catalogPages: 0, listingsSaved: 50, partsFromCatalog: 0,
    });
    // Every RYOBI row of both lookups is saved: 41 + 9 rows, 44 ASINs. Rows with no brand or
    // with brand "Amazon Renewed" are not.
    const listings = await w.store.listListings();
    expect(listings).toHaveLength(44);
    expect(listings.every((l) => l.brand === 'RYOBI')).toBe(true);
    expect(await w.store.getListing('B0B3JWF5ZV')).toMatchObject({
      brand: 'RYOBI', title: 'ONEAND HP 18V BRUSHLESS Cordless 3/8 in. Extended Reach Ratchet Tool ONLY PBLRC25B', models: ['PBLRC25B'],
      image: expect.stringMatching(/^https:\/\//), price: 169, reviews: 221, seenAt: T0, checkedAt: T0,
    });
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
    const job = await scan(w, { settings: { ...STEP2, queries: [{ q: 'dewalt 20v combo kit' }] } });
    expect(job).toMatchObject({ status: 'done', stopReason: null, searchesUsed: 1, queue: [], deferred: [] });
    expect(job.counts).toEqual({
      pagesFetched: 1, productsSeen: 24, bundlesSeen: 4, bundlesResolved: 0, reviewsOpened: 4, lookupsDone: 0, refreshesDone: 0, partsMatched: 0,
      catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0,
    });
    expect(await w.store.listListings()).toEqual([]);
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
    expect(second).toMatchObject({ id: String(T0 + 10 * MINUTE), status: 'done', stopReason: null, searchesUsed: 0, deferred: [] });
    // Step 2c rule 5: the first scan's PBLRC01B lookup saved B0B3JWF5ZV, whose title carries
    // PBLRC25B, so the waiting part is matched from that saved listing and nothing is searched.
    expect(second.counts).toMatchObject({ pagesFetched: 1, lookupsDone: 0, partsMatched: 1, reviewsOpened: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 1 });
    // The listing page came from the cache: two requests across both scans.
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
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
  it('continues the running job and answers the repeated step from the cache (also rule 3)', async () => {
    const w = world();
    // The PBLRC01B lookup is paid, cached and applied; the save that records the step fails.
    await expect(scan(w, { store: afterFirstLookup(w) })).rejects.toThrow('interrupted');
    const [saved] = await w.store.listScans();
    expect(saved).toMatchObject({ id: String(T0), status: 'running', phase: 'parts', searchesUsed: 1, finishedAt: null });
    expect(saved!.counts.lookupsDone).toBe(0);
    expect(saved!.counts.listingsSaved).toBe(0);
    // Rule 3: the rows of the PBLRC01B response were saved before the job save was attempted.
    expect(await w.store.listListings()).toHaveLength(41);
    expect(saved!.queue).toEqual([
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' },
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' },
    ]);
    // Rule 3: the step's result reached the store before the job save was attempted.
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK' });
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
    // The PBLRC01B rows were saved before the interruption and are saved again from the cache:
    // the continued job counts the rows it saved, 41 + 9.
    expect(job.counts).toEqual({
      pagesFetched: 1, productsSeen: 18, bundlesSeen: 8, bundlesResolved: 2, reviewsOpened: 6, lookupsDone: 2, refreshesDone: 0, partsMatched: 2,
      catalogPages: 0, listingsSaved: 50, partsFromCatalog: 0,
    });
    expect(await w.store.listListings()).toHaveLength(44);
    expect(await w.store.listScans()).toHaveLength(1);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK' });
  });

  it('continues a job interrupted during the listing phase, without fetching the page again', async () => {
    const w = world();
    await expect(scan(w, { store: interruptSave(w, (job) => job.counts.pagesFetched === 1) })).rejects.toThrow('interrupted');
    expect((await w.store.listScans())[0]).toMatchObject({ status: 'running', phase: 'listing', searchesUsed: 0, queue: [{ kind: 'listing', page: 1 }] });

    // Two hours later the page is older than listingMaxAgeMs, but it belongs to this job.
    w.clock = T0 + 120 * MINUTE;
    const job = await scan(w);
    expect(job).toMatchObject({ id: String(T0), status: 'done', searchesUsed: 2 });
    expect(job.counts).toMatchObject({ pagesFetched: 1, bundlesResolved: 2, lookupsDone: 2, catalogPages: 0, listingsSaved: 50, partsFromCatalog: 0 });
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B]);
  });

  it('stops, not "running", when a search fails in an unexpected way (test E2)', async () => {
    const w = world();
    // HTTP 200 with a body that is not JSON: the client's res.json() throws a SyntaxError.
    const amazon = failing(w, 'engine=amazon', 200, 'not json');
    const job = await scan(w, { fetchFn: amazon.fetchFn });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'error', phase: 'finish', searchesUsed: 1, queue: [] });
    expect(job.stopMessage).toEqual(expect.stringMatching(/\S/));
    expect((await w.store.listScans())[0]!.status).not.toBe('running');
    expect((await w.store.listMatches()).map((m) => [m.key, m.status])).toEqual([
      ['RYOBI:PBLRC01B', 'waiting'],
      ['RYOBI:PBLRC25B', 'waiting'],
    ]);
    expect(amazon.failed).toHaveLength(1);

    // The next run starts a new job (ids are the start time, so the clock moves on).
    w.clock = T0 + MINUTE;
    const next = await scan(w);
    expect(next.id).not.toBe(job.id);
    expect(next).toMatchObject({ id: String(T0 + MINUTE), status: 'done' });
    expect((await w.store.listScans()).map((j) => j.id)).toEqual([String(T0 + MINUTE), String(T0)]);
  });

  it('finishes a continued job whose parts queue is empty', async () => {
    const w = world();
    await w.store.putScan({
      id: '1', startedAt: T0 - MINUTE, finishedAt: null, status: 'running', stopReason: null, stopMessage: null,
      phase: 'parts', queue: [], deferred: [], searchesUsed: 4,
      counts: { pagesFetched: 1, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 3, refreshesDone: 0, partsMatched: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0 },
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
    expect(job.counts).toMatchObject({ pagesFetched: 1, lookupsDone: 0, refreshesDone: 0, reviewsOpened: 0, bundlesResolved: 2, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0 });
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
    // A refresh saves every row of its response, as a lookup does: 41 + 9 rows again.
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 2, partsMatched: 0, catalogPages: 0, listingsSaved: 50, partsFromCatalog: 0 });
    expect(await w.store.listListings()).toHaveLength(44);
    expect(await w.store.getListing('B0B3JWF5ZV')).toMatchObject({ price: 169, seenAt: later, checkedAt: later });
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

/** The replay, except that requests whose URL contains `match` get an HTTP `status` reply with `body`. */
function failing(w: World, match: string, status: number, body = JSON.stringify({ error: 'refused' })) {
  const failed: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(match)) {
      failed.push(url);
      return new Response(body, { status });
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
    expect(job.counts).toMatchObject({ lookupsDone: 0, bundlesResolved: 2, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0 });
    expect(await w.store.listListings()).toEqual([]);
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
    expect(job.counts).toMatchObject({ pagesFetched: 1, bundlesResolved: 2, reviewsOpened: 6, lookupsDone: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0 });
    expect(hd.failed).toHaveLength(1);
    expect(w.replay.calls).toEqual([LISTING]);
    expect((await w.store.listMatches()).map((m) => m.status)).toEqual(['waiting', 'waiting']);
  });

  it('a continued job whose budget refuses stops cleanly instead of staying running', async () => {
    const w = world();
    await expect(scan(w, { store: afterFirstLookup(w) })).rejects.toThrow('interrupted');

    // No searches allowed: PBLRC01B comes from the cache, PBLRC25B is refused.
    const job = await scan(w, { policy: { reserve: 0, maxPerRun: 0 } });
    expect(job).toMatchObject({ id: String(T0), status: 'stopped', stopReason: 'run_cap', stopMessage: null, searchesUsed: 1, queue: [] });
    expect(job.deferred).toEqual([{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' }]);
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 1, catalogPages: 0, listingsSaved: 41, partsFromCatalog: 0 });
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
    expect(job.counts).toMatchObject({ productsSeen: 16, bundlesSeen: 8, catalogPages: 0, listingsSaved: 50, partsFromCatalog: 0 });
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
    // The PBLRC01B lookup and the PBLRC25B refresh both save their rows: 41 + 9.
    expect(job.counts).toMatchObject({ lookupsDone: 1, refreshesDone: 1, partsMatched: 1, catalogPages: 0, listingsSaved: 50, partsFromCatalog: 0 });
    expect(await w.store.getPrice('B0USERPICK0')).toEqual({ asin: 'B0USERPICK0', price: null, reviews: null, seenAt: null, checkedAt: T0 });
  });

  it('keeps a decision the user made while a job was interrupted (test J, continued)', async () => {
    const w = world();
    await expect(scan(w, { store: afterFirstLookup(w) })).rejects.toThrow('interrupted');
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
    // The lookup skipped for the user's decision still saves the rows of its response.
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 0, catalogPages: 0, listingsSaved: 41, partsFromCatalog: 0 });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toEqual(user('PBLRC01B', 'B0USERPICK1'));
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(user('PBLRC25B', 'B0USERPICK2'));
  });

  it('sends nothing for a user decision that is waiting (test N)', async () => {
    const w = world();
    const decided = {
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'waiting' as const, asin: null, grade: null,
      alternatives: [], decidedBy: 'user' as const, updatedAt: T0 - 1000, waitingSince: T0 - 1000,
    };
    await w.store.putMatch(decided);
    const job = await scan(w);
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'scan:lookup:PBLRC01B']);
    expect(w.ledger.filter((label) => label.endsWith(':PBLRC25B'))).toEqual([]);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B]);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(decided);
    expect(job).toMatchObject({ status: 'done', searchesUsed: 2, deferred: [] });
    expect(job.counts).toMatchObject({ lookupsDone: 1, refreshesDone: 0, catalogPages: 0, listingsSaved: 41, partsFromCatalog: 0 });
  });

  it('never erases a stored barcode with a search row (test L)', async () => {
    const w = world();
    // The bundle's barcode is from its Home Depot page (core/test/fixtures.ts, HD_BUNDLE).
    await w.store.putBundle({
      key: 'homedepot:328814689', retailer: 'homedepot', itemId: fx.HD_BUNDLE.productID, title: fx.HD_BUNDLE.title, brand: 'RYOBI', model: fx.HD_BUNDLE.model,
      upc: fx.HD_BUNDLE.upc, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0 - DAY, split: null,
    });
    await w.store.putCatalogEntry({
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', title: 'ONE+ HP 18V Brushless Cordless 3/8 in. Extended Reach Ratchet (Tool Only)',
      kinds: ['ratchet'], isKit: false, upc: '033287193721', seenAt: T0 - DAY,
    });
    await scan(w);
    // The row replaces what it carries (price, seenAt) and keeps what it does not (the barcode).
    expect(await w.store.getBundle('homedepot:328814689')).toMatchObject({
      upc: '033287232581', price: 189, regularPrice: 338, percentOff: 44, seenAt: T0, split: { status: 'resolved' },
    });
    expect(await w.store.getCatalogEntry('RYOBI:PBLRC25B')).toMatchObject({ upc: '033287193721', seenAt: T0 });
    // Records with no stored barcode still get null.
    expect(await w.store.getCatalogEntry('RYOBI:PBLRC01B')).toMatchObject({ upc: null });
    expect(await w.store.getBundle('homedepot:318045287')).toMatchObject({ upc: null });
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
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 1, catalogPages: 0, listingsSaved: 9, partsFromCatalog: 0 });
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

describe('runScan: a part that always fails does not block the others (test M)', () => {
  /** The replay, except that a request whose decoded `k` is RYOBI PBLRC01B gets HTTP 500. Logs every `k` sent. */
  function failing01B(w: World) {
    const sent: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const k = new URL(String(input instanceof Request ? input.url : input)).searchParams.get('k');
      if (k !== null) sent.push(k);
      if (k === 'RYOBI PBLRC01B') return new Response(JSON.stringify({ error: 'refused' }), { status: 500 });
      return w.replay.fetchFn(input);
    }) as typeof fetch;
    return { fetchFn, sent };
  }

  async function secondScan(w: World, fetchFn: typeof fetch) {
    w.clock = T0 + 10 * MINUTE;
    const job = await scan(w, { fetchFn });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'error', searchesUsed: 1 });
    expect(job.stopMessage).toMatch(/HTTP 500/);
    expect(job.deferred).toEqual([{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' }]);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', waitingSince: null });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'waiting', waitingSince: T0 });
    return job;
  }

  it('tries the part that failed last time after the others', async () => {
    const w = world();
    const amazon = failing01B(w);
    const first = await scan(w, { fetchFn: amazon.fetchFn });
    expect(first).toMatchObject({ status: 'stopped', stopReason: 'error' });
    expect(first.deferred[0]).toEqual({ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' });
    expect((await w.store.listMatches()).map((m) => [m.key, m.status])).toEqual([
      ['RYOBI:PBLRC01B', 'waiting'],
      ['RYOBI:PBLRC25B', 'waiting'],
    ]);

    await secondScan(w, amazon.fetchFn);
    // PBLRC25B first in the second scan; PBLRC01B twice in all, PBLRC25B once.
    expect(amazon.sent).toEqual(['RYOBI PBLRC01B', 'RYOBI PBLRC25B', 'RYOBI PBLRC01B']);
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_25B]);
  });

  it('knows the failed step when other work was already deferred by the budget', async () => {
    const w = world();
    const amazon = failing01B(w);
    // Room for the page and one lookup: PBLRC25B is deferred by the run cap, then PBLRC01B fails.
    const first = await scan(w, { fetchFn: amazon.fetchFn, policy: { reserve: 0, maxPerRun: 2 } });
    expect(first).toMatchObject({ status: 'stopped', stopReason: 'error' });
    expect(first.deferred).toEqual([
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC01B' },
      { kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' },
    ]);

    await secondScan(w, amazon.fetchFn);
    expect(amazon.sent).toEqual(['RYOBI PBLRC01B', 'RYOBI PBLRC25B', 'RYOBI PBLRC01B']);
  });
});

describe('runScan: a lookup with no certain listing (rule 6)', () => {
  // A real DEWALT bundle (model and title from a Home Depot listing, core/test/fixtures.ts)
  // whose bonus tool DCF891B has a recorded Amazon search. Its only confirmed DEWALT listing
  // is B09YXXFPBJ; the other rows that show the model number are aftermarket parts
  // ("Gearcase for DeWalt DCF891N, DCF891B") whose brand Amazon does not confirm.
  const [bundleModel, bundleTitle] = fx.HD_DEWALT_BUNDLES[0]!;

  async function dewaltWorld(keep: (row: { asin: string; title: string }) => boolean, settings: ScanSettings = { ...STEP2, queries: [] }) {
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
    const job = await scan(w, { settings, fetchFn });
    return { w, job };
  }

  it('opens a review item when only unconfirmed listings show the model number', async () => {
    const { w, job } = await dewaltWorld((row) => row.asin !== 'B09YXXFPBJ');
    expect(job).toMatchObject({ status: 'done', searchesUsed: 1 });
    // The 33 DEWALT rows left in the response are saved; the review candidates are rows with no brand.
    expect(job.counts).toMatchObject({ pagesFetched: 0, bundlesResolved: 1, lookupsDone: 1, partsMatched: 0, reviewsOpened: 1, catalogPages: 0, listingsSaved: 33, partsFromCatalog: 0 });
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
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 0, reviewsOpened: 0, catalogPages: 0, listingsSaved: 32, partsFromCatalog: 0 });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toMatchObject({ status: 'none', asin: null, grade: null });
    expect(await w.store.listReview()).toEqual([]);
  });

  it('matches the confirmed listing when the full recorded response is answered', async () => {
    const { w, job } = await dewaltWorld(() => true);
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 1, reviewsOpened: 0, catalogPages: 0, listingsSaved: 34, partsFromCatalog: 0 });
    expect(await w.store.getMatch('DEWALT:DCF891B')).toMatchObject({ status: 'matched', asin: 'B09YXXFPBJ', grade: 'probable', alternatives: [] });
    expect(await w.store.getPrice('B09YXXFPBJ')).toEqual({ asin: 'B09YXXFPBJ', price: 185.73, reviews: 2200, seenAt: T0, checkedAt: T0 });
    // 34 DEWALT rows; the 25 rows with no brand and the Amazon Renewed row are not saved.
    const listings = await w.store.listListings();
    expect(listings).toHaveLength(34);
    expect(listings.every((l) => l.brand === 'DEWALT')).toBe(true);
    // The aftermarket gearcase has no brand on Amazon, so it is not saved, whatever its title says.
    expect(await w.store.getListing('B0HQGDLWH9')).toBeUndefined();
  });

  it('saves only rows of the brands in the settings', async () => {
    const { w, job } = await dewaltWorld(() => true, { ...STEP2, brands: ['RYOBI'], queries: [] });
    // The seeded DEWALT bundle is still split and looked up; its DEWALT rows are not saved.
    expect(job.counts).toMatchObject({ lookupsDone: 1, partsMatched: 1, listingsSaved: 0 });
    expect(await w.store.listListings()).toEqual([]);
    expect(await w.store.getMatch('DEWALT:DCF891B')).toMatchObject({ status: 'matched', asin: 'B09YXXFPBJ' });
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

// ---------------------------------------------------------------- step 2c: the Amazon catalog phase

const DEWALT_PAGE = 'amazon_domain=amazon.com&engine=amazon&k=DEWALT&rh=p_123:195991';
const RYOBI_PAGE = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI&rh=p_123:252605';
const DEWALT_COMBO = 'engine=home_depot&page=1&q=dewalt 20v combo kit';
/** One DEWALT brand page, then the recorded DEWALT combo page (test B's page). */
const CATALOG: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, brands: ['DEWALT'], queries: [{ q: 'dewalt 20v combo kit' }], catalogPagesPerScan: 1 };

describe('runScan: a bundle resolved and matched from the catalog alone (test N1)', () => {
  it('reads the DEWALT brand page, splits DCK540D1WCS334B with its models, and matches both parts with no lookup', async () => {
    const w = world();
    const job = await scan(w, { settings: CATALOG, policy: { reserve: 0, maxPerRun: 10 } });
    expect(w.replay.calls).toEqual([DEWALT_PAGE, DEWALT_COMBO]);
    expect(w.ledger).toEqual(['scan:catalog:DEWALT:p1', 'scan:listing:dewalt 20v combo kit:p1']);
    expect(job).toMatchObject({ status: 'done', stopReason: null, stopMessage: null, searchesUsed: 2, queue: [], deferred: [] });
    expect(job.counts).toMatchObject({
      catalogPages: 1, listingsSaved: 60, bundlesSeen: 4, bundlesResolved: 1, reviewsOpened: 3, lookupsDone: 0, partsFromCatalog: 2, partsMatched: 2,
    });
    expect((await w.store.getBundle('homedepot:343992133'))!.split).toMatchObject({ status: 'resolved', components: ['DCK540D1', 'DCS334B'] });
    expect(await w.store.getMatch('DEWALT:DCK540D1')).toMatchObject({ status: 'matched', asin: 'B0GQ6QKPWF', grade: 'probable', decidedBy: 'auto', waitingSince: null });
    expect(await w.store.getMatch('DEWALT:DCS334B')).toMatchObject({ status: 'matched', asin: 'B07JPFHQKG', grade: 'probable', decidedBy: 'auto', waitingSince: null });
    // The price record is the saved listing's.
    const listing = await w.store.getListing('B07JPFHQKG');
    expect(await w.store.getPrice('B07JPFHQKG')).toEqual({ asin: 'B07JPFHQKG', price: 123, reviews: listing!.reviews, seenAt: T0, checkedAt: T0 });
    expect(await w.store.getCursor('DEWALT')).toEqual({ brand: 'DEWALT', nextPage: 2, passes: 0, updatedAt: T0 });
    expect((await w.store.listReview()).map((r) => r.id)).toEqual(['split:homedepot:337440459', 'split:homedepot:337440461', 'split:homedepot:343992132']);
    const row = (await buildReport(w.store, CATALOG)).bundles.find((b) => b.key === 'homedepot:343992133');
    expect(row).toMatchObject({ section: 'confirmed', estimate: { cost: 499, netRevenue: 486.2, profit: -12.8, roi: -0.0257 } });
  });
});

describe('runScan: the catalog takes at most a fifth of the allowance (test N2)', () => {
  it('reads no brand page when a fifth of the allowance rounds down to 0, and is still done', async () => {
    const w = world();
    const job = await scan(w, { settings: CATALOG, policy: { reserve: 0, maxPerRun: 4 } });
    expect(w.replay.calls).toEqual([DEWALT_COMBO]);
    expect(job).toMatchObject({ status: 'done', stopReason: null, searchesUsed: 1, queue: [], deferred: [] });
    expect(job.counts).toMatchObject({ catalogPages: 0, listingsSaved: 0, pagesFetched: 1, bundlesResolved: 0, partsFromCatalog: 0 });
    expect(await w.store.getCursor('DEWALT')).toBeUndefined();
  });
});

const HOUR = 60 * MINUTE;

/**
 * The replay, except that a brand page request (one with `rh`) for a page after 1 is answered
 * with `answer(brand, page)`. Logs every brand page request as `<k>:page=<page>`, or
 * `<k>:no page` when the request has no page parameter.
 */
function brandPages(w: World, answer: (k: string, page: number) => unknown) {
  const sent: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const params = new URL(String(input instanceof Request ? input.url : input)).searchParams;
    if (params.has('rh')) {
      const page = params.get('page');
      sent.push(`${params.get('k')}:${page === null ? 'no page' : `page=${page}`}`);
      if (page !== null && page !== '1') return new Response(JSON.stringify(answer(params.get('k')!, Number(page))), { status: 200 });
    }
    return w.replay.fetchFn(input);
  }) as typeof fetch;
  return { fetchFn, sent };
}

/** A brand page recording with no link to a next page, as Amazon's last page of a brand has none. */
function lastPage(name: 'amazon-brand-dewalt-p1' | 'amazon-brand-ryobi-p1'): unknown {
  const data = { ...(recorded(name) as Record<string, unknown>) };
  delete data.serpapi_pagination;
  return data;
}

describe('runScan: the crawl continues across scans (test N3)', () => {
  it('reads the page the cursor points at, and after the last page starts the next pass', async () => {
    const w = world();
    await w.store.putCursor({ brand: 'DEWALT', nextPage: 2, passes: 0, updatedAt: T0 - DAY });
    const pages = brandPages(w, () => lastPage('amazon-brand-dewalt-p1'));
    const job = await scan(w, { settings: CATALOG, fetchFn: pages.fetchFn });
    expect(pages.sent).toEqual(['DEWALT:page=2']);
    expect(w.ledger).toEqual(['scan:catalog:DEWALT:p2', 'scan:listing:dewalt 20v combo kit:p1']);
    expect(w.replay.calls).toEqual([DEWALT_COMBO]);
    expect(job).toMatchObject({ status: 'done', stopMessage: null, searchesUsed: 2 });
    expect(job.counts).toMatchObject({ catalogPages: 1, listingsSaved: 60 });
    expect(await w.store.getCursor('DEWALT')).toEqual({ brand: 'DEWALT', nextPage: 1, passes: 1, updatedAt: T0 });
  });

  it('drops the later pages planned for a brand once its last page is read, without deferring them', async () => {
    const w = world();
    await w.store.putCursor({ brand: 'DEWALT', nextPage: 2, passes: 0, updatedAt: T0 - DAY });
    const pages = brandPages(w, () => lastPage('amazon-brand-dewalt-p1'));
    // Pages 2 and 3 are planned; page 2 turns out to be the last.
    const job = await scan(w, { settings: { ...CATALOG, catalogPagesPerScan: 2 }, fetchFn: pages.fetchFn });
    expect(pages.sent).toEqual(['DEWALT:page=2']);
    expect(job).toMatchObject({ status: 'done', stopReason: null, queue: [], deferred: [] });
    expect(job.counts.catalogPages).toBe(1);
    expect(await w.store.getCursor('DEWALT')).toMatchObject({ nextPage: 1, passes: 1 });
  });
});

describe('runScan: a brand page that fails (test N4)', () => {
  it('skips the page, reads the Home Depot page, and is done; the cursor stays where it was', async () => {
    const w = world();
    const seeded = { brand: 'DEWALT', nextPage: 1, passes: 3, updatedAt: T0 - DAY };
    await w.store.putCursor(seeded);
    const amazon = failing(w, 'rh=', 500);
    const job = await scan(w, { settings: CATALOG, fetchFn: amazon.fetchFn });
    expect(amazon.failed).toHaveLength(1);
    expect(w.replay.calls).toEqual([DEWALT_COMBO]);
    expect(w.ledger).toEqual(['scan:listing:dewalt 20v combo kit:p1']);
    expect(job).toMatchObject({ status: 'done', stopReason: null, searchesUsed: 1, queue: [], deferred: [] });
    expect(job.stopMessage).toMatch(/HTTP 500/);
    expect(job.stopMessage).toBe('The DEWALT Amazon page 1 was skipped: SerpApi returned HTTP 500.');
    expect(job.counts).toMatchObject({ catalogPages: 0, listingsSaved: 0, pagesFetched: 1, bundlesResolved: 0, partsFromCatalog: 0 });
    expect(await w.store.getCursor('DEWALT')).toEqual(seeded);
  });

  it('still reads the other brands\' pages', async () => {
    const w = world();
    const amazon = failing(w, 'k=DEWALT&rh=', 500);
    const job = await scan(w, { settings: { ...CATALOG, brands: ['DEWALT', 'RYOBI'], catalogPagesPerScan: 2 }, fetchFn: amazon.fetchFn });
    expect(amazon.failed).toHaveLength(1);
    expect(w.replay.calls).toEqual([RYOBI_PAGE, DEWALT_COMBO]);
    expect(job).toMatchObject({ status: 'done', stopReason: null, stopMessage: 'The DEWALT Amazon page 1 was skipped: SerpApi returned HTTP 500.' });
    expect(job.counts).toMatchObject({ catalogPages: 1, listingsSaved: 51 });
    expect(await w.store.getCursor('DEWALT')).toBeUndefined();
    expect(await w.store.getCursor('RYOBI')).toEqual({ brand: 'RYOBI', nextPage: 2, passes: 0, updatedAt: T0 });
  });

  it('a 429 on a brand page stops the scan as on any step', async () => {
    const w = world();
    const amazon = failing(w, 'rh=', 429);
    const job = await scan(w, { settings: CATALOG, fetchFn: amazon.fetchFn });
    expect(amazon.failed).toHaveLength(1);
    expect(w.replay.calls).toEqual([]);
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'rate_limited', searchesUsed: 0, queue: [] });
    expect(job.stopMessage).toMatch(/hourly limit reached or no searches left/);
    expect(job.deferred).toEqual([
      { kind: 'catalog', brand: 'DEWALT', page: 1 },
      { kind: 'listing', q: 'dewalt 20v combo kit', page: 1, filterTokens: null, bundlesOnly: false },
    ]);
    expect(await w.store.getCursor('DEWALT')).toBeUndefined();
  });
});

describe('runScan: brands in turn (test N5)', () => {
  it('reads the DEWALT page then the RYOBI page when neither brand has a cursor', async () => {
    const w = world();
    const job = await scan(w, { settings: { ...RATCHET, brands: ['DEWALT', 'RYOBI'], catalogPagesPerScan: 2 }, policy: { reserve: 0, maxPerRun: 10 } });
    expect(w.replay.calls.slice(0, 2)).toEqual([DEWALT_PAGE, RYOBI_PAGE]);
    expect(w.ledger.slice(0, 2)).toEqual(['scan:catalog:DEWALT:p1', 'scan:catalog:RYOBI:p1']);
    expect(job).toMatchObject({ status: 'done' });
    expect(job.counts).toMatchObject({ catalogPages: 2 });
    expect(await w.store.getCursor('DEWALT')).toMatchObject({ nextPage: 2, passes: 0 });
    expect(await w.store.getCursor('RYOBI')).toMatchObject({ nextPage: 2, passes: 0 });
  });

  it('starts with the brand whose cursor moved longest ago, and each brand reads on from its cursor', async () => {
    const w = world();
    await w.store.putCursor({ brand: 'DEWALT', nextPage: 5, passes: 1, updatedAt: T0 - HOUR });
    await w.store.putCursor({ brand: 'RYOBI', nextPage: 2, passes: 0, updatedAt: T0 - DAY });
    const pages = brandPages(w, (k) => recorded(k === 'DEWALT' ? 'amazon-brand-dewalt-p1' : 'amazon-brand-ryobi-p1'));
    const settings = { ...CATALOG, brands: ['DEWALT', 'RYOBI'], catalogPagesPerScan: 3 };
    // floor(15 * 0.2) = 3: all three pages fit.
    const job = await scan(w, { settings, policy: { reserve: 0, maxPerRun: 15 }, fetchFn: pages.fetchFn });
    expect(pages.sent).toEqual(['RYOBI:page=2', 'DEWALT:page=5', 'RYOBI:page=3']);
    expect(w.ledger.slice(0, 3)).toEqual(['scan:catalog:RYOBI:p2', 'scan:catalog:DEWALT:p5', 'scan:catalog:RYOBI:p3']);
    expect(job.counts.catalogPages).toBe(3);
    expect(await w.store.getCursor('RYOBI')).toEqual({ brand: 'RYOBI', nextPage: 4, passes: 0, updatedAt: T0 });
    expect(await w.store.getCursor('DEWALT')).toEqual({ brand: 'DEWALT', nextPage: 6, passes: 1, updatedAt: T0 });
  });

  it('reads at most a fifth of the allowance, skips a brand with no filter, and defers nothing', async () => {
    const w = world();
    // Five pages wanted, floor(10 * 0.2) = 2 read. MILWAUKEE has no Amazon brand filter.
    const settings = { ...CATALOG, brands: ['MILWAUKEE', 'RYOBI', 'DEWALT'], catalogPagesPerScan: 5 };
    const job = await scan(w, { settings, policy: { reserve: 0, maxPerRun: 10 } });
    expect(w.replay.calls.slice(0, 3)).toEqual([DEWALT_PAGE, RYOBI_PAGE, DEWALT_COMBO]);
    expect(w.ledger.filter((label) => label.includes(':catalog:'))).toEqual(['scan:catalog:DEWALT:p1', 'scan:catalog:RYOBI:p1']);
    expect(job).toMatchObject({ status: 'done', stopReason: null, deferred: [] });
    expect(job.counts.catalogPages).toBe(2);
    expect(await w.store.getCursor('MILWAUKEE')).toBeUndefined();
  });
});

describe('runScan: an interrupted catalog step (2c rules 2 and 3 with rule 3 of step 2)', () => {
  const afterCatalogStep = (w: World) => interruptSave(w, (job) => job.counts.catalogPages === 1);

  it('repeats the step from the cache when continued, and moves the cursor only once', async () => {
    const w = world();
    await expect(scan(w, { settings: CATALOG, store: afterCatalogStep(w) })).rejects.toThrow('interrupted');
    const [saved] = await w.store.listScans();
    expect(saved).toMatchObject({ status: 'running', phase: 'listing', searchesUsed: 0, queue: [{ kind: 'catalog', brand: 'DEWALT', page: 1 }, { kind: 'listing' }] });
    expect(saved!.counts.catalogPages).toBe(0);
    // The store first: the listings and the cursor were saved before the job save was attempted.
    expect(await w.store.listListings()).toHaveLength(60);
    expect(await w.store.getCursor('DEWALT')).toEqual({ brand: 'DEWALT', nextPage: 2, passes: 0, updatedAt: T0 });

    w.clock = T0 + 5 * MINUTE;
    const job = await scan(w, { settings: CATALOG });
    expect(job).toMatchObject({ id: String(T0), status: 'done', searchesUsed: 1 });
    expect(job.counts).toMatchObject({ catalogPages: 1, listingsSaved: 60, partsFromCatalog: 2 });
    expect(w.replay.calls).toEqual([DEWALT_PAGE, DEWALT_COMBO]);
    expect(w.ledger).toEqual(['scan:catalog:DEWALT:p1', 'scan:listing:dewalt 20v combo kit:p1']);
    expect(await w.store.getCursor('DEWALT')).toEqual({ brand: 'DEWALT', nextPage: 2, passes: 0, updatedAt: T0 + 5 * MINUTE });
  });

  it('counts a pass once when the step repeated is a brand\'s last page', async () => {
    const w = world();
    await w.store.putCursor({ brand: 'DEWALT', nextPage: 2, passes: 0, updatedAt: T0 - DAY });
    const pages = brandPages(w, () => lastPage('amazon-brand-dewalt-p1'));
    await expect(scan(w, { settings: CATALOG, fetchFn: pages.fetchFn, store: afterCatalogStep(w) })).rejects.toThrow('interrupted');
    expect(await w.store.getCursor('DEWALT')).toEqual({ brand: 'DEWALT', nextPage: 1, passes: 1, updatedAt: T0 });

    w.clock = T0 + 5 * MINUTE;
    const job = await scan(w, { settings: CATALOG, fetchFn: pages.fetchFn });
    expect(job).toMatchObject({ id: String(T0), status: 'done' });
    expect(pages.sent).toEqual(['DEWALT:page=2']);
    expect(await w.store.getCursor('DEWALT')).toEqual({ brand: 'DEWALT', nextPage: 1, passes: 1, updatedAt: T0 + 5 * MINUTE });
  });

  it('a continued job whose budget refuses a brand page stops cleanly instead of staying running', async () => {
    const w = world();
    const settings = { ...CATALOG, brands: ['DEWALT', 'RYOBI'], catalogPagesPerScan: 2 };
    await expect(scan(w, { settings, store: afterCatalogStep(w) })).rejects.toThrow('interrupted');

    // No searches allowed: the DEWALT page comes from the cache, the RYOBI page is refused.
    const job = await scan(w, { settings, policy: { reserve: 0, maxPerRun: 0 } });
    expect(job).toMatchObject({ id: String(T0), status: 'stopped', stopReason: 'run_cap', stopMessage: null, searchesUsed: 0, queue: [] });
    expect(job.deferred).toEqual([
      { kind: 'catalog', brand: 'RYOBI', page: 1 },
      { kind: 'listing', q: 'dewalt 20v combo kit', page: 1, filterTokens: null, bundlesOnly: false },
    ]);
    expect(job.counts).toMatchObject({ catalogPages: 1, listingsSaved: 60, pagesFetched: 0 });
    expect(w.replay.calls).toEqual([DEWALT_PAGE]);
    expect(await w.store.getCursor('DEWALT')).toMatchObject({ nextPage: 2, passes: 0 });
    expect(await w.store.getCursor('RYOBI')).toBeUndefined();
    expect((await w.store.listScans())[0]!.status).toBe('stopped');
  });
});

/** Saves every RYOBI row of a recorded Amazon response as a listing seen at `at`, as a scan would have. */
async function savedRows(w: World, name: RecordedName, at: number): Promise<void> {
  for (const c of parseAmazonSearch(recorded(name))) {
    const record = listingFrom(c, ['RYOBI'], at, await w.store.getListing(c.asin));
    if (record) await w.store.putListing(record);
  }
}

describe('runScan: saved listings do not loosen matching (test N6)', () => {
  it('rejects a saved kit listing for a single tool exactly as pick() rejects a search row, and looks the part up', async () => {
    const w = world();
    await w.store.putListing({
      asin: 'B0KIT000000', brand: 'RYOBI', title: 'RYOBI PBLRC25B 3/8 in. Ratchet Kit with Battery and Charger', models: ['PBLRC25B'],
      image: null, price: 229, reviews: 5000, seenAt: T0 - MINUTE, checkedAt: T0 - MINUTE,
    });
    const job = await scan(w, { settings: { ...RATCHET, catalogPagesPerScan: 0 } });
    expect(w.replay.calls).toEqual([LISTING, LOOKUP_01B, LOOKUP_25B]);
    expect(w.ledger).toContain('scan:lookup:PBLRC25B');
    expect(job).toMatchObject({ status: 'done', searchesUsed: 3 });
    expect(job.counts).toMatchObject({ lookupsDone: 2, partsMatched: 2, partsFromCatalog: 0 });
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', grade: 'probable', decidedBy: 'auto' });
    // The kit is never priced as the part.
    expect(await w.store.getPrice('B0KIT000000')).toBeUndefined();
  });
});

describe('runScan: a user decision is untouched by matching from saved listings (test N7)', () => {
  // The rows of the recorded PBLRC25B search, saved before the scan: they carry both parts,
  // PBLRC25B as B0B3JWF5ZV and PBLRC01B as B0B6Z2ZGVK.
  it('keeps a decided match and does not match it from a saved listing (as test J)', async () => {
    const w = world();
    await savedRows(w, 'amazon-search-PBLRC25B', T0 - MINUTE);
    const decided = {
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'matched' as const, asin: 'B0USERPICK0', grade: null,
      alternatives: [], decidedBy: 'user' as const, updatedAt: T0 - DAY, waitingSince: null,
    };
    await w.store.putMatch(decided);
    const job = await scan(w);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(decided);
    // PBLRC01B is matched from its saved listing; the user's listing has no price, so it is refreshed (rule 5).
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'scan:refresh:PBLRC25B']);
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 1, partsFromCatalog: 1, partsMatched: 1 });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK', grade: 'probable', decidedBy: 'auto' });
    expect(await w.store.getPrice('B0B3JWF5ZV')).toBeUndefined();
  });

  it('keeps a user decision that is waiting, and neither looks it up nor matches it', async () => {
    const w = world();
    await savedRows(w, 'amazon-search-PBLRC25B', T0 - MINUTE);
    const decided = {
      key: 'RYOBI:PBLRC25B', brand: 'RYOBI', model: 'PBLRC25B', status: 'waiting' as const, asin: null, grade: null,
      alternatives: [], decidedBy: 'user' as const, updatedAt: T0 - 1000, waitingSince: T0 - 1000,
    };
    await w.store.putMatch(decided);
    const job = await scan(w);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toEqual(decided);
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1']);
    expect(job).toMatchObject({ status: 'done', searchesUsed: 1 });
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 0, partsFromCatalog: 1, partsMatched: 1 });
  });
});

describe('runScan: a part matched from an old saved listing', () => {
  it('takes the listing\'s price and age, and refreshes it in the same scan when it is stale', async () => {
    const w = world();
    const seen = T0 - 4 * DAY;
    await savedRows(w, 'amazon-search-PBLRC25B', seen);
    const job = await scan(w);
    // No lookup: both parts are matched from saved listings; both prices are older than freshnessMs.
    expect(job.counts).toMatchObject({ lookupsDone: 0, partsFromCatalog: 2, partsMatched: 2, refreshesDone: 2 });
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1', 'scan:refresh:PBLRC01B', 'scan:refresh:PBLRC25B']);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', updatedAt: T0 });
    // The refresh read the price again.
    expect(await w.store.getPrice('B0B3JWF5ZV')).toEqual({ asin: 'B0B3JWF5ZV', price: 169, reviews: 221, seenAt: T0, checkedAt: T0 });
  });

  it('copies the saved listing into the price record when it is fresh', async () => {
    const w = world();
    const seen = T0 - HOUR;
    await savedRows(w, 'amazon-search-PBLRC25B', seen);
    const listing = await w.store.getListing('B0B6Z2ZGVK');
    const job = await scan(w);
    expect(w.ledger).toEqual(['scan:listing:ryobi extended reach ratchet:p1']);
    expect(job.counts).toMatchObject({ lookupsDone: 0, refreshesDone: 0, partsFromCatalog: 2 });
    expect(await w.store.getPrice('B0B6Z2ZGVK')).toEqual({ asin: 'B0B6Z2ZGVK', price: listing!.price, reviews: listing!.reviews, seenAt: seen, checkedAt: seen });
  });
});

describe('runScan: a stored catalog entry wins over one read from a listing (2c rule 4)', () => {
  it('keeps DCK240C2 a kit, as its Home Depot title says, although its Amazon title does not', async () => {
    const w = world();
    // DCK240C2 as the recorded pages show it: a row of Home Depot's Bundle filter page (where
    // every row is a bundle), and a catalog entry from the same row of the plain search page.
    const page = recorded('hd-bundles-dewalt-p1') as { products: { product_id: string; title: string; model_number: string }[] };
    const row = page.products.find((p) => p.model_number === 'DCK240C2')!;
    const entry = catalogEntry('DEWALT', row.model_number, row.title);
    expect(entry.isKit).toBe(true);
    await w.store.putCatalogEntry({ key: 'DEWALT:DCK240C2', brand: 'DEWALT', model: 'DCK240C2', title: row.title, kinds: entry.kinds, isKit: true, upc: null, seenAt: T0 - DAY });
    await w.store.putBundle({
      key: bundleKey(row.product_id), retailer: 'homedepot', itemId: row.product_id, title: row.title, brand: 'DEWALT', model: 'DCK240C2',
      upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0 - DAY, split: null,
    });
    const job = await scan(w, { settings: { ...CATALOG, queries: [] } });
    expect(w.replay.calls).toEqual([DEWALT_PAGE]);
    // The DEWALT brand page names DCK240C2 in a title that does not say kit.
    expect(await w.store.getListing('B00IJ0ALYS')).toMatchObject({ title: '20V MAX Cordless Drill and Impact Driver (DCK240C2)', models: ['DCK240C2'] });
    expect(catalogEntry('DEWALT', 'DCK240C2', '20V MAX Cordless Drill and Impact Driver (DCK240C2)').isKit).toBe(false);
    expect((await w.store.getBundle('homedepot:204373168'))!.split).toEqual({ components: ['DCK240C2'], status: 'resolved', notes: ['manufacturer kit'] });
    expect(job.counts).toMatchObject({ bundlesResolved: 1, lookupsDone: 0, partsFromCatalog: 1 });
    expect(await w.store.getMatch('DEWALT:DCK240C2')).toMatchObject({ status: 'matched', asin: 'B00IJ0ALYS', grade: 'probable' });
  });
});

describe('runScan: matching from saved listings after the listing phase stopped (2c rule 5 with rule 8)', () => {
  it('still splits and matches from saved listings, which is free, when a later page fails', async () => {
    const w = world();
    const hd = failing(w, 'ratchet', 500);
    const settings = { ...CATALOG, queries: [{ q: 'dewalt 20v combo kit' }, { q: 'ryobi extended reach ratchet' }] };
    const job = await scan(w, { settings, fetchFn: hd.fetchFn });
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'error', searchesUsed: 2, queue: [] });
    expect(job.stopMessage).toMatch(/HTTP 500/);
    expect(job.deferred).toEqual([{ kind: 'listing', q: 'ryobi extended reach ratchet', page: 1, filterTokens: null, bundlesOnly: false }]);
    expect(hd.failed).toHaveLength(1);
    expect(w.replay.calls).toEqual([DEWALT_PAGE, DEWALT_COMBO]);
    expect(job.counts).toMatchObject({ catalogPages: 1, bundlesResolved: 1, lookupsDone: 0, partsFromCatalog: 2, partsMatched: 2 });
    expect(await w.store.getMatch('DEWALT:DCS334B')).toMatchObject({ status: 'matched', asin: 'B07JPFHQKG' });
  });
});
