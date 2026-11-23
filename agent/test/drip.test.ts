// Step 15, decision 2: the drip. Between scans, while parts wait for an Amazon lookup and nothing else runs, the agent
// looks the next one up with Keepa whenever the account has a lookup's tokens (11) above the reserve, asking Keepa's free
// token status at most every 5 minutes. No SerpApi. Keepa here is a fake that answers with the recorded responses
// (fixtures/keepa: the RYOBI PCL235B search, 10 tokens; the product pull with stats, 1 token an ASIN). Fake clock.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildReport } from '../../core/src/scan/report';
import { bundleKey, DEFAULT_SCAN_SETTINGS } from '../../core/src/scan/types';
import { createAgent, type Agent } from '../app';
import { DRIP_POLL_MS, DRIP_RUN_MS } from '../work';

const T0 = Date.UTC(2026, 10, 23, 15);
const SEARCH = JSON.parse(readFileSync('fixtures/keepa/search-RYOBI-PCL235B.json', 'utf8')) as Record<string, unknown>;
const PRODUCTS = JSON.parse(readFileSync('fixtures/keepa/product-B0BGYFTPGK-B01H9BL8EO-B09M3TL9BB-stats.json', 'utf8')) as { products: { asin: string }[] } & Record<string, unknown>;
const BOT = '999:bot-secret-token';

let agent: Agent;
let clock: number;
let tokens: number;
let calls: string[];
let telegram: string[];

/** Keepa's account as the fake keeps it: 1 token a minute, as recorded. */
function keepaBody(consumed: number, extra: Record<string, unknown> = {}): Response {
  tokens -= consumed;
  return new Response(JSON.stringify({ ...extra, tokensLeft: tokens, tokensConsumed: consumed, refillRate: 1, refillIn: 30_000, processingTimeInMs: 1, timestamp: clock }), { status: 200 });
}

const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
  if (url.hostname === 'api.telegram.org') {
    telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  }
  if (url.hostname !== 'api.keepa.com') {
    calls.push(`other ${url.hostname}`);
    return new Response('{}', { status: 500 });
  }
  calls.push(`${url.pathname} ${url.searchParams.get('term') ?? url.searchParams.get('asin') ?? ''}`.trim());
  if (url.pathname === '/token') return keepaBody(0);
  if (url.pathname === '/search') {
    const { tokensLeft: _l, tokensConsumed: _c, ...rest } = SEARCH;
    return keepaBody(10, url.searchParams.get('term') === 'RYOBI PCL235B' ? rest : { products: [] });
  }
  if (url.pathname === '/product') {
    const asins = (url.searchParams.get('asin') ?? '').split(',');
    return keepaBody(asins.length, { products: PRODUCTS.products.filter((p) => asins.includes(p.asin)) });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

/** One resolved RYOBI bundle of the PCL235B impact driver, waiting for its lookup, as a scan leaves it. */
async function waitingPart(): Promise<void> {
  const store = agent.work.scanStore;
  await store.putBundle({
    key: bundleKey('318621812'), retailer: 'homedepot', itemId: '318621812', title: 'RYOBI ONE+ 18V Impact Driver Kit', brand: 'RYOBI', model: 'PCL235B',
    upc: null, price: 39, regularPrice: 79, percentOff: 50, link: null, seenAt: T0, split: { components: ['PCL235B'], status: 'resolved', notes: [] },
  });
  await store.putMatch({ key: 'RYOBI:PCL235B', brand: 'RYOBI', model: 'PCL235B', status: 'waiting', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: T0 });
  await agent.work.refresh();
}

beforeEach(() => {
  clock = T0;
  calls = [];
  telegram = [];
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-drip-')), port: 0, timers: false, fetchFn, now: () => clock });
  agent.store.update('keys', (k) => ({ ...k, keepa: 'keepa-secret-key-1', telegram: { botToken: BOT, chatId: '42' } }));
});

afterEach(async () => {
  await agent.work.idle();
  agent.close();
});

describe('the drip', () => {
  it('with a lookup’s tokens above the reserve: one Keepa search and one price pull, the match saved, the deal estimated, one Activity run, one digest line', async () => {
    tokens = 21;
    await waitingPart();
    expect(agent.store.get('deals').bundles[0]!.estimate).toBeNull();
    await agent.work.drip();
    expect(calls).toEqual(['/token', '/search RYOBI PCL235B', '/product B0BGYFTPGK']);
    const match = await agent.work.scanStore.getMatch('RYOBI:PCL235B');
    expect(match).toMatchObject({ status: 'matched', asin: 'B0BGYFTPGK' });
    expect((await agent.work.scanStore.getPrice('B0BGYFTPGK'))!.price).toBeGreaterThan(0);
    // The deals are rebuilt: the bundle has an estimate now.
    const report = await buildReport(agent.work.scanStore, DEFAULT_SCAN_SETTINGS);
    expect(report.bundles[0]!.estimate).not.toBeNull();
    expect(agent.store.get('deals').bundles[0]!.estimate).not.toBeNull();
    const runs = agent.store.get('activity').runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'lookup', trigger: 'scheduled', searchesUsed: 0, keepaTokensUsed: 11, summary: 'Looked up 1 part with Keepa: 1 matched.' });
    expect(telegram).toEqual(['Keepa lookups between scans gave 1 new estimate (from your fee settings, not your real fees).']);
    expect(agent.store.get('runtime').keepa).toMatchObject({ tokensLeft: 10, refillRate: 1 });
    expect(agent.work.state().drip).toMatchObject({ active: false, waiting: 0, lastLookupAt: new Date(T0).toISOString() });
  });

  it('below a lookup’s tokens: only the free status, and the next look waits at least 5 minutes, until the tokens have refilled', async () => {
    tokens = 12; // 7 above the reserve of 5: a lookup needs 11, 4 more minutes at 1 a minute.
    await waitingPart();
    await agent.work.drip();
    expect(calls).toEqual(['/token']);
    const next = Date.parse(agent.work.state().drip!.nextAt!);
    expect(next - clock).toBe(DRIP_POLL_MS);
    clock += DRIP_POLL_MS - 1;
    await agent.work.drip();
    expect(calls).toEqual(['/token']);
    clock += 1;
    tokens = 17;
    await agent.work.drip();
    expect(calls).toEqual(['/token', '/token', '/search RYOBI PCL235B', '/product B0BGYFTPGK']);
  });

  it('nothing waits, the setting off, paused, or no Keepa key: no call at all', async () => {
    tokens = 100;
    await agent.work.drip();
    expect(calls).toEqual([]);
    await waitingPart();
    agent.store.update('settings', (s) => ({ ...s, lookups: { drip: false } }));
    clock += DRIP_POLL_MS;
    await agent.work.drip();
    expect(agent.work.state().drip).toBeUndefined();
    agent.store.update('settings', (s) => ({ ...s, lookups: { drip: true } }));
    agent.store.update('agent', (a) => ({ ...a, paused: true }));
    await agent.work.drip();
    agent.store.update('agent', (a) => ({ ...a, paused: false }));
    agent.store.update('keys', (k) => ({ ...k, keepa: undefined }));
    await agent.work.drip();
    expect(calls).toEqual([]);
  });

  it('one Activity run an hour: lookups within the hour add to it, a later one starts the next', async () => {
    tokens = 21;
    await waitingPart();
    await agent.work.drip();
    // A second waiting part, its Keepa search finds nothing: no Amazon listing.
    await agent.work.scanStore.putBundle({
      key: bundleKey('1'), retailer: 'homedepot', itemId: '1', title: 'RYOBI kit', brand: 'RYOBI', model: 'PZZZ1',
      upc: null, price: 50, regularPrice: 90, percentOff: 44, link: null, seenAt: T0, split: { components: ['PZZZ1'], status: 'resolved', notes: [] },
    });
    tokens = 40;
    clock += DRIP_POLL_MS + 11 * 60_000;
    await agent.work.drip();
    expect(agent.store.get('activity').runs).toHaveLength(1);
    expect(agent.store.get('activity').runs[0]!.summary).toBe('Looked up 2 parts with Keepa: 1 matched, 1 no Amazon listing.');
    await agent.work.scanStore.putBundle({
      key: bundleKey('2'), retailer: 'homedepot', itemId: '2', title: 'RYOBI kit', brand: 'RYOBI', model: 'PZZZ2',
      upc: null, price: 50, regularPrice: 90, percentOff: 44, link: null, seenAt: T0, split: { components: ['PZZZ2'], status: 'resolved', notes: [] },
    });
    clock = T0 + DRIP_RUN_MS + 1;
    await agent.work.drip();
    expect(agent.store.get('activity').runs.map((r) => r.summary)).toEqual([
      'Looked up 2 parts with Keepa: 1 matched, 1 no Amazon listing.',
      'Looked up 1 part with Keepa: 0 matched, 1 no Amazon listing.',
    ]);
    // Never a SerpApi call.
    expect(calls.filter((c) => c.startsWith('other'))).toEqual([]);
  });

  it('a scan claimed while the drip runs starts once the drip has finished its part', async () => {
    tokens = 21;
    await waitingPart();
    const round = agent.work.drip();
    // Scan now refuses without a SerpApi key, but only after the drip's round: the two never write together.
    agent.work.scanNow();
    await round;
    await agent.work.idle();
    expect(calls.slice(0, 1)).toEqual(['/token']);
    expect(agent.store.get('activity').runs.some((r) => r.kind === 'scan')).toBe(true);
  });
});
