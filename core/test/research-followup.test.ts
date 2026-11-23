// Step 16, the follow-up loop (core/src/research/followUp.ts), with fake tools, a scripted model and a fake clock. No
// network: every model turn is written here, and the tools answer from what is written here or from the recordings.
//
// Two worlds. (1) The real "AI could not tell" question of the owner's scan 3, PCL406424SB-A21701-A25RS51 (item
// 335724135): its bundle page as the scan stored it (fixtures/e2e-2026-11-23/after-scan3), and Home Depot as the owner's
// Chrome read it for these three models on Nov 23 (core/test/followup-world.ts, a recording). (2) PCL500525SB (328690510)
// with the owner's Nov 20 recordings, where a first ask's searches failed.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { AssistEvidence } from '../src/assist/types';
import {
  deriveTasks, followUpKey, followUpNotes, MAX_FOLLOW_UP_ROUNDS, recheckWithFollowUp, runFollowUp, runFollowUpTasks, taskKey,
  type FollowUpAsk, type FollowUpRun, type FollowUpState,
} from '../src/research/followUp';
import { researchQuestion, type ResearchSuggestion } from '../src/research/loop';
import { FOLLOW_UP_VERSION_SUFFIX, RESEARCH_PROMPT_VERSION } from '../src/research/prompt';
import type { ResearchModel, ResearchPart, ResearchRequest, ResearchTools, ResearchTurn } from '../src/research/types';
import { verifyResearch } from '../src/research/verify';
import type { ReviewItem } from '../src/scan/types';
import { recordedTools } from '../../scripts/research-tools';
import { PCL500525SB, recorded, researchCase } from './research-world';
import { HD, recordedHomeDepot as warmTools, type Calls } from './followup-world';

const turn = (stopReason: string, content: unknown[]): ResearchTurn => ({ ok: true, stopReason, content, usage: { inputTokens: 1000, outputTokens: 100 } });
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const submit = (decision: string, parts: ResearchPart[] = [], reason = 'r') => use('toolu_submit', 'submit_answer', { quotes: [], parts, reason, decision, choiceIndex: null });

function scripted(turns: ResearchTurn[]) {
  const requests: ResearchRequest[] = [];
  const model: ResearchModel = {
    provider: 'fake', model: 'fake-model',
    async send(req) {
      requests.push(structuredClone(req));
      const t = turns[requests.length - 1];
      if (!t) throw new Error('the script ran out');
      return t;
    },
  };
  return { model, requests };
}

let clock = 1_000;
const now = () => (clock += 10);

// ---------------------------------------------------------------- world 1: the real "could not tell" question

const BUNDLE_ID = '335724135';
const scan3 = JSON.parse(readFileSync('fixtures/e2e-2026-11-23/after-scan3/store/review.json', 'utf8')) as {
  questions: ReviewItem[]; evidence: Record<string, { text: string; source: { label: string; url: string } }[]>;
};
const ITEM = scan3.questions.find((q) => q.id === `split:homedepot:${BUNDLE_ID}`)!;
const LINES = scan3.evidence[ITEM.id]!.map((l) => l.text);

/** The bundle's page as the scan stored it: its title, model, and the highlight and Includes lines. */
const EVIDENCE: AssistEvidence = {
  questionId: ITEM.id, kind: 'split', brand: 'RYOBI', model: ITEM.model, modelForms: [ITEM.model], notes: [], missing: [],
  sources: [{
    id: 'bundle', kind: 'bundle', label: 'Home Depot page', url: `${HD}/p/${BUNDLE_ID}`,
    lines: [{ field: 'title', text: LINES[0]! }, { field: 'model', text: LINES[1]! }, ...LINES.slice(2, -1).map((text) => ({ field: 'bullet' as const, text }))],
  }],
};

/** The first ask, as on Nov 23: its search for A21701 failed on a cold tab, and it could not tell. */
async function firstAsk(): Promise<ResearchSuggestion> {
  const { model } = scripted([
    turn('tool_use', [use('toolu_1', 'search_homedepot', { query: 'RYOBI A21701' })]),
    turn('tool_use', [submit('cannot_tell', [], 'The page lists a router and a sander, but never ties A21701 or A25RS51 to a named item.')]),
  ]);
  const cold: ResearchTools = { ...warmTools({ searches: [], pages: [] }), searchHomeDepot: async () => ({ error: 'The search page did not load.' }) };
  return researchQuestion(ITEM, EVIDENCE, cold, model, { catalog: [] });
}

/** The follow-up asks, through the same research loop with a scripted model. */
function asker(turns: ResearchTurn[]) {
  const s = scripted(turns);
  const ask: FollowUpAsk = async (followUp) => {
    const suggestion = await researchQuestion(ITEM, EVIDENCE, warmTools({ searches: [], pages: [] }), s.model, { catalog: [], followUp });
    return { suggestion, costUsd: 0.07 };
  };
  return { ...s, ask };
}

const baseRun = (first: ResearchSuggestion, calls: Calls, over: Partial<FollowUpRun> = {}): FollowUpRun => ({
  item: ITEM, catalog: [], start: { checked: first, answer: first.research.answer, trace: first.research },
  tools: () => warmTools(calls), ask: null, estimateUsd: 0.07, spentUsd: 0, capUsd: 20, now, ...over,
});

describe('the follow-up loop on PCL406424SB-A21701-A25RS51 (the owner\'s "could not tell")', () => {
  it('the first ask keeps the failed call itself, so it can be made once more', async () => {
    const first = await firstAsk();
    expect(first.status).toBe('cannot_tell');
    expect(first.research.failedTools).toEqual(['search_homedepot']);
    expect(first.research.failedCalls).toEqual([{ tool: 'search_homedepot', input: { query: 'RYOBI A21701' } }]);
  });

  it('derives its tasks from the structured record only: the failed call, and the readings no source shows', async () => {
    const first = await firstAsk();
    const tasks = deriveTasks({ item: ITEM, checked: first, answer: first.research.answer, trace: first.research, fetched: [], catalog: [], done: new Set() });
    // The failed "RYOBI A21701" search is the one confirm_model(A21701) makes first: made once.
    expect(tasks).toEqual([
      { kind: 'confirm_model', brand: 'RYOBI', model: 'PCL406424SB' },
      { kind: 'confirm_model', brand: 'RYOBI', model: 'A21701' },
      { kind: 'confirm_model', brand: 'RYOBI', model: 'A25RS51' },
    ]);
    // A task run already is not run again.
    expect(deriveTasks({ item: ITEM, checked: first, answer: null, trace: first.research, fetched: [], catalog: [], done: new Set(tasks.map(taskKey)) })).toEqual([]);
    // A verified answer needs nothing.
    expect(deriveTasks({ item: ITEM, checked: { status: 'verified' }, answer: null, trace: first.research, fetched: [], catalog: [], done: new Set() })).toEqual([]);
  });

  it('reads the three models, asks once more with the new sources and the gap, and gives up with what it tried when the answer still fails the check', async () => {
    const first = await firstAsk();
    const calls: Calls = { searches: [], pages: [] };
    // The follow-up answer names the three models. The verifier refuses it: the special buy is a 2-tool combo the catalog does
    // not know as a kit, and no source gives the model A25RS51 (Home Depot's search shows none).
    const quoteOf = (id: string, line: string) => ({ quote: line, sourceId: id });
    const { ask, requests } = asker([
      turn('tool_use', [submit('parts', [
        { model: 'PCL406424SB', qty: 1, quotes: [quoteOf('fu-hd-search:ryobi-pcl406424sb', 'RYOBI PCL406424SB (item 328690521): ONE+ 18V Cordless 2-Tool Combo Kit with Compact Fixed Base Router and 5 in. Random Orbit Sander (Tools Only)')] },
        { model: 'A21701', qty: 1, quotes: [quoteOf('fu-hd-search:ryobi-a21701', 'RYOBI A21701 (item 316546864): 7-Piece 5 in. Random Orbit Sand Paper Assortment Set - 80, 120, and 220 Grit')] },
        { model: 'A25RS51', qty: 1, quotes: [quoteOf('bundle', 'Includes: A25RS51 1/4 in., 3/8 in., 1/2 in., 5/8 in. straight router bits with a bonus 5/16 in. bit')] },
      ])]),
    ]);
    const states: FollowUpState[] = [];
    const r = await runFollowUp(baseRun(first, calls, { ask, progress: (s) => states.push(s) }));
    expect(calls.searches).toEqual(['RYOBI PCL406424SB', 'RYOBI A21701', 'RYOBI A25RS51']);
    // A25RS51: Home Depot's search shows no product of that model, so there is no page to read.
    expect(calls.pages).toEqual(['328690521', '316546864']);
    // One follow-up ask: its question is the code's, and carries the sources the loop read.
    expect(requests).toHaveLength(1);
    const message = String(requests[0]!.messages[0]!.content);
    expect(message).toContain('<follow_up>');
    expect(message).toContain('An earlier ask of this question answered cannot_tell.');
    expect(message).toContain('- fu-hd-page:316546864: the Home Depot product page of A21701.');
    expect(message).toContain('<source id="fu-hd-page:316546864"');
    expect(message).toContain("- A25RS51: Home Depot's search shows no product with this model number.");
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]!.suggestion.promptVersion).toBe(RESEARCH_PROMPT_VERSION + FOLLOW_UP_VERSION_SUFFIX);
    expect(r.asks[0]!.suggestion.status).toBe('unverified');
    // Round 2 finds nothing new to read, so it is not asked again on the same evidence.
    expect(r.state).toMatchObject({ state: 'gave_up', rounds: 1 });
    expect(r.state.reason).toBe('The app read what it could; nothing new to ask the AI about.');
    expect(r.costUsd).toBeCloseTo(0.07);
    expect(r.state.tried.map((t) => `${t.what} — ${t.result}`)).toEqual([
      'Searched Home Depot for RYOBI PCL406424SB — found: ONE+ 18V Cordless 2-Tool Combo Kit with Compact Fixed Base Router and 5 in. Random Orbit…',
      'Searched Home Depot for RYOBI A21701 — found: 7-Piece 5 in. Random Orbit Sand Paper Assortment Set - 80, 120, and 220 Grit',
      'Searched Home Depot for RYOBI A25RS51 — no product with that model number',
      'Asked the AI again with what the app read — its answer did not pass the checks',
      // Round 2, from the refusal "A25RS51 is not a model any source read gives": the local catalog, free. Nothing new: no second ask.
      'Looked up RYOBI A25RS51 in the catalog — not in the catalog',
    ]);
    expect(r.state.tried.map((t) => t.url)).toEqual([`${HD}/p/328690521`, `${HD}/p/316546864`, `${HD}/s/RYOBI%20A25RS51`, undefined, undefined]);
    // Rule 4: Home Depot's own pages settle A21701 as a part; PCL406424SB is a special buy (a bundle itself: its page is no
    // proof it is one part, measured in docs/decisions.md) and A25RS51 is not sold on Home Depot, so the question is about those two.
    expect(r.state.parts).toEqual({
      settled: [{ model: 'A21701', what: '7-Piece 5 in. Random Orbit Sand Paper Assortment Set - 80, 120, and 220 Grit', url: `${HD}/p/316546864` }],
      unsettled: [
        { model: 'PCL406424SB', why: 'special_buy', what: 'ONE+ 18V Cordless 2-Tool Combo Kit with Compact Fixed Base Router and 5 in. Random Orbit Sander (Tools Only)', url: `${HD}/p/328690521` },
        { model: 'A25RS51', why: 'not_sold' },
      ],
    });
    // While it ran, the card could say what it was doing.
    expect(states.map((s) => s.doing).filter(Boolean)).toContain("Reading Home Depot's page for A21701");
    expect(states.at(-1)!.state).toBe('gave_up');
  });

  it('with asks off it only reads, free, and says so; the same evidence is never asked on twice', async () => {
    const first = await firstAsk();
    const calls: Calls = { searches: [], pages: [] };
    const r = await runFollowUp(baseRun(first, calls));
    expect(r.asks).toEqual([]);
    expect(r.state).toMatchObject({ state: 'gave_up', rounds: 0, reason: 'The app read the pages; asking the AI again with them is off.' });
    expect(r.state.entries.map((e) => e.id)).toContain('fu-hd-page:316546864');
    // Later, with asks allowed: nothing is read again, and it asks once on what was read.
    const { ask, requests } = asker([turn('tool_use', [submit('cannot_tell')])]);
    const again = await runFollowUp(baseRun(first, calls, { prior: r.state, ask }));
    expect(calls.searches).toHaveLength(3);
    expect(requests).toHaveLength(1);
    expect(again.state).toMatchObject({ state: 'gave_up', rounds: 1 });
    // And a third run on the same evidence asks nothing.
    const third = await runFollowUp(baseRun(first, calls, { prior: again.state, ask }));
    expect(requests).toHaveLength(1);
    expect(third.state.reason).toBe('The app read what it could; nothing new to ask the AI about.');
  });

  it('no loop without changed evidence: every read fails, so no ask is made', async () => {
    const first = await firstAsk();
    const calls: Calls = { searches: [], pages: [] };
    const { ask, requests } = asker([turn('tool_use', [submit('cannot_tell')])]);
    const r = await runFollowUp(baseRun(first, calls, { ask, tools: () => warmTools(calls, { failAll: true }) }));
    expect(requests).toHaveLength(0);
    expect(r.state.entries).toEqual([]);
    expect(r.state.state).toBe('gave_up');
    expect(r.state.tried[0]).toEqual({ what: 'Searched Home Depot for RYOBI PCL406424SB', result: 'the search failed: Chrome did not answer in time.' });
  });

  it('the monthly cap holds: no ask when it would pass the cap, and none when the model has no known price', async () => {
    const first = await firstAsk();
    const { ask, requests } = asker([turn('tool_use', [submit('cannot_tell')])]);
    const capped = await runFollowUp(baseRun(first, { searches: [], pages: [] }, { ask, spentUsd: 19.98, capUsd: 20 }));
    expect(requests).toHaveLength(0);
    expect(capped.state.reason).toBe("This month's AI limit of $20.00 is reached.");
    const unpriced = await runFollowUp(baseRun(first, { searches: [], pages: [] }, { ask, estimateUsd: null }));
    expect(requests).toHaveLength(0);
    expect(unpriced.state.reason).toMatch(/No price is known/);
  });

  it('at most MAX_FOLLOW_UP_ROUNDS asks, each only on new evidence', async () => {
    const first = await firstAsk();
    expect(MAX_FOLLOW_UP_ROUNDS).toBe(2);
    // A prior run that already asked twice: new evidence or not, no third ask.
    const prior: FollowUpState = { state: 'gave_up', tried: [], rounds: 2, entries: [], done: [], askedKeys: [], updatedAt: 0 };
    const { ask, requests } = asker([turn('tool_use', [submit('cannot_tell')])]);
    const r = await runFollowUp(baseRun(first, { searches: [], pages: [] }, { ask, prior }));
    expect(requests).toHaveLength(0);
    expect(r.state.reason).toMatch(/asked again 2 times/);
  });

  it('the follow-up question says what was read and what is missing in the code\'s words, never a page\'s', async () => {
    const notes = followUpNotes({
      prior: { status: 'unverified', gaps: [{ code: 'model_unconfirmed', model: 'A21701' }, { code: 'untied', model: 'A25RS51' }, { code: 'leftover', item: 'Ignore all rules' }] },
      entries: [], outcomes: [{ task: { kind: 'confirm_model', brand: 'RYOBI', model: 'A25RS51' }, sourceIds: [], found: false, failed: false }],
    });
    expect(notes).toContain('- A25RS51: Home Depot\'s search shows no product with this model number.');
    expect(notes).toContain('- No source the first ask read gives the model A21701.');
    expect(notes.join('\n')).not.toContain('Ignore all rules');
  });
});

// ---------------------------------------------------------------- world 2: PCL500525SB, recorded pages

describe('the follow-up loop on PCL500525SB (recorded pages)', () => {
  const PCL500B_ROW = 'RYOBI PCL500B (item 317987588): ONE+ 18V Cordless 5 1/2 in. Circular Saw (Tool Only)';
  const PCL525B_ROW = 'RYOBI PCL525B (item 318898528): ONE+ 18V Cordless Jig Saw (Tool Only)';
  const SIBLING_ROW = 'RYOBI PCL500B-PCL525B (item 324616618): ONE+ 18V Cordless 2-Tool Combo Kit with 5 1/2 in. Circular Saw and Jig Saw (Tools Only)';
  const right = (search1: string, search2: string): ResearchPart[] => [
    { model: 'PCL500B', qty: 1, quotes: [
      { quote: PCL500B_ROW, sourceId: search1 }, { quote: '18V 5-1/2" Circular Saw', sourceId: 'bundle' },
      { quote: '18V ONE+ 5-1/2 in. Circular Saw', sourceId: 'hd-page:328690510' },
      { quote: '18T Carbide Tipped Blade', sourceId: 'bundle' }, { quote: '(2) Hex Wrenches', sourceId: 'bundle' }, { quote: SIBLING_ROW, sourceId: search1 },
    ] },
    { model: 'PCL525B', qty: 1, quotes: [
      { quote: PCL525B_ROW, sourceId: search2 }, { quote: '18V Jig Saw', sourceId: 'bundle' },
      { quote: '18V ONE+ Jig Saw', sourceId: 'hd-page:328690510' },
      { quote: 'Non-Marring Shoe', sourceId: 'bundle' }, { quote: 'T-Shank Wood Cutting Blade', sourceId: 'bundle' }, { quote: SIBLING_ROW, sourceId: search1 },
    ] },
  ];

  it('the searches that failed are made again, and the follow-up answer is verified by the same verifier', async () => {
    const c = await researchCase(PCL500525SB);
    const tools = recordedTools(recorded(), c.catalog);
    // First ask: the page reads, both searches fail on a cold tab, and it cannot tell.
    const cold: ResearchTools = { ...tools, searchHomeDepot: async () => ({ error: 'The search page did not load.' }) };
    const firstModel = scripted([
      turn('tool_use', [use('t1', 'read_homedepot_page', { itemId: '328690510', url: null })]),
      turn('tool_use', [use('t2', 'search_homedepot', { query: 'ryobi pcl500' }), use('t3', 'search_homedepot', { query: 'ryobi jig saw tool only' })]),
      turn('tool_use', [submit('cannot_tell')]),
    ]);
    const first = await researchQuestion(c.q, c.evidence, cold, firstModel.model, { catalog: c.catalog });
    expect(first.status).toBe('cannot_tell');
    const tasks = deriveTasks({ item: c.q, checked: first, answer: null, trace: first.research, fetched: [], catalog: c.catalog, done: new Set() });
    expect(tasks.filter((t) => t.kind === 'tool_failed')).toEqual([
      { kind: 'tool_failed', tool: 'search_homedepot', input: { query: 'ryobi pcl500' } },
      { kind: 'tool_failed', tool: 'search_homedepot', input: { query: 'ryobi jig saw tool only' } },
    ]);
    const follow = scripted([turn('tool_use', [submit('parts', right('fu-hd-search:ryobi-pcl500', 'fu-hd-search:ryobi-jig-saw-tool-only'))])]);
    const ask: FollowUpAsk = async (followUp) => ({ suggestion: await researchQuestion(c.q, c.evidence, tools, follow.model, { catalog: c.catalog, followUp }), costUsd: 0.07 });
    const r = await runFollowUp({
      item: c.q, catalog: c.catalog, start: { checked: first, answer: null, trace: first.research },
      tools: () => tools, ask, estimateUsd: 0.07, spentUsd: 0, capUsd: 20, now,
    });
    expect(r.asks).toHaveLength(1);
    const s = r.asks[0]!.suggestion;
    expect(s.status === 'unverified' ? s.reasons : []).toEqual([]);
    expect(s).toMatchObject({ status: 'verified', answer: { decision: 'parts', parts: ['PCL500B', 'PCL525B'] } });
    expect(r.state).toMatchObject({ state: 'done', rounds: 1 });
    // The page the first ask read came along (the answer quotes it), beside what the loop read.
    const ids = s.research.ledger.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['hd-page:328690510', 'fu-hd-search:ryobi-pcl500', 'fu-hd-search:ryobi-jig-saw-tool-only']));
  });

  it('(i) an unverified answer refused only because a model was unconfirmed verifies by code after confirm_model, with no model call', async () => {
    const c = await researchCase(PCL500525SB);
    const tools = recordedTools(recorded(), c.catalog);
    // The answer with its PCL525B row taken out: "PCL525B is not a model any source read gives".
    const parts = right('hd-search:ryobi-pcl500', 'hd-search:ryobi-jig-saw-tool-only').map((p) => ({ ...p, quotes: p.quotes.filter((q) => q.quote !== PCL525B_ROW) }));
    const page = await tools.readHomeDepotPage({ itemId: '328690510' });
    const s1 = await tools.searchHomeDepot({ query: 'ryobi pcl500' });
    if ('error' in page || 'error' in s1) throw new Error('recordings missing');
    const { pageEntry, searchEntry, bundleIdentity, ledgerFromEvidence } = await import('../src/research/ledger');
    const ledger = [...ledgerFromEvidence(c.evidence), pageEntry('hd-page:328690510', page, bundleIdentity(c.q), '328690510'), searchEntry('hd-search:ryobi-pcl500', s1)];
    const answer = { quotes: [], parts, reason: 'r', decision: 'parts' as const, choiceIndex: null };
    const checked = verifyResearch(answer, c.q, ledger, c.catalog);
    expect(checked.status).toBe('unverified');
    if (checked.status !== 'unverified') return;
    expect(checked.gaps).toEqual(expect.arrayContaining([{ code: 'model_unconfirmed', model: 'PCL525B' }]));
    const tasks = deriveTasks({ item: c.q, checked, answer, trace: { ledger }, fetched: [], catalog: c.catalog, done: new Set() });
    expect(tasks).toEqual(expect.arrayContaining([{ kind: 'catalog_lookup', brand: 'RYOBI', model: 'PCL525B' }, { kind: 'confirm_model', brand: 'RYOBI', model: 'PCL525B' }]));
    const ran = await runFollowUpTasks(tasks.filter((t) => t.kind === 'confirm_model' && t.model === 'PCL525B'), () => tools, c.q, ledger);
    expect(ran.tried[0]!.what).toBe('Searched Home Depot for RYOBI PCL525B');
    expect(followUpKey(ran.entries)).not.toBe(followUpKey([]));
    const rc = recheckWithFollowUp({ item: c.q, answer, ledger, catalog: c.catalog, entries: ran.entries });
    expect(rc?.status).toBe('verified');
    // And the loop stops there: done, no ask.
    const r = await runFollowUp({
      item: c.q, catalog: c.catalog, start: { checked, answer, trace: { ledger, toolCalls: 0, webSearches: 0, webFetches: 0, requests: 0, usage: { inputTokens: 0, outputTokens: 0, webSearchRequests: 0, webFetchRequests: 0 }, answer, droppedResults: 0 } },
      tools: () => tools, ask: async () => { throw new Error('no ask expected'); }, estimateUsd: 0.07, spentUsd: 0, capUsd: 20, now,
    });
    expect(r.rechecked?.status).toBe('verified');
    expect(r.asks).toEqual([]);
    expect(r.state.state).toBe('done');
  });
});
