import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { replayRecorded, type Replay } from '../../scripts/replay';
import * as fx from '../../core/test/fixtures';
import { reviewSignature } from '@core/scan/answers';
import { MemoryScanStore } from '@core/scan/memoryStore';
import { buildReport } from '@core/scan/report';
import type { BundleRow, PageOutcome, PaidAction, PartPriceReading, Quote, ReadPages, ReadPartPrices, ReviewAnswer, ScanJob, ScanStore } from '@core/scan/types';
import { parseAccount } from '@core/serpapi/budget';
import { type Cache, type LedgerEntry, MemoryCache, NETWORK_ERROR_PREFIX } from '@core/serpapi/client';
import { noticeSentence } from '../entrypoints/sidepanel/Notice';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS, type EbaySettings, type ExtensionSettings } from '@core/settings';
import type { AppState, PanelReport, Reply, Request } from './messages';
import type { ActiveScan, CachedEbayToken, StoredAccount } from './prefs';
import { parseProductPage, type ProductPage } from '@core/hdPage';
import type { EbayListing } from '@core/ebay/types';
import { browseItem, browseSearch } from '../../scripts/ebay-replay';
import { notePage, type PageView } from '@core/scan/pageView';
import { toScanSettings } from '@core/settings';
import { trustedRates, type UnitRates } from '@core/scan/pipeline';
import { createWorker, type DeferredPage, type PageEnv, type Prefs, progressOf, type Worker } from './worker';

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
/** What the panel's Notice says for a network failure. */
const OFFLINE = 'SerpApi could not be reached. Check the connection, then retry.';

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
  showChip = true;
  async getShowChip() {
    return this.showChip;
  }
  // Step 11: how long a unit of each kind took, as prefs.ts keeps it.
  rates: unknown = {};
  async getRates() {
    return trustedRates(structuredClone(this.rates));
  }
  async setRates(v: UnitRates) {
    this.rates = structuredClone(v);
  }
  // Step 10: the eBay and Anthropic keys, the judge's settings and eBay's token, unchecked like the rest.
  ebayKeys: { appId: string; certId: string } | null = null;
  anthropicKey: string | null = null;
  ebaySettings: unknown = {};
  token: CachedEbayToken | null = null;
  async getEbayKeys() {
    return structuredClone(this.ebayKeys);
  }
  async setEbayKeys(keys: { appId: string; certId: string }) {
    this.ebayKeys = structuredClone(keys);
  }
  async forgetEbayKeys() {
    this.ebayKeys = null;
  }
  async getAnthropicKey() {
    return this.anthropicKey;
  }
  async setAnthropicKey(key: string) {
    this.anthropicKey = key;
  }
  async forgetAnthropicKey() {
    this.anthropicKey = null;
  }
  async getEbaySettings() {
    return { ...structuredClone(DEFAULT_EBAY_SETTINGS), ...(typeof this.ebaySettings === 'object' && this.ebaySettings !== null ? structuredClone(this.ebaySettings) : {}) } as EbaySettings;
  }
  async saveEbaySettings(s: EbaySettings) {
    this.ebaySettings = structuredClone(s);
  }
  async getEbayToken() {
    return structuredClone(this.token);
  }
  async setEbayToken(t: CachedEbayToken) {
    this.token = structuredClone(t);
  }
  async clearEbayToken() {
    this.token = null;
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

/** The chip's page visits in memory: what chrome.storage.session and chrome.sidePanel give the worker, with a record of every call. */
class FakePages implements PageEnv {
  pages = new Map<number, ProductPage>();
  wantedTabs = new Set<number>();
  /** Every sidePanel.open call, in order. */
  opened: number[] = [];
  /** Every nudge sent to open panels. */
  told: number[] = [];
  /** Set to make sidePanel.open refuse, as Chrome does without a user action. */
  refuseOpen = false;
  async load(tabId: number) {
    const p = this.pages.get(tabId);
    return p ? structuredClone(p) : null;
  }
  async save(tabId: number, page: ProductPage | null) {
    if (page === null) this.pages.delete(tabId);
    else this.pages.set(tabId, structuredClone(page));
  }
  async setWanted(tabId: number, on: boolean) {
    if (on) this.wantedTabs.add(tabId);
    else this.wantedTabs.delete(tabId);
  }
  async wanted(tabId: number) {
    return this.wantedTabs.has(tabId);
  }
  openPanel(tabId: number) {
    this.opened.push(tabId);
    return this.refuseOpen ? Promise.reject(new Error('sidePanel.open() may only be called in response to a user gesture.')) : Promise.resolve();
  }
  tell(tabId: number) {
    this.told.push(tabId);
  }
  /** The visits not stored yet, as chrome.storage.session keeps them. */
  deferred = new Map<string, DeferredPage & { tabId: number }>();
  async setDeferred(tabId: number, itemId: string, entry: DeferredPage | null) {
    if (entry === null) this.deferred.delete(`${tabId}:${itemId}`);
    else this.deferred.set(`${tabId}:${itemId}`, { tabId, ...structuredClone(entry) });
  }
  async deferredAll() {
    return [...this.deferred.values()].map((e) => structuredClone(e));
  }
  /** The tab the scan's reader opened. */
  readerTab: number | null = null;
  chipTabSet = new Set<number>();
  /** Every chipSetting sent, as [tabId, show]. */
  chipSent: [number, boolean][] = [];
  /** Tabs that have no content script to receive a chipSetting. */
  deafTabs = new Set<number>();
  async isReaderTab(tabId: number) {
    return this.readerTab === tabId;
  }
  async chipTabs() {
    return [...this.chipTabSet];
  }
  async setChipTab(tabId: number, on: boolean) {
    if (on) this.chipTabSet.add(tabId);
    else this.chipTabSet.delete(tabId);
  }
  async sendChipSetting(tabId: number, show: boolean) {
    if (this.deafTabs.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
    this.chipSent.push([tabId, show]);
  }
}

interface World {
  pages: FakePages;
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
  readPartPrices?: ReadPartPrices;
  callTimeoutMs?: number;
  worker: Worker;
}

interface Setup {
  key?: string;
  settings?: unknown;
  lastScheduledRunAt?: number | null;
  accountOver?: Record<string, unknown>;
  readPages?: ReadPages;
  readPartPrices?: ReadPartPrices;
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
    pages: new FakePages(),
    requests: [],
    accountOver: setup.accountOver ?? {},
    beforeSearch: () => {},
    readPages: setup.readPages,
    readPartPrices: setup.readPartPrices,
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
    readPartPrices: w.readPartPrices,
    callTimeoutMs: w.callTimeoutMs,
    pages: w.pages,
  });
}

const send = <T = unknown>(w: World, request: Request, sender?: { tabId?: number }): Promise<Reply<T>> => w.worker.onMessage(request, sender) as Promise<Reply<T>>;

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
    const offline = await send(w, { type: 'checkKey', apiKey: KEY });
    expect(offline).toEqual({ ok: false, error: expect.stringMatching(new RegExp(`^${NETWORK_ERROR_PREFIX}: `)) });
    expect(offline).not.toMatchObject({ error: expect.stringContaining('Failed to fetch') });
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

describe('worker: reading Home Depot prices of parts', () => {
  it('a scan hands the part price reader to runScan, which asks it for the parts it has split, and no search pays for it', async () => {
    const asked: { brand: string; model: string }[][] = [];
    const readPartPrices: ReadPartPrices = async (parts) => {
      asked.push(parts);
      return parts.map((p): PartPriceReading => ({ ...p, status: 'not_found', matchedModel: null, itemId: null, price: null, title: null, link: null }));
    };
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR, readPartPrices });
    await w.worker.onTick();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.length).toBeGreaterThan(0);
    expect(asked[0]!.every((p) => p.brand === 'RYOBI' && p.model !== '')).toBe(true);
    // A reading is free: the searches counted are the scan's own lookups.
    expect(w.ledger.length).toBe((await lastJob(w)).searchesUsed);
  });

  it('without a reader, no price is read and the scan runs as before', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    await w.worker.onTick();
    expect((await lastJob(w)).status).not.toBe('running');
  });
});

describe('worker: how long a unit takes (step 11)', () => {
  /** Every search takes two seconds on this clock. */
  const slow = (w: World): void => {
    w.beforeSearch = () => {
      w.clock += 2000;
    };
  };

  it('a scan that ends adds what it measured to the rates, and the state carries them', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    slow(w);
    expect((await state(w)).rates).toEqual({});
    await w.worker.onTick();
    const job = await lastJob(w);
    expect(job.pipeline!.map((s) => s.id)).toHaveLength(8);
    const rates = (await state(w)).rates!;
    // One sample for the Home Depot page and one for the lookups, two seconds a search.
    expect(rates.serpapiSearch).toEqual([2, 2]);
    expect(Object.keys(rates)).toEqual(['serpapiSearch']);
  });

  it('keeps adding: a second scan makes four samples', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    slow(w);
    await w.worker.onTick();
    // The next scan is due again, a day on; its pages come from the replay, the clock still takes two seconds a search.
    w.clock += 25 * HOUR;
    await w.worker.onTick();
    expect((await state(w)).rates!.serpapiSearch!.length).toBeGreaterThanOrEqual(3);
  });

  it('a scan that measured nothing leaves the rates as they were', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    w.prefs.rates = { ebayCall: [0.5] };
    await w.worker.onTick();
    expect((await state(w)).rates).toEqual({ ebayCall: [0.5] });
  });

  it('a store that will not take the rates does not fail the scan', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, schedule: SIX_HOURS }, lastScheduledRunAt: T0 - 7 * HOUR });
    slow(w);
    w.prefs.setRates = async () => {
      throw new Error('quota');
    };
    await w.worker.onTick();
    expect((await lastJob(w)).status).not.toBe('running');
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
    expect(w.prefs.data.activeScan).toEqual({ jobId: saved!.id, trigger: 'scheduled', attempts: 0, progress: '0:listing:1:0:0:0' });
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
    expect((await state(w)).problem).toMatch(new RegExp(`^${NETWORK_ERROR_PREFIX}: `));
    expect(noticeSentence(w.broadcasts.at(-1)!, null)).toBe(OFFLINE);

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

  it('Scan now with SerpApi out of reach: the panel says it could not be reached, with no text of the failed request', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.accountApi = (key) => {
      throw new TypeError(`request to https://serpapi.com/account.json?api_key=${key} failed`);
    };
    const reply = await send(w, { type: 'scanNow' });
    expect(reply.ok).toBe(false);
    const { problem } = await state(w);
    expect(problem).toMatch(new RegExp(`^${NETWORK_ERROR_PREFIX}: `));
    expect(problem).not.toMatch(/request to|api_key/);
    expect(noticeSentence(await state(w), null)).toBe(OFFLINE);
    expect(noticeSentence(w.broadcasts.at(-1)!, reply.ok ? null : reply.error)).toBe(OFFLINE);
    expect(w.replay.calls).toEqual([]);
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

  it('exportAudit replies with the contract: bundles with primary parts, listings, matches, answered items; no key, no settings', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const [first] = await w.store.listReview();
    await w.store.putReview({ ...first!, answer: 'not a bundle', answeredAt: T0 });
    const reply = await send<string>(w, { type: 'exportAudit' });
    expect(reply.ok).toBe(true);
    const text = reply.ok ? reply.data : '{}';
    const data = JSON.parse(text);
    expect(Object.keys(data)).toEqual(['kind', 'version', 'exportedAt', 'bundles', 'listings', 'matches', 'answers', 'questions', 'ebayAnswers', 'ebayQuestions']);
    expect(data.ebayAnswers).toEqual([]);
    expect(data.ebayQuestions).toEqual([]);
    expect(data).toMatchObject({ kind: 'split-finder-audit', version: 1, exportedAt: w.clock });
    expect(data.matches.map((m: { key: string }) => m.key)).toEqual(['RYOBI:PBLRC01B', 'RYOBI:PBLRC25B']);
    expect(data.listings).toEqual(await w.store.listListings());
    expect(data.listings.length).toBeGreaterThan(0);
    expect(data.answers).toEqual([{ ...first, answer: 'not a bundle', answeredAt: T0 }]);
    expect(data.questions).toEqual((await w.store.listReview()).filter((r) => r.answer === null));
    expect(data.questions.length).toBeGreaterThan(0);
    expect(data.bundles.length).toBeGreaterThan(0);
    const report = await buildReport(w.store, toScanSettings(RYOBI));
    for (const b of data.bundles) {
      expect(Object.keys(b)).toEqual(['key', 'itemId', 'brand', 'model', 'title', 'section', 'split', 'parts']);
      const row = report.bundles.find((r) => r.key === b.key)!;
      expect(b.parts).toEqual(
        row.parts.map((p) => ({ brand: row.brand, model: p.model, qty: p.qty, asin: p.asin, grade: p.grade, source: null, isKit: false })),
      );
    }
    expect(data.bundles.some((b: { parts: unknown[] }) => b.parts.length > 0)).toBe(true);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('"settings"');
  });

  it('exportAudit marks a part isKit when the scan would ask for it as a kit', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const part = (await buildReport(w.store, toScanSettings(RYOBI))).bundles.flatMap((b) => b.parts.map((p) => ({ brand: b.brand, model: p.model })))[0]!;
    await w.store.putCatalogEntry({
      key: `${part.brand}:${part.model}`, brand: part.brand, model: part.model, title: 't', kinds: [], isKit: true, upc: null, seenAt: T0,
    });
    const reply = await send<string>(w, { type: 'exportAudit' });
    const data = JSON.parse(reply.ok ? reply.data : '{}');
    const exported = data.bundles.flatMap((b: { parts: { model: string; isKit: boolean }[] }) => b.parts).filter((p: { model: string }) => p.model === part.model);
    expect(exported.length).toBeGreaterThan(0);
    for (const p of exported) expect(p.isKit).toBe(true);
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
    expect(w.prefs.data.activeScan).toMatchObject({ attempts: 0, progress: '0:listing:1:0:0:0' });

    w.clock = T0 + MINUTE;
    await worker.onTick();
    expect(w.replay.calls).toEqual([RATCHET, RATCHET]);
    expect(w.prefs.data.activeScan).toMatchObject({ attempts: 1, progress: '0:listing:1:0:0:0' });

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
  /** A manual action may use the reserve down to zero: a reserve refusal means the month's searches are used up. */
  const NONE_LEFT = 'No searches are left this month.';
  /** A refused quote describes the action, not a scan: nothing has stopped. */
  const HOURLY = 'SerpApi allows 50 searches an hour, and they are used. Try again later.';
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

  it('a Look up above searches per scan quotes what fits and the parts left, and runPaid spends only that (Ruling 72)', async () => {
    const w = await waitingWorld();
    expect(await quote(w, LOOK_BOTH)).toEqual({ ok: true, data: { searches: 1, refusal: null, leftWaiting: 1 } });
    w.clock = T0 + MINUTE;
    expect(await runPaid(w, LOOK_BOTH)).toEqual({ ok: true, data: null });
    expect(panelLabels(w)).toHaveLength(1);
    // The next quote is for what is left: never more than one search, and nothing left over.
    const next = await quote(w, LOOK_BOTH);
    expect(next).toMatchObject({ ok: true, data: { refusal: null } });
    expect((next as { data: Quote }).data.searches).toBeLessThanOrEqual(1);
    expect((next as { data: Quote }).data.leftWaiting).toBeUndefined();
  });

  it('a quote above the budget refuses with the budget\'s own sentence, and runPaid then sends nothing', async () => {
    // Settings never allow fewer than 1 search per scan, so in the extension a Look up is refused by the month or the hour, never by the per-scan limit.
    const w = await waitingWorld();
    w.accountOver = { total_searches_left: 0 };
    w.clock = T0 + 6 * MINUTE;
    expect(await quote(w, LOOK_BOTH)).toEqual({ ok: true, data: { searches: 1, refusal: NONE_LEFT, leftWaiting: 1 } });
    const requests = w.requests.length;
    expect(await runPaid(w, LOOK_BOTH)).toEqual({ ok: false, error: NONE_LEFT });
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

  it('a failed account check before a paid action is said to the caller only, not as the scan\'s problem', async () => {
    const w = await waitingWorld();
    w.accountApi = () => new Response('{}', { status: 503 });
    expect(await runPaid(w, LOOK_01B)).toEqual({ ok: false, error: 'SerpApi account check failed (HTTP 503).' });
    expect((await state(w)).problem).toBeNull();
    expect(w.broadcasts.at(-1)!.problem).toBeNull();
    w.accountApi = () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await runPaid(w, LOOK_01B)).toEqual({ ok: false, error: expect.stringMatching(new RegExp(`^${NETWORK_ERROR_PREFIX}: `)) });
    expect((await state(w)).problem).toBeNull();
    expect(w.replay.calls).toEqual([RATCHET]);
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
      section: 'missing_listing', parts: [{ model: 'DCKTS650D1P1', status: 'unmatched' }, { model: 'DCF921B', status: 'unmatched' }],
    });
    // Its parts have no match yet: a Look up searches for both.
    const lookUp: PaidAction = { kind: 'lookUp', parts: [{ brand: 'DEWALT', model: 'DCKTS650D1P1' }, { brand: 'DEWALT', model: 'DCF921B' }] };
    expect(await send(w, { type: 'quote', action: lookUp })).toEqual({ ok: true, data: { searches: 2, refusal: null } });
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

  it('passes parts the owner typed to the split, and refuses an entry that is not model numbers with its sentence', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seedAmbiguous(w.store);
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const { seen } = await asShown(w, AMBIGUOUS, { none: true });
    const before = w.broadcasts.length;
    const tail = 'Enter model numbers like DCB205, separated by commas.';
    for (const [parts, error] of [[[], tail], [['KIT'], `"KIT" is not a model number. ${tail}`], ['DCKTS650D1P1, DCB205', tail]] as const) {
      const request = { type: 'answerReview', id: AMBIGUOUS, answer: { parts, seen } } as unknown as Request;
      expect(await send(w, request), JSON.stringify(parts)).toEqual({ ok: false, error });
    }
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: null });
    expect(w.broadcasts.length).toBe(before);

    w.clock = T0 + MINUTE;
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: { parts: ['dckts650d1p1', 'DCB205'], seen } })).toEqual({ ok: true, data: null });
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: 'DCKTS650D1P1,DCB205', answerParts: ['DCKTS650D1P1', 'DCB205'], answeredAt: T0 + MINUTE });
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual({ components: ['DCKTS650D1P1', 'DCB205'], status: 'resolved', notes: ['parts entered by you'] });
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

  it('reopenReview opens an answered split question again, broadcasts, and the report asks it at once (Ruling 42)', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seedAmbiguous(w.store);
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const open = (await w.store.getReview(AMBIGUOUS))!;
    const split = (await w.store.getBundle('homedepot:ambiguous'))!.split;
    w.clock = T0 + MINUTE;
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: { parts: ['DCKTS650D1P1', 'DCB205'], seen: reviewSignature(open) } })).toEqual({ ok: true, data: null });
    expect((await report(w)).bundles.find((b) => b.key === 'homedepot:ambiguous')!.answer).toEqual({ reviewId: AMBIGUOUS, kind: 'entered' });

    const before = w.broadcasts.length;
    w.clock = T0 + 2 * MINUTE;
    expect(await send(w, { type: 'reopenReview', id: AMBIGUOUS })).toEqual({ ok: true, data: null });
    expect(w.broadcasts.length).toBe(before + 1);
    expect(await w.store.getReview(AMBIGUOUS)).toEqual(open);
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual(split);
    const after = await report(w);
    expect(after.review.find((r) => r.id === AMBIGUOUS)).toMatchObject({ choices: [['DCKTS650D1P1', 'DCF891B'], ['DCKTS650D1P1', 'DCF921B']], openedAt: open.openedAt });
    expect(after.bundles.find((b) => b.key === 'homedepot:ambiguous')).toMatchObject({ section: 'split', status: 'needs_review', answer: null });

    // Answered again, as the question now shows.
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: await asShown(w, AMBIGUOUS, { choice: 1 }) })).toEqual({ ok: true, data: null });
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual({ components: ['DCKTS650D1P1', 'DCF921B'], status: 'resolved', notes: ['parts chosen by you'] });
  });

  it('reopenReview refuses an unknown id, an open question, and any request while a scan runs, with a plain sentence and nothing written', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seedAmbiguous(w.store);
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    const before = w.broadcasts.length;
    expect(await send(w, { type: 'reopenReview', id: 'split:homedepot:nothing' })).toEqual({ ok: false, error: 'That question was not found.' });
    expect(await send(w, { type: 'reopenReview', id: 7 } as unknown as Request)).toEqual({ ok: false, error: 'That question was not found.' });
    expect(await send(w, { type: 'reopenReview', id: AMBIGUOUS })).toEqual({ ok: false, error: 'That question has not been answered yet.' });
    expect(w.broadcasts.length).toBe(before);

    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer: await asShown(w, AMBIGUOUS, { none: true }) })).toEqual({ ok: true, data: null });
    const answered = await w.store.getReview(AMBIGUOUS);
    const gate = held(w);
    w.clock = T0 + 10 * MINUTE;
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    expect(await send(w, { type: 'reopenReview', id: AMBIGUOUS })).toEqual({ ok: false, error: SCANNING });
    expect(await w.store.getReview(AMBIGUOUS)).toEqual(answered);
    gate.release();
    await untilIdle(w);
    // The answer stood through the scan; once it has ended the question can be reopened.
    expect(await w.store.getReview(AMBIGUOUS)).toEqual(answered);
    expect(await send(w, { type: 'reopenReview', id: AMBIGUOUS })).toEqual({ ok: true, data: null });
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: null, answeredAt: null });
  });

  it('answerReview and reopenReview refuse while a Look up or Verify runs, writing nothing, and take the request once it has ended (final review)', async () => {
    const SEARCHING = 'A search is running. Answer again when it has finished.';
    const LOOK_01B: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC01B' }] };
    const LOOK_25B: PaidAction = { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC25B' }] };
    const VERIFY_25B: PaidAction = { kind: 'verify', brand: 'RYOBI', model: 'PBLRC25B', asin: 'B0B3JWF5ZV' };
    // One search per scan: the ratchet page is read, both parts wait, and the ambiguous bundle is asked about.
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 1 } });
    await seedAmbiguous(w.store);
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    /** Holds the next search of a paid action until the returned release is called. */
    const holdPaid = async (action: PaidAction) => {
      let reached!: () => void;
      const atSearch = new Promise<void>((resolve) => (reached = resolve));
      let release!: () => void;
      const open = new Promise<void>((resolve) => (release = resolve));
      w.beforeSearch = async () => {
        reached();
        await open;
      };
      const reply = send<null>(w, { type: 'runPaid', action });
      await atSearch;
      return async () => {
        release();
        w.beforeSearch = () => {};
        expect(await reply).toEqual({ ok: true, data: null });
      };
    };

    // An open question, while a Look up waits on SerpApi.
    const answer = await asShown(w, AMBIGUOUS, { none: true });
    const open = await w.store.getReview(AMBIGUOUS);
    let finish = await holdPaid(LOOK_01B);
    let before = w.broadcasts.length;
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer })).toEqual({ ok: false, error: SEARCHING });
    expect(await w.store.getReview(AMBIGUOUS)).toEqual(open);
    expect(w.broadcasts.length).toBe(before);
    await finish();
    expect(await send(w, { type: 'answerReview', id: AMBIGUOUS, answer })).toEqual({ ok: true, data: null });

    // An answered question, while a Verify waits on SerpApi.
    expect(await send(w, { type: 'runPaid', action: LOOK_25B })).toEqual({ ok: true, data: null });
    const answered = await w.store.getReview(AMBIGUOUS);
    const split = (await w.store.getBundle('homedepot:ambiguous'))!.split;
    finish = await holdPaid(VERIFY_25B);
    before = w.broadcasts.length;
    expect(await send(w, { type: 'reopenReview', id: AMBIGUOUS })).toEqual({ ok: false, error: SEARCHING });
    expect(await w.store.getReview(AMBIGUOUS)).toEqual(answered);
    expect((await w.store.getBundle('homedepot:ambiguous'))!.split).toEqual(split);
    expect(w.broadcasts.length).toBe(before);
    await finish();
    expect(await send(w, { type: 'reopenReview', id: AMBIGUOUS })).toEqual({ ok: true, data: null });
    expect(await w.store.getReview(AMBIGUOUS)).toMatchObject({ answer: null, answeredAt: null });
  });
});

// ---------------------------------------------------------------- the chip and This page (step 7)

describe('worker: Home Depot pages the chip sends (pageSeen, getThisPage, openThisPage)', () => {
  // The pages are the recorded ones in fixtures/homedepot-pages (328814689, RYOBI PBLRC2501SB, is the founder's bundle);
  // its price is the shape captured on Nov 17 ($189, was $338), which the Nov 10 recordings cut out.
  const recorded = (JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/pages-2026-11-10.json', import.meta.url), 'utf8')) as {
    pages: { itemId: string; text: string }[];
  }).pages;
  const priced = (itemId: string, value: number, original: number): ProductPage => {
    const mark = `"base-catalog-${itemId}":{`;
    const entry = `"pricing({\\"isBrandPricingPolicyCompliant\\":false,\\"storeId\\":\\"8119\\"})":{"value":${value},"original":${original}},`;
    return parseProductPage(recorded.find((p) => p.itemId === itemId)!.text.replace(mark, mark + entry), itemId)!;
  };
  const unpriced = (itemId: string): ProductPage => parseProductPage(recorded.find((p) => p.itemId === itemId)!.text, itemId)!;
  const FOUNDER = priced('328814689', 189, 338);
  /** PCL500525SB: no split rule and no Includes list, so its split is a question that offers no reading. */
  const ASKED = unpriced('328690510');
  const ASKED_KEY = 'homedepot:328690510';
  const KIT = unpriced('317987591');
  const TAB = 7;

  const seen = (w: World, page: ProductPage, tabId: number | undefined = TAB) => send<PageView>(w, { type: 'pageSeen', page }, { tabId });
  const thisPage = (w: World, tabId = TAB) => send<{ kind: string } & Partial<PageView>>(w, { type: 'getThisPage', tabId });
  const bundleOf = (reply: Reply<unknown>) => {
    if (!reply.ok) throw new Error(reply.error);
    const view = reply.data as PageView;
    if (view.kind !== 'bundle') throw new Error(`expected a bundle, got ${view.kind}`);
    return view;
  };
  /** Everything the store holds that a visit could write. */
  async function stored(w: World) {
    return { bundles: await w.store.listBundles(), review: await w.store.listReview(), matches: await w.store.listMatches(), scans: await w.store.listScans() };
  }
  /** The view notePage gives over a store of its own, as the one to compare the worker's with. */
  async function direct(page: ProductPage, now = T0): Promise<PageView> {
    return notePage(new MemoryScanStore(), toScanSettings(RYOBI), page, now);
  }

  it('the founder\'s page: split into PBLRC25B and PBLRC01B from the page, priced at $189, stored, remembered for the tab, and not one request sent', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const before = w.broadcasts.length;
    const view = bundleOf(await seen(w, FOUNDER));
    expect(view).toMatchObject({ model: 'PBLRC2501SB', parts: 2, question: null, key: 'homedepot:328814689' });
    expect(view.row).toMatchObject({ price: 189, regularPrice: 338, parts: [{ model: 'PBLRC25B' }, { model: 'PBLRC01B' }] });
    // The same view a scan's own steps give over an empty store.
    expect(view).toEqual(await direct(FOUNDER));
    expect(await w.store.getBundle('homedepot:328814689')).toMatchObject({ price: 189, seenAt: T0, split: { status: 'resolved', components: ['PBLRC25B', 'PBLRC01B'] } });
    expect(w.pages.pages.get(TAB)).toEqual(FOUNDER);
    // The panel hears of it, the key is never asked for, nothing is sent anywhere.
    expect(w.broadcasts.length).toBe(before + 1);
    expect(w.requests).toEqual([]);
    expect(w.replay.calls).toEqual([]);
    expect(await w.store.listScans()).toEqual([]);
  });

  it('works with no key at all: a page visit never needs one', async () => {
    const w = world({ settings: RYOBI });
    expect(bundleOf(await seen(w, FOUNDER)).parts).toBe(2);
    expect(w.requests).toEqual([]);
  });

  it('refuses a page with no tab (an extension page sent it) and stores nothing', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    expect(await send(w, { type: 'pageSeen', page: FOUNDER })).toEqual({ ok: false, error: 'This request needs a browser tab.' });
    expect(await stored(w)).toMatchObject({ bundles: [], review: [] });
    expect(w.pages.pages.size).toBe(0);
  });

  it('a page that is not a bundle (a plain kit) is none: nothing is stored, and the tab no longer holds the page it showed before', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seen(w, FOUNDER);
    const bundles = await w.store.listBundles();
    expect(await seen(w, KIT)).toEqual({ ok: true, data: { kind: 'none' } });
    expect(await w.store.listBundles()).toEqual(bundles);
    expect(w.pages.pages.has(TAB)).toBe(false);
    expect(await thisPage(w)).toEqual({ ok: true, data: { kind: 'empty' } });
  });

  it('a brand turned off in settings, and a page with a price that is not a number, are none and are not remembered', async () => {
    const w = world({ key: KEY, settings: { ...DEFAULT_SETTINGS, brands: ['DEWALT'] } });
    expect(await seen(w, FOUNDER)).toEqual({ ok: true, data: { kind: 'none' } });
    expect(w.pages.pages.size).toBe(0);
    const v = world({ key: KEY, settings: RYOBI });
    const bad = { ...FOUNDER, price: 'free' } as unknown as ProductPage;
    expect(await seen(v, bad)).toEqual({ ok: true, data: { kind: 'none' } });
    expect(v.pages.pages.size).toBe(0);
    expect(await v.store.listBundles()).toEqual([]);
  });

  it('keeps only the fields of a page: what else a script put in the message is not stored', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seen(w, { ...FOUNDER, extra: 'x'.repeat(5000), apiKey: 'nope' } as unknown as ProductPage);
    expect(w.pages.pages.get(TAB)).toEqual(FOUNDER);
  });

  it('a page that needs an answer: the view carries the question, and the answer through answerReview shows in the next view', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const view = bundleOf(await seen(w, ASKED));
    expect(view).toMatchObject({ parts: 0, question: { id: `split:${ASKED_KEY}`, kind: 'split', answer: null, choices: [] } });
    expect(view.row.status).toBe('needs_review');
    const answer: ReviewAnswer = { parts: ['PCL500B', 'PBP005'], seen: reviewSignature(view.question!) };
    expect(await send(w, { type: 'answerReview', id: view.question!.id, answer })).toEqual({ ok: true, data: null });
    // The page is not sent again: the tab's view is rebuilt from the store, and the question is gone.
    const after = bundleOf(await thisPage(w));
    expect(after.question).toBeNull();
    expect(after.row.parts.map((p) => p.model)).toEqual(['PCL500B', 'PBP005']);
    expect(after.parts).toBe(2);
  });

  it('getThisPage rebuilds the same view with no search and no write, and an unseen tab is empty', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const first = bundleOf(await seen(w, FOUNDER));
    const snapshot = await stored(w);
    w.clock = T0 + HOUR;
    const reply = await thisPage(w);
    expect(reply.ok && reply.data).toMatchObject({ kind: 'bundle', key: first.key, parts: first.parts, model: first.model });
    expect(await stored(w)).toEqual(snapshot);
    expect(w.requests).toEqual([]);
    expect(await thisPage(w, 99)).toEqual({ ok: true, data: { kind: 'empty' } });
    for (const bad of ['7', 1.5, null, undefined]) {
      expect(await send(w, { type: 'getThisPage', tabId: bad } as unknown as Request), String(bad)).toEqual({ ok: false, error: 'This request needs a browser tab.' });
    }
  });

  it('two tabs hold two pages, and a tab that is closed forgets its own', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seen(w, FOUNDER, 1);
    await seen(w, ASKED, 2);
    expect(bundleOf(await thisPage(w, 1)).itemId).toBe('328814689');
    expect(bundleOf(await thisPage(w, 2)).itemId).toBe('328690510');
    await w.worker.onTabClosed(1);
    expect(await thisPage(w, 1)).toEqual({ ok: true, data: { kind: 'empty' } });
    expect(bundleOf(await thisPage(w, 2)).itemId).toBe('328690510');
  });

  it('seen again after the owner navigates in the page: the tab shows the new page', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seen(w, FOUNDER);
    await seen(w, ASKED);
    expect(bundleOf(await thisPage(w)).itemId).toBe('328690510');
  });

  it('three pages sent together are taken one after the other: each stored once, one question opened', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const replies = await Promise.all([seen(w, ASKED, 1), seen(w, ASKED, 2), seen(w, FOUNDER, 3)]);
    expect(replies.every((r) => r.ok)).toBe(true);
    expect((await w.store.listReview()).map((r) => r.id)).toEqual([`split:${ASKED_KEY}`]);
    expect((await w.store.listBundles()).map((r) => r.key).sort()).toEqual(['homedepot:328690510', 'homedepot:328814689']);
  });

  it('while a scan runs the page is shown at once and nothing is written; it is stored when the scan has ended', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    const scanning = await stored(w);
    const broadcasts = w.broadcasts.length;

    // Not waited behind the scan, which is parked at its first search.
    const view = bundleOf(await seen(w, ASKED));
    expect(view).toMatchObject({ itemId: '328690510', question: { id: `split:${ASKED_KEY}` } });
    expect(await stored(w)).toEqual(scanning);
    expect(await w.store.getBundle(ASKED_KEY)).toBeUndefined();
    expect(w.broadcasts.length).toBeGreaterThan(broadcasts);
    // This page shows it too, still with nothing written.
    expect(bundleOf(await thisPage(w)).itemId).toBe('328690510');
    expect(await w.store.getBundle(ASKED_KEY)).toBeUndefined();

    gate.release();
    await untilIdle(w);
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toBeDefined());
    expect(await w.store.getReview(`split:${ASKED_KEY}`)).toMatchObject({ answer: null });
    // The scan used its own searches; the page used none.
    expect(w.replay.calls).toEqual([RYOBI_PAGE, RATCHET, LOOKUP_01B, LOOKUP_25B]);
  });

  it('while a Look up runs the page is shown and not written either, and is stored when it has ended', async () => {
    const w = world({ key: KEY, settings: { ...RYOBI, searchesPerScan: 1 } });
    await send(w, { type: 'scanNow' });
    await untilIdle(w);
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atSearch = new Promise<void>((resolve) => (reached = resolve));
    w.beforeSearch = async () => {
      reached();
      await open;
    };
    const lookUp = send(w, { type: 'runPaid', action: { kind: 'lookUp', parts: [{ brand: 'RYOBI', model: 'PBLRC01B' }] } });
    await atSearch;
    const snapshot = await stored(w);
    expect(bundleOf(await seen(w, ASKED)).itemId).toBe('328690510');
    expect(await stored(w)).toEqual(snapshot);
    release();
    expect(await lookUp).toEqual({ ok: true, data: null });
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toBeDefined());
  });

  it('a page seen while a scan runs, in a tab closed before the scan ends, is still stored when the scan ends: the visit happened', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    await seen(w, ASKED);
    await w.worker.onTabClosed(TAB);
    // The tab forgets its page, but not the visit that is waiting to be stored.
    expect(w.pages.pages.has(TAB)).toBe(false);
    expect(w.pages.deferred.size).toBe(1);
    gate.release();
    await untilIdle(w);
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toBeDefined());
    expect(await w.store.getReview(`split:${ASKED_KEY}`)).toMatchObject({ answer: null });
    expect(w.pages.deferred.size).toBe(0);
  });

  it('two pages opened one after the other in the same tab during a scan are both kept, and stored in the order they were seen', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    w.clock = T0 + 2 * MINUTE;
    await seen(w, ASKED);
    w.clock = T0 + 3 * MINUTE;
    await seen(w, FOUNDER);
    // The tab shows its last page; both visits wait.
    expect(w.pages.pages.get(TAB)?.itemId).toBe('328814689');
    expect([...w.pages.deferred.keys()].sort()).toEqual([`${TAB}:328690510`, `${TAB}:328814689`]);
    expect(await w.store.getBundle(ASKED_KEY)).toBeUndefined();

    gate.release();
    await untilIdle(w);
    await vi.waitFor(async () => expect(w.pages.deferred.size).toBe(0));
    expect(await w.store.getBundle(ASKED_KEY)).toMatchObject({ page: { readAt: T0 + 2 * MINUTE } });
    expect(await w.store.getBundle('homedepot:328814689')).toMatchObject({ page: { readAt: T0 + 3 * MINUTE } });
    expect(await w.store.getReview(`split:${ASKED_KEY}`)).toMatchObject({ openedAt: T0 + 2 * MINUTE });
  });

  it('a page that is not a bundle, or the chip turned off, does not drop the visits already waiting in that tab', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    await seen(w, ASKED);
    await seen(w, KIT);
    w.prefs.showChip = false;
    await seen(w, FOUNDER);
    expect([...w.pages.deferred.keys()]).toEqual([`${TAB}:${ASKED.itemId}`]);
    gate.release();
    await untilIdle(w);
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toBeDefined());
  });

  it('openThisPage: Chrome is asked at once, for the sender\'s tab; the panel is told, and takes the answer once', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const reply = send<{ opened: boolean }>(w, { type: 'openThisPage' }, { tabId: TAB });
    // Before any await: Chrome counts only a call made in answer to the click.
    expect(w.pages.opened).toEqual([TAB]);
    expect(await reply).toEqual({ ok: true, data: { opened: true } });
    expect(w.pages.told).toEqual([TAB]);
    expect(await send(w, { type: 'takeShowThisPage', tabId: 99 })).toEqual({ ok: true, data: false });
    expect(await send(w, { type: 'takeShowThisPage', tabId: TAB })).toEqual({ ok: true, data: true });
    expect(await send(w, { type: 'takeShowThisPage', tabId: TAB })).toEqual({ ok: true, data: false });
  });

  it('openThisPage when Chrome refuses to open the panel: opened is false, nothing is left for the panel, nobody is told', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.pages.refuseOpen = true;
    expect(await send(w, { type: 'openThisPage' }, { tabId: TAB })).toEqual({ ok: true, data: { opened: false } });
    expect(w.pages.told).toEqual([]);
    expect(await send(w, { type: 'takeShowThisPage', tabId: TAB })).toEqual({ ok: true, data: false });
  });

  it('openThisPage with no tab is refused and opens nothing; takeShowThisPage refuses a tab id that is not a whole number', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    expect(await send(w, { type: 'openThisPage' })).toEqual({ ok: false, error: 'This request needs a browser tab.' });
    expect(w.pages.opened).toEqual([]);
    expect(await send(w, { type: 'takeShowThisPage', tabId: 'x' } as unknown as Request)).toEqual({ ok: false, error: 'This request needs a browser tab.' });
  });

  it('opening the panel does not wait for a scan, and a tab closed forgets the answer waiting for it', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    expect(await send(w, { type: 'openThisPage' }, { tabId: TAB })).toEqual({ ok: true, data: { opened: true } });
    await w.worker.onTabClosed(TAB);
    expect(await send(w, { type: 'takeShowThisPage', tabId: TAB })).toEqual({ ok: true, data: false });
    gate.release();
    await untilIdle(w);
  });

  it('with the chip turned off a page is answered off: nothing is read, stored or remembered, and an earlier page of the tab is forgotten', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seen(w, FOUNDER);
    expect(w.pages.pages.has(TAB)).toBe(true);
    w.prefs.showChip = false;
    const bundles = await w.store.listBundles();
    const broadcasts = w.broadcasts.length;
    expect(await seen(w, ASKED)).toEqual({ ok: true, data: { kind: 'off' } });
    expect(await w.store.listBundles()).toEqual(bundles);
    expect(await w.store.getReview(`split:${ASKED_KEY}`)).toBeUndefined();
    expect(w.pages.pages.has(TAB)).toBe(false);
    expect(w.broadcasts.length).toBe(broadcasts);
    // This page says the chip is off, and shows no page read before it was turned off.
    expect(await thisPage(w)).toEqual({ ok: true, data: { kind: 'off' } });
    // Turned on again: the same page is read as before.
    w.prefs.showChip = true;
    expect(bundleOf(await seen(w, ASKED)).itemId).toBe('328690510');
  });

  it('a change of the chip setting reaches every tab that sent a page, including one with the chip off; a tab with no script is ignored', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seen(w, FOUNDER, 1);
    await seen(w, KIT, 2);
    w.prefs.showChip = false;
    await seen(w, ASKED, 3);
    w.pages.deafTabs.add(2);
    await w.worker.onChipSetting(false);
    expect(w.pages.chipSent).toEqual([[1, false], [3, false]]);
    await w.worker.onChipSetting(true);
    expect(w.pages.chipSent.slice(2)).toEqual([[1, true], [3, true]]);
    // A closed tab is no longer told.
    await w.worker.onTabClosed(1);
    await w.worker.onChipSetting(true);
    expect(w.pages.chipSent.slice(4)).toEqual([[3, true]]);
  });

  it('a change of the chip setting is broadcast, so an open panel reads This page again at once, off and on', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await seen(w, FOUNDER);
    const before = w.broadcasts.length;
    w.prefs.showChip = false;
    await w.worker.onChipSetting(false);
    expect(w.broadcasts.length).toBe(before + 1);
    expect(await thisPage(w)).toEqual({ ok: true, data: { kind: 'off' } });
    w.prefs.showChip = true;
    await w.worker.onChipSetting(true);
    expect(w.broadcasts.length).toBe(before + 2);
    // Back on: the chip's script sends its page again, and the panel hears that too.
    expect(bundleOf(await seen(w, FOUNDER)).itemId).toBe('328814689');
    expect(w.broadcasts.length).toBe(before + 3);
  });

  it('the scan\'s reader tab is ignored: none, nothing stored, not remembered, and not told of the chip setting', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.pages.readerTab = 21;
    const before = await stored(w);
    expect(await seen(w, FOUNDER, 21)).toEqual({ ok: true, data: { kind: 'none' } });
    expect(await stored(w)).toEqual(before);
    expect(w.pages.pages.has(21)).toBe(false);
    expect(await thisPage(w, 21)).toEqual({ ok: true, data: { kind: 'empty' } });
    await w.worker.onChipSetting(true);
    expect(w.pages.chipSent).toEqual([]);
    // The owner's own tab is still read.
    expect(bundleOf(await seen(w, FOUNDER, 22)).itemId).toBe('328814689');
  });

  it('a page whose empty price and was-price arrive as missing keys (what a message may carry) is read as null, and is stored whole', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const { price: _p, wasPrice: _w, ...bare } = ASKED;
    expect(bundleOf(await seen(w, bare as unknown as ProductPage))).toMatchObject({ itemId: '328690510', question: { kind: 'split' } });
    expect(w.pages.pages.get(TAB)).toEqual(ASKED);
    // A message that is no page at all is none, not an error.
    expect(await seen(w, null as unknown as ProductPage)).toEqual({ ok: true, data: { kind: 'none' } });
  });

  // ------------------------------------------------ fix round 1

  /** What a stopped worker left in session storage: the page of a visit that was not stored, and when it was seen. */
  const leave = (w: World, tabId: number, page: ProductPage, seenAt: number) => {
    w.pages.pages.set(tabId, structuredClone(page));
    w.pages.deferred.set(`${tabId}:${page.itemId}`, { tabId, page: structuredClone(page), seenAt });
  };

  it('a visit during a scan is kept in session storage with its time, and is stored as of the visit (not the time of the store) when the scan ends', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    w.clock = T0 + 5 * MINUTE;
    await seen(w, ASKED);
    expect([...w.pages.deferred]).toEqual([[`${TAB}:${ASKED.itemId}`, { tabId: TAB, page: ASKED, seenAt: T0 + 5 * MINUTE }]]);
    expect(await w.store.getBundle(ASKED_KEY)).toBeUndefined();

    w.clock = T0 + HOUR;
    gate.release();
    await untilIdle(w);
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toBeDefined());
    // The page has no price, so the new record is seen at 0 (f4ee8de); its reading is the visit's.
    expect(await w.store.getBundle(ASKED_KEY)).toMatchObject({ seenAt: 0, page: { readAt: T0 + 5 * MINUTE } });
    expect(await w.store.getReview(`split:${ASKED_KEY}`)).toMatchObject({ openedAt: T0 + 5 * MINUTE, answer: null });
    expect(w.pages.deferred.size).toBe(0);
  });

  it('a worker restarted with a visit left deferred stores it at its start, as of the visit', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    leave(w, TAB, ASKED, T0 + 5 * MINUTE);
    w.clock = T0 + HOUR;
    const before = w.broadcasts.length;
    await w.worker.onStart();
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toMatchObject({ seenAt: 0, page: { readAt: T0 + 5 * MINUTE } }));
    expect(await w.store.getReview(`split:${ASKED_KEY}`)).toMatchObject({ openedAt: T0 + 5 * MINUTE });
    expect(w.pages.deferred.size).toBe(0);
    await vi.waitFor(() => expect(w.broadcasts.length).toBeGreaterThan(before));
  });

  it('visits are stored in the order they were seen across tabs, whatever order they were left in: the first visit makes the record, the later one reads it again', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    leave(w, 1, { ...ASKED, price: 100, wasPrice: 150 }, T0 + 2 * MINUTE);
    leave(w, 2, { ...ASKED, price: 120, wasPrice: 150 }, T0 + 1 * MINUTE);
    w.clock = T0 + HOUR;
    await w.worker.onStart();
    await vi.waitFor(async () => expect(w.pages.deferred.size).toBe(0));
    // A visit never changes a stored bundle's price or seenAt (f4ee8de): the earlier visit's stand. Stored the other
    // way round they would be 100 at T0 + 2 minutes.
    expect(await w.store.getBundle(ASKED_KEY)).toMatchObject({ price: 120, seenAt: T0 + 1 * MINUTE, page: { readAt: T0 + 2 * MINUTE } });
  });

  it('a scan that starts before the settle runs leaves the visit deferred; it is stored when that scan ends', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    leave(w, TAB, ASKED, T0 + MINUTE);
    const gate = held(w);
    await send(w, { type: 'scanNow' });
    await w.worker.onTick();
    // The settle found a scan running: nothing was written, and the visit is still kept.
    expect(await w.store.getBundle(ASKED_KEY)).toBeUndefined();
    expect(w.pages.deferred.size).toBe(1);
    gate.release();
    await untilIdle(w);
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toMatchObject({ seenAt: 0, page: { readAt: T0 + MINUTE } }));
    expect(w.pages.deferred.size).toBe(0);
  });

  it('a visit whose store fails stays deferred while the others are stored, and is stored by a later tick', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const failing = { on: true };
    w.worker = workerOver(
      w,
      new Proxy(w.store, {
        get(t, prop) {
          if (prop === 'putBundle') {
            return async (b: Parameters<ScanStore['putBundle']>[0]) => {
              if (failing.on && b.key === ASKED_KEY) throw new Error('The disk is full.');
              return t.putBundle(b);
            };
          }
          const v: unknown = Reflect.get(t, prop, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }) as ScanStore,
    );
    leave(w, 1, ASKED, T0 + MINUTE);
    leave(w, 2, FOUNDER, T0 + 2 * MINUTE);
    await w.worker.onStart();
    await vi.waitFor(async () => expect(await w.store.getBundle('homedepot:328814689')).toBeDefined());
    expect([...w.pages.deferred.keys()]).toEqual([`1:${ASKED.itemId}`]);
    expect(await w.store.getBundle(ASKED_KEY)).toBeUndefined();

    failing.on = false;
    await w.worker.onTick();
    await vi.waitFor(async () => expect(await w.store.getBundle(ASKED_KEY)).toMatchObject({ seenAt: 0, page: { readAt: T0 + MINUTE } }));
    expect(w.pages.deferred.size).toBe(0);
  });

  it('a page over the limits is answered none and is not stored, kept or deferred (hostile sizes)', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const hostile = [
      { ...FOUNDER, title: 'T'.repeat(5_000_000) },
      { ...FOUNDER, bullets: Array.from({ length: 100_000 }, () => 'x'.repeat(100)) },
      { ...FOUNDER, bullets: ['x'.repeat(2_001)] },
      { ...FOUNDER, description: 'd'.repeat(10_001) },
      { ...FOUNDER, model: 'PBLRC2501SB'.padEnd(61, '0') },
      { ...FOUNDER, price: 1e12 },
      { ...FOUNDER, wasPrice: Infinity },
    ];
    for (const page of hostile) {
      expect(await seen(w, page as ProductPage)).toEqual({ ok: true, data: { kind: 'none' } });
    }
    expect(await stored(w)).toMatchObject({ bundles: [], review: [] });
    expect(w.pages.pages.size).toBe(0);
    expect(w.pages.deferred.size).toBe(0);
    // A real page is far under them.
    expect(bundleOf(await seen(w, FOUNDER)).itemId).toBe('328814689');
  });

  it('a tab closed while its visit is still being stored is forgotten after it, not before', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    await Promise.all([seen(w, FOUNDER, 9), w.worker.onTabClosed(9)]);
    expect(w.pages.pages.has(9)).toBe(false);
    expect(w.pages.chipTabSet.has(9)).toBe(false);
    expect(await thisPage(w, 9)).toEqual({ ok: true, data: { kind: 'empty' } });
  });

  it('the view says whether its question is stored: not while a scan holds the write back, stored once it ends', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    expect(bundleOf(await seen(w, ASKED, 1)).questionStored).toBe(true);
    const v = world({ key: KEY, settings: RYOBI });
    const gate = held(v);
    await send(v, { type: 'scanNow' });
    expect(bundleOf(await seen(v, ASKED)).questionStored).toBe(false);
    expect(bundleOf(await thisPage(v)).questionStored).toBe(false);
    gate.release();
    await untilIdle(v);
    await vi.waitFor(async () => expect(bundleOf(await thisPage(v)).questionStored).toBe(true));
  });
});

// ---------------------------------------------------------------- step 10: eBay reference values

// eBay and the model are fakes here; the worker's wiring is what is tested (the pass itself is core/test/ebay-pass.test.ts, on
// the recorded eBay responses). The listings are SYNTHETIC: three New "PBLRC25B" listings, so the ratchet bundle the world's
// scans read has parts eBay answers for.
const APP = 'split-finder-app';
const CERT = 'cert-secret-9f3c';
const ANTHROPIC = 'sk-ant-secret-71ab';
const TOKEN = 'v^1.1#token-one';
const BASIC = `Basic ${btoa(`${APP}:${CERT}`)}`;

const ratchetListing = (n: number, price: number, sold: number): EbayListing => ({
  itemId: `v1|${900000 + n}|0`, title: `RYOBI PBLRC25B 18V ONE+ Extended Reach Ratchet (Tool Only) ${n}`, price, currency: 'USD', conditionId: '1000', categoryIds: ['3247'],
  brand: 'RYOBI', mpn: 'PBLRC25B', aspects: [{ name: 'Brand', value: 'RYOBI' }], descriptionText: 'New, tool only.', soldQuantity: sold, url: `https://www.ebay.com/itm/${900000 + n}`,
});
const RATCHET_LISTINGS = [ratchetListing(1, 120, 40), ratchetListing(2, 130, 10), ratchetListing(3, 99, 5)];

interface Call { origin: string; path: string; method: string; headers: Record<string, string>; search: string; signal?: AbortSignal }

/** eBay and the model, answering over the world's fetch. Records every call that reaches either, with its headers. */
function withEbay(w: World, o: { claude?: (n: number, init?: RequestInit) => Response | Promise<Response>; onSearch?: () => void | Promise<void>; token?: () => string } = {}): { calls: Call[]; searches: () => number; anthropic: () => number } {
  const inner = w.fetchFn;
  const calls: Call[] = [];
  let anthropic = 0;
  let tokenNo = 0;
  w.fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.origin === 'https://api.ebay.com') {
      calls.push({ origin: url.origin, path: url.pathname, method: init?.method ?? 'GET', headers, search: url.search, ...(init?.signal ? { signal: init.signal } : {}) });
      if (url.pathname === '/identity/v1/oauth2/token') {
        if (headers.authorization !== BASIC) return json({ error: 'invalid_client' }, 401);
        tokenNo += 1;
        return json({ access_token: o.token ? o.token() : `${TOKEN}-${tokenNo}`, expires_in: 7200, token_type: 'Application Access Token' });
      }
      if (headers.authorization === undefined || !headers.authorization.startsWith(`Bearer ${TOKEN}`)) return json({ error: 'no token' }, 401);
      if (url.pathname === '/buy/browse/v1/item_summary/search') {
        await o.onSearch?.();
        const ratchet = url.searchParams.get('q') === 'RYOBI PBLRC25B';
        return json(browseSearch(ratchet ? RATCHET_LISTINGS.length : 0, ratchet ? RATCHET_LISTINGS : []));
      }
      const item = RATCHET_LISTINGS.find((l) => url.pathname === `/buy/browse/v1/item/${encodeURIComponent(l.itemId)}`);
      return item ? json(browseItem(item)) : json({ error: 'not found' }, 404);
    }
    if (url.origin === 'https://api.anthropic.com') {
      calls.push({ origin: url.origin, path: url.pathname, method: init?.method ?? 'GET', headers, search: url.search, ...(init?.signal ? { signal: init.signal } : {}) });
      anthropic += 1;
      if (o.claude) return o.claude(anthropic, init);
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const title = /<title>\n([\s\S]*?)\n<\/title>/.exec(body.messages[0]!.content)![1]!.trim();
      const answer = {
        evidence: [{ claim: 'identity', quote: title }, { claim: 'contents', quote: 'tool only' }], contentsMatch: true, quantity: 1, condition: 'new', extras: [], missing: [],
        reason: 'The title names the model and says tool only.', verdict: 'match',
      };
      return json({ id: 'msg', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 500, output_tokens: 50 } });
    }
    return inner(input as string, init);
  }) as typeof fetch;
  return { calls, searches: () => calls.filter((c) => c.path === '/buy/browse/v1/item_summary/search').length, anthropic: () => anthropic };
}

const withKeys = (w: World): World => {
  w.prefs.ebayKeys = { appId: APP, certId: CERT };
  w.prefs.anthropicKey = ANTHROPIC;
  return w;
};

async function scanThrough(w: World): Promise<ScanJob> {
  expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
  await untilIdle(w);
  return lastJob(w);
}

describe('worker: eBay reference values (step 10)', () => {
  it('the state says whether the keys are saved and what the settings are, never the keys', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    expect((await state(w)).ebay).toEqual({ hasEbayKeys: false, hasAnthropicKey: false, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 });
    withEbay(w);
    expect(await send(w, { type: 'saveEbayKeys', appId: APP, certId: CERT })).toEqual({ ok: true, data: null });
    expect(await send(w, { type: 'saveAnthropicKey', apiKey: ANTHROPIC })).toEqual({ ok: true, data: null });
    const s = await state(w);
    expect(s.ebay).toEqual({ hasEbayKeys: true, hasAnthropicKey: true, judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 });
    const text = JSON.stringify([s, await send(w, { type: 'getReport' }), w.broadcasts]);
    for (const secret of [CERT, ANTHROPIC]) expect(text).not.toContain(secret);
  });

  it('eBay keys are saved only when eBay gives a token for them, and the token is kept for the scans', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const net = withEbay(w);
    expect(await send(w, { type: 'saveEbayKeys', appId: APP, certId: 'wrong' })).toEqual({ ok: false, error: 'eBay did not accept this App ID and Cert ID.' });
    expect(w.prefs.ebayKeys).toBeNull();
    expect(await send(w, { type: 'saveEbayKeys', appId: '  ', certId: CERT })).toEqual({ ok: false, error: 'Enter the eBay App ID and the Cert ID.' });
    expect(await send(w, { type: 'saveEbayKeys', appId: APP, certId: CERT })).toEqual({ ok: true, data: null });
    expect(w.prefs.ebayKeys).toEqual({ appId: APP, certId: CERT });
    expect(w.prefs.token).toMatchObject({ appId: APP, token: `${TOKEN}-1`, expiresAt: T0 + 7200_000 });
    // The keys went only to eBay's token address, in the Authorization header: never in a URL.
    expect(net.calls.every((c) => c.origin === 'https://api.ebay.com' && c.path === '/identity/v1/oauth2/token' && c.search === '')).toBe(true);
  });

  it('a network failure while checking eBay keys is one plain sentence, and nothing is saved', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    w.fetchFn = (() => Promise.reject(new TypeError(`failed to fetch ${CERT}`))) as typeof fetch;
    const reply = await send(w, { type: 'saveEbayKeys', appId: APP, certId: CERT });
    expect(reply).toEqual({ ok: false, error: 'eBay could not be reached. Check the connection, then try again.' });
    expect(w.prefs.ebayKeys).toBeNull();
  });

  it('the Anthropic key is saved without a call: a check would cost money', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const net = withEbay(w);
    expect(await send(w, { type: 'saveAnthropicKey', apiKey: '   ' })).toEqual({ ok: false, error: 'Enter your Anthropic API key.' });
    expect(await send(w, { type: 'saveAnthropicKey', apiKey: ` ${ANTHROPIC} ` })).toEqual({ ok: true, data: null });
    expect(w.prefs.anthropicKey).toBe(ANTHROPIC);
    expect(net.calls).toEqual([]);
    expect(await send(w, { type: 'forgetAnthropicKey' })).toEqual({ ok: true, data: null });
    expect(w.prefs.anthropicKey).toBeNull();
  });

  it('forgetting the eBay keys forgets the token too', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    withEbay(w);
    await send(w, { type: 'saveEbayKeys', appId: APP, certId: CERT });
    expect(w.prefs.token).not.toBeNull();
    expect(await send(w, { type: 'forgetEbayKeys' })).toEqual({ ok: true, data: null });
    expect(w.prefs.ebayKeys).toBeNull();
    expect(w.prefs.token).toBeNull();
  });

  it('settings: a known model and a whole number of listings are saved; anything else is refused and nothing changes', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    expect(await send(w, { type: 'saveEbaySettings', judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 25 })).toEqual({ ok: true, data: null });
    expect((await state(w)).ebay).toMatchObject({ judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 25 });
    expect(await send(w, { type: 'saveEbaySettings', judgeModel: 'gpt-4', listingsJudgedPerScan: 25 })).toEqual({ ok: false, error: 'Choose one of the models offered.' });
    expect(await send(w, { type: 'saveEbaySettings', judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 0 })).toMatchObject({ ok: false });
    expect(await send(w, { type: 'saveEbaySettings', judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 2.5 })).toMatchObject({ ok: false });
    expect(await send(w, { type: 'saveEbaySettings', judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 100_000 })).toMatchObject({ ok: false });
    expect((await state(w)).ebay).toMatchObject({ judgeModel: 'claude-opus-5-5', listingsJudgedPerScan: 25 });
    // Stored settings are untrusted: a bad model reads as the default.
    w.prefs.ebaySettings = { judgeModel: 'nope', listingsJudgedPerScan: 25 };
    expect((await state(w)).ebay).toMatchObject({ judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 60 });
  });

  it('a scan with no keys skips the step with a plain notice and calls nobody', async () => {
    const w = world({ key: KEY, settings: RYOBI });
    const net = withEbay(w);
    let job = await scanThrough(w);
    expect(job.status).toBe('done');
    expect(job.ebayNotice).toBe('eBay reference values were skipped. Add your eBay App ID and Cert ID and your Anthropic key in Settings to see them.');
    w.prefs.ebayKeys = { appId: APP, certId: CERT };
    job = await scanThrough(w);
    expect(job.ebayNotice).toBe('eBay reference values were skipped. Add your Anthropic key in Settings to see them.');
    w.prefs.ebayKeys = null;
    w.prefs.anthropicKey = ANTHROPIC;
    job = await scanThrough(w);
    expect(job.ebayNotice).toBe('eBay reference values were skipped. Add your eBay App ID and Cert ID in Settings to see them.');
    expect(net.calls).toEqual([]);
  });

  it('a scan with both keys checks each part: eBay values are stored, the report shows the reference line, and the counts say what was done', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    const net = withEbay(w);
    const job = await scanThrough(w);
    expect(job.status).toBe('done');
    expect(job.ebayNotice ?? null).toBeNull();
    expect(job.counts).toMatchObject({ ebaySearches: 2, ebayItemReads: 3, listingsJudged: 3, judgeTokensIn: 1500, judgeTokensOut: 150 });
    const value = (await w.store.getEbayValue('RYOBI:PBLRC25B'))!;
    expect(value.value).toEqual({ listings: 3, unitsSold: 55, low: 99, high: 130, medianPrice: 120, links: expect.any(Array), linkPrices: [120, 130, 99] });
    expect((await w.store.getEbayValue('RYOBI:PBLRC01B'))!.value).toBeNull();
    const report = await send<PanelReport>(w, { type: 'getReport' });
    const part = report.ok ? report.data.bundles.find((b) => b.key === 'homedepot:328814689')!.parts.find((p) => p.model === 'PBLRC25B')! : undefined;
    expect(part?.prices.find((o) => o.kind === 'ebay_sold_new')).toMatchObject({ reference: true, price: 120, offers: 3 });
    // One token for the whole scan, and no key in a URL.
    expect(net.calls.filter((c) => c.path === '/identity/v1/oauth2/token')).toHaveLength(1);
    expect(net.calls.every((c) => !c.search.includes(CERT) && !c.search.includes(ANTHROPIC) && !c.search.includes(APP))).toBe(true);
    expect(w.prefs.token).toMatchObject({ appId: APP });
  });

  it('keys go only to their own host: the Anthropic key to api.anthropic.com alone, the eBay keys to api.ebay.com alone, SerpApi\'s key to neither', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    const net = withEbay(w);
    await scanThrough(w);
    for (const c of net.calls) {
      const sent = JSON.stringify(c.headers);
      if (c.origin === 'https://api.anthropic.com') {
        expect(c.headers['x-api-key']).toBe(ANTHROPIC);
        expect(sent).not.toContain(CERT);
        expect(c.path).toBe('/v1/messages');
      } else {
        expect(sent).not.toContain(ANTHROPIC);
        expect(sent).not.toContain(KEY);
        // The Cert ID appears only, encoded, in the token request's Authorization header.
        if (c.path === '/identity/v1/oauth2/token') expect(c.headers.authorization).toBe(BASIC);
        else expect(c.headers.authorization).toBe(`Bearer ${TOKEN}-1`);
      }
    }
    // And no SerpApi request carried them.
    expect(JSON.stringify(w.requests)).not.toMatch(new RegExp(`${CERT}|${ANTHROPIC}`));
  });

  it('the token is kept between scans: the second scan asks eBay for none, and a token eBay refuses is fetched again', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    const net = withEbay(w);
    await scanThrough(w);
    expect(net.calls.filter((c) => c.path === '/identity/v1/oauth2/token')).toHaveLength(1);
    // A later scan, the values stale: the cached token is used.
    w.clock += 4 * 24 * HOUR;
    w.prefs.token = { appId: APP, token: `${TOKEN}-1`, expiresAt: w.clock + HOUR };
    await scanThrough(w);
    expect(net.calls.filter((c) => c.path === '/identity/v1/oauth2/token')).toHaveLength(1);
    // eBay stops accepting it: dropped, one new token, the call goes through.
    w.clock += 4 * 24 * HOUR;
    w.prefs.token = { appId: APP, token: 'stale', expiresAt: w.clock + HOUR };
    const job = await scanThrough(w);
    expect(net.calls.filter((c) => c.path === '/identity/v1/oauth2/token')).toHaveLength(2);
    expect(job.ebayNotice ?? null).toBeNull();
    expect(w.prefs.token).toMatchObject({ token: `${TOKEN}-2` });
  });

  it('a model that refuses the key stops judging for the scan with a notice; the scan itself is done', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    const net = withEbay(w, { claude: () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${ANTHROPIC}` } }), { status: 401 }) });
    const job = await scanThrough(w);
    expect(job.status).toBe('done');
    expect(job.ebayNotice).toBe('Claude did not accept the Anthropic key, so eBay listings were not judged. Check the key in Settings.');
    expect(net.anthropic()).toBe(1);
    expect(JSON.stringify(await state(w))).not.toContain(ANTHROPIC);
    expect(await w.store.getEbayValue('RYOBI:PBLRC25B')).toBeUndefined();
  });

  it('a rate-limited model stops the step with a notice', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    const net = withEbay(w, { claude: () => new Response('{}', { status: 429 }) });
    const job = await scanThrough(w);
    expect(job.ebayNotice).toBe("Claude's rate limit was reached, so the rest of the eBay listings wait for the next scan.");
    expect(net.anthropic()).toBe(1);
  });

  it('the owner removing the Anthropic key during the step ends it: no further call to eBay or the model', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    const net = withEbay(w, { onSearch: async () => void (await send(w, { type: 'forgetAnthropicKey' })) });
    const job = await scanThrough(w);
    expect(job.status).toBe('done');
    expect(net.searches()).toBe(1);
    expect(net.anthropic()).toBe(0);
  });

  it('the listings judged per scan is the owner\'s cap on model calls', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    await send(w, { type: 'saveEbaySettings', judgeModel: 'claude-haiku-5-5', listingsJudgedPerScan: 2 });
    const net = withEbay(w);
    const job = await scanThrough(w);
    expect(net.anthropic()).toBe(2);
    expect(job.ebayNotice).toBe('The limit of 2 listings judged a scan was reached. The rest wait for the next scan.');
  });

  it('answerEbay: refused while a scan runs; otherwise saved, counted in the value, and exported as an owner label', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    // The model is unsure of the 99 listing.
    withEbay(w, {
      claude: (n) =>
        new Response(JSON.stringify({
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: JSON.stringify({ evidence: [], contentsMatch: null, quantity: null, condition: null, extras: [], missing: [], reason: `Not sure (${n}).`, verdict: 'unsure' }) }],
        })),
    });
    await scanThrough(w);
    const before = (await send<PanelReport>(w, { type: 'getReport' }));
    const questions = before.ok ? before.data.ebayQuestions! : [];
    expect(questions.map((q) => [q.model, q.itemId])).toEqual(RATCHET_LISTINGS.map((l) => ['PBLRC25B', l.itemId]));
    expect((await w.store.getEbayValue('RYOBI:PBLRC25B'))!.value).toBeNull();

    const gate = held(w);
    await send(w, { type: 'scanNow' });
    expect(await send(w, { type: 'answerEbay', key: 'RYOBI:PBLRC25B', itemId: questions[0]!.itemId, answer: 'yes' })).toEqual({ ok: false, error: 'A scan is running. Answer again when it has finished.' });
    gate.release();
    await untilIdle(w);

    expect(await send(w, { type: 'answerEbay', key: 'RYOBI:PBLRC25B', itemId: questions[0]!.itemId, answer: 'yes' })).toEqual({ ok: true, data: null });
    expect(await send(w, { type: 'answerEbay', key: 'RYOBI:PBLRC25B', itemId: questions[0]!.itemId, answer: 'no' })).toEqual({ ok: false, error: 'That question was already answered.' });
    expect((await w.store.getEbayValue('RYOBI:PBLRC25B'))!.value).toMatchObject({ listings: 1, unitsSold: 40 });
    const exported = await send<string>(w, { type: 'exportAudit' });
    const audit = JSON.parse(exported.ok ? exported.data : '{}');
    expect(audit.ebayAnswers).toEqual([
      expect.objectContaining({ itemId: questions[0]!.itemId, model: 'PBLRC25B', verdict: 'match', labelledBy: 'owner', judged: 'unsure' }),
    ]);
    expect(audit.ebayQuestions.map((q: { itemId: string }) => q.itemId)).toEqual(questions.slice(1).map((q) => q.itemId));
    expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${CERT}|${ANTHROPIC}|seller`, 'i'));
  });

  it('the CSV export carries the eBay columns', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    withEbay(w);
    await scanThrough(w);
    const csv = await send<string>(w, { type: 'exportDeals' });
    const lines = csv.ok ? csv.data.trimEnd().split('\n') : [];
    expect(lines[0]!.endsWith(',ebay_ref_low,ebay_ref_high,ebay_units_sold')).toBe(true);
    const row = lines.find((l) => l.includes('PBLRC2501SB'))!;
    expect(row.endsWith(',99 | ?,130 | ?,55 | ?')).toBe(true);
  });

  it('a scan\'s progress counts the eBay step: an eviction during it is not "no progress"', () => {
    const base = { searchesUsed: 3, phase: 'listing', queue: [], counts: {} } as unknown as ScanJob;
    const at = (counts: Record<string, number>) => progressOf({ ...base, counts: counts as unknown as ScanJob['counts'] });
    expect(at({})).toBe(at({ ebaySearches: 0, ebayItemReads: 0, listingsJudged: 0 }));
    const seen = new Set([at({}), at({ ebaySearches: 1 }), at({ ebayItemReads: 1 }), at({ listingsJudged: 1 }), at({ ebaySearches: 1, ebayItemReads: 1, listingsJudged: 1 })]);
    expect(seen.size).toBe(5);
  });

  it('a model call that never answers is given up at the timeout: not judged, and the scan goes on', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    w.callTimeoutMs = 40;
    w.worker = workerOver(w);
    let signals = 0;
    withEbay(w, {
      claude: (_n, init) =>
        new Promise<Response>((_resolve, reject) => {
          signals += 1;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const job = await scanThrough(w);
    expect(signals).toBe(3);
    expect(await w.store.getEbayValue('RYOBI:PBLRC25B')).toBeUndefined();
    expect(job.counts).toMatchObject({ listingsJudged: 3 });
    expect(JSON.stringify(await state(w))).not.toContain(ANTHROPIC);
  });

  it('Stop ends a model call in flight at once', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    let inFlight: AbortSignal | undefined;
    withEbay(w, {
      claude: (_n, init) =>
        new Promise<Response>((_resolve, reject) => {
          inFlight = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    expect(await send(w, { type: 'scanNow' })).toEqual({ ok: true, data: null });
    await vi.waitFor(() => expect(inFlight).toBeDefined());
    expect(inFlight!.aborted).toBe(false);
    await send(w, { type: 'stopScan' });
    await untilIdle(w);
    expect(inFlight!.aborted).toBe(true);
    expect((await lastJob(w)).stopReason).toBe('user');
  });

  it('every eBay call carries an abort signal too', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    const net = withEbay(w);
    await scanThrough(w);
    expect(net.calls.filter((c) => c.origin === 'https://api.ebay.com').every((c) => c.signal)).toBe(true);
  });

  it('the eBay App ID is kept out of what a page is told, as the keys are', async () => {
    const w = withKeys(world({ key: KEY, settings: RYOBI }));
    await scanThrough(w);
    const [job] = await w.store.listScans();
    await w.store.putScan({ ...job!, stopMessage: `a failure that echoed ${APP} and ${CERT}` });
    const text = JSON.stringify(await state(w));
    expect(text).not.toContain(APP);
    expect(text).not.toContain(CERT);
    expect(text).toContain('[key]');
  });
});

