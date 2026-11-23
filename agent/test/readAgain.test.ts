// Nov 23: Read again (POST /api/scan/read-pages). The owner's real scan stored 16 bundles whose Home Depot pages were not
// read. Read again runs the free Chrome steps once more for them, searches no listing page and no Amazon brand page, and
// lets the Amazon lookups spend only what the last scan left of its limit. The scan itself is a fake that records what
// it was given and spends nothing; a fake paired Chrome answers the jobs. No network.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityResponse, AgentState, ReadPagesResponse } from '../../core/src/api/contract';
import type { runScan } from '../../core/src/scan/runner';
import type { ScanJob } from '../../core/src/scan/types';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';
import { outcomeSentence } from '../work';

const T0 = Date.UTC(2026, 10, 23, 9);
let server: Server;
let agent: Agent;
let base: string;
let live: boolean;
let given: Parameters<typeof runScan>[0][];
/** Searches the fake scan says it used, per call. */
let spend: number[];

/** The paired Chrome: a BOGO listing it cannot read (so the BOGO pass ends at once), anything else empty. */
async function chrome(): Promise<void> {
  while (live) {
    const job = await agent.jobs.next(50);
    if (!job) continue;
    agent.jobs.complete({ id: job.id, ok: true, result: job.kind === 'bogoListing' ? { error: 'Home Depot refused the BOGO listing (HTTP 403).' } : [] });
  }
}

const fakeScan = (async (deps: Parameters<typeof runScan>[0]) => {
  given.push(deps);
  const at = deps.now?.() ?? T0;
  // The scan stored one bundle whose page it could not read, and one whose page it read.
  await deps.store.putBundle({ key: 'homedepot:320243741', retailer: 'homedepot', itemId: '320243741', title: 'RYOBI kit', brand: 'RYOBI', model: 'PCL1600K2-P553', upc: null, price: 199, regularPrice: 268, percentOff: 26, link: null, seenAt: at, split: null });
  await deps.store.putBundle({ key: 'homedepot:317987591', retailer: 'homedepot', itemId: '317987591', title: 'RYOBI kit 2', brand: 'RYOBI', model: 'PCL1600K2', upc: null, price: 99, regularPrice: 99, percentOff: 0, link: null, seenAt: at, split: null, page: { title: 'x', model: 'PCL1600K2', bullets: [], description: '', specifications: [], includes: [], readAt: at } as never });
  const job = {
    id: String(at), startedAt: at, finishedAt: at, status: 'done', stopReason: null, stopMessage: null, phase: 'finish', queue: [], deferred: [], searchesUsed: spend.shift() ?? 0, keepaTokensUsed: 0,
    counts: { pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0, partPricesRead: 0 },
  } as ScanJob;
  await deps.store.putScan(job);
  return job;
}) as unknown as typeof runScan;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.includes('/account.json')) return new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE), { status: 200 });
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-again-')), port, timers: false, fetchFn, now: () => T0, work: { runScan: fakeScan } });
  server.on('request', agent.handle);
  live = false;
  given = [];
  spend = [];
});

afterEach(async () => {
  live = false;
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' } });
const json = async <T>(path: string, init?: RequestInit) => (await (await ui(path, init)).json()) as T;
const readAgain = () => json<ReadPagesResponse>('/api/scan/read-pages', { method: 'POST', body: '{}' });

describe('Read again (POST /api/scan/read-pages)', () => {
  it('reads the pages again for free, and lets the lookups spend only what the last scan left of its limit', async () => {
    await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: 'serp-secret-key-123' }) });
    await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ settings: { brands: ['RYOBI'], searchesPerScan: 5 }, ai: { monthlyCapUsd: 0 } }) });

    // Before any scan there is nothing to read again.
    expect(await readAgain()).toEqual({ started: false, reason: 'No scan has run yet: Scan now first.' });

    // A scan with Chrome closed: one bundle page is not read, and the scan used 2 of its 5 searches.
    spend = [2];
    await ui('/api/scan', { method: 'POST' });
    await agent.work.idle();
    let state = await json<AgentState>('/api/state');
    expect(state.agent.lastScan).toMatchObject({ pagesUnread: 1, searchesUsed: 2, canReadPagesAgain: false });
    expect(await readAgain()).toEqual({ started: false, reason: 'Chrome is closed: open Chrome with the Split Finder helper, then read again.' });
    expect(given).toHaveLength(1);

    // Chrome connects: Read again can start, and says what it may spend.
    live = true;
    const polling = chrome();
    await vi.waitFor(() => expect(agent.jobs.pollers()).toBeGreaterThan(0)); // Chrome's poll has arrived
    state = await json<AgentState>('/api/state');
    expect(state.agent.lastScan?.canReadPagesAgain).toBe(true);
    const started = await readAgain();
    expect(started).toEqual({
      started: true,
      reason: 'Reading the Home Depot pages again (free); then at most 3 Amazon searches, what the last scan left of its limit, for the parts now known.',
    });
    await agent.work.idle();
    live = false;
    await polling;

    const again = given[1]!;
    // No listing page and no Amazon brand page; the page readers are there; the lookups get 3 searches at most.
    expect(again.settings.queries).toEqual([]);
    expect(again.settings.catalogPagesPerScan).toBe(0);
    expect(again.readPages).toBeTypeOf('function');
    expect(again.waitForPages).toBe(true);
    expect(again.budget.leftThisRun).toBe(3);
    // The two count as one scan against the limit, and the run says what it was.
    expect((await json<AgentState>('/api/state')).agent.lastScan).toMatchObject({ searchesUsed: 2, pagesUnread: 1 });
    const runs = (await json<ActivityResponse>('/api/activity')).runs;
    expect(runs[0]!.summary).toMatch(/^Read again\. Found /);
  });

  it('a scan that used its whole limit reads again with no Amazon search, and says so', async () => {
    await ui('/api/keys/serpapi', { method: 'PUT', body: JSON.stringify({ key: 'serp-secret-key-123' }) });
    await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ settings: { brands: ['RYOBI'], searchesPerScan: 2 }, ai: { monthlyCapUsd: 0 } }) });
    spend = [2];
    await ui('/api/scan', { method: 'POST' });
    await agent.work.idle();
    live = true;
    const polling = chrome();
    await vi.waitFor(() => expect(agent.jobs.pollers()).toBeGreaterThan(0)); // Chrome's poll has arrived
    expect(await readAgain()).toEqual({ started: true, reason: 'Reading the Home Depot pages again (free); no Amazon search, because the last scan used its whole limit.' });
    await agent.work.idle();
    live = false;
    await polling;
    expect(given[1]!.budget.leftThisRun).toBe(0);
  });
});

describe('the run summary leads with the outcome', () => {
  const row = (over: Record<string, unknown>) => ({ estimate: null, ...over }) as never;
  it('says how many were estimated, and why the rest were not when their pages were not read', () => {
    const rows = Array.from({ length: 16 }, () => row({ waitingPage: true }));
    expect(outcomeSentence({ bundles: rows } as never)).toBe('Found 16 bundles; 0 estimated because their Home Depot pages were not read — Read again (free).');
    expect(outcomeSentence({ bundles: [row({ estimate: {} }), row({ waitingPage: true }), row({})] } as never)).toBe(
      'Found 3 bundles; 1 estimated; 1 waits for its Home Depot page — Read again (free).',
    );
    expect(outcomeSentence({ bundles: [row({ estimate: {} }), row({})] } as never)).toBe('Found 2 bundles; 1 estimated.');
  });
});
