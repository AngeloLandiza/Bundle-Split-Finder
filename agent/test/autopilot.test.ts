import { describe, expect, it } from 'vitest';

import type { StoredSuggestion } from '../../core/src/assist/stored';
import type { Suggestion } from '../../core/src/assist/types';
import { reviewSignature } from '../../core/src/scan/answers';
import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import { runScan } from '../../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ReviewItem, type ScanSettings } from '../../core/src/scan/types';
import { parseAccount, SearchBudget } from '../../core/src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../../core/src/serpapi/client';
import * as fx from '../../core/test/fixtures';
import { replayRecorded } from '../../scripts/replay';
import { autopilotDecision, undoAutopilot } from '../autopilot';
import { aiPipelinePatch } from '../app';
import { applyAutopilot, measuredByDefault, MEASURED_MODELS } from '../autopilot';
import { defaultAiSettings } from '../store';

/** Settings with the measured model (Opus 5.5) on assist, trusted by default. */
const opusAi = () => {
  const ai = defaultAiSettings();
  return { ...ai, assist: { ...ai.assist, model: 'claude-opus-5-5', trusted: measuredByDefault('assist', { ...ai.assist, model: 'claude-opus-5-5' }) } };
};

// The recorded "ryobi 18v combo kit" page, scanned over the replay with one search: PCL1600K2-P553's split
// question offers one reading, PCL1600K2 + P553 (core/test/review-answers.test.ts, Ruling 42).
const P553 = 'split:homedepot:320243741';
const RYOBI: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
const T0 = Date.UTC(2026, 10, 22, 12);

async function scanned() {
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 1 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store, settings: RYOBI, now: () => T0 });
  const item = (await store.getReview(P553))!;
  expect(item).toMatchObject({ choices: [['PCL1600K2', 'P553']], answer: null });
  return { store, item };
}

const quote = { quote: 'PCL1600K2', sourceId: 'bundle', label: 'Home Depot page', url: 'https://www.homedepot.com/p/320243741', names: true };
const meta = (item: ReviewItem) => ({ questionId: item.id, seen: reviewSignature(item), provider: 'claude', model: 'claude-opus-5-5', promptVersion: 'test' });
const verified = (item: ReviewItem): Suggestion => ({
  ...meta(item), status: 'verified', answer: { decision: 'choose', kind: 'split', choiceIndex: 0, parts: ['PCL1600K2', 'P553'] }, quotes: [quote], reason: 'The page lists both.',
});
const stored = (s: Suggestion, item: ReviewItem): StoredSuggestion => ({ key: `${item.id}|1`, questionId: item.id, seen: s.seen, askedAt: 1, suggestion: s, costUsd: 0.01 });

describe('Autopilot decides from code checks only', () => {
  it('applies a verified split suggestion from a trusted model, with the checks it passed', async () => {
    const { item } = await scanned();
    const d = autopilotDecision(item, stored(verified(item), item), opusAi(), false);
    expect(d).toMatchObject({ apply: true, answer: { choice: 0, seen: reviewSignature(item) } });
    if (d.apply) {
      expect(d.applied).toBe('PCL1600K2-P553 contains PCL1600K2, P553');
      expect(d.verifiedBy.join(' ')).toMatch(/word for word/);
      expect(d.verifiedBy.join(' ')).toMatch(/PCL1600K2/);
    }
  });

  it('never applies unverified, cannot tell, none fits or no suggestion', async () => {
    const { item } = await scanned();
    const ai = opusAi();
    const others: Suggestion[] = [
      { ...meta(item), status: 'unverified', reasons: ['quote not found'], claimed: null },
      { ...meta(item), status: 'cannot_tell', reason: 'unclear', quotes: [] },
      { ...meta(item), status: 'none_suggested', reason: 'none fits', quotes: [] },
      { ...meta(item), status: 'not_suggested', reason: 'no call' },
    ];
    for (const s of others) expect(autopilotDecision(item, stored(s, item), ai, false)).toMatchObject({ apply: false });
    expect(autopilotDecision(item, undefined, ai, false)).toMatchObject({ apply: false });
  });

  it('never applies a model that is not marked measured, nor one whose model is not the one the settings trust', async () => {
    const { item } = await scanned();
    const deepseek = { ...opusAi(), assist: { provider: 'openai-compatible' as const, preset: 'deepseek' as const, model: 'deepseek-flash', apiKeyRef: 'openai', trusted: false } };
    const fromDeepseek = stored({ ...verified(item), provider: 'deepseek', model: 'deepseek-flash' }, item);
    expect(autopilotDecision(item, fromDeepseek, deepseek, false)).toMatchObject({ apply: false, reason: expect.stringMatching(/not measured/) });
    const trustedNow = { ...deepseek, assist: { ...deepseek.assist, trusted: true } };
    expect(autopilotDecision(item, fromDeepseek, trustedNow, false)).toMatchObject({ apply: true });
    const otherModel = stored({ ...verified(item), model: 'claude-haiku-5-5' }, item);
    expect(autopilotDecision(item, otherModel, opusAi(), false)).toMatchObject({ apply: false });
  });

  it('leaves a question the owner undid, a stale suggestion and a match question to the owner', async () => {
    const { item } = await scanned();
    const ai = opusAi();
    expect(autopilotDecision(item, stored(verified(item), item), ai, true)).toMatchObject({ apply: false, reason: expect.stringMatching(/undid/) });
    const stale = stored({ ...verified(item), seen: 'other' }, item);
    expect(autopilotDecision(item, { ...stale, seen: 'other' }, ai, false)).toMatchObject({ apply: false });
    const match: ReviewItem = { ...item, id: 'match:RYOBI:P553', kind: 'match', choices: [] };
    expect(autopilotDecision(match, stored(verified(match), match), ai, false)).toMatchObject({ apply: false, reason: expect.stringMatching(/split/) });
  });

  it('applies through the same path as the owner, and Undo reopens the question; an answer the owner changed is not undone', async () => {
    const { store, item } = await scanned();
    const d = autopilotDecision(item, stored(verified(item), item), opusAi(), false);
    if (!d.apply) throw new Error(d.reason);
    const done = await applyAutopilot(store, item, d, T0 + 1);
    expect(done).toEqual({ answer: 'PCL1600K2,P553', answeredAt: T0 + 1 });
    expect((await store.getBundle('homedepot:320243741'))!.split).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'P553'] });

    await undoAutopilot(store, { questionId: item.id, ...done }, T0 + 2);
    const reopened = (await store.getReview(item.id))!;
    expect(reopened.answer).toBeNull();
    expect((await store.getBundle('homedepot:320243741'))!.split?.status).toBe('needs_review');

    const again = await applyAutopilot(store, reopened, { ...d, answer: { choice: 0, seen: reviewSignature(reopened) } }, T0 + 3);
    await store.putReview({ ...(await store.getReview(item.id))!, answeredAt: T0 + 4 });
    await expect(undoAutopilot(store, { questionId: item.id, ...again }, T0 + 5)).rejects.toThrow(/changed since/);
  });
});

describe('which models Autopilot trusts', () => {
  it('trusts by default only the exact models the evals measured, from one list', () => {
    expect(MEASURED_MODELS.assist).toEqual(['claude-opus-5-5']);
    const ai = defaultAiSettings();
    expect(ai.assist).toMatchObject({ model: 'claude-haiku-5-5', trusted: false });
    expect(ai.research.trusted).toBe(false);
    expect(opusAi().assist.trusted).toBe(true);
    expect(measuredByDefault('research', { provider: 'openai-compatible', model: 'claude-opus-5-5' })).toBe(false);
    expect(measuredByDefault('research', { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: 'https://proxy.example' })).toBe(false);
  });

  it('resets trust when the provider, model, address, preset or id changes, unless the same patch sets it', () => {
    const trusted = { ...opusAi().assist };
    expect(aiPipelinePatch(trusted, { model: 'claude-opus-5-5' }, 'assist').trusted).toBe(true);
    expect(aiPipelinePatch(trusted, { model: 'claude-haiku-5-5' }, 'assist').trusted).toBe(false);
    expect(aiPipelinePatch(trusted, { model: 'claude-haiku-5-5', trusted: true }, 'assist').trusted).toBe(true);
    expect(aiPipelinePatch(trusted, { provider: 'openai-compatible' }, 'assist').trusted).toBe(false);
    const deepseek = { provider: 'openai-compatible' as const, preset: 'deepseek' as const, model: 'deepseek-flash', apiKeyRef: 'openai', trusted: true };
    expect(aiPipelinePatch(deepseek, { label: 'DeepSeek' }, 'assist').trusted).toBe(true);
    expect(aiPipelinePatch(deepseek, { baseUrl: 'https://other.example' }, 'assist').trusted).toBe(false);
    expect(aiPipelinePatch(deepseek, { preset: 'generic' }, 'assist').trusted).toBe(false);
    expect(aiPipelinePatch(deepseek, { id: 'other' }, 'assist').trusted).toBe(false);
  });
});
