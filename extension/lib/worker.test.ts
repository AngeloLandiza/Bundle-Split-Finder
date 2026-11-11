import { describe, expect, it, vi } from 'vitest';
import { replayRecorded, type Replay } from '../../scripts/replay';
import * as fx from '../../core/test/fixtures';
import { reviewSignature } from '@core/scan/answers';
import { MemoryScanStore } from '@core/scan/memoryStore';
import type { BundleRow, PageOutcome, PaidAction, Quote, ReadPages, ReviewAnswer, ScanJob, ScanStore } from '@core/scan/types';
import { parseAccount } from '@core/serpapi/budget';
import { type Cache, type LedgerEntry, MemoryCache } from '@core/serpapi/client';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '@core/settings';
import type { AppState, PanelReport, Reply, Request } from './messages';
import type { ActiveScan, StoredAccount } from './prefs';
import { createWorker, type Prefs, type Worker } from './worker';

// Every search goes through the real SerpApiClient over replayRecorded(); the Account API
// is a fake answered from fx.SERPAPI_ACCOUNT_FREE. Nothing reaches the network.

const T0 = Date.UTC(2026, 10, 10, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KEY = 'TEST';

const FREE = parseAccount(fx.SERPAPI_ACCOUNT_FREE);
const SIX_HOURS = { mode: 'interval', hours: 6 } as const;
/** One brand, so the scan sends one Home Depot query: "ryobi 18v combo kit". */
const RYOBI: ExtensionSettings = { ...DEFAULT_SETTINGS, brands: ['RYOBI'] };

// toScanSettings builds one query per brand. The test answers the RYOBI query with the
// recorded ratchet page, the page the core runner tests use (PBLRC2501SB and two parts).
const RYOBI_QUERY = 'ryobi 18v combo kit';
const RATCHET_QUERY = 'ryobi extended reach ratchet';
const RATCHET = 'engine=home_depot&page=1&q=ryobi extended reach ratchet';
const LOOKUP_01B = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC01B';
const LOOKUP_25B = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI PBLRC25B';
const RYOBI_PAGE = 'amazon_domain=amazon.com&engine=amazon&k=RYOBI&rh=p_123:252605';

// ---------------------------------------------------------------- the world

/** prefs.ts in memory. Values are cloned in and out, as chrome.storage does. Nothing is repaired. */
class FakePrefs implements Prefs {
  data: {
    apiKey?: string;
    settings?: unknown;
    activeScan?: ActiveScan | null;
    lastScheduledRunAt?: number | null;
    notified?: string[];
    packaging?: unknown;
    account?: StoredAccount | null;
  } = {};
  restricted = 0;

  async getKey() {
    return typeof this.data.apiKey === 'string' && this.data.apiKey !== '' ? this.data.apiKey : null;
  }
  async setKey(key: string) {
    this.data.apiKey = key;
  }
  async forgetKey() {
    delete this.data.apiKey;
  }
  async restrictKeyAccess() {
    this.restricted += 1;
  }
  /** Defaults under what is stored, unchecked: the worker must not trust it. */
  async getSettings() {
    const s = this.data.settings;
    return { ...structuredClone(DEFAULT_SETTINGS), ...(typeof s === 'object' && s !== null ? structuredClone(s) : {}) } as ExtensionSettings;
  }
  async saveSettings(s: ExtensionSettings) {
    this.data.settings = structuredClone(s);
  }
  async getActiveScan() {
    return structuredClone(this.data.activeScan ?? null);
  }
  async setActiveScan(v: ActiveScan | null) {
    this.data.activeScan = structuredClone(v);
  }
  async getLastScheduledRunAt() {
    return this.data.lastScheduledRunAt ?? null;
  }
  async setLastScheduledRunAt(v: number | null) {
    this.data.lastScheduledRunAt = v;
  }
  async getNotified() {
    return structuredClone(this.data.notified ?? []);
  }
  async setNotified(v: string[]) {
    this.data.notified = structuredClone(v);
  }
  async getPackaging() {
    const v = this.data.packaging;
    const out: Record<string, 'retail_boxed' | 'loose'> = {};
    if (typeof v === 'object' && v !== null) for (const [m, a] of Object.entries(v)) if (a === 'retail_boxed' || a === 'loose') out[m] = a;
    return out;
  }
  async savePackaging(v: Record<string, 'retail_boxed' | 'loose'>) {
    this.data.packaging = structuredClone(v);
  }
  async getAccount() {
    return structuredClone(this.data.account ?? null);
  }
  async setAccount(v: StoredAccount | null) {
    this.data.account = structuredClone(v);
  }
}

/** MemoryCache with the clear() the worker needs. */
function clearableCache(): Cache & { clear(): Promise<void> } {
  let inner = new MemoryCache();
  return {
    get: (key) => inner.get(key),
    set: (key, entry) => inner.set(key, entry),
    clear: async () => {
      inner = new MemoryCache();
    },
  };
}

interface World {
  store: MemoryScanStore;
  cache: Cache & { clear(): Promise<void> };
  prefs: FakePrefs;
  replay: Replay;
  clock: number;
  ledger: LedgerEntry[];
  notified: BundleRow[][];
  broadcasts: AppState[];
  /** Origin and path of every request, account checks included. Never the query: it holds the key. */
  requests: string[];
  /** Fields laid over fx.SERPAPI_ACCOUNT_FREE in the fake Account API's answer. */
  accountOver: Record<string, unknown>;
  /** The fake Account API. Default: 200 for KEY, 401 for any other key. */
  accountApi: (key: string) => Response | Promise<Response>;
  /** Called before each search reaches the replay; may wait, or throw as fetch does. */
  beforeSearch: (url: URL) => void | Promise<void>;
  fetchFn: typeof fetch;
  readPages?: ReadPages;
  worker: Worker;
}

interface Setup {
  key?: string;
  settings?: unknown;
  lastScheduledRunAt?: number | null;
  accountOver?: Record<string, unknown>;
  readPages?: ReadPages;
}

function world(setup: Setup = {}): World {
  const w = {
    store: new MemoryScanStore(),
    cache: clearableCache(),
    prefs: new FakePrefs(),
    replay: replayRecorded(),
    clock: T0,
    ledger: [],
    notified: [],
    broadcasts: [],
    requests: [],
    accountOver: setup.accountOver ?? {},
    beforeSearch: () => {},
    readPages: setup.readPages,
  } as unknown as World;
  if (setup.key !== undefined) w.prefs.data.apiKey = setup.key;
  if (setup.settings !== undefined) w.prefs.data.settings = structuredClone(setup.settings);
  if (setup.lastScheduledRunAt !== undefined) w.prefs.data.lastScheduledRunAt = setup.lastScheduledRunAt;
  w.accountApi = (key) =>
    key === KEY
      ? new Response(JSON.stringify({ ...fx.SERPAPI_ACCOUNT_FREE, ...w.accountOver }), { status: 200 })
      : new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 401 });
  w.fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    w.requests.push(url.origin + url.pathname);
    if (url.pathname === '/account.json') return w.accountApi(url.searchParams.get('api_key') ?? '');
    await w.beforeSearch(url);
    if (url.searchParams.get('q') === RYOBI_QUERY) url.searchParams.set('q', RATCHET_QUERY);
    return w.replay.fetchFn(url.toString());
  }) as typeof fetch;
  w.worker = workerOver(w);
  return w;
}

/** A worker over the world's storage. `store` replaces the world's store (to interrupt it). */
function workerOver(w: World, store: ScanStore = w.store): Worker {
  return createWorker({
    store,
    cache: w.cache,
    prefs: w.prefs,
    ledger: (entry) => void w.ledger.push(entry),
    fetchFn: (input, init) => w.fetchFn(input, init),
    now: () => w.clock,
    notify: (rows) => void w.notified.push(rows),
    broadcast: (state) => void w.broadcasts.push(state),
    readPages: w.readPages,
  });
}

const send = <T = unknown>(w: World, request: Request): Promise<Reply<T>> => w.worker.onMessage(request) as Promise<Reply<T>>;

async function state(w: World): Promise<AppState> {
  const reply = await send<AppState>(w, { type: 'getState' });
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

/** Waits for the scan that scanNow started to end. */
async function untilIdle(w: World): Promise<void> {
  await vi.waitFor(async () => {
    if ((await state(w)).scanRunning) throw new Error('still scanning');
  });
}

async function lastJob(w: World): Promise<ScanJob> {
  const job = (await state(w)).lastJob;
  if (job === null) throw new Error('no job');
  return job;
}

/** Holds every search until release(): the scan is under way and waiting on SerpApi. */
function held(w: World): { release(): void } {
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  w.beforeSearch = () => open;
  return { release };
}

const labels = (w: World) => w.ledger.map((e) => e.label);

// ---------------------------------------------------------------- 1. the key and the account

describe('worker: the key (acceptance criteria 1 and 2)', () => {
  it('no key: scanNow replies not ok, no request leaves, and problem is set', async () => {
    const w = world();
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: false, error: 'Add your SerpApi key in Settings.' });
    expect(w.requests).toEqual([]);
    expect(w.ledger).toEqual([]);
    expect(await w.store.listScans()).toEqual([]);
    expect(await state(w)).toMatchObject({ hasKey: false, problem: 'Add your SerpApi key in Settings.', scanRunning: false, lastJob: null });
  });

  it('no key: a scheduled scan that is due sends nothing either', async () => {
    const w = world({ settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    await w.worker.onTick();
    expect(w.requests).toEqual([]);
    expect(await w.store.listScans()).toEqual([]);
    expect((await state(w)).problem).toBe('Add your SerpApi key in Settings.');
    // Still due: nothing was run, so nothing moved the schedule on.
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0 - 7 * HOUR);
  });

  it('checkKey with a 401 replies in plain words and saves nothing', async () => {
    const w = world();
    expect(await send(w, { type: 'checkKey', apiKey: 'WRONG' })).toEqual({ ok: false, error: 'SerpApi did not accept this key.' });
    expect(w.prefs.data.apiKey).toBeUndefined();
    expect(w.prefs.data.account ?? null).toBeNull();
    expect(w.requests).toEqual(['https://serpapi.com/account.json']);
  });

  it('checkKey with a 401 leaves a saved key untouched', async () => {
    const w = world({ key: KEY });
    expect(await send(w, { type: 'checkKey', apiKey: 'WRONG' })).toEqual({ ok: false, error: 'SerpApi did not accept this key.' });
    expect(w.prefs.data.apiKey).toBe(KEY);
  });

  it('checkKey with a 200 saves the key and the account and replies with the plan', async () => {
    const w = world();
    const reply = await send(w, { type: 'checkKey', apiKey: KEY });
    expect(reply).toEqual({ ok: true, data: FREE });
    expect(FREE).toMatchObject({ planName: 'Free Plan', totalSearchesLeft: 250, rateLimitPerHour: 50 });
    expect(w.prefs.data.apiKey).toBe(KEY);
    expect(w.prefs.data.account).toEqual({ info: FREE, at: T0 });
    expect(await state(w)).toMatchObject({ hasKey: true, account: FREE, accountCheckedAt: T0, problem: null });
    expect(w.broadcasts.at(-1)).toMatchObject({ hasKey: true, account: FREE });
    // A key check spends nothing.
    expect(w.ledger).toEqual([]);
  });

  it('checkKey sends nothing for an empty key', async () => {
    const w = world();
    expect(await send(w, { type: 'checkKey', apiKey: '  ' })).toEqual({ ok: false, error: 'Enter your SerpApi key.' });
    expect(w.requests).toEqual([]);
  });

  it('a key check that fails for another reason says so in one sentence', async () => {
    const w = world();
    w.accountApi = () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await send(w, { type: 'checkKey', apiKey: KEY })).toEqual({ ok: false, error: 'Something went wrong while checking your SerpApi account.' });
    w.accountApi = () => new Response('{}', { status: 503 });
    expect(await send(w, { type: 'checkKey', apiKey: KEY })).toEqual({ ok: false, error: 'SerpApi account check failed (HTTP 503).' });
    expect(w.prefs.data.apiKey).toBeUndefined();
  });

  it('forgetKey removes the key and the account it showed', async () => {
    const w = world();
    await send(w, { type: 'checkKey', apiKey: KEY });
    expect(await send(w, { type: 'forgetKey' })).toEqual({ ok: true, data: null });
    expect(w.prefs.data.apiKey).toBeUndefined();
    expect(await state(w)).toMatchObject({ hasKey: false, account: null, accountCheckedAt: null });
    expect(w.broadcasts.at(-1)).toMatchObject({ hasKey: false, account: null });
  });

  it('getState never carries the key', async () => {
    const w = world({ key: KEY });
    expect(JSON.stringify(await state(w))).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------- 2. the budget

describe('worker: reading bundle pages', () => {
  it('a scan hands the reader it was given to runScan, which asks it for the bundles it has seen', async () => {
    const asked: string[][] = [];
    const readPages: ReadPages = async (ids) => {
      asked.push(ids);
      return ids.map((itemId): PageOutcome => ({ itemId, kind: 'unreadable' }));
    };
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR, readPages });
    await w.worker.onTick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.length).toBeGreaterThan(0);
    expect((await lastJob(w)).counts.pagesRead).toBe(0);
  });
});

describe('worker: each scan\'s budget (criterion 3 and the reserve rule)', () => {
  it('a scheduled scan with searchesPerScan 2 on the ratchet query stops with run_cap after 2 searches', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 2, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    await w.worker.onTick();
    const job = await lastJob(w);
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 2, queue: [] });
    expect(job.deferred).toEqual([{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' }]);
    // A fifth of 2 rounds down to no brand page: the listing page and one lookup.
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B]);
    expect(labels(w)).toEqual([`scan:listing:${RYOBI_QUERY}:p1`, 'scan:lookup:PBLRC01B']);
    expect(w.requests.filter((r) => r.endsWith('/account.json'))).toHaveLength(2); // before and after
    expect(w.prefs.data.activeScan).toBeNull();
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0);
    expect(await state(w)).toMatchObject({ scanRunning: false, problem: null, nextRunAt: T0 + 6 * HOUR });
  });

  it('a scheduled scan with 101 searches left and a reserve of 100 spends 1 and stops at the reserve', async () => {
    const w = world({
      key: KEY, settings: { ...RYOBI, reserve: 100, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR, accountOver: { total_searches_left: 101 },
    });
    await w.worker.onTick();
    const job = await lastJob(w);
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'reserve', searchesUsed: 1 });
    expect(w.replay.calls).toEqual([RATCHET]);
    expect(w.ledger).toHaveLength(1);
  });

  it('scanNow in the same position may spend the reserve, up to searchesPerScan (5)', async () => {
    const w = world({
      key: KEY, settings: { ...RYOBI, reserve: 100, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR, accountOver: { total_searches_left: 101 },
    });
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    await untilIdle(w);
    const job = await lastJob(w);
    // A fifth of 5 is one RYOBI brand page; its listings answer neither part, so both are
    // looked up. Everything wanted fits in 5, and 101 - 4 = 97 is below the reserve.
    expect(job).toMatchObject({ status: 'done', stopReason: null, searchesUsed: 4, deferred: [] });
    expect(w.replay.calls).toEqual([RYOBI_PAGE, RATCHET, LOOKUP_01B, LOOKUP_25B]);
    expect(labels(w)).toEqual(['scan:catalog:RYOBI:p1', `scan:listing:${RYOBI_QUERY}:p1`, 'scan:lookup:PBLRC01B', 'scan:lookup:PBLRC25B']);
    // A manual scan does not move the schedule.
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0 - 7 * HOUR);
  });

  it('scanNow is still held to searchesPerScan, and may spend the account down to zero', async () => {
    const capped = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 2 }, accountOver: { total_searches_left: 101 } });
    await send(capped, { type: 'scanNow' });
    await untilIdle(capped);
    expect(await lastJob(capped)).toMatchObject({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 2 });

    const last = world({ key: KEY, settings: RYOBI, accountOver: { total_searches_left: 1 } });
    await send(last, { type: 'scanNow' });
    await untilIdle(last);
    expect(await lastJob(last)).toMatchObject({ status: 'stopped', stopReason: 'reserve', searchesUsed: 1 });
    expect(last.replay.calls).toEqual([RATCHET]);
  });

  it('a manual schedule starts nothing on a tick', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await w.worker.onTick();
    expect(w.requests).toEqual([]);
    expect(await state(w)).toMatchObject({ nextRunAt: null, lastJob: null });
  });

  it('broadcasts when a scan starts and when it ends', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const running = w.broadcasts.map((s) => s.scanRunning);
    expect(running).toContain(true);
    expect(running.at(-1)).toBe(false);
    expect(w.broadcasts.at(-1)!.lastJob).toMatchObject({ status: 'done' });
  });

  /** Both brands and two searches: the DEWALT combo page, then the ratchet page; every lookup is left waiting. */
  const TWO_PAGES: ExtensionSettings = { ...DEFAULT_SETTINGS, searchesPerScan: 2 };
  const pagesWhileRunning = (w: World) =>
    w.broadcasts.filter((s) => s.scanRunning && s.lastJob?.status === 'running').map((s) => s.lastJob!.counts.pagesFetched);

  it('broadcasts the job as it is saved, so the progress moves before the scan ends', async () => {
    const w = world({ key: KEY, settings: TWO_PAGES });
    // Each search takes two seconds by the worker's clock, and a moment of real time for the broadcasts to land.
    w.beforeSearch = async () => {
      w.clock += 2_000;
      await new Promise((ok) => setTimeout(ok, 20));
    };
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(w.replay.calls).toHaveLength(2);
    const pages = pagesWhileRunning(w);
    expect(pages).toEqual(expect.arrayContaining([0, 1, 2]));
    expect(pages).toEqual([...pages].sort((a, b) => a - b));
    expect(w.broadcasts.at(-1)).toMatchObject({ scanRunning: false, lastJob: { status: 'stopped', counts: { pagesFetched: 2 } } });
  });

  it('broadcasts saves at most once a second, and the last save of a burst once its second is up', async () => {
    const w = world({ key: KEY, settings: TWO_PAGES });
    let reach!: () => void;
    const reached = new Promise<void>((ok) => (reach = ok));
    let release!: () => void;
    const open = new Promise<void>((ok) => (release = ok));
    // The worker's clock stands still. The DEWALT page waits a moment, so the broadcast of the new job lands first;
    // the ratchet page is held, so the scan waits with page 1 saved.
    w.beforeSearch = async (url) => {
      if (url.searchParams.get('q') !== RYOBI_QUERY) return void (await new Promise((ok) => setTimeout(ok, 20)));
      reach();
      await open;
    };
    await send(w, { type: 'scanNow' });
    await reached;
    await new Promise((ok) => setTimeout(ok, 50));
    // The new job was broadcast at once; page 1 was saved within the same second, so it waits.
    expect(pagesWhileRunning(w)).toEqual([0]);
    await vi.waitFor(() => expect(pagesWhileRunning(w)).toEqual([0, 1]), { timeout: 3_000 });
    release();
    await untilIdle(w);
    expect(w.broadcasts.at(-1)).toMatchObject({ scanRunning: false, lastJob: { counts: { pagesFetched: 2 } } });
  });
});

// ---------------------------------------------------------------- 3. resume

/** The world's store, except that the first job save after the first lookup throws, as when Chrome stops the worker. */
function interruptedAfterFirstLookup(w: World): ScanStore {
  let thrown = false;
  return new Proxy(w.store, {
    get(target, prop) {
      if (prop === 'putScan') {
        return async (job: ScanJob) => {
          if (!thrown && job.counts.lookupsDone === 1) {
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

describe('worker: continues after the worker restarts (criterion 8)', () => {
  it('a second worker over the same storage finishes the job, repeats no request, and keeps to searchesPerScan', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 3, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    const first = workerOver(w, interruptedAfterFirstLookup(w));
    await first.onTick();
    const [saved] = await w.store.listScans();
    expect(saved).toMatchObject({ status: 'running', phase: 'parts', searchesUsed: 1 });
    expect(w.prefs.data.activeScan).toEqual({ jobId: saved!.id, trigger: 'scheduled', attempts: 0, progress: '0:listing:1' });
    // The scheduled run is not over, so the schedule has not moved on.
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0 - 7 * HOUR);
    expect(w.ledger).toHaveLength(2);

    w.clock = T0 + 2 * MINUTE;
    const second = workerOver(w);
    await second.onStart();
    const [job] = await w.store.listScans();
    expect(job).toMatchObject({ id: saved!.id, status: 'done', searchesUsed: 2, deferred: [] });
    expect(await w.store.listScans()).toHaveLength(1);
    // The interrupted lookup is answered from the cache.
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B, LOOKUP_25B]);
    expect(new Set(w.replay.calls).size).toBe(w.replay.calls.length);
    expect(w.ledger.length).toBeLessThanOrEqual(3);
    expect(w.prefs.data.activeScan).toBeNull();
    // Continued with the trigger it was saved with.
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0 + 2 * MINUTE);
    expect(w.prefs.restricted).toBeGreaterThanOrEqual(2);
  });

  it('a continued job runs only its saved queue: the two runs together spend searchesPerScan at most', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 2, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    await workerOver(w, interruptedAfterFirstLookup(w)).onTick();
    await workerOver(w).onStart();
    // The PBLRC01B lookup comes from the cache; PBLRC25B was deferred when the job was planned.
    expect(await lastJob(w)).toMatchObject({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 1 });
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B]);
    expect(w.ledger).toHaveLength(2);
  });

  it('scanNow on a job left running continues it with its saved trigger, so a scheduled job keeps the reserve', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 3, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    await workerOver(w, interruptedAfterFirstLookup(w)).onTick();
    w.accountOver = { total_searches_left: 100 }; // exactly the reserve
    w.clock = T0 + 5 * MINUTE;
    const second = workerOver(w);
    w.worker = second;
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    await untilIdle(w);
    const job = await lastJob(w);
    expect(job).toMatchObject({ status: 'stopped', stopReason: 'reserve', deferred: [{ kind: 'lookup', brand: 'RYOBI', model: 'PBLRC25B' }] });
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B]);
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0 + 5 * MINUTE);
  });

  it('clears an activeScan whose job is missing or finished, and starts nothing unless one is due', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.prefs.data.activeScan = { jobId: 'gone', trigger: 'manual' };
    await w.worker.onTick();
    expect(w.prefs.data.activeScan).toBeNull();
    expect(w.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------- 4. one scan at a time; the account unreachable

describe('worker: one scan at a time', () => {
  it('scanNow and onTick started together run one job', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    const [reply] = await Promise.all([send(w, { type: 'scanNow' }), w.worker.onTick()]);
    expect(reply).toEqual({ ok: true, data: null });
    await untilIdle(w);
    expect(await w.store.listScans()).toHaveLength(1);
    expect(new Set(w.replay.calls).size).toBe(w.replay.calls.length);
    // The tick found the scan running and did nothing: a manual scan does not move the schedule.
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0 - 7 * HOUR);
  });

  it('scanNow while a scan runs is refused, and a tick does nothing', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    const gate = held(w);
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: false, error: 'A scan is already running.' });
    const accountChecks = w.requests.length;
    await w.worker.onTick();
    expect(w.requests).toHaveLength(accountChecks);
    expect((await state(w)).scanRunning).toBe(true);
    gate.release();
    await untilIdle(w);
    expect(await w.store.listScans()).toHaveLength(1);
  });

  it('two ticks together (onStart and the first alarm) run one job', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    await Promise.all([w.worker.onStart(), w.worker.onTick()]);
    expect(await w.store.listScans()).toHaveLength(1);
    expect(w.replay.calls).toEqual([RYOBI_PAGE, RATCHET, LOOKUP_01B, LOOKUP_25B]);
  });
});

describe('worker: the account cannot be checked when a scan is due (review focus 3)', () => {
  it('sends no search, says why, and the next tick tries again', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    const answer = w.accountApi;
    w.accountApi = () => {
      throw new TypeError('Failed to fetch');
    };
    await w.worker.onTick();
    expect(w.replay.calls).toEqual([]);
    expect(await w.store.listScans()).toEqual([]);
    expect((await state(w)).problem).toBe('Something went wrong while checking your SerpApi account.');
    expect(w.broadcasts.at(-1)!.problem).toBe('Something went wrong while checking your SerpApi account.');

    w.accountApi = () => new Response('{}', { status: 401 });
    w.clock = T0 + MINUTE;
    await w.worker.onTick();
    expect(w.replay.calls).toEqual([]);
    expect((await state(w)).problem).toBe('SerpApi did not accept this key.');

    w.accountApi = answer;
    w.clock = T0 + 2 * MINUTE;
    await w.worker.onTick();
    expect(await lastJob(w)).toMatchObject({ status: 'done' });
    expect((await state(w)).problem).toBeNull();
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0 + 2 * MINUTE);
  });
});

// ---------------------------------------------------------------- 5. settings and the schedule

describe('worker: saving settings (rule 5, criterion 7)', () => {
  it('manual to every 6 hours: no scan on the next tick, nextRunAt six hours on, and a tick then starts one', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    expect(await send(w, { type: 'saveSettings', settings: { ...RYOBI, schedule: SIX_HOURS } })).toEqual({ ok: true, data: null });
    expect(w.broadcasts.at(-1)).toMatchObject({ settings: { schedule: SIX_HOURS }, nextRunAt: T0 + 6 * HOUR });
    expect(w.requests).toEqual([]);

    w.clock = T0 + MINUTE;
    await w.worker.onTick();
    expect(w.requests).toEqual([]);
    expect(await state(w)).toMatchObject({ nextRunAt: T0 + 6 * HOUR, lastJob: null });

    // The same worker, no reload in between.
    w.clock = T0 + 6 * HOUR;
    await w.worker.onTick();
    expect(await lastJob(w)).toMatchObject({ status: 'done', startedAt: T0 + 6 * HOUR });
    expect((await state(w)).nextRunAt).toBe(T0 + 12 * HOUR);
  });

  it('saving the same schedule again does not move nextRunAt', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'saveSettings', settings: { ...RYOBI, schedule: SIX_HOURS } });
    w.clock = T0 + HOUR;
    const again = { ...RYOBI, schedule: { mode: 'interval', hours: 6 } as const, searchesPerScan: 9 };
    expect(await send(w, { type: 'saveSettings', settings: again })).toEqual({ ok: true, data: null });
    expect(await state(w)).toMatchObject({ nextRunAt: T0 + 6 * HOUR, settings: { searchesPerScan: 9 } });
  });

  it('a daily time comes at the next daily time, not on the next tick', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'saveSettings', settings: { ...RYOBI, schedule: { mode: 'daily', at: '07:00' } } });
    expect((await state(w)).nextRunAt!).toBeGreaterThan(T0);
    w.clock = T0 + MINUTE;
    await w.worker.onTick();
    expect(w.requests).toEqual([]);
  });

  it('rejects settings with the first problem and saves nothing', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const reply = await send(w, { type: 'saveSettings', settings: { ...RYOBI, schedule: { mode: 'interval', hours: 0 }, searchesPerScan: 9999 } });
    expect(reply).toEqual({ ok: false, error: 'Choose between 1 and 168 hours.' });
    expect(w.prefs.data.settings).toEqual(RYOBI);
    expect(w.prefs.data.lastScheduledRunAt ?? null).toBeNull();
    const garbled = await send(w, { type: 'saveSettings', settings: { ...RYOBI, fees: null } as unknown as ExtensionSettings });
    expect(garbled.ok).toBe(false);
    expect(w.prefs.data.settings).toEqual(RYOBI);
  });

  it('a change while a scan runs does not stop it or change its budget', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 3 } });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    expect(await send(w, { type: 'saveSettings', settings: { ...RYOBI, searchesPerScan: 1, schedule: SIX_HOURS } })).toEqual({ ok: true, data: null });
    expect((await state(w)).scanRunning).toBe(true);
    gate.release();
    await untilIdle(w);
    expect(await lastJob(w)).toMatchObject({ status: 'done', stopReason: null, searchesUsed: 3 });
    // The new schedule counts from the change: no scheduled scan follows at once.
    await w.worker.onTick();
    expect(await w.store.listScans()).toHaveLength(1);
    expect((await state(w)).nextRunAt).toBe(T0 + 6 * HOUR);
  });

  it('stored settings are checked field by field: fees null are read as the default fees', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, fees: null, alerts: { enabled: 'yes' }, schedule: { mode: 'weekly' }, searchesPerScan: 7 } });
    const s = (await state(w)).settings;
    expect(s).toEqual({ ...RYOBI, searchesPerScan: 7 });
    expect(s.fees).toEqual(DEFAULT_SETTINGS.fees);
    // A scan runs on them, and the export prices with the default fees.
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const csv = await send<string>(w, { type: 'exportDeals' });
    expect(csv.ok && csv.data.split('\n')[1]).toMatch(/^confirmed,RYOBI,PBLRC2501SB,.*,268\.55,189,79\.55,0\.4209,/);
  });
});

// ---------------------------------------------------------------- 6. stop and alerts

describe('worker: stopScan', () => {
  it('during a scan gives stopReason "user", and nothing more is sent', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    expect(await send(w, { type: 'stopScan' })).toEqual({ ok: true, data: null });
    gate.release();
    await untilIdle(w);
    expect(await lastJob(w)).toMatchObject({ status: 'stopped', stopReason: 'user', searchesUsed: 1 });
    // The brand page was in flight when Stop came; the runner asks before every paid step.
    expect(w.replay.calls).toEqual([RYOBI_PAGE]);
    expect(w.prefs.data.activeScan).toBeNull();
  });

  it('replies ok when nothing runs, and the next scan is not stopped by it', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    expect(await send(w, { type: 'stopScan' })).toEqual({ ok: true, data: null });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(await lastJob(w)).toMatchObject({ status: 'done', stopReason: null });
  });

  it('forgetKey during a scan stops it: nothing is spent once the key is gone', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    await send(w, { type: 'forgetKey' });
    gate.release();
    await untilIdle(w);
    expect(await lastJob(w)).toMatchObject({ status: 'stopped', stopReason: 'user' });
    expect(w.replay.calls).toEqual([RYOBI_PAGE]);
  });
});

describe('worker: alerts', () => {
  const ALERTS: ExtensionSettings = { ...RYOBI, alerts: { enabled: true, minProfit: 50, minRoiPercent: 30 } };

  it('at $50 and 30%, notify is called once with PBLRC2501SB, and not again after a second scan', async () => {
    const w = world({ key: KEY, settings: ALERTS });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(w.notified).toHaveLength(1);
    expect(w.notified[0]!.map((r) => r.model)).toEqual(['PBLRC2501SB']);
    expect(w.notified[0]![0]!.estimate).toMatchObject({ profit: 79.55, roi: 0.4209 });
    expect(w.prefs.data.notified).toEqual(['homedepot:328814689']);

    w.clock = T0 + 10 * MINUTE;
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(await w.store.listScans()).toHaveLength(2);
    expect(w.notified).toHaveLength(1);
  });

  it('notifies nothing when alerts are off', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(w.notified).toEqual([]);
  });
});

// ---------------------------------------------------------------- 7. exports, saved searches, the key

describe('worker: exports and saved searches (rule 6)', () => {
  it('exportMatches replies with every match and the answered review items only', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const [first, ...rest] = await w.store.listReview();
    await w.store.putReview({ ...first!, answer: 'not a bundle', answeredAt: T0 });
    expect(rest.length).toBeGreaterThan(0);
    const reply = await send<string>(w, { type: 'exportMatches' });
    expect(reply.ok).toBe(true);
    const data = JSON.parse(reply.ok ? reply.data : '{}');
    expect(data.matches.map((m: { key: string }) => m.key)).toEqual(['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']);
    expect(data.answers).toEqual([{ ...first, answer: 'not a bundle', answeredAt: T0 }]);
  });

  it('clearSavedSearches empties the cache only: the next scan pays for its pages again, the store keeps its records', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(await send(w, { type: 'clearSavedSearches' })).toEqual({ ok: true, data: null });
    expect(await w.store.listMatches()).toHaveLength(2);
    expect(await w.store.listScans()).toHaveLength(1);
    // Ten minutes on, the listing page would have come from the cache; now it is paid for.
    w.clock = T0 + 10 * MINUTE;
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(w.replay.calls.filter((c) => c === RATCHET)).toHaveLength(2);
  });

  it('uses baseUrl for the Account API and for searches', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.worker = createWorker({
      store: w.store, cache: w.cache, prefs: w.prefs, ledger: () => {}, fetchFn: w.fetchFn, now: () => w.clock,
      notify: () => {}, broadcast: () => {}, baseUrl: 'http://localhost:8787',
    });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(new Set(w.requests)).toEqual(new Set(['http://localhost:8787/account.json', 'http://localhost:8787/search.json']));
  });
});

describe('worker: the key never leaves in a reply or a broadcast', () => {
  it('not in any reply, broadcast or notification of a whole session', async () => {
    const w = world({ settings: { ...RYOBI, alerts: { enabled: true, minProfit: 0, minRoiPercent: 0 } } });
    const replies: unknown[] = [];
    for (const request of [{ type: 'checkKey', apiKey: KEY }, { type: 'getState' }, { type: 'scanNow' }] as Request[]) replies.push(await send(w, request));
    await untilIdle(w);
    for (const request of [{ type: 'exportDeals' }, { type: 'exportMatches' }, { type: 'getState' }, { type: 'stopScan' }] as Request[]) replies.push(await send(w, request));
    expect(w.notified.length).toBeGreaterThan(0);
    expect(JSON.stringify([replies, w.broadcasts, w.notified])).not.toContain(KEY);
  });

  it('not even when a failed search\'s error message carries the request URL', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.beforeSearch = (url) => {
      if (url.searchParams.get('k')?.startsWith('RYOBI ')) throw new TypeError(`request to ${url} failed`);
    };
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    // The key is taken out before the job is written: the stored job never holds it.
    const stored = (await w.store.listScans())[0]!.stopMessage!;
    expect(stored).toMatch(/^Network error reaching SerpApi: request to .*api_key=\[key\]/);
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain(`api_key=${KEY}`);
    const shown = await state(w);
    expect(shown.lastJob).toMatchObject({ status: 'stopped', stopReason: 'error' });
    expect(JSON.stringify([shown, w.broadcasts])).not.toContain(KEY);
    // Once the key is forgotten the reply scrub no longer knows it; the stored job is clean anyway.
    await send(w, { type: 'forgetKey' });
    expect(JSON.stringify((await state(w)).lastJob)).not.toContain(KEY);
  });

  it('any api_key value in an error text is replaced, whatever the key was', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.beforeSearch = (url) => {
      if (url.searchParams.get('k')?.startsWith('RYOBI ')) throw new TypeError('request to https://serpapi.com/search.json?api_key=OLDKEY123&q=x failed');
    };
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const stored = (await w.store.listScans())[0]!.stopMessage!;
    expect(stored).toContain('api_key=[key]&q=x');
    expect(stored).not.toContain('OLDKEY123');
  });
});

// ---------------------------------------------------------------- review fixes: storage failures, write order, a start in progress

describe('worker: a scan that cannot be saved stops after two tries', () => {
  const GAVE_UP = 'The scan could not be saved, so it was stopped. Check that Chrome has free storage, then scan again.';

  it('every job save after the first fails and the cache cannot be written: two tries, then nothing is sent', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 3, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    let saves = 0;
    const broken = new Proxy(w.store, {
      get(target, prop) {
        if (prop === 'putScan') {
          return async (job: ScanJob) => {
            saves += 1;
            if (saves > 1) throw new Error('QuotaExceededError');
            return target.putScan(job);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    w.cache.set = async () => {
      throw new Error('QuotaExceededError');
    };
    const worker = workerOver(w, broken);
    w.worker = worker;

    await worker.onTick();
    expect(w.replay.calls).toEqual([RATCHET]);
    expect(w.prefs.data.activeScan).toMatchObject({ attempts: 0, progress: '0:listing:1' });

    w.clock = T0 + MINUTE;
    await worker.onTick();
    expect(w.replay.calls).toEqual([RATCHET, RATCHET]);
    expect(w.prefs.data.activeScan).toMatchObject({ attempts: 1, progress: '0:listing:1' });

    w.clock = T0 + 2 * MINUTE;
    const before = w.requests.length;
    await worker.onTick();
    expect(w.requests).toHaveLength(before);
    expect(w.prefs.data.activeScan).toBeNull();
    expect((await state(w)).problem).toBe(GAVE_UP);
    expect(w.broadcasts.at(-1)!.problem).toBe(GAVE_UP);

    // The schedule does not start it again at once either.
    w.clock = T0 + 3 * MINUTE;
    await worker.onTick();
    expect(w.requests).toHaveLength(before);

    // A later Scan now may try again.
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    await untilIdle(w);
    expect(w.replay.calls).toEqual([RATCHET, RATCHET, RATCHET]);
  });

  it('a job that makes progress between interruptions is continued as many times as needed', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 3, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    // The first save after each paid step fails once, as when Chrome stops the worker each time.
    const thrown = new Set<string>();
    const flaky = new Proxy(w.store, {
      get(target, prop) {
        if (prop === 'putScan') {
          return async (job: ScanJob) => {
            const at = `${job.counts.pagesFetched}:${job.counts.lookupsDone}`;
            if (at !== '0:0' && !thrown.has(at)) {
              thrown.add(at);
              throw new Error('interrupted');
            }
            return target.putScan(job);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    for (let i = 0; i < 6; i++) {
      w.clock = T0 + i * MINUTE;
      await workerOver(w, flaky).onTick();
    }
    expect(thrown.size).toBe(3);
    expect(await lastJob(w)).toMatchObject({ status: 'done', searchesUsed: 0 });
    expect(await w.store.listScans()).toHaveLength(1);
    // Each paid step once: every repeat came from the cache.
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B, LOOKUP_25B]);
    expect((await state(w)).problem).toBeNull();
    expect(w.prefs.data.activeScan).toBeNull();
  });
});

describe('worker: the order of the writes after a scheduled scan', () => {
  it('lastScheduledRunAt is written before activeScan is cleared, so a failure between them starts no second scan', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    const setActiveScan = w.prefs.setActiveScan.bind(w.prefs);
    let failed = false;
    w.prefs.setActiveScan = async (v) => {
      if (v === null && !failed) {
        failed = true;
        throw new Error('storage failed');
      }
      return setActiveScan(v);
    };
    await w.worker.onTick();
    expect(failed).toBe(true);
    expect(w.prefs.data.lastScheduledRunAt).toBe(T0);
    w.clock = T0 + MINUTE;
    await w.worker.onTick();
    expect(await w.store.listScans()).toHaveLength(1);
    expect(w.prefs.data.activeScan).toBeNull();
  });
});

describe('worker: stopScan and forgetKey while a start waits on the Account API', () => {
  function pendingAccount(w: World) {
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const answer = w.accountApi;
    w.accountApi = async (key) => {
      await open;
      return answer(key);
    };
    return { release, asked: () => vi.waitFor(() => expect(w.requests).toContain('https://serpapi.com/account.json')) };
  }

  it('stopScan sent then results in no search', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const account = pendingAccount(w);
    const reply = send(w, { type: 'scanNow' });
    await account.asked();
    expect(await send(w, { type: 'stopScan' })).toEqual({ ok: true, data: null });
    account.release();
    expect((await reply).ok).toBe(false);
    await untilIdle(w);
    expect(w.replay.calls).toEqual([]);
    expect(w.ledger).toEqual([]);
    // The stop was for that start only.
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(await lastJob(w)).toMatchObject({ status: 'done' });
  });

  it('forgetKey sent then results in no search and no key', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const account = pendingAccount(w);
    const reply = send(w, { type: 'scanNow' });
    await account.asked();
    await send(w, { type: 'forgetKey' });
    account.release();
    expect(await reply).toEqual({ ok: false, error: 'Add your SerpApi key in Settings.' });
    await untilIdle(w);
    expect(w.replay.calls).toEqual([]);
    expect(w.prefs.data.apiKey).toBeUndefined();
    expect(await w.store.listScans()).toEqual([]);
  });
});

// ---------------------------------------------------------------- side panel messages

describe('worker: getReport and setPackaging', () => {
  it('getReport returns the report sections and review plus an empty packaging map', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const reply = await send<PanelReport>(w, { type: 'getReport' });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.packaging).toEqual({});
    expect(reply.data.bundles.length).toBeGreaterThan(0);
    expect(reply.data.bundles[0]).toMatchObject({ model: 'PBLRC2501SB' });
    expect(Array.isArray(reply.data.review)).toBe(true);
  });

  it('setPackaging saves under the upper-case model, broadcasts, and survives a worker restart', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const before = w.broadcasts.length;
    expect(await send(w, { type: 'setPackaging', model: ' pblrc2501sb ', packaging: 'loose' })).toEqual({ ok: true, data: null });
    expect(w.broadcasts.length).toBeGreaterThan(before);
    w.worker = workerOver(w);
    const reply = await send<PanelReport>(w, { type: 'getReport' });
    expect(reply.ok && reply.data.packaging).toEqual({ PBLRC2501SB: 'loose' });
    await send(w, { type: 'setPackaging', model: 'PBLRC2501SB', packaging: 'retail_boxed' });
    const again = await send<PanelReport>(w, { type: 'getReport' });
    expect(again.ok && again.data.packaging).toEqual({ PBLRC2501SB: 'retail_boxed' });
  });

  it('setPackaging refuses any other value with a plain sentence and saves nothing', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const bad = await send(w, { type: 'setPackaging', model: 'X1', packaging: 'boxed' } as unknown as Request);
    expect(bad).toEqual({ ok: false, error: 'Choose retail boxed or loose.' });
    expect(await send(w, { type: 'setPackaging', model: '  ', packaging: 'loose' })).toEqual({ ok: false, error: 'Name the bundle model.' });
    expect(w.prefs.data.packaging).toBeUndefined();
  });

  it('a stored entry that is not a known answer is dropped on read', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.prefs.data.packaging = { A1: 'loose', B2: 'sealed', C3: 7 };
    const reply = await send<PanelReport>(w, { type: 'getReport' });
    expect(reply.ok && reply.data.packaging).toEqual({ A1: 'loose' });
  });

});

describe('worker: Verify and Look up from the panel (quote, runPaid)', () => {
  const LOOK_01B: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC01B' }] };
  const LOOK_25B: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC25B' }] };
  const LOOK_BOTH: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC01B' }, { brand: 'RYOBI', model: 'PBLRC25B' }] };
  const VERIFY_25B: PaidAction = { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' };
  /** The PBLRC01B title match a Look up makes (B0B6Z2ZGVK); its detail page is recorded. */
  const VERIFY_01B: PaidAction = { kind: 'verify', brand: 'RYOBI', model: 'PBLRC01B', asin: 'B0B6Z2ZGVK' };
  const PRODUCT_25B = 'amazon_domain=amazon.com&asin=B0B3JWF5ZV&engine=amazon_product';
  const RUN_CAP = 'Stopped: this run reached its search limit.';
  const HOURLY = "Stopped: the plan's hourly search limit is reached. Try again next hour.";
  const SCANNING = 'A scan is running.';
  const PAYING = 'A Look up or Verify is running.';
  /** One search per scan, and so per paid action (the manual-trigger budget: reserve 0, cap searchesPerScan). */
  const ONE: ExtensionSettings = { ...RYOBI, searchesPerScan: 1 };

  /** Scan now with one search: the ratchet page is read and both parts are left waiting. */
  async function waitingWorld(setup: Setup = {}): Promise<World> {
    const w = world({ key: KEY, settings: ONE, ...setup });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(await lastJob(w)).toMatchObject({ status: 'stopped', stopReason: 'run_cap', searchesUsed: 1 });
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'waiting' });
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'waiting' });
    return w;
  }

  const quote = (w: World, action: PaidAction) => send<Quote>(w, { type: 'quote', action });
  const runPaid = (w: World, action: PaidAction) => send<null>(w, { type: 'runPaid', action });
  const accountChecks = (w: World) => w.requests.filter((r) => r.endsWith('/account.json')).length;
  const panelLabels = (w: World) => labels(w).filter((l) => l.startsWith('panel:'));

  it('quote shows the cost before the click; Look up runs the scan\'s lookup for a waiting part, labelled panel:lookup, and broadcasts', async () => {
    const w = await waitingWorld();
    expect(await quote(w, LOOK_01B)).toEqual({ ok: true, data: { searches: 1, refusal: null } });
    const checks = accountChecks(w);
    const broadcasts = w.broadcasts.length;
    w.clock = T0 + MINUTE;
    expect(await runPaid(w, LOOK_01B)).toEqual({ ok: true, data: null });
    expect(labels(w)).toEqual([`scan:listing:${RYOBI_QUERY}:p1`, 'panel:lookup:PBLRC01B']);
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B]);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched', asin: 'B0B6Z2ZGVK', grade: 'probable', decidedBy: 'auto' });
    // A fresh account check (free) before it, and again after it spent.
    expect(accountChecks(w)).toBe(checks + 2);
    expect(w.prefs.data.account).toMatchObject({ at: T0 + MINUTE });
    expect(w.broadcasts.length).toBeGreaterThan(broadcasts);
    expect(w.broadcasts.at(-1)).toMatchObject({ scanRunning: false });
    // The panel's action is not a scan: the last job is as the scan left it.
    expect(await lastJob(w)).toMatchObject({ status: 'stopped', searchesUsed: 1 });

    // PBLRC25B is now answered by a listing the PBLRC01B search saved: it costs nothing.
    expect(await quote(w, LOOK_25B)).toEqual({ ok: true, data: { searches: 0, refusal: null } });
    expect(await runPaid(w, LOOK_25B)).toEqual({ ok: true, data: null });
    expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B']);
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', grade: 'probable' });
  });

  it('Verify upgrades the title match from the recorded detail page; a listing the owner chose is refused', async () => {
    const w = await waitingWorld();
    await runPaid(w, LOOK_01B);
    await runPaid(w, LOOK_25B);
    expect(await quote(w, VERIFY_25B)).toEqual({ ok: true, data: { searches: 1, refusal: null } });
    expect(await runPaid(w, VERIFY_25B)).toEqual({ ok: true, data: null });
    expect(w.replay.calls.at(-1)).toBe(PRODUCT_25B);
    expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B', 'panel:verify:PBLRC25B']);
    const match = (await w.store.getMatch('RYOBI:PBLRC25B'))!;
    expect(match).toMatchObject({ status: 'matched', asin: 'B0B3JWF5ZV', grade: 'strong', decidedBy: 'auto' });

    await w.store.putMatch({ ...match, decidedBy: 'user' });
    const chosen = 'You chose this listing yourself.';
    expect(await quote(w, VERIFY_25B)).toEqual({ ok: true, data: { searches: 1, refusal: chosen } });
    expect(await runPaid(w, VERIFY_25B)).toEqual({ ok: false, error: chosen });
    expect(panelLabels(w)).toHaveLength(2);
  });

  it('a quote above the budget refuses with the budget\'s own sentence, and runPaid then sends nothing', async () => {
    const w = await waitingWorld();
    expect(await quote(w, LOOK_BOTH)).toEqual({ ok: true, data: { searches: 2, refusal: RUN_CAP } });
    const requests = w.requests.length;
    expect(await runPaid(w, LOOK_BOTH)).toEqual({ ok: false, error: RUN_CAP });
    // The account is checked (free); no search is sent.
    expect(w.requests.slice(requests)).toEqual(['https://serpapi.com/account.json']);
    expect(w.replay.calls).toEqual([RATCHET]);
    expect(panelLabels(w)).toEqual([]);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'waiting' });
  });

  it('quote uses the account checked in the last five minutes, and checks it again (free) when older', async () => {
    const w = await waitingWorld();
    const checks = accountChecks(w);
    w.accountOver = { this_hour_searches: 50 };
    w.clock = T0 + 4 * MINUTE;
    expect(await quote(w, LOOK_01B)).toEqual({ ok: true, data: { searches: 1, refusal: null } });
    expect(accountChecks(w)).toBe(checks);
    w.clock = T0 + 6 * MINUTE;
    expect(await quote(w, LOOK_01B)).toEqual({ ok: true, data: { searches: 1, refusal: HOURLY } });
    expect(accountChecks(w)).toBe(checks + 1);
    expect(w.prefs.data.account).toMatchObject({ at: T0 + 6 * MINUTE, info: { thisHourSearches: 50 } });
    // runPaid checks the account itself, whatever quote saw.
    expect(await runPaid(w, LOOK_01B)).toEqual({ ok: false, error: HOURLY });
    expect(w.replay.calls).toEqual([RATCHET]);
  });

  it('during a scan both refuse with "A scan is running."', async () => {
    const w = await waitingWorld();
    const gate = held(w);
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    expect(await quote(w, LOOK_01B)).toEqual({ ok: true, data: { searches: 1, refusal: SCANNING } });
    expect(await runPaid(w, LOOK_01B)).toEqual({ ok: false, error: SCANNING });
    gate.release();
    await untilIdle(w);
    expect(panelLabels(w)).toEqual([]);
  });

  it('one paid action at a time, and no scan beside it; a second runPaid is refused and spends nothing', async () => {
    const w = await waitingWorld({ settings: { ...ONE, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    let reached!: () => void;
    const atSearch = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    w.beforeSearch = async () => {
      reached();
      await open;
    };
    const first = runPaid(w, LOOK_01B);
    await atSearch;
    expect(await runPaid(w, LOOK_01B)).toEqual({ ok: false, error: PAYING });
    expect(await quote(w, VERIFY_25B)).toEqual({ ok: true, data: { searches: 1, refusal: PAYING } });
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: false, error: PAYING });
    // A scheduled scan that is due does not start either.
    const requests = w.requests.length;
    await w.worker.onTick();
    expect(w.requests).toHaveLength(requests);
    release();
    expect(await first).toEqual({ ok: true, data: null });
    expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B']);
    expect(await w.store.listScans()).toHaveLength(1);
  });

  it('two runPaid sent together spend once', async () => {
    const w = await waitingWorld();
    const replies = await Promise.all([runPaid(w, LOOK_01B), runPaid(w, LOOK_01B)]);
    expect(replies).toContainEqual({ ok: true, data: null });
    expect(replies).toContainEqual({ ok: false, error: PAYING });
    expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B']);
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B]);
  });

  it('a failed search is reported in one sentence without the key, and not retried', async () => {
    const w = await waitingWorld();
    w.beforeSearch = (url) => {
      if (url.searchParams.get('k') === 'RYOBI PBLRC01B') throw new TypeError(`request to ${url} failed (api_key=OLDKEY123&q=x)`);
    };
    const searches = () => w.requests.filter((r) => r.endsWith('/search.json')).length;
    const before = searches();
    const reply = await runPaid(w, LOOK_01B);
    expect(reply.ok).toBe(false);
    const error = reply.ok ? '' : reply.error;
    expect(error).toMatch(/^Network error reaching SerpApi: request to .*api_key=\[key\]/);
    expect(error).toContain('api_key=[key]&q=x');
    expect(error).not.toContain(`api_key=${KEY}`);
    expect(error).not.toContain('OLDKEY123');
    expect(searches()).toBe(before + 1);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'waiting' });
    expect(JSON.stringify(w.broadcasts)).not.toContain('OLDKEY123');
  });

  it('forgetKey sent while the account is checked: no search, and no account saved for the forgotten key', async () => {
    const w = await waitingWorld();
    let asked!: () => void;
    const checking = new Promise<void>((resolve) => (asked = resolve));
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const answer = w.accountApi;
    w.accountApi = async (key) => {
      asked();
      await open;
      return answer(key);
    };
    const reply = runPaid(w, LOOK_01B);
    await checking;
    await send(w, { type: 'forgetKey' });
    release();
    expect(await reply).toEqual({ ok: false, error: 'Add your SerpApi key in Settings.' });
    expect(w.replay.calls).toEqual([RATCHET]);
    expect(w.prefs.data.account ?? null).toBeNull();
  });

  /** Holds the search for `k` until release(); `reached` resolves when it is held. */
  function holdSearch(w: World, k: string) {
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    w.beforeSearch = async (url) => {
      if (url.searchParams.get('k') !== k) return;
      reach();
      await open;
    };
    return { reached, release };
  }

  /** The key of every Account API request from now on. NEWKEY is accepted too, with 77 searches left. */
  function accountKeys(w: World): string[] {
    const keys: string[] = [];
    const answer = w.accountApi;
    w.accountApi = (key) => {
      keys.push(key);
      return key === 'NEWKEY' ? new Response(JSON.stringify({ ...fx.SERPAPI_ACCOUNT_FREE, total_searches_left: 77 }), { status: 200 }) : answer(key);
    };
    return keys;
  }

  const STOPPED_KEY = 'Stopped: the key was removed or changed.';

  it('Forget key during the search: the account is not checked again with the forgotten key, nor saved', async () => {
    const w = await waitingWorld();
    const keys = accountKeys(w);
    const search = holdSearch(w, 'RYOBI PBLRC01B');
    const reply = runPaid(w, LOOK_01B);
    await search.reached;
    expect(keys).toEqual([KEY]);
    await send(w, { type: 'forgetKey' });
    search.release();
    // The one search was already sent: it is answered and applied.
    expect(await reply).toEqual({ ok: true, data: null });
    expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B']);
    expect(keys).toEqual([KEY]);
    expect(w.prefs.data.account ?? null).toBeNull();
  });

  it('a new key saved during the search: its account is not overwritten with the old key\'s', async () => {
    const w = await waitingWorld();
    const keys = accountKeys(w);
    const search = holdSearch(w, 'RYOBI PBLRC01B');
    const reply = runPaid(w, LOOK_01B);
    await search.reached;
    expect(await send(w, { type: 'checkKey', apiKey: 'NEWKEY' })).toMatchObject({ ok: true });
    search.release();
    await reply;
    expect(keys).toEqual([KEY, 'NEWKEY']);
    expect(w.prefs.data.account).toMatchObject({ info: { totalSearchesLeft: 77 } });
  });

  it('a quote whose account check outlives the key saves nothing, and says there is no key', async () => {
    const w = await waitingWorld();
    w.clock = T0 + 6 * MINUTE;
    let asked!: () => void;
    const checking = new Promise<void>((resolve) => (asked = resolve));
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const answer = w.accountApi;
    w.accountApi = async (key) => {
      asked();
      await open;
      return answer(key);
    };
    const reply = quote(w, LOOK_01B);
    await checking;
    await send(w, { type: 'forgetKey' });
    release();
    expect(await reply).toEqual({ ok: true, data: { searches: 1, refusal: 'Add your SerpApi key in Settings.' } });
    expect(w.prefs.data.account ?? null).toBeNull();
  });

  it('Forget key during a two-part Look up spends at most what was already in flight', async () => {
    const w = await waitingWorld();
    w.prefs.data.settings = { ...ONE, searchesPerScan: 2 };
    expect(await quote(w, LOOK_BOTH)).toEqual({ ok: true, data: { searches: 2, refusal: null } });
    const search = holdSearch(w, 'RYOBI PBLRC01B');
    const reply = runPaid(w, LOOK_BOTH);
    await search.reached;
    await send(w, { type: 'forgetKey' });
    search.release();
    expect(await reply).toEqual({ ok: false, error: STOPPED_KEY });
    expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B']);
    expect(w.replay.calls).toEqual([RATCHET, LOOKUP_01B]);
    expect(await w.store.getMatch('RYOBI:PBLRC01B')).toMatchObject({ status: 'matched' });
    expect(await w.store.getMatch('RYOBI:PBLRC25B')).toMatchObject({ status: 'waiting' });
  });

  it('a different key saved during a two-part Look up stops it too; the same key saved again does not', async () => {
    for (const [apiKey, stopped] of [['NEWKEY', true], [KEY, false]] as const) {
      const w = await waitingWorld();
      w.prefs.data.settings = { ...ONE, searchesPerScan: 2 };
      const keys = accountKeys(w);
      const search = holdSearch(w, 'RYOBI PBLRC01B');
      const reply = runPaid(w, LOOK_BOTH);
      await search.reached;
      expect(await send(w, { type: 'checkKey', apiKey })).toMatchObject({ ok: true });
      search.release();
      expect(await reply, apiKey).toEqual(stopped ? { ok: false, error: STOPPED_KEY } : { ok: true, data: null });
      expect(panelLabels(w), apiKey).toEqual(stopped ? ['panel:lookup:PBLRC01B'] : ['panel:lookup:PBLRC01B', 'panel:lookup:PBLRC25B']);
      if (!stopped) continue;
      // The same worker's next action is not stopped: it checks the new key's account and spends.
      const before = keys.length;
      expect(await runPaid(w, VERIFY_01B)).toEqual({ ok: true, data: null });
      expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B', 'panel:verify:PBLRC01B']);
      expect(keys.slice(before)).toEqual(['NEWKEY', 'NEWKEY']);
    }
  });

  it('after Forget key stopped a Look up, the same worker refuses without a key, then runs and spends once a key is saved', async () => {
    const w = await waitingWorld();
    w.prefs.data.settings = { ...ONE, searchesPerScan: 2 };
    const search = holdSearch(w, 'RYOBI PBLRC01B');
    const reply = runPaid(w, LOOK_BOTH);
    await search.reached;
    await send(w, { type: 'forgetKey' });
    search.release();
    expect(await reply).toEqual({ ok: false, error: STOPPED_KEY });
    expect(await runPaid(w, VERIFY_01B)).toEqual({ ok: false, error: 'Add your SerpApi key in Settings.' });
    expect(await send(w, { type: 'checkKey', apiKey: KEY })).toMatchObject({ ok: true });
    expect(await runPaid(w, VERIFY_01B)).toEqual({ ok: true, data: null });
    expect(panelLabels(w)).toEqual(['panel:lookup:PBLRC01B', 'panel:verify:PBLRC01B']);
  });

  it('a Forget key between a quote\'s key read and its account check: the forgotten key is not sent', async () => {
    const w = await waitingWorld();
    w.clock = T0 + 6 * MINUTE;
    const keys = accountKeys(w);
    // The first account read after the quote's key read is where the Forget key lands.
    const getAccount = w.prefs.getAccount.bind(w.prefs);
    let first = true;
    w.prefs.getAccount = async () => {
      if (first) {
        first = false;
        await send(w, { type: 'forgetKey' });
      }
      return getAccount();
    };
    expect(await quote(w, LOOK_01B)).toEqual({ ok: true, data: { searches: 1, refusal: 'Add your SerpApi key in Settings.' } });
    expect(first).toBe(false);
    expect(keys).toEqual([]);
    expect(w.prefs.data.account ?? null).toBeNull();
  });

  it('without a key both say so, and a request that is not a paid action is refused', async () => {
    const w = await waitingWorld();
    await send(w, { type: 'forgetKey' });
    expect(await quote(w, LOOK_01B)).toEqual({ ok: true, data: { searches: 1, refusal: 'Add your SerpApi key in Settings.' } });
    expect(await runPaid(w, LOOK_01B)).toEqual({ ok: false, error: 'Add your SerpApi key in Settings.' });
    for (const action of [{ kind: 'lookUp', parts: [] }, { kind: 'verify', brand: 'RYOBI' }, null]) {
      for (const type of ['quote', 'runPaid'] as const) {
        expect(await send(w, { type, action } as unknown as Request)).toEqual({ ok: false, error: 'That request could not be read.' });
      }
    }
    expect(w.replay.calls).toEqual([RATCHET]);
  });
});

describe('worker: answerReview', () => {
  const AMBIGUOUS = 'split:homedepot:ambiguous';
  const SCANNING = 'A scan is running. Answer again when it has finished.';

  /** The real bundle whose '1B' fits DCF891B and DCF921B (core/test/fixtures.ts). A scan asks which. */
  async function seedAmbiguous(store: ScanStore): Promise<void> {
    const [model, title] = fx.HD_DEWALT_AMBIGUOUS;
    await store.putBundle({
      key: 'homedepot:ambiguous', retailer: 'homedepot', itemId: 'ambiguous', title, brand: 'DEWALT', model,
      upc: null, price: null, regularPrice: null, percentOff: null, link: null, seenAt: T0, split: null,
    });
    for (const m of ['DCF891B', 'DCF921B']) {
      await store.putCatalogEntry({ key: `DEWALT:${m}`, brand: 'DEWALT', model: m, title: `${m} (seeded for this test)`, kinds: ['impact wrench'], isKit: false, upc: null, seenAt: T0 });
    }
  }

  async function report(w: World): Promise<PanelReport> {
    const reply = await send<PanelReport>(w, { type: 'getReport' });
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }

  /** The answer as the panel sends it: signed with the question as getReport shows it ('[]' when it shows no such question). */
  async function asShown(w: World, id: string, pick: { choice: number } | { none: true }): Promise<ReviewAnswer> {
    const item = (await report(w)).review.find((r) => r.id === id);
    return { ...pick, seen: item ? reviewSignature(item) : '[]' };
  }

  it('saves the chosen reading, broadcasts, and the report no longer asks the question', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seedAmbiguous(w.store);
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect((await report(w)).review.find((r) => r.id === AMBIGUOUS)).toMatchObject({
      kind: 'split', choices: [['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']],
    });

    const answer = await asShown(w, AMBIGUOUS, { choice: 1 });
    const before = w.broadcasts.length;
    w.clock = T0 + MINUTE;
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer })).toEqual({ ok: true, data: null });
    expect(w.broadcasts.length).toBe(before + 1);
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: 'DCKTS650D1P1,DCF921B', answeredAt: T0 + MINUTE });
    const after = await report(w);
    expect(after.review.map((r) => r.id)).not.toContain(AMBIGUOUS);
    expect(after.bundles.find((b) => b.key === 'homedepot:ambiguous')).toMatchObject({
      section: 'missing_listing', parts: [{ model: 'DCKTS650D1P1' }, { model: 'DCF921B' }],
    });
  });

  it('refuses an unknown question, an answered one and an answer not shown with a plain sentence', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seedAmbiguous(w.store);
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const before = w.broadcasts.length;
    expect(await send(w, { type: 'answerReview', id: 'split:homedepot:nothing', answer: { none: true, seen: '[]' } })).toEqual({ ok: false, error: 'That question was not found.' });
    const { seen } = await asShown(w, AMBIGUOUS, { none: true });
    // An index not shown, or a request without the signature of what was shown.
    for (const answer of [{ choice: 2, seen }, { choice: -1, seen }, { seen }, { choice: 0 }, { none: true }, {}, undefined]) {
      const request = { type: 'answerReview', id: AMBIGUOUS, answer } as unknown as Request;
      expect(await send(w, request), JSON.stringify(answer)).toEqual({ ok: false, error: 'Choose one of the answers shown.' });
    }
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: { choice: 0, seen: '[]' } })).toEqual({ ok: false, error: 'That question changed. Choose again.' });
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: null });
    expect(w.broadcasts.length).toBe(before);

    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: { none: true, seen } })).toEqual({ ok: true, data: null });
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: { choice: 0, seen } })).toEqual({ ok: false, error: 'That question was already answered.' });
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: 'none' });
  });

  it('refuses while a scan runs, which reads and rewrites the questions, and takes the answer once it has ended', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seedAmbiguous(w.store);
    const gate = held(w);
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: await asShown(w, AMBIGUOUS, { choice: 0 }) })).toEqual({ ok: false, error: SCANNING });
    gate.release();
    await untilIdle(w);
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: await asShown(w, AMBIGUOUS, { choice: 0 }) })).toEqual({ ok: true, data: null });
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual({
      components: ['DCKTS650D1P1', 'DCF891B'], status: 'resolved', notes: ['parts chosen by you'],
    });
  });

  it('the answer stands after the worker restarts and scans again', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seedAmbiguous(w.store);
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: await asShown(w, AMBIGUOUS, { choice: 1 }) })).toEqual({ ok: true, data: null });

    w.worker = workerOver(w);
    w.clock = T0 + 10 * MINUTE;
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual({
      components: ['DCKTS650D1P1', 'DCF921B'], status: 'resolved', notes: ['parts chosen by you'],
    });
    expect((await report(w)).review.map((r) => r.id)).not.toContain(AMBIGUOUS);
  });
});
