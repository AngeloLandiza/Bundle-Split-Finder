import { readdirSync, readFileSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActivityResponse, AgentState, DealsResponse, ReviewResponse, SettingsResponse } from '../../core/src/api/contract';
import { parseBundlePage } from '../../core/src/hdPage';
import { AnswerRefused } from '../../core/src/scan/answers';
import type { runScan } from '../../core/src/scan/runner';
import * as fx from '../../core/test/fixtures';
import { replayRecorded } from '../../scripts/replay';
import { createAgent, type Agent, type AgentOptions } from '../app';
import { WorkRefused } from '../work';

// The agent scans by itself: the owner's SerpApi key from the store, the recorded responses behind a fake fetch
// (the real SerpApiClient and SearchBudget, nothing reaches the network), no Chrome connected, and a Telegram bot.

const SERP_KEY = 'serp-secret-key-123';
const BOT = '999:bot-secret-token';
const T0 = Date.UTC(2026, 10, 22, 15);
/** The recorded Home Depot page of PCL1600K2-P553 (it names no models, so the split stays a question). */
const PAGE_320243741 = (JSON.parse(readFileSync('fixtures/homedepot-pages/pages-2026-11-10.json', 'utf8')) as { pages: { itemId: string; text: string }[] }).pages.find((p) => p.itemId === '320243741')!.text;

let server: Server;
let agent: Agent;
let base: string;
let dataDir: string;
let clock: number;
let telegram: { url: string; text: string }[];

async function start(opts: Partial<AgentOptions> = {}) {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'sf-run-'));
  clock = T0;
  telegram = [];
  const replay = replayRecorded();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.includes('/account.json')) return new Response(JSON.stringify(fx.SERPAPI_ACCOUNT_FREE), { status: 200 });
    if (url.startsWith('https://api.telegram.org/')) {
      telegram.push({ url, text: (JSON.parse(String(init?.body)) as { text: string }).text });
      return new Response('{"ok":true,"result":{}}', { status: 200 });
    }
    return replay.fetchFn(input as string, init);
  }) as typeof fetch;
  agent = createAgent({ dataDir, port, timers: false, fetchFn, now: () => clock, ...opts });
  server.on('request', agent.handle);
}

afterEach(async () => {
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const json = async <T>(path: string, init?: RequestInit) => (await (await ui(path, init)).json()) as T;
const put = (path: string, body: unknown) => ui(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = (body: unknown) => ui('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]));
}

describe('a scan from the app', () => {
  beforeEach(() => start());

  it('runs in the agent, under the per-scan cap, and its results reach Deals, Review, Activity and Telegram', async () => {
    expect((await json<AgentState>('/api/state')).firstRun).toBe(true);
    await put('/api/keys/serpapi', { key: SERP_KEY });
    await put('/api/keys/telegram', { botToken: BOT, chatId: '42' });
    expect((await patch({ settings: { brands: ['RYOBI'], searchesPerScan: 1 }, ai: { monthlyCapUsd: 0 } })).status).toBe(200);

    const started = await ui('/api/scan', { method: 'POST' });
    expect(started.status).toBe(200);
    await agent.work.idle();

    const activity = await json<ActivityResponse>('/api/activity');
    const run = activity.runs.at(-1)!;
    expect(run).toMatchObject({ kind: 'scan', trigger: 'manual', status: 'finished', searchesUsed: 1 });
    expect(run.summary).toContain('Chrome is closed');
    expect(run.steps?.find((s) => s.label === 'Bundle pages')).toMatchObject({ state: 'skipped', figure: 'Chrome closed' });

    const state = await json<AgentState>('/api/state');
    expect(state).toMatchObject({ firstRun: false, agent: { status: 'idle' }, budget: { serpMonthly: 250, serpPerScan: 1, serpLeft: 250 } });

    // Nov 23: with Chrome closed no bundle page is read, so a bundle the title does not split waits for its page: it is
    // under Waiting for a lookup (waiting_page) and is not a question.
    const waiting = (await json<DealsResponse>('/api/deals')).rows.find((r) => r.id === 'homedepot:320243741')!;
    expect(waiting).toMatchObject({ matchState: 'waiting_page', matchKind: 'waiting_page', needsAnswer: false });
    expect((await json<ReviewResponse>('/api/review')).questions.some((x) => x.id === 'split:homedepot:320243741')).toBe(false);
    expect(telegram).toHaveLength(0);

    // Its page read (as the helper would have): the page names no model, so the split PCL1600K2 + P553 waits for Home
    // Depot's own reading of each part (step 15, rule 2: waiting_parts), still not a question.
    const bundle = (await agent.work.scanStore.getBundle('homedepot:320243741'))!;
    await agent.work.scanStore.putBundle({ ...bundle, page: { ...parseBundlePage(PAGE_320243741, '320243741')!, readAt: clock } });
    expect((await ui('/api/scan', { method: 'POST' })).status).toBe(200);
    await agent.work.idle();
    const parts = (await json<DealsResponse>('/api/deals')).rows.find((r) => r.id === 'homedepot:320243741')!;
    expect(parts).toMatchObject({ matchState: 'waiting_parts', matchKind: 'waiting_parts', needsAnswer: false });
    expect((await json<ReviewResponse>('/api/review')).questions.some((x) => x.id === 'split:homedepot:320243741')).toBe(false);

    // Home Depot's search, read as the helper would have, found no P553 sold by itself, and PCL1600K2 sold under its own
    // model: every part is read now (step 16 round 2: no question while a part has a free read to come), so the next scan asks.
    await agent.work.scanStore.putPartPrice({
      key: 'RYOBI:P553', brand: 'RYOBI', model: 'P553', itemId: null, matchedModel: null, price: null, title: null, link: null, seenAt: null, checkedAt: clock,
    });
    await agent.work.scanStore.putPartPrice({
      key: 'RYOBI:PCL1600K2', brand: 'RYOBI', model: 'PCL1600K2', itemId: '317987591', matchedModel: 'PCL1600K2', price: 199, link: 'https://www.homedepot.com/p/317987591',
      title: 'ONE+ 18V Cordless 6-Tool Combo Kit with Compact Battery, 4.0 Ah Battery, and Charger', seenAt: clock, checkedAt: clock,
    });
    expect((await ui('/api/scan', { method: 'POST' })).status).toBe(200);
    await agent.work.idle();

    const review = await json<ReviewResponse>('/api/review');
    const q = review.questions.find((x) => x.id === 'split:homedepot:320243741')!;
    expect(q).toMatchObject({ prompt: 'What is inside the RYOBI PCL1600K2-P553?', choices: [{ id: 'choice:0', models: ['PCL1600K2', 'P553'] }] });
    expect(q.seen).toEqual(expect.any(String));

    // The scan's point is in each bundle's history; a bundle still in Review is not watched by itself.
    const tracking = agent.store.get('tracking');
    expect(tracking.history['homedepot:320243741']?.map((p) => [p.section, p.reviewOpen])).toEqual([['split', true]]);
    expect(tracking.watch['homedepot:320243741']).toBeUndefined();

    // One digest after the run, on Telegram too, with no key in it.
    expect(telegram).toHaveLength(1);
    expect(telegram[0]!.url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(telegram[0]!.text).toMatch(/1 question needs you/);
    expect(telegram[0]!.text).not.toContain('secret');

    // The owner's answer is applied by the agent, through answers.ts.
    const answered = await ui(`/api/review/${encodeURIComponent(q.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: { choiceId: 'choice:0' }, seen: q.seen }) });
    expect(answered.status).toBe(200);
    expect((await json<ReviewResponse>('/api/review')).questions.some((x) => x.id === q.id)).toBe(false);
    const stale = await ui(`/api/review/${encodeURIComponent(q.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: { none: true } }) });
    expect(stale.status).toBe(409);

    // The ledger records the one search; no file but the keys file holds a key.
    expect(readFileSync(join(dataDir, 'serpapi-ledger.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    for (const f of filesUnder(dataDir)) {
      if (f.endsWith(join('store', 'keys.json'))) continue;
      const body = readFileSync(f, 'utf8');
      expect(body.includes(SERP_KEY) || body.includes('bot-secret'), f).toBe(false);
    }
  });

  it('Nov 23 migration: a "What is inside" question opened for a bundle whose page was never read is withdrawn at start', async () => {
    // As the owner's store was left: the bundle unread, its split question open (opened from the title by the old rule).
    const { splitOne } = await import('../../core/src/scan/runner');
    const record = {
      key: 'homedepot:320243741', retailer: 'homedepot' as const, itemId: '320243741', title: 'RYOBI kit', brand: 'RYOBI', model: 'PCL1600K2-P553',
      upc: null, price: 199, regularPrice: 268, percentOff: 26, link: null, seenAt: T0, split: null,
    };
    await agent.work.scanStore.putBundle(record);
    await splitOne(agent.work.scanStore, record, { stored: new Map(), catalog: new Map() }, T0);
    await agent.work.refresh();
    expect((await json<ReviewResponse>('/api/review')).questions.map((q) => q.id)).toEqual(['split:homedepot:320243741']);

    expect(await agent.work.withdrawWaitingQuestions()).toBe(1);
    expect((await json<ReviewResponse>('/api/review')).questions).toEqual([]);
    expect((await json<DealsResponse>('/api/deals')).rows[0]).toMatchObject({ matchState: 'waiting_page', needsAnswer: false });
    expect(await agent.work.withdrawWaitingQuestions()).toBe(0);
  });

  it('without a key the run says so in a sentence, offers Retry, and spends nothing', async () => {
    await ui('/api/scan', { method: 'POST' });
    await agent.work.idle();
    const activity = await json<ActivityResponse>('/api/activity');
    expect(activity.runs[0]).toMatchObject({ status: 'failed', error: 'Add your SerpApi key in Settings.', searchesUsed: 0 });
    expect(activity.errors?.[0]).toMatchObject({ sentence: 'Add your SerpApi key in Settings.', retry: { label: 'Scan again' } });
  });
});

describe('the schedule', () => {
  it('starts a due scan once, not while paused or busy, and counts the next one from its start', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const fakeScan = (async () => {
      calls += 1;
      await new Promise<void>((r) => (release = r));
      throw new Error('stop here');
    }) as unknown as typeof runScan;
    await start({ work: { runScan: fakeScan } });
    await put('/api/keys/serpapi', { key: SERP_KEY });
    expect(agent.work.nextScanAt()).toBeNull();
    await patch({ settings: { schedule: { mode: 'interval', hours: 6 } } });
    // Switching on the schedule spends nothing at the next tick: the first scheduled scan is one interval later.
    expect(agent.work.nextScanAt()).toBe(new Date(T0 + 6 * 3_600_000).toISOString());
    expect(((await json<AgentState>('/api/state')).agent.nextScanAt)).toBe(new Date(T0 + 6 * 3_600_000).toISOString());
    expect(agent.work.tick()).toBe(false);
    clock = T0 + 6 * 3_600_000;
    const firstAt = clock;

    await ui('/api/agent/pause', { method: 'POST' });
    expect(agent.work.tick()).toBe(false);
    expect(agent.work.nextScanAt()).toBeNull();
    await ui('/api/agent/resume', { method: 'POST' });

    // Free scan: no helper is connected, so the due scheduled scan waits for Chrome; it is still due.
    expect(agent.work.tick()).toBe(false);
    expect(calls).toBe(0);
    expect(agent.work.nextScanAt()).toBe(new Date(firstAt).toISOString());
    // The owner lets SerpApi find the bundles while Chrome is closed: the scan starts.
    await patch({ scan: { serpWhenChromeClosed: true } });
    expect((await json<SettingsResponse>('/api/settings')).settings.scan).toEqual({ listingSource: 'auto', serpWhenChromeClosed: true });

    expect(agent.work.tick()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.work.tick()).toBe(false);
    expect((await json<AgentState>('/api/state')).agent.status).toBe('scanning');
    release();
    await agent.work.idle();
    expect(calls).toBe(1);
    expect(agent.work.nextScanAt()).toBe(new Date(firstAt + 6 * 3_600_000).toISOString());
    expect(agent.work.tick()).toBe(false);
    const activity = await json<ActivityResponse>('/api/activity');
    expect(activity.runs[0]).toMatchObject({ trigger: 'scheduled', status: 'failed', error: 'stop here' });
  });

  it('while an answer is being applied no scan starts, and answers go one at a time', async () => {
    // The last tick() starts a scheduled scan that afterEach waits for; a real replayed scan made this the slowest test
    // here (and the one to time out its hook when the machine was busy). This test is about the slot, not the scan.
    const quick = (async () => {
      throw new Error('stop here');
    }) as unknown as typeof runScan;
    await start({ work: { runScan: quick } });
    await put('/api/keys/serpapi', { key: SERP_KEY });
    await patch({ settings: { schedule: { mode: 'interval', hours: 6 } }, scan: { serpWhenChromeClosed: true } });
    clock += 6 * 3_600_000;
    let found: (v: undefined) => void = () => {};
    const order: string[] = [];
    const real = agent.work.scanStore.getReview.bind(agent.work.scanStore);
    agent.work.scanStore.getReview = (id: string) => {
      order.push(id);
      return id === 'first' ? new Promise((r) => (found = r)) : real(id);
    };
    const first = agent.work.answer('first', { none: true }, undefined, false);
    const second = agent.work.answer('second', { none: true }, undefined, false);
    expect(agent.work.tick()).toBe(false);
    expect(() => agent.work.scanNow()).toThrow(/answer is being applied/);
    // 'second' must not have started: let every queued microtask and one macrotask run, then look.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['first']);
    found(undefined);
    await expect(first).rejects.toThrow('That question was not found.');
    await expect(second).rejects.toThrow('That question was not found.');
    expect(order).toEqual(['first', 'second']);
    expect(agent.work.tick()).toBe(true);
  });

  it('after a failed scan nothing runs (no AI, Autopilot or digest); only a waiting Telegram message is sent again', async () => {
    const fakeScan = (async () => {
      throw new Error('Reading Home Depot pages failed.');
    }) as unknown as typeof runScan;
    await start({ work: { runScan: fakeScan } });
    await put('/api/keys/serpapi', { key: SERP_KEY });
    await put('/api/keys/telegram', { botToken: BOT, chatId: '42' });
    agent.store.update('runtime', (r) => ({ ...r, telegram: { ...r.telegram, pending: [{ text: 'Waiting digest', at: new Date(T0).toISOString(), tries: 1 }] } }));
    const w = agent.work as unknown as Record<'aiPass' | 'autopilot' | 'message', () => Promise<unknown>>;
    const after = [vi.spyOn(w, 'aiPass'), vi.spyOn(w, 'autopilot'), vi.spyOn(w, 'message')];
    agent.work.scanNow();
    await agent.work.idle();
    for (const spy of after) expect(spy).not.toHaveBeenCalled();
    expect(telegram.map((t) => t.text)).toEqual(['Waiting digest']);
    expect(agent.store.get('runtime').telegram.pending).toEqual([]);
    expect((await json<ActivityResponse>('/api/activity')).runs[0]).toMatchObject({ status: 'failed', error: 'Reading Home Depot pages failed.' });
  });

  it('Stop ends the running scan before its next paid step', async () => {
    let sawStop = false;
    const fakeScan = (async (deps: Parameters<typeof runScan>[0]) => {
      while (!deps.shouldStop?.()) await new Promise((r) => setTimeout(r, 5));
      sawStop = true;
      throw new Error('stopped');
    }) as unknown as typeof runScan;
    await start({ work: { runScan: fakeScan } });
    await put('/api/keys/serpapi', { key: SERP_KEY });
    await ui('/api/scan', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 20));
    expect(await json('/api/scan/stop', { method: 'POST' })).toEqual({ stopping: true });
    await agent.work.idle();
    expect(sawStop).toBe(true);
  });

  it('a Look up holds the one slot from the click, before its first await: nothing else starts meanwhile', async () => {
    await start();
    await put('/api/keys/serpapi', { key: SERP_KEY });
    let fail: (e: unknown) => void = () => {};
    const planned = new Promise<never>((_res, rej) => (fail = rej));
    agent.work.paidPlan = () => planned;
    const first = agent.work.paid('B', 'lookUp');
    expect(agent.work.state().busy).toBe('paid');
    expect(() => agent.work.scanNow()).toThrow(WorkRefused);
    expect(() => agent.work.askNow()).toThrow(WorkRefused);
    expect(() => agent.work.paid('B', 'lookUp')).toThrow(WorkRefused);
    await patch({ settings: { schedule: { mode: 'interval', hours: 6 } } });
    clock += 6 * 3_600_000;
    expect(agent.work.tick()).toBe(false);
    // A refusal after the claim frees the slot.
    fail(new AnswerRefused('No such deal.'));
    await expect(first).rejects.toThrow('No such deal.');
    await agent.work.idle();
    expect(agent.work.state().busy).toBeNull();
  });
});
