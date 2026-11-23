import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { StoredSuggestion } from '../../core/src/assist/stored';
import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import { read, REVIEW, SUGGESTIONS, FIXTURE } from '../../core/test/brief-world';
import { loadScanFolder } from '../../scripts/data-folder';
import { aiPipelinePatch } from '../app';
import type { AiPassResult } from '../aiPass';
import { addBriefs, BACKFILL_LIMIT, briefPass, type BriefCtx, RETRY_AFTER_MS } from '../brief';
import { defaultAiSettings, defaultSettings, Store, type StoreData } from '../store';
import { aiSpentThisMonth, reviewResponse } from '../views';

// Step 16, the agent's side of the brief, on the owner's real data (fixtures/e2e-2026-11-23/after-scan3 for the questions and
// their pages, store/suggestions.json for what the AI answered): the rules brief of every question, the brief pass with a fake
// fetch (nothing here reaches a model), its cost in the month's AI spend, and its limits.

const NOW = 1_795_500_000_000; // the day after the AI's answers, Nov 2026
const SPLITS = ['split:homedepot:321809549', 'split:homedepot:321811428', 'split:homedepot:326894185', 'split:homedepot:328690510', 'split:homedepot:320243671'];
const open: Store[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const suggestionsOf = (ids: string[]): StoredSuggestion[] => SUGGESTIONS.filter((s) => ids.includes(s.questionId));

function dataOf(suggestions: StoredSuggestion[]): Pick<StoreData, 'review' | 'suggestions' | 'deals' | 'settings'> {
  return {
    review: { at: REVIEW.at, questions: REVIEW.questions, ebayQuestions: [], evidence: REVIEW.evidence },
    suggestions,
    deals: read<StoreData['deals']>('after-scan3/store/deals.json'),
    settings: defaultSettings(),
  } as unknown as Pick<StoreData, 'review' | 'suggestions' | 'deals' | 'settings'>;
}

describe('GET /api/review: brief, from the rules', () => {
  const qs = reviewResponse(dataOf(SUGGESTIONS)).questions;

  it('every one of the owner’s 10 real questions has a rules brief, snapshot', () => {
    expect(qs).toHaveLength(10);
    expect(Object.fromEntries(qs.map((q) => [q.id, q.brief]))).toMatchSnapshot();
    expect(qs.every((q) => q.brief?.writtenBy === 'rules' && q.brief.reasons.length >= 1 && q.brief.reasons.length <= 3)).toBe(true);
  });

  it('the state and the proposed answer follow the suggestion the code holds, and say nothing the AI argued', () => {
    const by = (id: string) => qs.find((q) => q.id === id)!.brief!;
    expect(by('split:homedepot:328690510')).toMatchObject({ state: 'not_verified', suggestion: 'PCL500B + PCL525B', ask: 'What is inside this bundle?' });
    expect(by('split:homedepot:335724135')).toMatchObject({ state: 'none', suggestion: null });
    expect(by('match:DEWALT:DCF860B')).toMatchObject({ state: 'none', suggestion: null, ask: 'Which Amazon listing is this part?' });
    // The verifier's plain sentences are the reasons of a suggestion that was not verified.
    expect(by('split:homedepot:326894185').reasons.map((r) => r.text)).toContain('Nothing the AI read shows DCS334B is a real model.');
    // A question's link is the Home Depot page or the listing, never invented.
    expect(by('split:homedepot:328690510').check!.url).toBe(qs.find((q) => q.id === 'split:homedepot:328690510')!.sources[0]!.url);
  });

  it('a stored model brief is shown for the live suggestion; one for a suggestion that has gone stale is not', () => {
    const [first] = suggestionsOf([SPLITS[3]!]);
    const brief = { ask: 'What is inside this bundle?', suggestion: 'PCL500B + PCL525B', state: 'not_verified' as const, reasons: [{ text: 'The page names a circular saw and a jig saw.' }], check: null, writtenBy: 'ai' as const };
    const live = reviewResponse(dataOf([{ ...first!, brief }])).questions.find((q) => q.id === SPLITS[3])!;
    expect(live.brief).toEqual(brief);
    const stale = reviewResponse(dataOf([{ ...first!, seen: 'an older question', brief }])).questions.find((q) => q.id === SPLITS[3])!;
    expect(stale.brief).toMatchObject({ writtenBy: 'rules', state: 'none', suggestion: null });
  });
});

describe('the cost of a brief', () => {
  it('counts in the month it was written, once, with the ask', () => {
    const [s] = suggestionsOf([SPLITS[0]!]);
    const runs = [] as never[];
    const base = aiSpentThisMonth({ suggestions: [s!], runs }, NOW);
    const withBrief = { ...s!, briefMeta: { at: NOW, provider: 'claude', model: 'claude-haiku-5-5', promptVersion: 'v', called: true, costUsd: 0.0002 } };
    expect(aiSpentThisMonth({ suggestions: [withBrief], runs }, NOW)).toBeCloseTo(base + 0.0002, 8);
    // A brief written in an earlier month is that month's.
    expect(aiSpentThisMonth({ suggestions: [{ ...withBrief, briefMeta: { ...withBrief.briefMeta, at: Date.UTC(2026, 9, 30) } }], runs }, NOW)).toBeCloseTo(base, 8);
  });
});

// ---------------------------------------------------------------- the pass

interface World {
  ctx: BriefCtx;
  store: Store;
  scan: MemoryScanStore;
  calls: { url: string; key: string; body: Record<string, unknown> }[];
  clock: { now: number };
}

const REPLY = JSON.stringify({ suggestion: null, reasons: [{ text: 'The page lists what the bundle holds.', quoteIndex: 1 }], check: { text: 'Read the Includes list on the Home Depot page.', quoteIndex: null } });

async function world(opts: { reply?: (n: number) => Response | Error; key?: string | null; suggestions?: StoredSuggestion[]; cap?: number } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'sf-brief-'));
  const store = Store.open(dir);
  open.push(store);
  if (opts.key !== null) store.update('keys', (k) => ({ ...k, anthropic: opts.key ?? 'sk-ant-test-key' }));
  store.update('settings', (s) => ({ ...s, ai: { ...s.ai, monthlyCapUsd: opts.cap ?? 25 } }));
  store.update('suggestions', () => opts.suggestions ?? suggestionsOf(SPLITS));
  const scan = await loadScanFolder(join(FIXTURE, 'after-scan3'));
  const calls: World['calls'] = [];
  const clock = { now: NOW };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, key: String((init?.headers as Record<string, string>)['x-api-key']), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const r = opts.reply?.(calls.length) ?? new Response(JSON.stringify({ content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn', usage: { input_tokens: 1200, output_tokens: 200 } }));
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  const ctx: BriefCtx = { store, scanStore: scan, keyFor: (ref) => (ref === 'anthropic' ? store.get('keys').anthropic : undefined), fetchFn, now: () => clock.now, signal: new AbortController().signal };
  return { ctx, store, scan, calls, clock };
}

const reply = (text: string) => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 } }));

describe('the brief pass', () => {
  it('writes a brief for each live suggestion, each a call to Anthropic with the key in its header only', async () => {
    const w = await world();
    const r = await briefPass(w.ctx);
    expect(r).toMatchObject({ written: 5, asked: 5, problem: null });
    expect(r.costUsd).toBeCloseTo(5 * 0.00022, 8);
    expect(w.calls).toHaveLength(5);
    expect(new Set(w.calls.map((c) => c.url))).toEqual(new Set(['https://api.anthropic.com/v1/messages']));
    expect(w.calls.every((c) => c.key === 'sk-ant-test-key')).toBe(true);
    expect(w.calls.every((c) => c.body.model === 'claude-haiku-5-5')).toBe(true);
    expect(JSON.stringify(w.calls.map((c) => c.body))).not.toContain('sk-ant-test-key');
    // The prompt holds the question and the found quotes, not the research agent's own argument or its answer's quotes.
    const prompt = JSON.stringify(w.calls[0]!.body.messages);
    expect(prompt).toContain('<quote n=\\"1\\"');
    expect(prompt).not.toContain('item 324616618');

    const saved = w.store.get('suggestions');
    expect(saved.filter((s) => s.brief?.writtenBy === 'ai')).toHaveLength(5);
    expect(saved[0]!.briefMeta).toMatchObject({ called: true, model: 'claude-haiku-5-5', costUsd: expect.closeTo(0.00022, 8) });
    // What the suggestion says is untouched.
    expect(saved.map(({ brief: _b, briefMeta: _m, ...rest }) => rest)).toEqual(suggestionsOf(SPLITS));
    // GET /api/review shows it, and the month's AI spend counts it.
    const shown = reviewResponse({ ...dataOf(saved), settings: w.store.get('settings') }).questions.find((q) => q.id === SPLITS[3])!;
    expect(shown.brief).toMatchObject({ writtenBy: 'ai', state: 'not_verified', suggestion: 'PCL500B + PCL525B' });
    expect(shown.brief!.reasons[0]).toMatchObject({ text: 'The page lists what the bundle holds.', sourceLabel: 'Home Depot page' });
    expect(aiSpentThisMonth({ suggestions: saved, runs: [] }, NOW)).toBeCloseTo(aiSpentThisMonth({ suggestions: suggestionsOf(SPLITS), runs: [] }, NOW) + 5 * 0.00022, 8);
  });

  it('writes each brief once', async () => {
    const w = await world();
    await briefPass(w.ctx);
    const again = await briefPass(w.ctx);
    expect(again).toMatchObject({ written: 0, asked: 0 });
    expect(w.calls).toHaveLength(5);
  });

  it('the batch at start makes at most BACKFILL_LIMIT calls; Ask AI on one question makes one', async () => {
    expect(BACKFILL_LIMIT).toBe(20);
    const w = await world();
    await briefPass(w.ctx, { limit: 2 });
    expect(w.calls).toHaveLength(2);
    const w2 = await world();
    await briefPass(w2.ctx, { only: [SPLITS[3]!] });
    expect(w2.calls).toHaveLength(1);
  });

  it('skips a question the owner has answered, and one whose suggestion was made for another version of it', async () => {
    const w = await world({ suggestions: suggestionsOf(SPLITS).map((s, i) => (i === 0 ? { ...s, seen: 'older' } : s)) });
    const item = (await w.scan.getReview(SPLITS[1]!))!;
    await w.scan.putReview({ ...item, answer: 'PCL1600K2,PBP006', answeredAt: 1 });
    await briefPass(w.ctx);
    expect(w.calls).toHaveLength(3);
  });

  it('with no Anthropic key it asks nothing and says nothing: the rules brief stays', async () => {
    const w = await world({ key: null });
    expect(await briefPass(w.ctx)).toEqual({ written: 0, asked: 0, costUsd: 0, problem: null });
    expect(w.calls).toHaveLength(0);
  });

  it('with the monthly cap reached it asks nothing and says why; a cap of 0 says nothing (the AI is off)', async () => {
    const w = await world({ cap: 0.12 });
    const spent = aiSpentThisMonth({ suggestions: w.store.get('suggestions'), runs: [] }, NOW);
    expect(spent).toBeGreaterThan(0.2);
    const r = await briefPass(w.ctx);
    expect(r.asked).toBe(0);
    expect(r.problem).toBe("This month's AI limit of $0.12 is reached; the plain summaries use the rules until next month or a higher limit.");
    expect(w.calls).toHaveLength(0);
    const off = await world({ cap: 0 });
    expect(await briefPass(off.ctx)).toMatchObject({ asked: 0, problem: null });
  });

  it('stops before the call that would pass the cap', async () => {
    const w = await world();
    const spent = aiSpentThisMonth({ suggestions: w.store.get('suggestions'), runs: [] }, NOW);
    w.store.update('settings', (s) => ({ ...s, ai: { ...s.ai, monthlyCapUsd: spent + 0.0005 } }));
    // One brief is estimated at $0.0004 and costs $0.00022: after the first, a second would pass the cap.
    const r = await briefPass(w.ctx);
    expect(r.asked).toBe(1);
    expect(r.problem).toMatch(/is reached/);
  });

  it('a model with no known price is not asked: the cap could not hold', async () => {
    const w = await world();
    w.store.update('settings', (s) => ({ ...s, ai: { ...s.ai, brief: { ...s.ai.brief!, model: 'house-model' } } }));
    const r = await briefPass(w.ctx);
    expect(r.asked).toBe(0);
    expect(r.problem).toBe('No price is known for house-model, so the monthly AI limit could not hold; the plain summaries use the rules.');
  });

  it('a model brief that fails the checks leaves the rules brief, is paid for, and is not asked again for a day', async () => {
    const bad = JSON.stringify({ suggestion: null, reasons: [{ text: 'The pair costs $30.', quoteIndex: 1 }], check: null });
    const w = await world({ reply: () => reply(bad), suggestions: suggestionsOf([SPLITS[3]!]) });
    const r = await briefPass(w.ctx);
    expect(r).toMatchObject({ written: 0, asked: 1 });
    expect(r.costUsd).toBeGreaterThan(0);
    const [s] = w.store.get('suggestions');
    expect(s!.brief).toBeUndefined();
    expect(s!.briefMeta).toMatchObject({ called: true, fellBack: 'No sentence of the brief passed the checks.' });
    await briefPass(w.ctx);
    expect(w.calls).toHaveLength(1);
    w.clock.now += RETRY_AFTER_MS;
    await briefPass(w.ctx);
    expect(w.calls).toHaveLength(2);
  });

  it('a call that fails leaves no mark, and three failures in a row end the pass', async () => {
    const w = await world({ reply: () => new Error('offline') });
    const r = await briefPass(w.ctx);
    expect(w.calls).toHaveLength(3);
    expect(r).toMatchObject({ written: 0, asked: 0, costUsd: 0, problem: 'Claude could not be reached. The plain summaries use the rules.' });
    expect(w.store.get('suggestions').every((s) => s.briefMeta === undefined)).toBe(true);
  });

  it('a stop ends the pass', async () => {
    const w = await world();
    const stop = new AbortController();
    stop.abort();
    expect(await briefPass({ ...w.ctx, signal: stop.signal })).toMatchObject({ asked: 0 });
    expect(w.calls).toHaveLength(0);
  });

  it('adds its cost to the AI pass’s and keeps the pass’s own problem', async () => {
    const w = await world();
    const pass: AiPassResult = { asked: 2, suggested: 2, verified: 0, costUsd: 0.1, waitingForChrome: 0, problem: 'The AI stopped.' };
    const out = await addBriefs(pass, w.ctx);
    expect(out.costUsd).toBeCloseTo(0.1 + 5 * 0.00022, 8);
    expect(out).toMatchObject({ asked: 2, problem: 'The AI stopped.' });
  });
});

describe('the brief in Settings', () => {
  it('starts as Claude Haiku, never trusted, and a change of model keeps it untrusted', () => {
    const cur = { ...defaultAiSettings().brief! };
    expect(cur).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKeyRef: 'anthropic', trusted: false });
    const next = aiPipelinePatch(cur, { provider: 'openai-compatible', preset: 'deepseek', model: 'deepseek-flash', trusted: true }, 'brief');
    expect(next).toMatchObject({ provider: 'openai-compatible', model: 'deepseek-flash', apiKeyRef: 'openai', trusted: false });
  });

  it('a store saved before it has the default, and keeps the owner’s choice after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sf-brief-settings-'));
    const s = Store.open(dir);
    s.close();
    const file = join(dir, 'store', 'settings.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as StoreData['settings'];
    delete saved.ai.brief;
    writeFileSync(file, JSON.stringify(saved));
    const again = Store.open(dir);
    open.push(again);
    expect(again.get('settings').ai.brief).toMatchObject({ model: 'claude-haiku-5-5', trusted: false });
    again.update('settings', (cur) => ({ ...cur, ai: { ...cur.ai, brief: { ...cur.ai.brief!, model: 'claude-opus-5-5' } } }));
    again.close();
    const third = Store.open(dir);
    open.push(third);
    expect(third.get('settings').ai.brief!.model).toBe('claude-opus-5-5');
  });
});
