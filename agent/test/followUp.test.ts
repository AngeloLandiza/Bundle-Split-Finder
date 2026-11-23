// Step 16, the follow-up loop's agent side (agent/followUp.ts), end to end on the owner's real scan-3 store
// (fixtures/e2e-2026-11-23/after-scan3) and its "AI could not tell" question PCL406424SB-A21701-A25RS51. Fake tools (the
// constructed Home Depot of core/test/followup-world.ts), a scripted model, a fake clock. No network.

import { describe, expect, it } from 'vitest';

import { gatherEvidence } from '../../core/src/assist/evidence';
import type { StoredSuggestion } from '../../core/src/assist/stored';
import { researchQuestion } from '../../core/src/research/loop';
import type { ResearchModel, ResearchRequest, ResearchTools, ResearchTurn } from '../../core/src/research/types';
import type { ReviewItem, ScanStore } from '../../core/src/scan/types';
import { warmTools, type Calls } from '../../core/test/followup-world';
import { loadScanFolder } from '../../scripts/data-folder';
import { researchRecord } from '../aiPass';
import { autopilotDecision } from '../autopilot';
import { askPlan, followUpPass, type FollowUpPassDeps } from '../followUp';
import { defaultSettings, type StoreData } from '../store';
import { reviewResponse, workingReviewCount } from '../views';

const ID = 'split:homedepot:335724135';
const MODEL = 'claude-opus-5-5';
const turn = (stopReason: string, content: unknown[]): ResearchTurn => ({ ok: true, stopReason, content, usage: { inputTokens: 20_000, outputTokens: 1_000 } });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const cannotTell = () => use('toolu_s', 'submit_answer', { quotes: [], parts: [], reason: 'r', decision: 'cannot_tell', choiceIndex: null });

function scripted(turns: ResearchTurn[]) {
  const requests: ResearchRequest[] = [];
  const model: ResearchModel = {
    provider: 'claude', model: MODEL,
    async send(req) {
      requests.push(structuredClone(req));
      return turns[requests.length - 1] ?? { ok: false, notJudged: { reason: 'no_answer', message: 'the script ran out' } };
    },
  };
  return { model, requests };
}

let t = 1_000;
const now = () => (t += 10);

/** The real store, and the first ask as on Nov 23: its Home Depot search failed on a cold tab, and it could not tell. */
async function world(): Promise<{ store: ScanStore; item: ReviewItem; records: StoredSuggestion[] }> {
  const store = await loadScanFolder('fixtures/e2e-2026-11-23/after-scan3');
  const item = (await store.getReview(ID))!;
  const { model } = scripted([turn('tool_use', [use('t1', 'search_homedepot', { query: 'RYOBI A21701' })]), turn('tool_use', [cannotTell()])]);
  const cold: ResearchTools = { ...warmTools({ searches: [], pages: [] }), searchHomeDepot: async () => ({ error: 'The search page did not load.' }) };
  const first = await researchQuestion(item, await gatherEvidence(store, item), cold, model, { catalog: [] });
  expect(first.status).toBe('cannot_tell');
  return { store, item, records: [researchRecord(item, first, MODEL, now())] };
}

const put = (records: StoredSuggestion[]) => (r: StoredSuggestion) => {
  const i = records.findIndex((x) => x.key === r.key);
  if (i >= 0) records.splice(i, 1, r);
  else records.push(r);
};

function deps(store: ScanStore, records: StoredSuggestion[], calls: Calls, model: ResearchModel, over: Partial<FollowUpPassDeps> = {}): FollowUpPassDeps {
  return {
    store, suggestions: () => records, put: put(records), tools: () => warmTools(calls), research: model, allowAsk: true, chromeConnected: () => true,
    spentUsd: 0, capUsd: 20, signal: new AbortController().signal, now, ...over,
  };
}

const data = async (store: ScanStore, records: StoredSuggestion[]) => ({
  review: { at: null, questions: await store.listReview(), ebayQuestions: [] }, suggestions: records,
  deals: { at: null, bundles: [], auditAt: null, auditBundles: [] }, settings: defaultSettings(),
}) as unknown as Pick<StoreData, 'review' | 'suggestions' | 'deals' | 'settings'>;

const plan = (store: ScanStore, records: StoredSuggestion[], item: ReviewItem, over: Partial<Parameters<typeof askPlan>[0]> = {}) =>
  askPlan({ store, suggestions: records, item, force: false, model: { ok: true, model: MODEL }, spentUsd: 0, capUsd: 20, chromeConnected: true, ...over });

describe('Ask AI on a question that has an answer is never a silent no-op', () => {
  it('runs the follow-up loop when something is missing, the question is the app\'s meanwhile, and it comes back with what was tried', async () => {
    const { store, item, records } = await world();
    expect(await plan(store, records, item)).toEqual({ action: 'follow_up' });
    const calls: Calls = { searches: [], pages: [] };
    const seen: number[] = [];
    const { model, requests } = scripted([turn('tool_use', [cannotTell()])]);
    const tools = () => {
      const w = warmTools(calls);
      return { ...w, searchHomeDepot: async (input: { query: string }) => {
        // While the loop reads, the question is not counted in "Needs you".
        seen.push(workingReviewCount((await data(store, records)).review, records));
        return w.searchHomeDepot(input);
      } } as ResearchTools;
    };
    const r = await followUpPass(deps(store, records, calls, model, { only: [ID], tools }));
    expect(seen.every((n) => n === 1)).toBe(true);
    expect(calls.searches).toEqual(['RYOBI PCL406424SB', 'RYOBI A21701', 'RYOBI A25RS51']);
    expect(requests).toHaveLength(1);
    expect(r).toMatchObject({ ran: 1, asked: 1, verified: 0 });
    expect(r.costUsd).toBeGreaterThan(0);
    // The follow-up ask is a suggestion of its own, naming the record it asked again; it is the live one now.
    expect(records).toHaveLength(2);
    expect(records[1]!.followUpOf).toBe(records[0]!.key);
    const q = (await reviewResponse(await data(store, records))).questions.find((x) => x.id === ID)!;
    expect(q.suggestion?.key).toBe(records[1]!.key);
    expect(q.followUp).toMatchObject({ state: 'gave_up', roundsLeft: 1 });
    expect(q.followUp!.tried.map((x) => x.what)).toEqual([
      'Searched Home Depot for PCL406424SB', 'Searched Home Depot for A21701', 'Searched Home Depot for A25RS51', 'Asked the AI again with what the app read',
    ]);
    expect(q.followUp!.tried[1]!.url).toBe('https://www.homedepot.com/p/317000001');
    // The card's check says what the app did, not what the owner should go and read.
    expect(q.brief?.check?.who).toBe('app');
    expect(q.brief?.check?.text).toMatch(/^The app already read what it could for this \(4 steps\)/);
    expect(workingReviewCount((await data(store, records)).review, records)).toBe(0);

    // Pressed again: nothing new to read, so it says why and what Ask anyway costs.
    const again = await plan(store, records, item);
    expect(again).toEqual({ action: 'none', reason: 'Nothing new to read since the last answer; asking again would cost about $0.08.', canForce: true, costUsd: expect.any(Number) });
    // Ask anyway: a fresh ask.
    expect(await plan(store, records, item, { force: true })).toEqual({ action: 'ask', force: true });
    // Force changes nothing when the cap would be passed or Chrome is closed.
    expect(await plan(store, records, item, { force: true, spentUsd: 19.99 })).toEqual({ action: 'none', reason: "This month's AI limit of $20.00 is reached." });
    expect((await plan(store, records, item, { chromeConnected: false })).action).toBe('none');
    expect(await plan(store, records, item, { model: { ok: false, error: 'No Anthropic key yet — add it in Settings › Keys.' } })).toEqual({ action: 'none', reason: 'No Anthropic key yet — add it in Settings › Keys.' });
  });

  it('says so while the app is already working on it; a question with no suggestion is simply asked', async () => {
    const { store, item, records } = await world();
    records[0] = { ...records[0]!, followUp: { state: 'running', tried: [], rounds: 0, entries: [], done: [], askedKeys: [], updatedAt: 1 } };
    expect(await plan(store, records, item)).toEqual({ action: 'none', reason: 'The app is already working on this question.' });
    expect(await plan(store, [], item)).toEqual({ action: 'ask', force: false });
  });

  it('automatically (not pressed), asks are off by default: only the free reads run, and the reason is kept', async () => {
    const { store, records } = await world();
    const calls: Calls = { searches: [], pages: [] };
    const { model, requests } = scripted([]);
    const r = await followUpPass(deps(store, records, calls, model, { allowAsk: false }));
    expect(requests).toHaveLength(0);
    expect(r).toMatchObject({ ran: 1, asked: 0, costUsd: 0 });
    expect(records[0]!.followUp).toMatchObject({ state: 'gave_up', reason: 'The app read the pages; asking the AI again with them is off.' });
    // It is not run again by itself; the owner's press asks on what was read.
    expect((await followUpPass(deps(store, records, calls, model, { allowAsk: false }))).ran).toBe(0);
    expect(await plan(store, records, (await store.getReview(ID))!)).toEqual({ action: 'follow_up' });
  });

  it('with Chrome closed it reads nothing and says why', async () => {
    const { store, records } = await world();
    const r = await followUpPass(deps(store, records, { searches: [], pages: [] }, scripted([]).model, { chromeConnected: () => false }));
    expect(r.problem).toBe('Chrome is closed, so the app could not read the pages these questions need.');
    expect(records[0]!.followUp).toBeUndefined();
  });

  it('Autopilot leaves a follow-up ask\'s verified answer to the owner until follow-up asks are measured', async () => {
    const { item, records } = await world();
    const settings = defaultSettings();
    const base = records[0]!;
    const verified = {
      ...base, followUpOf: 'x',
      suggestion: { ...base.suggestion, status: 'verified', provider: 'claude', model: settings.ai.research.model, quotes: [], reason: 'r', answer: { decision: 'parts', kind: 'split', parts: ['A21701'] } },
    } as unknown as StoredSuggestion;
    const d = autopilotDecision(item, verified, { ...settings.ai, research: { ...settings.ai.research, trusted: true } }, false);
    expect(d).toEqual({ apply: false, reason: 'It came from asking the AI again with what the app read, which is not measured yet, so it waits for you.' });
  });
});
