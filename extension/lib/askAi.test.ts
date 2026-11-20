// Ask AI in the worker (step 11, A2): the real Review questions of the validation replay, the real evidence the scan
// stored for them, a fake model endpoint. Nothing here reaches a network or a model.

import { describe, expect, it } from 'vitest';
import { asked, assistWorld } from '../../core/test/assist-world';
import { reviewSignature } from '@core/scan/answers';
import { OverlayStore } from '@core/scan/overlayStore';
import { MemorySuggestionStore, type StoredSuggestion } from '@core/assist/stored';
import type { AssistRaw } from '@core/assist/types';
import type { ReviewItem } from '@core/scan/types';
import { DEFAULT_EBAY_SETTINGS, DEFAULT_SETTINGS, type EbaySettings } from '@core/settings';
import { MemoryCache } from '@core/serpapi/client';
import * as fx from '../../core/test/fixtures';
import type { AppState, PanelReport, Reply, Request } from './messages';
import { createWorker, type Prefs } from './worker';

const KEY = 'TEST';
const ANTHROPIC = 'sk-ant-test-0000-not-a-real-key';
const T0 = Date.UTC(2026, 10, 20, 12);
const PSK = 'split:homedepot:339206615';
const PSK_INCLUDES = 'Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries, (1) PBP003 18V ONE+ 2Ah Lithium Battery, (1) PCG002 18V ONE+ Charger';

const RIGHT: AssistRaw = { evidence: [{ quote: PSK_INCLUDES, source: 'bundle' }], reason: 'The page lists PBP004, PBP003 and PCG002.', decision: 'choose', choiceIndex: 0, asin: null };
const message = (answer: AssistRaw | Record<string, unknown>, usage = { input_tokens: 1200, output_tokens: 100 }) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', stop_details: null, usage,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** prefs.ts in memory: only what the worker reads for these messages. */
function fakePrefs(over: { anthropic?: string | null; ebaySettings?: EbaySettings } = {}): Prefs {
  let anthropic = over.anthropic === undefined ? ANTHROPIC : over.anthropic;
  const ebaySettings = over.ebaySettings ?? { ...DEFAULT_EBAY_SETTINGS };
  return {
    getKey: async () => KEY,
    getSettings: async () => structuredClone(DEFAULT_SETTINGS),
    getLastScheduledRunAt: async () => null,
    getPackaging: async () => ({}),
    getAccount: async () => null,
    setAccount: async () => {},
    setLastScheduledRunAt: async () => {},
    restrictKeyAccess: async () => {},
    getRates: async () => ({}),
    setRates: async () => {},
    setNotified: async () => {},
    getEbayKeys: async () => null,
    getAnthropicKey: async () => anthropic,
    setAnthropicKey: async (k: string) => void (anthropic = k),
    forgetAnthropicKey: async () => void (anthropic = null),
    getEbaySettings: async () => ({ ...ebaySettings }),
    getActiveScan: async () => null,
    setActiveScan: async () => {},
    getShowChip: async () => true,
    getNotified: async () => [],
    getEbayToken: async () => null,
  } as unknown as Prefs;
}

interface Call { url: string; headers: Record<string, string>; body: { model: string; messages: { content: string }[] } }

async function setup(opts: { anthropic?: string | null; ebaySettings?: EbaySettings; respond?: (call: Call) => Response | Promise<Response>; callTimeoutMs?: number; blockSearches?: Promise<void> } = {}) {
  const w = await assistWorld();
  const store = new OverlayStore(w.store);
  const question = asked(w, PSK);
  await store.putReview(question);
  const suggestions = new MemorySuggestionStore();
  const calls: Call[] = [];
  const broadcasts: AppState[] = [];
  let clock = T0;
  const respond = opts.respond ?? (() => json(200, message(RIGHT)));
  const worker = createWorker({
    store,
    cache: { ...new MemoryCache(), get: async () => undefined, set: async () => {}, clear: async () => {} },
    prefs: fakePrefs(opts),
    ledger: () => {},
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/account.json')) return json(200, fx.SERPAPI_ACCOUNT_FREE);
      if (url.startsWith('https://api.anthropic.com/')) {
        const call: Call = { url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
        calls.push(call);
        // The call ends when its signal does, as a real fetch's.
        const aborted = new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        return Promise.race([Promise.resolve(respond(call)), aborted]);
      }
      await opts.blockSearches;
      throw new TypeError('no network in the tests');
    }) as typeof fetch,
    now: () => clock,
    notify: () => {},
    broadcast: (s) => void broadcasts.push(s),
    suggestions,
    callTimeoutMs: opts.callTimeoutMs,
  });
  const send = <T = unknown>(request: Request): Promise<Reply<T>> => worker.onMessage(request) as Promise<Reply<T>>;
  return { worker, store, suggestions, calls, broadcasts, question, send, tick: (ms: number) => void (clock += ms) };
}

describe('askAi', () => {
  it('drafts a suggestion for the question: the Settings model and the key, the evidence the scan stored, and no answer', async () => {
    const t = await setup({ ebaySettings: { ...DEFAULT_EBAY_SETTINGS, judgeModel: 'claude-opus-5-5' } });
    const reply = await t.send<StoredSuggestion>({ type: 'askAi', questionId: PSK });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data).toMatchObject({ questionId: PSK, seen: reviewSignature(t.question), askedAt: T0, suggestion: { status: 'verified', model: 'claude-opus-5-5' } });
    // One call, to Anthropic, with the Settings model; the owner's key only in its header.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(t.calls[0]!.headers['x-api-key']).toBe(ANTHROPIC);
    expect(t.calls[0]!.body.model).toBe('claude-opus-5-5');
    expect(t.calls[0]!.body.messages[0]!.content).toContain(PSK_INCLUDES);
    expect(JSON.stringify(reply)).not.toContain(ANTHROPIC);
    // Never an answer: the question is as it was asked.
    expect(await t.store.getReview(PSK)).toEqual(t.question);
    expect((await t.store.getReview(PSK))!.answer).toBeNull();
  });

  it('counts tokens and cost with the suggestion, at the model\'s published rates', async () => {
    const t = await setup({ ebaySettings: { ...DEFAULT_EBAY_SETTINGS, judgeModel: 'claude-opus-5-5' } });
    await t.send({ type: 'askAi', questionId: PSK });
    const [record] = await t.suggestions.list();
    expect(record!.suggestion.usage).toEqual({ inputTokens: 1200, outputTokens: 100 });
    // 1,200 in at $4 and 100 out at $20 a million.
    expect(record!.costUsd).toBeCloseTo(0.0068, 6);
  });

  it('offers the suggestion in the report for the open question, and nothing about a question that has none', async () => {
    const t = await setup();
    const before = await t.send<PanelReport>({ type: 'getReport' });
    expect(before.ok && before.data.aiSuggestions).toEqual([]);
    await t.send({ type: 'askAi', questionId: PSK });
    const after = await t.send<PanelReport>({ type: 'getReport' });
    expect(after.ok && after.data.aiSuggestions?.map((s) => s.questionId)).toEqual([PSK]);
    // The panel hears of it.
    expect(t.broadcasts.length).toBeGreaterThan(0);
  });

  it('is refused with no Anthropic key, and calls nothing', async () => {
    const t = await setup({ anthropic: null });
    expect(await t.send({ type: 'askAi', questionId: PSK })).toEqual({ ok: false, error: 'Add your Anthropic key in Settings.' });
    expect(t.calls).toHaveLength(0);
    expect(await t.suggestions.list()).toEqual([]);
  });

  it('is refused while a scan runs, and calls nothing', async () => {
    let release!: () => void;
    const blockSearches = new Promise<void>((r) => (release = r));
    const t = await setup({ blockSearches });
    expect(await t.send({ type: 'scanNow' })).toMatchObject({ ok: true });
    expect((await t.send<AppState>({ type: 'getState' })).ok && true).toBe(true);
    const reply = await t.send({ type: 'askAi', questionId: PSK });
    release();
    expect(reply).toEqual({ ok: false, error: 'A scan is running. Ask again when it has finished.' });
    expect(t.calls).toHaveLength(0);
    // Let the scan end before the test does.
    for (let i = 0; i < 100; i++) {
      const s = await t.send<AppState>({ type: 'getState' });
      if (s.ok && !s.data.scanRunning) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  it('refuses a question that is not there, one already answered, and an id that is not a string', async () => {
    const t = await setup();
    expect(await t.send({ type: 'askAi', questionId: 'split:homedepot:nope' })).toEqual({ ok: false, error: 'That question was not found.' });
    expect(await t.send({ type: 'askAi', questionId: 42 as unknown as string })).toEqual({ ok: false, error: 'That question was not found.' });
    await t.store.putReview({ ...t.question, answer: 'none', answeredAt: T0 });
    expect(await t.send({ type: 'askAi', questionId: PSK })).toEqual({ ok: false, error: 'That question was already answered.' });
    expect(t.calls).toHaveLength(0);
  });

  it('refuses a second ask about the same question while the first is out', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = await setup({ respond: async () => (await hold, json(200, message(RIGHT))) });
    const first = t.send({ type: 'askAi', questionId: PSK });
    await new Promise((r) => setTimeout(r, 20));
    expect(await t.send({ type: 'askAi', questionId: PSK })).toEqual({ ok: false, error: 'Already asking about that question.' });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(t.calls).toHaveLength(1);
  });

  it('gives up after the call timeout: not suggested, nothing shown, and the owner can ask again', async () => {
    const t = await setup({ callTimeoutMs: 30, respond: () => new Promise<Response>(() => {}) });
    const reply = await t.send<StoredSuggestion>({ type: 'askAi', questionId: PSK });
    expect(reply.ok && reply.data.suggestion).toMatchObject({ status: 'not_suggested' });
    const report = await t.send<PanelReport>({ type: 'getReport' });
    expect(report.ok && report.data.aiSuggestions).toEqual([]);
    expect(await t.send({ type: 'askAi', questionId: PSK })).toMatchObject({ ok: true });
    expect(t.calls).toHaveLength(2);
  });

  it('says the call failed when the model answers with an error, and keeps nothing to show', async () => {
    const t = await setup({ respond: () => json(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${ANTHROPIC}` } }) });
    const reply = await t.send<StoredSuggestion>({ type: 'askAi', questionId: PSK });
    expect(reply.ok && reply.data.suggestion.status).toBe('not_suggested');
    expect(JSON.stringify(reply)).not.toContain(ANTHROPIC);
    expect((await t.send<PanelReport>({ type: 'getReport' })).ok).toBe(true);
    expect(await t.suggestions.list()).toEqual([]);
  });

  it('keeps an unverified suggestion and a cannot-tell one, each with what it cost', async () => {
    const unverified: AssistRaw = { ...RIGHT, evidence: [{ quote: 'a line the page does not have', source: 'bundle' }] };
    const t = await setup({ respond: () => json(200, message(unverified)) });
    const reply = await t.send<StoredSuggestion>({ type: 'askAi', questionId: PSK });
    expect(reply.ok && reply.data.suggestion.status).toBe('unverified');
    const cannot = await setup({ respond: () => json(200, message({ ...RIGHT, decision: 'cannot_tell', choiceIndex: null, evidence: [], reason: 'The page does not list the parts.' })) });
    const second = await cannot.send<StoredSuggestion>({ type: 'askAi', questionId: PSK });
    expect(second.ok && second.data.suggestion).toMatchObject({ status: 'cannot_tell', reason: 'The page does not list the parts.' });
    expect((await cannot.suggestions.list())[0]!.costUsd).not.toBeNull();
  });

  it('discards a suggestion for a question that changed while the model worked', async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup({
      respond: async () => {
        // A scan rewrote the question's readings while the call was out.
        await t.store.putReview({ ...t.question, choices: [['PBP004', 'PCG002']] });
        return json(200, message(RIGHT));
      },
    });
    const reply = await t.send({ type: 'askAi', questionId: PSK });
    expect(reply).toEqual({ ok: false, error: 'That question changed while the AI worked. Ask again.' });
    const report = await t.send<PanelReport>({ type: 'getReport' });
    expect(report.ok && report.data.aiSuggestions).toEqual([]);
    // The readings come back as they were: the discarded suggestion must not come back with them.
    await t.store.putReview(t.question);
    const back = await t.send<PanelReport>({ type: 'getReport' });
    expect(back.ok && back.data.aiSuggestions).toEqual([]);
  });

  it('closes a suggestion for a question the owner answered while the AI worked: it cannot come back when the question is reopened, and its cost is kept', async () => {
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup({
      respond: async () => {
        await t.store.putReview({ ...t.question, answer: 'none', answeredAt: T0 });
        return json(200, message(RIGHT));
      },
    });
    expect(await t.send({ type: 'askAi', questionId: PSK })).toEqual({ ok: false, error: 'That question changed while the AI worked. Ask again.' });
    // Reopened, with the same readings: nothing is preselected from the closed suggestion.
    await t.store.putReview(t.question);
    const report = await t.send<PanelReport>({ type: 'getReport' });
    expect(report.ok && report.data.aiSuggestions).toEqual([]);
    const [record] = await t.suggestions.list();
    expect(record!.outcome).toEqual({ answeredAt: T0, answer: 'none', agreed: null });
    expect(record!.costUsd).not.toBeNull();
  });

  it('stops showing a stored suggestion once a scan changes the question', async () => {
    const t = await setup();
    await t.send({ type: 'askAi', questionId: PSK });
    expect((await t.send<PanelReport>({ type: 'getReport' })).ok && true).toBe(true);
    await t.store.putReview({ ...t.question, choices: [['PBP004', 'PCG002']] });
    const report = await t.send<PanelReport>({ type: 'getReport' });
    expect(report.ok && report.data.aiSuggestions).toEqual([]);
  });
});

describe('answering with a suggestion on screen', () => {
  const ask = async (t: Awaited<ReturnType<typeof setup>>) => {
    await t.send({ type: 'askAi', questionId: PSK });
    return (await t.suggestions.list())[0]!;
  };
  const seen = (q: ReviewItem) => reviewSignature(q);

  it('Approve: the answer is saved through the answer path, and it is recorded as the one suggested', async () => {
    const t = await setup();
    await ask(t);
    const reply = await t.send({ type: 'answerReview', id: PSK, answer: { choice: 0, seen: seen(t.question) }, aiSuggestion: true });
    expect(reply).toEqual({ ok: true, data: null });
    expect((await t.store.getReview(PSK))!.answer).toBe('PBP004,PBP003,PCG002');
    const [record] = await t.suggestions.list();
    expect(record!.outcome).toEqual({ answeredAt: T0, answer: 'PBP004,PBP003,PCG002', agreed: true });
    // An answered question is no longer offered a suggestion.
    const report = await t.send<PanelReport>({ type: 'getReport' });
    expect(report.ok && report.data.aiSuggestions).toEqual([]);
  });

  it('changing the selection before saving records a disagreement', async () => {
    const t = await setup();
    await ask(t);
    await t.send({ type: 'answerReview', id: PSK, answer: { none: true, seen: seen(t.question) }, aiSuggestion: true });
    expect((await t.suggestions.list())[0]!.outcome).toEqual({ answeredAt: T0, answer: 'none', agreed: false });
  });

  it('an answer given with no suggestion on screen records nothing, even when one was made', async () => {
    const t = await setup();
    await ask(t);
    await t.send({ type: 'answerReview', id: PSK, answer: { choice: 0, seen: seen(t.question) } });
    expect((await t.suggestions.list())[0]!.outcome).toBeUndefined();
  });

  it('a refused answer records nothing', async () => {
    const t = await setup();
    await ask(t);
    const reply = await t.send({ type: 'answerReview', id: PSK, answer: { choice: 0, seen: '[["OLD"]]' }, aiSuggestion: true });
    expect(reply).toMatchObject({ ok: false });
    expect((await t.suggestions.list())[0]!.outcome).toBeUndefined();
  });

  it('cannot tell: the owner answers as before and there is nothing to agree with', async () => {
    const t = await setup({ respond: () => json(200, message({ ...RIGHT, decision: 'cannot_tell', choiceIndex: null, evidence: [] })) });
    await ask(t);
    await t.send({ type: 'answerReview', id: PSK, answer: { choice: 0, seen: seen(t.question) }, aiSuggestion: true });
    expect((await t.suggestions.list())[0]!.outcome).toEqual({ answeredAt: T0, answer: 'PBP004,PBP003,PCG002', agreed: null });
  });
});

describe('the audit file', () => {
  it('records each ask as { questionId, source: "ai", suggestion, agreed }, with its cost and tokens, and never the key', async () => {
    const t = await setup({ ebaySettings: { ...DEFAULT_EBAY_SETTINGS, judgeModel: 'claude-opus-5-5' } });
    await t.send({ type: 'askAi', questionId: PSK });
    const open = JSON.parse(((await t.send<string>({ type: 'exportAudit' })) as { data: string }).data);
    expect(open.aiSuggestions).toEqual([
      expect.objectContaining({ questionId: PSK, source: 'ai', agreed: null, answeredAt: null, model: 'claude-opus-5-5', tokens: { inputTokens: 1200, outputTokens: 100 }, suggestion: expect.objectContaining({ status: 'verified' }) }),
    ]);
    await t.send({ type: 'answerReview', id: PSK, answer: { choice: 0, seen: reviewSignature(t.question) }, aiSuggestion: true });
    const done = JSON.parse(((await t.send<string>({ type: 'exportAudit' })) as { data: string }).data);
    expect(done.aiSuggestions[0]).toMatchObject({ questionId: PSK, source: 'ai', agreed: true, answeredAt: T0, answer: 'PBP004,PBP003,PCG002' });
    expect(JSON.stringify(done)).not.toContain(ANTHROPIC);
  });
});
