// Nov 23 scan 5, "honest spend": the reserve is the owner's, spent only on his explicit say-so (a manual scan at or
// below it spends nothing and says how many lookups wait; "Use searches for these" spends within the per-scan cap), and
// the balance the app shows is the last account figure less the ledger rows written after it. The owner's real scan
// store (fixtures/e2e-2026-11-23: 18 parts waiting for an Amazon lookup), a fake Keepa at 7 tokens (its reserve is 5, so
// none can pay), a fake SerpApi whose account counts down with every search it answers. No network, no key.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentState } from '../../core/src/api/contract';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';

const T0 = Date.UTC(2026, 10, 23, 15);
const AMAZON = readFileSync('fixtures/recorded/amazon-search-PCL206.json', 'utf8');

let agent: Agent;
let server: Server | null = null;
afterEach(async () => {
  await agent?.work.idle();
  agent?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** The agent's HTTP face, for the routes and the state (the agent is told its port, as in agentRun.test.ts). */
let ui: (path: string, init?: RequestInit) => Promise<Response>;

interface World {
  dir: string;
  /** Searches the fake SerpApi answered (the ones that count), and what the app said the balance was before each. */
  searches: { engine: string; leftSeenByApp: number | null }[];
  account: { left: number };
  /** True: the account endpoint fails (the check at a scan's end cannot be made). */
  accountDown: boolean;
}

/** Copies the owner's scan store into a fresh data folder. */
function dataFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-reserve-'));
  mkdirSync(join(dir, 'scan'), { recursive: true });
  for (const kind of ['bundles', 'catalog', 'matches', 'prices', 'listings', 'partPrices', 'reviews']) {
    copyFileSync(join('fixtures/e2e-2026-11-23/scan', `${kind}.json`), join(dir, 'scan', `${kind}.json`));
  }
  return dir;
}

/** An agent over `dir` with `left` searches on the account, the reserve at 100, Keepa at `tokens`, and a clock that moves. */
async function open(dir: string, o: { left: number; perScan?: number; tokens?: number; downAfterFirstSearch?: boolean }): Promise<World> {
  const world: World = { dir, searches: [], account: { left: o.left }, accountDown: false };
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let tokens = o.tokens ?? 7;
  let t = T0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
    if (url.pathname.endsWith('/account.json')) {
      if (world.accountDown) return new Response('{"error":"down"}', { status: 503 });
      return new Response(JSON.stringify({ ...fx.SERPAPI_ACCOUNT_FREE, total_searches_left: world.account.left, plan_searches_left: world.account.left }), { status: 200 });
    }
    if (url.pathname.endsWith('/search.json')) {
      const engine = url.searchParams.get('engine') ?? '';
      if (engine !== 'amazon') return new Response(JSON.stringify({ error: 'not recorded here' }), { status: 404 });
      world.searches.push({ engine, leftSeenByApp: agent.work.serpLeft() });
      world.account.left -= 1;
      if (o.downAfterFirstSearch) world.accountDown = true;
      return new Response(AMAZON, { status: 200 });
    }
    if (url.hostname === 'api.keepa.com') {
      return new Response(JSON.stringify({ products: [], tokensLeft: tokens, tokensConsumed: 0, refillRate: 1, refillIn: 30_000, processingTimeInMs: 1 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  agent = createAgent({ dataDir: dir, port, timers: false, fetchFn, now: () => (t += 1000) });
  server.on('request', agent.handle);
  ui = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' } });
  agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-key-123', keepa: 'keepa-secret-key-1' }));
  agent.store.update('settings', (s) => ({
    ...s, settings: { ...s.settings, brands: ['RYOBI'], searchesPerScan: o.perScan ?? 18, reserve: 100 }, ai: { ...s.ai, monthlyCapUsd: 0 },
  }));
  tokens = o.tokens ?? 7;
  return world;
}

const ledgerRows = (dir: string): number => (existsSync(join(dir, 'serpapi-ledger.jsonl')) ? readFileSync(join(dir, 'serpapi-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0);

describe('a manual scan at or below the reserve (97 left, reserve 100, Keepa at 7 tokens)', () => {
  it('spends no search, and says how many lookups wait and what "Use searches for these" may spend', async () => {
    const w = await open(dataFolder(), { left: 97 });
    agent.work.scanNow();
    await agent.work.idle();
    expect(w.searches).toEqual([]);
    expect(ledgerRows(w.dir)).toBe(0);
    expect(w.account.left).toBe(97);
    const last = agent.store.get('activity').lastScan!;
    const waiting = last.waitingLookups ?? 0;
    expect(waiting).toBeGreaterThan(0);
    expect(last.searchesUsed).toBe(0);
    const run = agent.store.get('activity').runs.at(-1)!;
    expect(run.searchesUsed).toBe(0);
    const may = Math.min(18, waiting);
    expect(run.summary).toContain(`Searches are at your reserve (97 searches left, you keep 100), so this scan spent none. To look these up, use searches for them: up to ${may} of your 97 left.`);
    expect(run.summary).toMatch(/Amazon lookups? waits? for/);
  });

  it('a Look up that is not the owner\'s explicit yes keeps the reserve too: it does not start', async () => {
    const w = await open(dataFolder(), { left: 97 });
    const refused = await agent.work.lookUpAll(18);
    expect(refused.started).toBe(false);
    expect(refused.reason).toMatch(/^Nothing can pay for a lookup now: \d+ Amazon lookups wait/);
    expect(w.searches).toEqual([]);
  });

  it('"Use searches for these" (useReserve) spends from the reserve, within the per-scan cap and the number asked', async () => {
    const w = await open(dataFolder(), { left: 97, perScan: 18 });
    const started = await agent.work.lookUpAll(5, true);
    expect(started).toMatchObject({ started: true, viaKeepa: 0, viaSerpapi: 5 });
    await agent.work.idle();
    expect(w.searches).toHaveLength(5);
    expect(ledgerRows(w.dir)).toBe(5);
    expect(w.account.left).toBe(92);
    expect(agent.store.get('activity').runs.at(-1)!.searchesUsed).toBe(5);
  });

  it('the per-scan cap still binds an explicit yes: asking for 40 with a cap of 3 spends 3', async () => {
    const w = await open(dataFolder(), { left: 97, perScan: 3 });
    expect(await agent.work.lookUpAll(40, true)).toMatchObject({ started: true, viaSerpapi: 3 });
    await agent.work.idle();
    expect(w.searches).toHaveLength(3);
  });

  it('POST /api/lookups/run takes useReserve as a boolean only', async () => {
    const w = await open(dataFolder(), { left: 97 });
    const bad = await ui('/api/lookups/run', { method: 'POST', body: JSON.stringify({ useReserve: 'yes' }) });
    expect(bad.status).toBe(400);
    expect(w.searches).toEqual([]);
    const ok = await ui('/api/lookups/run', { method: 'POST', body: JSON.stringify({ maxSearches: 2, useReserve: true }) });
    expect(await ok.json()).toMatchObject({ started: true, viaSerpapi: 2 });
    await agent.work.idle();
    expect(w.searches).toHaveLength(2);
  });
});

describe('a manual scan above the reserve', () => {
  it('keeps the reserve too: with 105 left it spends at most 5, not the cap of 18', async () => {
    const w = await open(dataFolder(), { left: 105, perScan: 18 });
    await agent.work.lookUpAll(18);
    await agent.work.idle();
    expect(w.searches.length).toBeLessThanOrEqual(5);
    expect(w.account.left).toBeGreaterThanOrEqual(100);
  });
});

describe('the balance the app shows', () => {
  it('counts each search the ledger wrote at once, before any new account check, and is the account\'s own figure when the scan ends', async () => {
    const w = await open(dataFolder(), { left: 140, perScan: 18 });
    await agent.work.lookUpAll(6);
    await agent.work.idle();
    // Before each search the app counted the ones already made: 40 above the reserve, 6 searches.
    expect(w.searches.map((s) => s.leftSeenByApp)).toEqual([140, 139, 138, 137, 136, 135]);
    // The scan's end refreshed the free account check: 134 is the account's figure.
    expect(w.account.left).toBe(134);
    expect(agent.work.serpLeft()).toBe(134);
    expect(agent.store.get('runtime').serp?.left).toBe(134);
  });

  it('with the end-of-scan check failing the ledger alone carries it: the state shows it, and a restart reads it back from the file', async () => {
    const w = await open(dataFolder(), { left: 140, downAfterFirstSearch: true });
    await agent.work.lookUpAll(4);
    await agent.work.idle();
    // The account check at the start said 140; the one at the end could not be made; 4 searches are in the ledger.
    expect(agent.store.get('runtime').serp?.left).toBe(140);
    expect(ledgerRows(w.dir)).toBe(4);
    expect(agent.work.serpLeft()).toBe(136);
    expect(((await (await ui('/api/state')).json()) as AgentState).budget.serpLeft).toBe(136);
    agent.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await open(w.dir, { left: 136, downAfterFirstSearch: true });
    expect(agent.work.serpLeft()).toBe(136);
    expect(((await (await ui('/api/state')).json()) as AgentState).budget.serpLeft).toBe(136);
  });
});
