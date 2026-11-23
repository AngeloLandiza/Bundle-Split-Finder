import { readdirSync, readFileSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityResponse, AgentState, ReviewResponse } from '../../core/src/api/contract';
import type { runScan } from '../../core/src/scan/runner';
import * as fx from '../../core/test/fixtures';
import { replayRecorded } from '../../scripts/replay';
import { createAgent, type Agent, type AgentOptions } from '../app';

// The agent scans by itself: the owner's SerpApi key from the store, the recorded responses behind a fake fetch
// (the real SerpApiClient and SearchBudget, nothing reaches the network), no Chrome connected, and a Telegram bot.

const SERP_KEY = 'serp-secret-key-123';
const BOT = '999:bot-secret-token';
const T0 = Date.UTC(2026, 10, 22, 15);

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
    const run = activity.runs[0]!;
    expect(run).toMatchObject({ kind: 'scan', trigger: 'manual', status: 'finished', searchesUsed: 1 });
    expect(run.summary).toContain('Chrome is closed');
    expect(run.steps?.find((s) => s.label === 'Bundle pages')).toMatchObject({ state: 'skipped', figure: 'Chrome closed' });

    const state = await json<AgentState>('/api/state');
    expect(state).toMatchObject({ firstRun: false, agent: { status: 'idle' }, budget: { serpMonthly: 250, serpPerScan: 1, serpLeft: 250 } });

    const review = await json<ReviewResponse>('/api/review');
    const q = review.questions.find((x) => x.id === 'split:homedepot:320243741')!;
    expect(q).toMatchObject({ prompt: 'What is inside the RYOBI PCL1600K2-P553?', choices: [{ id: 'choice:0', models: ['PCL1600K2', 'P553'] }] });
    expect(q.seen).toEqual(expect.any(String));

    // One digest after the run, on Telegram too, with no key in it.
    expect(telegram).toHaveLength(1);
    expect(telegram[0]!.url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(telegram[0]!.text).toMatch(/questions need you/);
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
    expect(agent.work.nextScanAt()).toBe(new Date(T0).toISOString());

    await ui('/api/agent/pause', { method: 'POST' });
    expect(agent.work.tick()).toBe(false);
    expect(agent.work.nextScanAt()).toBeNull();
    await ui('/api/agent/resume', { method: 'POST' });

    expect(agent.work.tick()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(agent.work.tick()).toBe(false);
    expect((await json<AgentState>('/api/state')).agent.status).toBe('scanning');
    release();
    await agent.work.idle();
    expect(calls).toBe(1);
    expect(agent.work.nextScanAt()).toBe(new Date(T0 + 6 * 3_600_000).toISOString());
    expect(agent.work.tick()).toBe(false);
    const activity = await json<ActivityResponse>('/api/activity');
    expect(activity.runs[0]).toMatchObject({ trigger: 'scheduled', status: 'failed', error: 'stop here' });
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
});
