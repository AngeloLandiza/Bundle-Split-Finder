// Step 15 in the agent: the per-scan Keepa cap's old default (5, which no lookup fits) moves to automatic once; a scan
// asks Keepa's free token status first and routes lookups Keepa-then-SerpApi; the last scan, the run's summary and the
// state say what the lookups did and why the rest wait; a key Keepa rejects is a key problem until it is replaced.
// SerpApi is the recorded responses; Keepa is a fake shaped as its recordings. No network.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { endStep, newPipeline, startStep } from '../../core/src/scan/pipeline';
import type { ScanJob } from '../../core/src/scan/types';
import * as fx from '../../core/test/fixtures';
import { replayRecorded } from '../../scripts/replay';
import { createAgent, type Agent } from '../app';
import { KEEPA_AUTO_MIGRATION, Store } from '../store';
import { agentState } from '../views';

const T0 = Date.UTC(2026, 10, 23, 15);
const SEARCH = JSON.parse(readFileSync('fixtures/keepa/search-RYOBI-PCL235B.json', 'utf8')) as Record<string, unknown>;

describe('the Keepa per-scan cap', () => {
  it('a new store starts automatic (0), and the change is marked done', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-mig-'));
    const store = Store.open(dir);
    expect(store.get('settings').settings.keepaTokensPerScan).toBe(0);
    expect(store.get('runtime').migrations).toContain(KEEPA_AUTO_MIGRATION);
    store.close();
  });

  it('a store still at the old default 5 moves to automatic once; 5 set again afterwards is kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-mig-'));
    const first = Store.open(dir);
    first.update('settings', (s) => ({ ...s, settings: { ...s.settings, keepaTokensPerScan: 5 } }));
    first.update('runtime', (r) => ({ ...r, migrations: [] }));
    first.close();
    const second = Store.open(dir);
    expect(second.get('settings').settings.keepaTokensPerScan).toBe(0);
    second.update('settings', (s) => ({ ...s, settings: { ...s.settings, keepaTokensPerScan: 5 } }));
    second.close();
    const third = Store.open(dir);
    expect(third.get('settings').settings.keepaTokensPerScan).toBe(5);
    third.close();
  });

  it('an owner who set another number keeps it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-mig-'));
    const first = Store.open(dir);
    first.update('settings', (s) => ({ ...s, settings: { ...s.settings, keepaTokensPerScan: 40 } }));
    first.update('runtime', (r) => ({ ...r, migrations: [] }));
    first.close();
    const second = Store.open(dir);
    expect(second.get('settings').settings.keepaTokensPerScan).toBe(40);
    second.close();
  });

  it('lookups.drip is on by default and filled for a store written before it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-mig-'));
    const first = Store.open(dir);
    first.close();
    const path = join(dir, 'store', 'settings.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete raw.lookups;
    writeFileSync(path, JSON.stringify(raw));
    const second = Store.open(dir);
    expect(second.get('settings').lookups).toEqual({ drip: true });
    second.close();
  });
});

let agent: Agent;
afterEach(async () => {
  await agent?.work.idle();
  agent?.close();
});

/** The agent with SerpApi's recorded responses and a fake Keepa holding `tokens` (refill 1 a minute). */
function withKeepa(o: { tokens: number; keepaStatus?: number }) {
  let tokens = o.tokens;
  const keepaCalls: string[] = [];
  const replay = replayRecorded();
  const body = (consumed: number, extra: Record<string, unknown> = {}) => {
    tokens -= consumed;
    return new Response(JSON.stringify({ ...extra, tokensLeft: tokens, tokensConsumed: consumed, refillRate: 1, refillIn: 30_000, processingTimeInMs: 1 }), { status: 200 });
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
    if (url.pathname.endsWith('/account.json')) return new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE), { status: 200 });
    if (url.hostname === 'api.keepa.com') {
      keepaCalls.push(url.pathname);
      if (o.keepaStatus) return new Response('{}', { status: o.keepaStatus });
      if (url.pathname === '/token') return body(0);
      if (url.pathname === '/search') {
        const { tokensLeft: _l, tokensConsumed: _c, ...rest } = SEARCH;
        return body(10, url.searchParams.get('term') === 'RYOBI PCL235B' ? rest : { products: [] });
      }
      return body(1, { products: [] });
    }
    return replay.fetchFn(String(url), init);
  }) as typeof fetch;
  // The owner's scan store after the second real scan (fixtures/e2e-2026-11-23): its bundles' pages are read and split,
  // and 18 parts wait for a lookup. A fresh scan plans them again.
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-kscan-'));
  mkdirSync(join(dataDir, 'scan'), { recursive: true });
  for (const kind of ['bundles', 'catalog', 'matches', 'prices', 'listings', 'partPrices', 'reviews']) {
    copyFileSync(join('fixtures/e2e-2026-11-23/scan', `${kind}.json`), join(dataDir, 'scan', `${kind}.json`));
  }
  agent = createAgent({ dataDir, port: 0, timers: false, fetchFn, now: () => T0 });
  agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-key-123', keepa: 'keepa-secret-key-1' }));
  agent.store.update('settings', (s) => ({ ...s, settings: { ...s.settings, brands: ['RYOBI'], searchesPerScan: 1 }, ai: { ...s.ai, monthlyCapUsd: 0 } }));
  return { keepaCalls };
}

const stateOf = (a: Agent) => agentState(
  Object.fromEntries(['agent', 'settings', 'keys', 'deals', 'review', 'suggestions', 'activity', 'autopilot', 'jobs', 'pairing', 'outbox', 'runtime', 'tracking'].map((n) => [n, a.store.get(n as never)])) as never,
  { connected: false, lastSeenAt: null, jobsWaiting: 0, now: T0, busy: null, stopping: false, pipeline: null, nextScanAt: null },
);

describe('a scan with Keepa', () => {
  it('asks the free token status first, puts what the tokens cover on Keepa, and says the rest wait for Keepa tokens, not the search limit', async () => {
    const { keepaCalls } = withKeepa({ tokens: 21 });
    agent.work.scanNow();
    await agent.work.idle();
    expect(keepaCalls[0]).toBe('/token');
    // 16 tokens above the reserve of 5: one lookup (search 10, and a price pull only when it matched).
    expect(keepaCalls.filter((c) => c === '/search')).toHaveLength(1);
    const last = agent.store.get('activity').lastScan!;
    expect(last.lookupsDone).toEqual({ keepa: 1, serpapi: 0 });
    expect(last.waitingLookups).toBeGreaterThan(0);
    expect(last.lookupsBlockedBy).toBe('keepa_tokens');
    const run = agent.store.get('activity').runs.at(-1)!;
    expect(run.stopReason).toBe('keepa_tokens');
    expect(run.status).toBe('limit');
    expect(run.summary).toContain(`${last.waitingLookups} Amazon lookups wait for Keepa tokens (1 a minute); 1 was done with Keepa.`);
    expect(run.summary).not.toMatch(/search limit/);
    expect(run.steps?.find((s) => s.label === 'Amazon lookups')).toMatchObject({ state: 'done', figure: `1 Keepa, ${last.waitingLookups} wait` });
    const state = stateOf(agent);
    expect(state.budget).toMatchObject({ keepaTokens: 11, keepaRefillPerMin: 1 });
    expect(state.agent.lastScan).toMatchObject({ lookupsBlockedBy: 'keepa_tokens', lookupsDone: { keepa: 1, serpapi: 0 } });
  }, 30_000);

  it('a Keepa key Keepa rejects is a key problem in plain words, and the scan goes on without Keepa', async () => {
    const { keepaCalls } = withKeepa({ tokens: 0, keepaStatus: 401 });
    agent.work.scanNow();
    await agent.work.idle();
    expect(keepaCalls).toEqual(['/token']);
    expect(stateOf(agent).keyProblems).toEqual({ keepa: 'Keepa did not accept this key.' });
    const run = agent.store.get('activity').runs.at(-1)!;
    expect(run.summary).toContain('Keepa: Keepa did not accept this key.');
    expect(JSON.stringify(agent.store.get('activity'))).not.toContain('keepa-secret');
  }, 30_000);
});

describe('the live view (step 15)', () => {
  it('a step started inside the second after the last save is shown as running, with its count', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const fakeScan = (async (deps: { store: { putScan: (j: ScanJob) => Promise<void> }; now?: () => number }) => {
      const at = deps.now?.() ?? T0;
      const job = {
        id: String(at), startedAt: at, finishedAt: null, status: 'running', stopReason: null, stopMessage: null, phase: 'parts', queue: [], deferred: [], searchesUsed: 0,
        counts: { pagesFetched: 0, productsSeen: 0, bundlesSeen: 0, bundlesResolved: 0, reviewsOpened: 0, lookupsDone: 0, refreshesDone: 0, partsMatched: 0, catalogPages: 0, listingsSaved: 0, partsFromCatalog: 0, pagesRead: 0 },
        pipeline: newPipeline(0),
      } as ScanJob;
      endStep(job, 'hdPages', at);
      await deps.store.putScan(job);
      // The next save comes in the same second, as the part-price step's did on Nov 23 (14 ms after the kit pages).
      startStep(job, 'partPrices', { remaining: 40, now: at });
      await deps.store.putScan(job);
      await hold;
      job.status = 'done';
      job.phase = 'finish';
      await deps.store.putScan(job);
      return job;
    }) as never;
    const fetchFn = (async () => new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE))) as unknown as typeof fetch;
    agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-live-')), port: 0, timers: false, fetchFn, now: () => T0, work: { runScan: fakeScan } });
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-key-123' }));
    agent.work.scanNow();
    await new Promise((r) => setTimeout(r, 50));
    const view = agent.work.state().pipeline!;
    expect(view.current).toEqual({ label: 'Reading part prices', count: '0 of 40' });
    expect(view.steps.find((s) => s.label === 'Home Depot part prices')).toMatchObject({ state: 'now', done: 0, total: 40 });
    release();
    await agent.work.idle();
  });
});

describe('Look up all (POST /api/lookups/run)', () => {
  it('answers with what it will do on each budget, then looks up with no page, brand page, Chrome read, eBay or AI', async () => {
    const { keepaCalls } = withKeepa({ tokens: 40 });
    // 35 tokens above the reserve of 5: 3 lookups on Keepa; then the 1 search the per-scan cap allows.
    const answer = await agent.work.lookUpAll();
    expect(answer).toMatchObject({ started: true, viaKeepa: 3, viaSerpapi: 1 });
    expect(answer.reason).toMatch(/^Looking up 4 parts: 3 with Keepa and 1 with a search\. \d+ more wait\.$/);
    await agent.work.idle();
    expect(keepaCalls.filter((c) => c === '/search')).toHaveLength(3);
    const run = agent.store.get('activity').runs.at(-1)!;
    expect(run.kind).toBe('scan');
    expect(run.summary).toMatch(/^Look up all\. /);
    expect(run.searchesUsed).toBeLessThanOrEqual(1);
    expect(run.aiCostUsd).toBe(0);
    expect(run.steps?.find((s) => s.label === 'Home Depot deals pages')?.state).not.toBe('done');
    expect(run.steps?.find((s) => s.label === 'Bundle pages')).toMatchObject({ state: 'skipped', figure: 'not in this run' });
  }, 30_000);

  it('maxSearches lowers the search cap for this run; with nothing able to pay it does not start, and says why', async () => {
    withKeepa({ tokens: 40 });
    expect(await agent.work.lookUpAll(0)).toMatchObject({ started: true, viaKeepa: 3, viaSerpapi: 0 });
    await agent.work.idle();
    agent.close();
    withKeepa({ tokens: 5 });
    const refused = await agent.work.lookUpAll(0);
    expect(refused.started).toBe(false);
    expect(refused.reason).toMatch(/^Nothing can pay for a lookup now: \d+ Amazon lookups wait for Keepa tokens/);
    expect([refused.viaKeepa, refused.viaSerpapi]).toEqual([0, 0]);
  }, 30_000);

  it('nothing waiting, or something already running: it does not start', async () => {
    agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-all-')), port: 0, timers: false, fetchFn: (async () => new Response('{}')) as unknown as typeof fetch, now: () => T0 });
    agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-key-123' }));
    expect(await agent.work.lookUpAll()).toEqual({ started: false, reason: 'No part waits for an Amazon lookup.', viaKeepa: 0, viaSerpapi: 0 });
  });
});
