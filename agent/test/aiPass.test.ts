import { describe, expect, it } from 'vitest';

import { estimatedQuestionCost } from '../../core/src/assist/cost';
import type { StoredSuggestion } from '../../core/src/assist/stored';
import { reviewSignature } from '../../core/src/scan/answers';
import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import { runScan } from '../../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ReviewItem, type ScanSettings } from '../../core/src/scan/types';
import { parseAccount, SearchBudget } from '../../core/src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../../core/src/serpapi/client';
import * as fx from '../../core/test/fixtures';
import { replayRecorded } from '../../scripts/replay';
import { runAiPass, type AiPassDeps, type AskOne } from '../aiPass';

// The recorded RYOBI page leaves two split questions open: PCL500525SB (no reading) and PCL1600K2-P553 (one).
const RYOBI: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
const MODEL = 'claude-haiku-5-5';

async function scanned() {
  const store = new MemoryScanStore();
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 1 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => 1 });
  await runScan({ client, budget, store, settings: RYOBI, now: () => 1 });
  const open = (await store.listReview()).filter((q) => q.answer === null && q.kind === 'split');
  expect(open.length).toBeGreaterThanOrEqual(2);
  return { store, open };
}

const verifiedFor = (item: ReviewItem): StoredSuggestion => ({
  key: `${item.id}|9`, questionId: item.id, seen: reviewSignature(item), askedAt: 9, costUsd: 0.05,
  suggestion: { questionId: item.id, seen: reviewSignature(item), provider: 'claude', model: MODEL, promptVersion: 't', status: 'cannot_tell', reason: 'unclear', quotes: [], usage: { inputTokens: 1, outputTokens: 1 } },
});

function deps(store: MemoryScanStore, over: Partial<AiPassDeps> & { asked?: string[] } = {}): AiPassDeps & { kept: StoredSuggestion[] } {
  const kept: StoredSuggestion[] = [];
  const asked = over.asked ?? [];
  const askOne: AskOne = async (item) => {
    asked.push(item.id);
    return verifiedFor(item);
  };
  return {
    store, kept, suggestions: () => kept, keep: (r) => void kept.push(r), askOne,
    models: { assist: { ok: true, model: MODEL }, research: { ok: true, model: MODEL } },
    chromeConnected: () => true, spentUsd: 0, capUsd: 25, signal: new AbortController().signal, now: () => 10,
    ...over,
  };
}

describe('the AI pass after a run', () => {
  it('asks about every open question once and keeps each answer as a suggestion', async () => {
    const { store, open } = await scanned();
    const d = deps(store);
    const r = await runAiPass(d);
    expect(r).toMatchObject({ asked: open.length, suggested: open.length, verified: 0, problem: null });
    expect(d.kept.map((k) => k.questionId).sort()).toEqual(open.map((q) => q.id).sort());
    expect((await store.listReview()).filter((q) => q.answer !== null)).toEqual([]);
    // Asked once: a question with a suggestion on screen is not asked again.
    const again = await runAiPass({ ...d, suggestions: () => d.kept });
    expect(again.asked).toBe(0);
  });

  it('split questions wait while Chrome is closed (research reads Home Depot through it)', async () => {
    const { store, open } = await scanned();
    const asked: string[] = [];
    const r = await runAiPass(deps(store, { chromeConnected: () => false, asked }));
    expect(asked).toEqual([]);
    expect(r.waitingForChrome).toBe(open.length);
  });

  it('stops at the monthly AI limit, and asks nothing when the limit is $0 or the model has no known price', async () => {
    const { store } = await scanned();
    const each = estimatedQuestionCost('split', MODEL)!;
    const asked: string[] = [];
    const capped = await runAiPass(deps(store, { spentUsd: 25 - each * 1.5, asked }));
    expect(asked.length).toBe(1);
    expect(capped.problem).toMatch(/limit of \$25.00 is reached/);

    const off = await runAiPass(deps(store, { capUsd: 0, asked: [] }));
    expect(off).toMatchObject({ asked: 0, problem: expect.stringMatching(/off/) });

    const unpriced: string[] = [];
    const r = await runAiPass(deps(store, { models: { assist: { ok: true, model: 'mystery-1' }, research: { ok: true, model: 'mystery-1' } }, asked: unpriced }));
    expect(unpriced).toEqual([]);
    expect(r.problem).toMatch(/No price is known for mystery-1/);
  });

  it('a pipeline with no key says why, and Stop ends the pass', async () => {
    const { store } = await scanned();
    const r = await runAiPass(deps(store, { models: { assist: { ok: true, model: MODEL }, research: { ok: false, error: 'There is no API key saved for this model.' } } }));
    expect(r).toMatchObject({ asked: 0, problem: 'There is no API key saved for this model.' });
    const stop = new AbortController();
    stop.abort();
    expect((await runAiPass(deps(store, { signal: stop.signal }))).asked).toBe(0);
  });
});
