// Step 18 in the agent: GET /api/costs, the cost settings on PATCH /api/settings (and the AI cap's move into them), the
// cost blocker at the paid call sites with the run going on, the owner's confirm on his own click, and the warnings once
// each. The owner's real scan store (fixtures/e2e-2026-11-23), a fake SerpApi and Keepa, a clock that moves. No network.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentState, NotifyEvent, PaidResponse } from '../../core/src/api/contract';
import type { CostsView } from '../../core/src/costs/types';
import * as fx from '../../core/test/fixtures';
import { createAgent, type Agent } from '../app';
import { COSTS_AI_LIMIT_MIGRATION, Store } from '../store';

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

let ui: (path: string, init?: RequestInit) => Promise<Response>;

interface World {
  dir: string;
  searches: number;
  keepaCalls: number;
  notes: NotifyEvent[];
  anthropicCalls: number;
}

function dataFolder(serpRowsToday = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'sf-costs-'));
  mkdirSync(join(dir, 'scan'), { recursive: true });
  for (const kind of ['bundles', 'catalog', 'matches', 'prices', 'listings', 'partPrices', 'reviews']) {
    copyFileSync(join('fixtures/e2e-2026-11-23/scan', `${kind}.json`), join(dir, 'scan', `${kind}.json`));
  }
  // Searches already spent this month, in the ledger's own shape.
  if (serpRowsToday > 0) {
    const at = new Date(T0 - 3_600_000).toISOString();
    writeFileSync(join(dir, 'serpapi-ledger.jsonl'), Array.from({ length: serpRowsToday }, (_, i) => `${JSON.stringify({ at, engine: 'amazon', key: `k${i}`, label: 'agent:lookup' })}\n`).join(''));
  }
  return dir;
}

async function open(dir: string, o: { tokens?: number; costs?: Record<string, unknown>; aiCap?: number } = {}): Promise<World> {
  const world: World = { dir, searches: 0, keepaCalls: 0, notes: [], anthropicCalls: 0 };
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let t = T0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(typeof input === 'string' || input instanceof URL ? input : input.url));
    if (url.pathname.endsWith('/account.json')) return new Response(JSON.stringify({ ...fx.SERPAPI_ACCOUNT_FREE, total_searches_left: 200, plan_searches_left: 200 }), { status: 200 });
    if (url.pathname.endsWith('/search.json')) {
      if (url.searchParams.get('engine') !== 'amazon') return new Response(JSON.stringify({ error: 'not recorded here' }), { status: 404 });
      world.searches += 1;
      return new Response(AMAZON, { status: 200 });
    }
    if (url.hostname === 'api.keepa.com') {
      world.keepaCalls += 1;
      return new Response(JSON.stringify({ products: [], tokensLeft: o.tokens ?? 7, tokensConsumed: 0, refillRate: 1, refillIn: 30_000, processingTimeInMs: 1 }), { status: 200 });
    }
    if (url.hostname === 'api.anthropic.com') world.anthropicCalls += 1;
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  agent = createAgent({ dataDir: dir, port, timers: false, fetchFn, now: () => (t += 1000) });
  const publish = agent.events.publish.bind(agent.events);
  agent.events.publish = ((name: string, data: unknown) => {
    if (name === 'notify') world.notes.push(data as NotifyEvent);
    publish(name as never, data as never);
  }) as typeof agent.events.publish;
  server.on('request', agent.handle);
  ui = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json' } });
  agent.store.update('keys', (k) => ({ ...k, serpapi: 'serp-secret-key-123', keepa: 'keepa-secret-key-1' }));
  agent.store.update('settings', (s) => ({ ...s, settings: { ...s.settings, brands: ['RYOBI'], searchesPerScan: 18, reserve: 100 }, ai: { ...s.ai, monthlyCapUsd: o.aiCap ?? 0 } }));
  if (o.costs) {
    const res = await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ costs: o.costs }) });
    expect(res.status).toBe(200);
  }
  return world;
}

const costsNotes = (w: World) => w.notes.filter((n) => n.kind === 'costs');

describe('GET /api/costs', () => {
  it("answers the month's costs to the app only, from the data folder's ledger", async () => {
    await open(dataFolder(12));
    const view = (await (await ui('/api/costs')).json()) as CostsView;
    expect(view.month).toBe('2026-11');
    expect(view.services.map((s) => s.service)).toEqual(['serpapi', 'keepa', 'ai', 'ebay', 'telegram']);
    expect(view.services[0]).toMatchObject({ label: 'SerpApi', unit: 'searches', used: 12, limit: null });
    expect(view.settings.services.ai.monthlyLimit).toBe(0);
    const anon = await fetch(new URL('/api/costs', `http://127.0.0.1:${(server!.address() as { port: number }).port}`));
    expect(anon.status).toBe(401);
    const state = (await (await ui('/api/state')).json()) as AgentState;
    expect(state.budget.costs).toMatchObject({ state: 'ok', attention: [] });
  });
});

describe('the cost settings', () => {
  it('are checked on PATCH /api/settings', async () => {
    await open(dataFolder());
    for (const costs of [{ services: { keepa: { monthlyPriceUsd: -5 } } }, { services: { serpapi: { warnAtPercent: 40 } } }, { totalMonthlyUsd: 'lots' }, { services: { ai: { monthlyPriceUsd: 10 } } }]) {
      expect((await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ costs }) })).status).toBe(400);
    }
    const ok = await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ costs: { totalMonthlyUsd: 80, services: { keepa: { monthlyPriceUsd: 49, monthlyLimit: 20000 } } } }) });
    expect(ok.status).toBe(200);
    expect(agent.store.get('settings').costs).toMatchObject({ totalMonthlyUsd: 80, blockWhenOver: true, services: { keepa: { monthlyPriceUsd: 49, monthlyLimit: 20000, warnAtPercent: 80 } } });
  });

  it('hold the AI limit and ai.monthlyCapUsd as one value, whichever is written', async () => {
    await open(dataFolder());
    await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ ai: { monthlyCapUsd: 12 } }) });
    expect(agent.store.get('settings').costs!.services.ai.monthlyLimit).toBe(12);
    await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ costs: { services: { ai: { monthlyLimit: 30 } } } }) });
    expect(agent.store.get('settings').ai.monthlyCapUsd).toBe(30);
    // A writer that sets only the cap (as the AI passes' tests do) moves the limit too.
    agent.store.update('settings', (s) => ({ ...s, ai: { ...s.ai, monthlyCapUsd: 3 } }));
    expect(agent.store.get('settings').costs!.services.ai.monthlyLimit).toBe(3);
  });

  it("move a stored AI cap into the costs once, logged, and keep it on the next start", () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-costs-'));
    const first = Store.open(dir);
    first.update('runtime', (r) => ({ ...r, migrations: (r.migrations ?? []).filter((m) => m !== COSTS_AI_LIMIT_MIGRATION), migrationLog: [] }));
    first.close();
    // The settings as an agent before step 18 wrote them: no costs, a cap of $40.
    const file = join(dir, 'store', 'settings.json');
    const old = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { ai: Record<string, unknown> };
    delete old.costs;
    old.ai.monthlyCapUsd = 40;
    writeFileSync(file, JSON.stringify(old));
    const second = Store.open(dir);
    expect(second.get('settings').costs).toMatchObject({ totalMonthlyUsd: null, blockWhenOver: true, services: { ai: { monthlyLimit: 40, monthlyPriceUsd: null }, serpapi: { monthlyPriceUsd: null } } });
    expect(second.get('settings').ai.monthlyCapUsd).toBe(40);
    expect(second.get('runtime').migrationLog).toEqual([expect.objectContaining({ name: COSTS_AI_LIMIT_MIGRATION, sentence: 'Costs: your monthly AI cap of $40.00 is now the AI limit in Costs, one setting. No price or budget is entered.' })]);
    second.close();
    const third = Store.open(dir);
    expect(third.get('runtime').migrationLog).toHaveLength(1);
    expect(third.get('settings').costs!.services.ai.monthlyLimit).toBe(40);
    third.close();
  });
});

describe('the cost blocker in a scan', () => {
  it("holds the scan's searches that would pass the search limit, says why, and the scan goes on", async () => {
    const w = await open(dataFolder(45), { costs: { services: { serpapi: { monthlyLimit: 50 } } } });
    agent.work.scanNow();
    await agent.work.idle();
    expect(w.searches).toBe(0);
    const run = agent.store.get('activity').runs.at(-1)!;
    expect(run.status).not.toBe('failed');
    const sentence = "The scan's searches were not made: expected to use about 18 searches, and 5 of your SerpApi limit of 50 searches are left. Raise the limit in Costs, or wait until Dec 1.";
    expect(run.summary).toContain(sentence);
    expect(agent.store.get('runtime').costs!.blocked.serpapi).toEqual([expect.objectContaining({ what: "The scan's searches", why: sentence })]);
    // Keepa ran: the rest of the scan did not stop.
    expect(w.keepaCalls).toBeGreaterThan(0);
    // One message for the service in this run (a second SerpApi step held in the same run sends none), and the 90% warning.
    const held = costsNotes(w).filter((n) => n.title === 'SerpApi: held back');
    expect(held).toHaveLength(1);
    expect(held[0]!.body).toBe(sentence);
    expect(costsNotes(w).filter((n) => n.title === 'SerpApi: 90% of your limit used')).toHaveLength(1);
    const view = (await (await ui('/api/costs')).json()) as CostsView;
    expect(view.services[0]).toMatchObject({ state: 'blocked', blocked: [expect.objectContaining({ what: "The scan's searches" })] });
    // The next scan is another run: held again, said again; the warning is not repeated.
    agent.work.scanNow();
    await agent.work.idle();
    expect(costsNotes(w).filter((n) => n.title === 'SerpApi: held back')).toHaveLength(2);
    expect(costsNotes(w).filter((n) => n.title === 'SerpApi: 90% of your limit used')).toHaveLength(1);
    // Two scans: longer than the suite's limit on a busy machine.
  }, 150_000);

  it('lets the lookups spend when the high end fits', async () => {
    const w = await open(dataFolder(45), { costs: { services: { serpapi: { monthlyLimit: 70 } } } });
    expect(await agent.work.lookUpAll(18)).toMatchObject({ started: true });
    await agent.work.idle();
    expect(w.searches).toBeGreaterThan(0);
    expect(w.searches).toBeLessThanOrEqual(18);
    expect(agent.store.get('runtime').costs?.blocked.serpapi ?? []).toEqual([]);
  });

  it('only warns when the blocker is switched off', async () => {
    const w = await open(dataFolder(45), { costs: { blockWhenOver: false, services: { serpapi: { monthlyLimit: 50 } } } });
    expect(await agent.work.lookUpAll(18)).toMatchObject({ started: true });
    await agent.work.idle();
    expect(w.searches).toBeGreaterThan(0);
    expect(agent.store.get('activity').runs.at(-1)!.summary).toContain("The scan's searches ran past a limit: expected to use about 18 searches");
    expect(costsNotes(w).filter((n) => n.title === 'SerpApi: held back')).toEqual([]);
  });

  it("holds the scan's Keepa lookups past the token limit and looks up with searches instead", async () => {
    const w = await open(dataFolder(), { tokens: 400, costs: { services: { keepa: { monthlyLimit: 5 } } } });
    agent.work.scanNow();
    await agent.work.idle();
    const run = agent.store.get('activity').runs.at(-1)!;
    expect(run.summary).toMatch(/The scan's Keepa lookups were not made: expected to use about \d+ tokens, and 5 of your Keepa limit of 5 tokens are left\./);
    expect(run.keepaTokensUsed).toBe(0);
    expect(w.searches).toBeGreaterThan(0);
  });

  it('holds the Review cards past the AI limit, a hard stop, and asks nothing', async () => {
    const w = await open(dataFolder(), { aiCap: 0.01 });
    agent.store.update('keys', (k) => ({ ...k, anthropic: 'sk-ant-test-key-1' }));
    // Ask about all: the same Review cards a scan writes after it.
    agent.work.askNow();
    await agent.work.idle();
    expect(w.anthropicCalls).toBe(0);
    const held = agent.store.get('runtime').costs?.blocked.ai ?? [];
    expect(held).toEqual([expect.objectContaining({ what: 'Review cards', why: expect.stringMatching(/^Review cards were not written: expected to cost about \$\d+\.\d\d, and \$0\.01 of your \$0\.01 AI limit is left\. Raise the limit in Costs, or wait until Dec 1\.$/) })]);
  });
});

describe("the owner's own click", () => {
  it('Look up held by the search limit says the sentence and asks to confirm; { force: true } spends', async () => {
    const w = await open(dataFolder(50), { costs: { services: { serpapi: { monthlyLimit: 50 } } } });
    agent.work.scanNow();
    await agent.work.idle();
    const deal = agent.store.get('deals').bundles.find((b) => b.parts.some((p) => p.status === 'unmatched' || p.status === 'waiting'))!;
    const before = w.searches;
    const held = (await (await ui(`/api/deals/${encodeURIComponent(deal.key)}/lookup`, { method: 'POST', body: '{}' })).json()) as PaidResponse;
    expect(held).toMatchObject({ searches: 0, canForce: true, reason: expect.stringMatching(/^Look up was not started: expected to use about \d+ searches?, and 0 of your SerpApi limit of 50 searches are left\. Raise the limit in Costs, or wait until Dec 1\. Confirm to spend anyway\.$/) });
    expect(w.searches).toBe(before);
    const forced = await ui(`/api/deals/${encodeURIComponent(deal.key)}/lookup`, { method: 'POST', body: JSON.stringify({ force: true }) });
    expect(forced.status).toBe(200);
    expect(w.searches).toBeGreaterThan(before);
  });

  it('Ask AI past the total budget asks him to confirm; past the AI limit it is a hard stop', async () => {
    await open(dataFolder(), { aiCap: 25, costs: { totalMonthlyUsd: 49, services: { keepa: { monthlyPriceUsd: 49 } } } });
    agent.store.update('keys', (k) => ({ ...k, anthropic: 'sk-ant-test-key-1' }));
    const id = (await agent.work.scanStore.listReview()).find((q) => q.answer === null)!.id;
    const budget = await agent.work.askQuestion(id, false);
    expect(budget).toMatchObject({ queued: false, canForce: true, reason: expect.stringMatching(/^The AI answer was not asked for: expected to cost about \$\d+\.\d\d, and \$0\.00 of your \$49\.00 monthly budget is left\. Raise the budget in Costs, or wait until Dec 1\. Ask anyway to spend it\.$/) });
    agent.store.update('settings', (s) => ({ ...s, ai: { ...s.ai, monthlyCapUsd: 0.001 } }));
    const limit = await agent.work.askQuestion(id, true);
    expect(limit.queued).toBe(false);
    expect(limit.canForce).toBeUndefined();
    expect(limit.reason).toMatch(/^The AI answer was not asked for: expected to cost about \$\d+\.\d\d, and \$0\.00 of your \$0\.00 AI limit is left\./);
  });
});

describe('the warnings', () => {
  it('reach the owner once a month, and not when he switched the costs kind off', async () => {
    const w = await open(dataFolder(42), { costs: { services: { serpapi: { monthlyLimit: 50 } } } });
    // 42 of 50 is 84%: the warning comes after the next run that finishes.
    agent.work.askNow();
    await agent.work.idle();
    expect(costsNotes(w).map((n) => n.title)).toEqual(['SerpApi: 84% of your limit used']);
    expect(costsNotes(w)[0]).toMatchObject({ body: '42 of 50 searches (84%).', route: '/costs' });
    agent.work.askNow();
    await agent.work.idle();
    expect(costsNotes(w)).toHaveLength(1);
    // Switched off: a new warning (the limit reached) is not sent.
    await ui('/api/settings', { method: 'PATCH', body: JSON.stringify({ notifications: { kinds: { costs: false } }, costs: { services: { serpapi: { monthlyLimit: 42 } } } }) });
    agent.work.askNow();
    await agent.work.idle();
    expect(costsNotes(w)).toHaveLength(1);
  });
});
