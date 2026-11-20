// Ask AI about all in the worker (step 12, R3): a background queue over the real Review questions of the validation replay,
// one question at a time, with a fake model endpoint. Nothing here reaches a network or a model.

import { describe, expect, it } from 'vitest';
import { asked, assistWorld } from '../../core/test/assist-world';
import { PRICE_TABLE } from '@core/judge/eval';
import { reviewSignature } from '@core/scan/answers';
import { OverlayStore } from '@core/scan/overlayStore';
import { MemorySuggestionStore, type StoredSuggestion } from '@core/assist/stored';
import type { AssistRaw } from '@core/assist/types';
import type { ReviewItem } from '@core/scan/types';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS, type EbaySettings } from '@core/settings';
import { MemoryCache } from '@core/serpapi/client';
import * as fx from '../../core/test/fixtures';
import type { AppState, PanelReport, Reply, Request } from './messages';
import type { ResearchTools } from '@core/research/types';
import { createWorker, type AskOne, type Prefs } from './worker';
import { askAllCostLabel } from '@core/assist/cost';
import { askAllSentence } from '../entrypoints/sidepanel/AskAll';

const KEY = 'TEST';
const ANTHROPIC = 'sk-ant-test-0000-not-a-real-key';
const T0 = Date.UTC(2026, 10, 20, 12);
const PSK = 'split:homedepot:339206615';
const PSK_INCLUDES = 'Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries, (1) PBP003 18V ONE+ 2Ah Lithium Battery, (1) PCG002 18V ONE+ Charger';
/** The other open questions: four splits and a match question, all real. */
const OTHERS = ['split:homedepot:344285193', 'split:homedepot:344304336', 'split:homedepot:342303258', 'match:RYOBI:P553'];
const NO_CANDIDATES = 'match:RYOBI:PBP004';

const RIGHT: AssistRaw = { evidence: [{ quote: PSK_INCLUDES, source: 'bundle' }], reason: 'The page lists PBP004, PBP003 and PCG002.', decision: 'choose', choiceIndex: 0, asin: null };
const CANNOT: AssistRaw = { evidence: [], reason: 'The page does not say.', decision: 'cannot_tell', choiceIndex: null, asin: null };
const message = (answer: AssistRaw | Record<string, unknown>, usage = { input_tokens: 1000, output_tokens: 100 }) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', stop_details: null, usage,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

class FakePrefs {
  anthropic: string | null;
  askAfterScan = false;
  rates: unknown = {};
  constructor(
    private readonly ebaySettings: EbaySettings,
    anthropic: string | null,
  ) {
    this.anthropic = anthropic;
  }
  getKey = async () => KEY;
  getSettings = async () => structuredClone(DEFAULT_SETTINGS);
  getLastScheduledRunAt = async () => null;
  getPackaging = async () => ({});
  getAccount = async () => null;
  setAccount = async () => {};
  setLastScheduledRunAt = async () => {};
  restrictKeyAccess = async () => {};
  getRates = async () => structuredClone(this.rates) as Record<string, number[]>;
  setRates = async (v: unknown) => void (this.rates = structuredClone(v));
  setNotified = async () => {};
  getEbayKeys = async () => null;
  getAnthropicKey = async () => this.anthropic;
  setAnthropicKey = async (k: string) => void (this.anthropic = k);
  forgetAnthropicKey = async () => void (this.anthropic = null);
  getEbaySettings = async () => ({ ...this.ebaySettings });
  getActiveScan = async () => null;
  setActiveScan = async () => {};
  getShowChip = async () => true;
  getNotified = async () => [];
  getEbayToken = async () => null;
  getAskAfterScan = async () => this.askAfterScan;
  setAskAfterScan = async (v: boolean) => void (this.askAfterScan = v);
}

interface Call { headers: Record<string, string>; user: string; model: string; tools?: { name?: string }[] }

interface Options {
  anthropic?: string | null;
  ebaySettings?: EbaySettings;
  /** The model's answer to the call; the call's user message says which question it is. */
  respond?: (call: Call, n: number) => Response | Promise<Response>;
  blockSearches?: Promise<void>;
  askOne?: AskOne;
  /** Step 12: with it a split question is researched. */
  researchTools?: { forQuestion(): ResearchTools };
  /** Which questions are open. Default: the PSK one and OTHERS. */
  ids?: string[];
}

const modelAnswer = (call: Call, n: number): Response => json(200, message(call.user.includes('PBP003 18V ONE+ 2Ah Lithium Battery') ? RIGHT : CANNOT, { input_tokens: 1000 + n, output_tokens: 100 }));

async function setup(opts: Options = {}) {
  const w = await assistWorld();
  const store = new OverlayStore(w.store);
  const questions: ReviewItem[] = [];
  const open = opts.ids ?? [PSK, ...OTHERS];
  // The replay stored more questions than a test names (the match ones are open): the others are answered, so they are not asked.
  for (const q of w.questions.values()) if (!open.includes(q.id)) await store.putReview({ ...q, answer: q.answer ?? 'none', answeredAt: T0 });
  for (const id of open) {
    const q = asked(w, id);
    await store.putReview(q);
    questions.push(q);
  }
  const suggestions = new MemorySuggestionStore();
  const calls: Call[] = [];
  const broadcasts: AppState[] = [];
  const flight = { now: 0, max: 0 };
  let clock = T0;
  const respond = opts.respond ?? modelAnswer;
  const prefs = new FakePrefs(opts.ebaySettings ?? { ...DEFAULT_EBAY_SETTINGS }, opts.anthropic === undefined ? ANTHROPIC : opts.anthropic);
  const worker = createWorker({
    store,
    cache: { ...new MemoryCache(), get: async () => undefined, set: async () => {}, clear: async () => {} },
    prefs: prefs as unknown as Prefs,
    ledger: () => {},
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/account.json')) return json(200, fx.SERPAPI_ACCOUNT_FREE);
      if (url.startsWith('https://api.anthropic.com/')) {
        const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[]; tools?: { name?: string }[] };
        const call: Call = { headers: init?.headers as Record<string, string>, user: body.messages[0]!.content, model: body.model, ...(body.tools ? { tools: body.tools } : {}) };
        calls.push(call);
        flight.now += 1;
        flight.max = Math.max(flight.max, flight.now);
        // The call ends when its signal does, as a real fetch's.
        const aborted = new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        try {
          return await Promise.race([Promise.resolve(respond(call, calls.length)), aborted]);
        } finally {
          flight.now -= 1;
        }
      }
      await opts.blockSearches;
      throw new TypeError('no network in the tests');
    }) as typeof fetch,
    now: () => clock,
    notify: () => {},
    broadcast: (s) => void broadcasts.push(s),
    suggestions,
    ...(opts.askOne ? { askOne: opts.askOne } : {}),
    ...(opts.researchTools ? { researchTools: opts.researchTools } : {}),
  });
  const send = <T = unknown>(request: Request): Promise<Reply<T>> => worker.onMessage(request) as Promise<Reply<T>>;
  const state = async () => (await send<AppState>({ type: 'getState' })) as { ok: true; data: AppState };
  const idle = async () => {
    for (let i = 0; i < 400; i++) {
      if ((await state()).data.askAll == null) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('the queue never ended');
  };
  return { worker, store, suggestions, calls, broadcasts, questions, send, state, idle, prefs, flight, tick: (ms: number) => void (clock += ms) };
}

describe('askAiAll: what it queues', () => {
  it('asks about every open question that can be asked, one at a time, and answers none of them', async () => {
    const t = await setup();
    const reply = await t.send<{ queued: number }>({ type: 'askAiAll' });
    expect(reply).toEqual({ ok: true, data: { queued: 5 } });
    await t.idle();
    expect(t.calls).toHaveLength(5);
    // One at a time: never two calls in flight.
    expect(t.flight.max).toBe(1);
    const records = await t.suggestions.list();
    expect(records.map((r) => r.questionId).sort()).toEqual([PSK, ...OTHERS].sort());
    expect(records.find((r) => r.questionId === PSK)!.suggestion.status).toBe('verified');
    // A suggestion is never an answer.
    for (const q of t.questions) expect((await t.store.getReview(q.id))!.answer).toBeNull();
    // The owner's key went only in each call's header.
    expect(t.calls.every((c) => c.headers['x-api-key'] === ANTHROPIC)).toBe(true);
    expect(JSON.stringify(await t.send({ type: 'getReport' }))).not.toContain(ANTHROPIC);
  });

  it('leaves out an answered question, one with a suggestion on screen, and a match question with no listing', async () => {
    const t = await setup({ ids: [PSK, ...OTHERS, NO_CANDIDATES] });
    // The match question the replay stored has one candidate: take it away to make it a question with nothing to choose.
    await t.store.putReview({ ...(await t.store.getReview(NO_CANDIDATES))!, candidates: [] });
    await t.store.putReview({ ...(await t.store.getReview(OTHERS[0]!))!, answer: 'none', answeredAt: T0 });
    await t.send({ type: 'askAi', questionId: OTHERS[1]! });
    expect(t.calls).toHaveLength(1);
    const reply = await t.send<{ queued: number }>({ type: 'askAiAll' });
    // Five open and askable, minus the one answered, the one already asked about, and the one with no listing.
    expect(reply).toEqual({ ok: true, data: { queued: 3 } });
    await t.idle();
    expect(t.calls).toHaveLength(4);
    expect(new Set(t.calls.map((c) => c.user)).size).toBe(4);
  });

  it('says so when there is nothing to ask, and calls nothing', async () => {
    const t = await setup({ ids: [NO_CANDIDATES] });
    await t.store.putReview({ ...(await t.store.getReview(NO_CANDIDATES))!, candidates: [] });
    expect(await t.send({ type: 'askAiAll' })).toEqual({ ok: false, error: 'There is nothing to ask about.' });
    expect(t.calls).toHaveLength(0);
  });

  it('is refused with no Anthropic key, and while it is already running', async () => {
    const none = await setup({ anthropic: null });
    expect(await none.send({ type: 'askAiAll' })).toEqual({ ok: false, error: 'Add your Anthropic key in Settings.' });
    expect(none.calls).toHaveLength(0);

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = await setup({ respond: async (c, n) => (await hold, modelAnswer(c, n)) });
    expect(await t.send({ type: 'askAiAll' })).toMatchObject({ ok: true });
    expect(await t.send({ type: 'askAiAll' })).toEqual({ ok: false, error: 'Already asking about all questions.' });
    release();
    await t.idle();
    expect(t.calls).toHaveLength(5);
  });
});

describe('askAiAll and a scan', () => {
  it('is refused while a scan runs, and calls nothing', async () => {
    let release!: () => void;
    const blockSearches = new Promise<void>((r) => (release = r));
    const t = await setup({ blockSearches });
    expect(await t.send({ type: 'scanNow' })).toMatchObject({ ok: true });
    const reply = await t.send({ type: 'askAiAll' });
    release();
    expect(reply).toEqual({ ok: false, error: 'A scan is running. Ask again when it has finished.' });
    expect(t.calls).toHaveLength(0);
    for (let i = 0; i < 100 && (await t.state()).data.scanRunning; i++) await new Promise((r) => setTimeout(r, 10));
  });

  it('holds a scan back while it runs: Scan now is refused in one sentence, and the alarm starts nothing', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = await setup({ respond: async (c, n) => (await hold, modelAnswer(c, n)) });
    await t.send({ type: 'askAiAll' });
    expect(await t.send({ type: 'scanNow' })).toEqual({ ok: false, error: 'Asking AI is running. Stop it first, or wait for it to finish.' });
    await t.worker.onTick();
    expect((await t.state()).data.scanRunning).toBe(false);
    release();
    await t.idle();
    // Once it has ended a scan may start: the gate is open.
    expect(await t.send({ type: 'scanNow' })).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && (await t.state()).data.scanRunning; i++) await new Promise((r) => setTimeout(r, 10));
  });

  it('refuses a single Ask AI while it runs, with one sentence', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = await setup({ respond: async (c, n) => (await hold, modelAnswer(c, n)) });
    await t.send({ type: 'askAiAll' });
    expect(await t.send({ type: 'askAi', questionId: PSK })).toEqual({ ok: false, error: 'Asking about all questions is running. Ask again when it has finished.' });
    release();
    await t.idle();
  });
});

describe('askAiAll: progress and cost', () => {
  it('tells the panel the count and what it has cost so far, then how it ended', async () => {
    const t = await setup({ ebaySettings: { ...DEFAULT_EBAY_SETTINGS, judgeModel: 'claude-opus-5-5' } });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    const running = t.broadcasts.flatMap((s) => (s.askAll ? [s.askAll] : []));
    expect(running.length).toBeGreaterThan(0);
    expect(running[0]).toMatchObject({ done: 0, total: 5, costUsd: 0 });
    expect(running.at(-1)).toMatchObject({ done: 5, total: 5 });
    // Strictly forward, and the estimate is said from the start (a number: the model has a rate).
    expect(running.map((r) => r.done)).toEqual([...running.map((r) => r.done)].sort((a, b) => a - b));
    expect(typeof running[0]!.estimateUsd).toBe('number');
    // Cost is each call's tokens at the model's rates: 1,000+n in at $4 and 100 out at $20 a million.
    const records = await t.suggestions.list();
    const spent = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const after = (await t.state()).data;
    expect(after.askAll ?? null).toBeNull();
    expect(after.askAllResult).toMatchObject({ total: 5, asked: 5, suggested: 5, verified: 1, stopped: false, problem: null });
    expect(after.askAllResult!.costUsd).toBeCloseTo(spent, 8);
    expect(spent).toBeGreaterThan(0);
    // The time per call is kept for the next estimate.
    expect(((t.prefs.rates as { askAi?: number[] }).askAi ?? []).length).toBe(0);
  });

  it('keeps the seconds a call took as the rate of the next estimate, when time passed', async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup({ respond: (c, n) => (t.tick(4_000), modelAnswer(c, n)) });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    expect((t.prefs.rates as { askAi?: number[] }).askAi).toEqual([4]);
  });
});

describe('askAiAll: Stop', () => {
  it('cancels the call in flight, writes nothing for it, and asks nothing more; what was already suggested stays', async () => {
    const t = await setup({ respond: (c, n) => (n === 3 ? new Promise<Response>(() => {}) : modelAnswer(c, n)) });
    await t.send({ type: 'askAiAll' });
    for (let i = 0; i < 200 && t.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.calls).toHaveLength(3);
    expect(await t.send({ type: 'stopAskAll' })).toEqual({ ok: true, data: null });
    await t.idle();
    // The third call was out when Stop came: no record of it, no fourth call.
    expect(t.calls).toHaveLength(3);
    const records = await t.suggestions.list();
    expect(records).toHaveLength(2);
    for (const r of records) expect(r.suggestion.status).not.toBe('not_suggested');
    const result = (await t.state()).data.askAllResult!;
    expect(result).toMatchObject({ stopped: true, total: 5, asked: 2 });
    // And it can be started again: the questions that have a suggestion are not asked twice.
    expect(await t.send({ type: 'askAiAll' })).toEqual({ ok: true, data: { queued: 3 } });
    await t.idle();
  });

  it('says Stopping while a call that has not ended yet is being cancelled', async () => {
    // A call that is slow to end: it does not answer to its signal until it is let go.
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let started = false;
    const askOne: AskOne = async (id) => {
      started = true;
      await slow;
      throw new Error('cancelled');
    };
    const t = await setup({ askOne, ids: [PSK] });
    await t.send({ type: 'askAiAll' });
    for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    await t.send({ type: 'stopAskAll' });
    expect(t.broadcasts.some((s) => s.askAll?.stopping === true)).toBe(true);
    release();
    await t.idle();
  });

  it('forgetting the Anthropic key stops it too', async () => {
    const t = await setup({ respond: (c, n) => (n === 2 ? new Promise<Response>(() => {}) : modelAnswer(c, n)) });
    await t.send({ type: 'askAiAll' });
    for (let i = 0; i < 200 && t.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    await t.send({ type: 'forgetAnthropicKey' });
    await t.idle();
    expect(t.calls).toHaveLength(2);
    expect((await t.state()).data.askAllResult).toMatchObject({ stopped: true });
  });

  it('Stop with nothing running is a no-op', async () => {
    const t = await setup();
    expect(await t.send({ type: 'stopAskAll' })).toEqual({ ok: true, data: null });
  });
});

describe('askAiAll: questions that change while it runs', () => {
  it('skips a question the owner answered before its turn, and one that changed while the AI worked', async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup({
      ids: [PSK, OTHERS[0]!, OTHERS[1]!],
      respond: async (c, n) => {
        // While the first call is out the owner answers the second question; while the second... there is no second call for it.
        if (n === 1) await t.store.putReview({ ...(await t.store.getReview(OTHERS[0]!))!, answer: 'none', answeredAt: T0 });
        // And the third's readings are rewritten by a scan while its call is out.
        if (n === 2) await t.store.putReview({ ...(await t.store.getReview(OTHERS[1]!))!, choices: [['PBP004', 'PCG002']] });
        return modelAnswer(c, n);
      },
    });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    // The answered question was never asked about; the changed one was asked and its suggestion closed, never shown.
    expect(t.calls).toHaveLength(2);
    const report = await t.send<PanelReport>({ type: 'getReport' });
    expect(report.ok && report.data.aiSuggestions?.map((s) => s.questionId)).toEqual([PSK]);
    expect((await t.state()).data.askAllResult).toMatchObject({ total: 3, stopped: false });
  });

  it('stops after three failed calls in a row and says why, rather than asking on', async () => {
    const t = await setup({ respond: () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    expect(t.calls).toHaveLength(3);
    const result = (await t.state()).data.askAllResult!;
    expect(result.problem).toMatch(/refused the API key/);
    expect(result.suggested).toBe(0);
    expect(JSON.stringify(await t.state())).not.toContain(ANTHROPIC);
  });
});

describe('askAiAll: the limits of the queue (step 12, fix round R3b)', () => {
  const SPLITS = [PSK, OTHERS[0]!, OTHERS[1]!, OTHERS[2]!, 'split:homedepot:314716732'];
  const fakeTools: { forQuestion(): ResearchTools } = {
    forQuestion: () => ({
      readHomeDepotPage: async () => ({ error: 'not recorded' }),
      searchHomeDepot: async () => ({ error: 'not recorded' }),
      catalogLookup: async () => ({ sourceId: 'catalog:none', entries: [] }),
    }),
  };
  const usage = { inputTokens: 100, outputTokens: 10 };
  const stored = (id: string, question: ReviewItem, costUsd: number, suggestion: Record<string, unknown>): StoredSuggestion => ({
    key: `${id}|${T0}`, questionId: id, seen: reviewSignature(question), askedAt: T0, costUsd,
    suggestion: { questionId: id, seen: reviewSignature(question), provider: 'test', model: 'research', promptVersion: 'x', usage, ...suggestion } as StoredSuggestion['suggestion'],
  });
  const ranOut = (id: string, question: ReviewItem): StoredSuggestion =>
    stored(id, question, 0.01, { status: 'not_suggested', reason: 'The research reached its limit of 8 tool calls before an answer.', notSuggested: { reason: 'limit', message: 'x' } });
  const couldNotTell = (id: string, question: ReviewItem, costUsd: number): StoredSuggestion => stored(id, question, costUsd, { status: 'cannot_tell', reason: 'No.', quotes: [] });

  it('three researches in a row that ran past a limit end the queue, with a sentence, instead of asking on at the same cost', async () => {
    // A model that only ever pauses: each question hits the 12-request limit, which comes back as not_suggested with no provider error.
    const pause = () => json(200, { id: 'msg', type: 'message', role: 'assistant', model: 'm', stop_reason: 'pause_turn', stop_details: null, content: [], usage: { input_tokens: 1000, output_tokens: 10 } });
    const t = await setup({ researchTools: fakeTools, ids: SPLITS, respond: pause });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    // Three questions of twelve requests each, and no fourth.
    expect(t.calls).toHaveLength(36);
    const result = (await t.state()).data.askAllResult!;
    expect(result.problem).toMatch(/limit/);
    expect(result.stopped).toBe(false);
    expect(askAllSentence(result)).toMatch(/^Asking stopped after \d of 5: .*limit/);
  });

  it('a result that says something in between resets the count: two limits, an answer, two limits is not three in a row', async () => {
    let n = 0;
    let t!: Awaited<ReturnType<typeof setup>>;
    const askOne: AskOne = async (id) => {
      const question = (await t.store.getReview(id))!;
      n += 1;
      return n === 3 ? couldNotTell(id, question, 0.01) : ranOut(id, question);
    };
    t = await setup({ askOne, ids: SPLITS });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    expect(n).toBe(5);
    expect((await t.state()).data.askAllResult!.problem).toBeNull();
  });

  it('a question the model declined is not a limit, and does not end the queue', async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    const askOne: AskOne = async (id) =>
      stored(id, (await t.store.getReview(id))!, 0.01, { status: 'not_suggested', reason: 'The model declined.', notSuggested: { reason: 'refusal', message: 'x' } });
    t = await setup({ askOne, ids: SPLITS });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    expect((await t.state()).data.askAllResult!.problem).toBeNull();
  });

  it('stops when what it has cost passes twice the estimate its button showed, says so, and keeps what was suggested', async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    const ids: string[] = [];
    let each = 0;
    const askOne: AskOne = async (id) => {
      ids.push(id);
      return couldNotTell(id, (await t.store.getReview(id))!, each);
    };
    t = await setup({ askOne, ids: SPLITS });
    const shown = Number(askAllCostLabel(SPLITS.map(() => 'split' as const), 'claude-haiku-5-5')!.replace('about $', ''));
    // Each question costs 0.9 of the whole estimate: the third pushes the total past twice what the button said.
    each = shown * 0.9;
    await t.send({ type: 'askAiAll' });
    await t.idle();
    expect(ids).toHaveLength(3);
    const result = (await t.state()).data.askAllResult!;
    expect(result).toMatchObject({ overspent: true, problem: null, stopped: false });
    expect(askAllSentence(result)).toBe(`Stopped: asking cost more than expected ($${result.costUsd.toFixed(2)}). Nothing was applied.`);
    expect(await t.suggestions.list()).toHaveLength(3);
    for (const id of ids) expect((await t.store.getReview(id))!.answer).toBeNull();
  });

  it('does not stop at exactly twice the estimate: only passing it does', async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    const four = SPLITS.slice(0, 4);
    const shown = Number(askAllCostLabel(four.map(() => 'split' as const), 'claude-haiku-5-5')!.replace('about $', ''));
    // Four questions at half the estimate each: exactly twice in all, after the last.
    const askOne: AskOne = async (id) => couldNotTell(id, (await t.store.getReview(id))!, shown / 2);
    t = await setup({ askOne, ids: four });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    expect(await t.suggestions.list()).toHaveLength(4);
    expect((await t.state()).data.askAllResult).toMatchObject({ asked: 4, overspent: false });
  });
});

describe('askAiAll: the question is asked through the function it is given', () => {
  it('calls AskOne for each question with a signal, and saves what it returns as a suggestion, never an answer', async () => {
    const seen: { id: string; signal: AbortSignal }[] = [];
    let t!: Awaited<ReturnType<typeof setup>>;
    const askOne: AskOne = async (id, signal) => {
      seen.push({ id, signal });
      const question = (await t.store.getReview(id))!;
      const suggestion = { questionId: id, seen: reviewSignature(question), provider: 'test', model: 'research', promptVersion: 'x', status: 'cannot_tell' as const, reason: 'Could not tell.', quotes: [], usage: { inputTokens: 5000, outputTokens: 400 } };
      return { key: `${id}|${T0}`, questionId: id, seen: suggestion.seen, askedAt: T0, suggestion, costUsd: 0.05 } satisfies StoredSuggestion;
    };
    t = await setup({ askOne, ids: [PSK, OTHERS[0]!] });
    await t.send({ type: 'askAiAll' });
    await t.idle();
    expect(seen.map((s) => s.id)).toEqual([PSK, OTHERS[0]]);
    expect(seen.every((s) => s.signal instanceof AbortSignal)).toBe(true);
    expect(t.calls).toHaveLength(0);
    expect((await t.suggestions.list()).map((r) => r.questionId)).toEqual([PSK, OTHERS[0]]);
    expect((await t.state()).data.askAllResult).toMatchObject({ asked: 2, costUsd: 0.1 });
    for (const id of [PSK, OTHERS[0]!]) expect((await t.store.getReview(id))!.answer).toBeNull();
  });

  it('gives AskOne a signal that Stop aborts, and keeps nothing from a call that was aborted', async () => {
    let signal!: AbortSignal;
    const askOne: AskOne = (id, s) => {
      signal = s;
      return new Promise((_, reject) => s.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    };
    const t = await setup({ askOne, ids: [PSK, OTHERS[0]!] });
    await t.send({ type: 'askAiAll' });
    for (let i = 0; i < 100 && !signal; i++) await new Promise((r) => setTimeout(r, 5));
    await t.send({ type: 'stopAskAll' });
    await t.idle();
    expect(signal.aborted).toBe(true);
    expect(await t.suggestions.list()).toEqual([]);
    expect((await t.state()).data.askAllResult).toMatchObject({ stopped: true, asked: 0 });
  });

  it('the single Ask AI goes through it too', async () => {
    const ids: string[] = [];
    const askOne: AskOne = async (id) => {
      ids.push(id);
      throw new Error('research failed');
    };
    const t = await setup({ askOne, ids: [PSK] });
    const reply = await t.send({ type: 'askAi', questionId: PSK });
    expect(ids).toEqual([PSK]);
    expect(reply).toMatchObject({ ok: false });
    expect(await t.suggestions.list()).toEqual([]);
  });
});

describe('Ask AI after each scan: the setting', () => {
  it('is off until the owner turns it on, and the state says which', async () => {
    const t = await setup();
    expect((await t.state()).data.askAfterScan).toBe(false);
    expect(await t.send({ type: 'saveAskAfterScan', on: true })).toEqual({ ok: true, data: null });
    expect((await t.state()).data.askAfterScan).toBe(true);
    expect(t.prefs.askAfterScan).toBe(true);
    expect(await t.send({ type: 'saveAskAfterScan', on: 'yes' as unknown as boolean })).toMatchObject({ ok: false });
    expect(t.prefs.askAfterScan).toBe(true);
  });
});

describe('research: a split question is researched, any other is asked as before', () => {
  const fakeTools: { forQuestion(): ResearchTools } = {
    forQuestion: () => ({
      readHomeDepotPage: async () => ({ error: 'not recorded' }),
      searchHomeDepot: async () => ({ error: 'not recorded' }),
      catalogLookup: async () => ({ sourceId: 'catalog:none', entries: [] }),
    }),
  };
  const submit = (input: Record<string, unknown>) =>
    json(200, { id: 'msg', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_details: null, content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_answer', input }], usage: { input_tokens: 4000, output_tokens: 300 } });
  const bodyOf = (c: Call) => JSON.parse(JSON.stringify(c)) as Call;

  it('sends the question to the model with the research tools, keeps the result as a suggestion with the trace\'s sources and no page text, and never the key', async () => {
    const t = await setup({
      researchTools: fakeTools, ids: [PSK],
      respond: () => submit({ quotes: [{ quote: PSK_INCLUDES, sourceId: 'bundle' }], parts: [], reason: 'The page lists the parts.', decision: 'choose', choiceIndex: 0 }),
    });
    const reply = await t.send<StoredSuggestion>({ type: 'askAi', questionId: PSK });
    expect(reply.ok && reply.data.suggestion).toMatchObject({ status: 'verified', answer: { decision: 'choose', kind: 'split', choiceIndex: 0 }, research: { requests: 1, toolCalls: 0 } });
    expect(t.calls).toHaveLength(1);
    expect(bodyOf(t.calls[0]!).user).toContain(PSK_INCLUDES);
    expect(t.calls[0]!.tools!.map((x) => x.name)).toEqual(expect.arrayContaining(['read_homedepot_page', 'search_homedepot', 'catalog_lookup', 'submit_answer', 'web_search']));
    // The brand's own sites only.
    expect(JSON.stringify(t.calls[0]!.tools)).toContain('ryobitools.com');
    const [record] = await t.suggestions.list();
    const ledger = (record!.suggestion as unknown as { research: { ledger: { id: string; url: string | null; lines: unknown[] }[] } }).research.ledger;
    expect(ledger.map((e) => e.id)).toContain('bundle');
    expect(ledger.every((e) => e.lines.length === 0)).toBe(true);
    expect(record!.costUsd).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toContain(ANTHROPIC);
    expect((await t.store.getReview(PSK))!.answer).toBeNull();
  });

  it('a research suggestion costs its cache writes and reads and its web searches too, at the model\'s rates; a match question costs its tokens', async () => {
    const usage = { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 5000, cache_read_input_tokens: 9000, server_tool_use: { web_search_requests: 2 } };
    const answer = { quotes: [], parts: [], reason: 'x', decision: 'cannot_tell', choiceIndex: null };
    const t = await setup({
      researchTools: fakeTools, ids: [PSK, 'match:RYOBI:P553'], ebaySettings: { ...DEFAULT_EBAY_SETTINGS, judgeModel: 'claude-opus-5-5' },
      respond: (c) => (c.tools ? json(200, { ...message(answer), stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_answer', input: answer }], usage }) : json(200, message(CANNOT, { input_tokens: 1000, output_tokens: 100 }))),
    });
    await t.send({ type: 'askAi', questionId: PSK });
    await t.send({ type: 'askAi', questionId: 'match:RYOBI:P553' });
    const records = await t.suggestions.list();
    const research = records.find((r) => r.questionId === PSK)!;
    const match = records.find((r) => r.questionId === 'match:RYOBI:P553')!;
    // Opus: $4 in and $20 out a million; a cache write 1.25x the input rate, a read at the model's cache-read rate (else 0.1x); $0.01 a web search.
    const rates = PRICE_TABLE['claude-opus-5-5']!;
    const expected = (2000 * 4 + 300 * 20 + 5000 * 4 * 1.25 + 9000 * (rates.cacheRead ?? 4 * 0.1)) / 1e6 + 2 * 0.01;
    expect(research.costUsd).toBeCloseTo(expected, 8);
    expect(research.costUsd!).toBeGreaterThan((2000 * 4 + 300 * 20) / 1e6);
    expect(match.costUsd).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6, 8);
  });

  it('a split question with no reading is asked, since research can answer it; without the tools it is not (nothing to ask with the evidence alone)', async () => {
    const asked = await setup({ researchTools: fakeTools, ids: ['split:homedepot:314716732'], respond: () => submit({ quotes: [], parts: [], reason: 'Not settled.', decision: 'cannot_tell', choiceIndex: null }) });
    expect(await asked.send<{ queued: number }>({ type: 'askAiAll' })).toEqual({ ok: true, data: { queued: 1 } });
    await asked.idle();
    expect(asked.calls).toHaveLength(1);
    expect((await asked.suggestions.list())[0]!.suggestion.status).toBe('cannot_tell');
  });

  it('a match question is asked as in step 11, with no research tools', async () => {
    const t = await setup({ researchTools: fakeTools, ids: ['match:RYOBI:P553'] });
    await t.send({ type: 'askAi', questionId: 'match:RYOBI:P553' });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.model).toBe('claude-haiku-5-5');
    expect(t.calls[0]!.tools).toBeUndefined();
  });

  it('a scan is refused while one question is researched: research reads in the doorway tab', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = await setup({ researchTools: fakeTools, ids: [PSK], respond: async () => (await hold, submit({ quotes: [], parts: [], reason: 'x', decision: 'cannot_tell', choiceIndex: null })) });
    const asking = t.send({ type: 'askAi', questionId: PSK });
    for (let i = 0; i < 100 && t.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await t.send({ type: 'scanNow' })).toEqual({ ok: false, error: 'Asking AI is running. Stop it first, or wait for it to finish.' });
    await t.worker.onTick();
    expect((await t.state()).data.scanRunning).toBe(false);
    release();
    expect(await asking).toMatchObject({ ok: true });
    expect(await t.send({ type: 'scanNow' })).toMatchObject({ ok: true });
    for (let i = 0; i < 100 && (await t.state()).data.scanRunning; i++) await new Promise((r) => setTimeout(r, 10));
  });

  it('Stop ends a research in flight and keeps nothing for it', async () => {
    const t = await setup({ researchTools: fakeTools, ids: [PSK, OTHERS[0]!], respond: () => new Promise<Response>(() => {}) });
    await t.send({ type: 'askAiAll' });
    for (let i = 0; i < 200 && t.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await t.send({ type: 'stopAskAll' });
    await t.idle();
    expect(t.calls).toHaveLength(1);
    expect(await t.suggestions.list()).toEqual([]);
    expect((await t.state()).data.askAllResult).toMatchObject({ stopped: true, asked: 0 });
  });

  it('Stop reaches a page read in flight: the tool is handed the research signal, and it is aborted', async () => {
    let seen: AbortSignal | undefined;
    const reading: { forQuestion(): ResearchTools } = {
      forQuestion: () => ({
        ...fakeTools.forQuestion(),
        readHomeDepotPage: (_input, signal) => new Promise((resolve) => {
          seen = signal;
          signal?.addEventListener('abort', () => resolve({ error: 'stopped' }));
        }),
      }),
    };
    const readPage = () => json(200, { id: 'msg', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_details: null, content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_homedepot_page', input: { itemId: '339206615' } }], usage: { input_tokens: 1000, output_tokens: 50 } });
    const t = await setup({ researchTools: reading, ids: [PSK, OTHERS[0]!], respond: readPage });
    await t.send({ type: 'askAiAll' });
    for (let i = 0; i < 200 && seen === undefined; i++) await new Promise((r) => setTimeout(r, 5));
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    await t.send({ type: 'stopAskAll' });
    await t.idle();
    expect(seen!.aborted).toBe(true);
    expect(t.calls).toHaveLength(1);
    // What the call cost is kept for the count; no suggestion comes of it, and the next question is not asked.
    for (const r of await t.suggestions.list()) expect(r.suggestion.status).toBe('not_suggested');
    expect((await t.state()).data.askAllResult).toMatchObject({ stopped: true, suggested: 0 });
  });
});
