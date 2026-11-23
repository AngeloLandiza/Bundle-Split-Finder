// Step 16, the agent's hooks (agent/reverify.ts), on real data: the latest recorded research run's answer for RYOBI
// PCL500525SB (validation item 328690510; the key: PCL500B + PCL525B), refused for "PCL525B is not a model any source
// read gives", and Home Depot's part-price readings of Nov 18 (fixtures/validation). No network, no model call.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { suggestionKey, type StoredSuggestion } from '../../core/src/assist/stored';
import { researchQuestion } from '../../core/src/research/loop';
import type { ResearchModel, ResearchTurn } from '../../core/src/research/types';
import { MemoryScanStore } from '../../core/src/scan/memoryStore';
import { partPricesWanted } from '../../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type PartPriceRecord, type ReviewItem } from '../../core/src/scan/types';
import { replayedTools, type ToolCallLog } from '../../scripts/research-tools';
import type { ResearchRunsFile } from '../../scripts/research-eval-cli';
import { loadInputs } from '../../scripts/validate-cli';
import { researchCase } from '../../core/test/research-world';
import { runAiPass, type AskOne } from '../aiPass';
import { MAX_REASKS, reaskDue, reverifyPass, waitingSentence, wantedReads, withEvidenceKey } from '../reverify';
import { reviewResponse } from '../views';
import { defaultSettings, type StoreData } from '../store';

const LATEST = JSON.parse(readFileSync('fixtures/research/runs-claude-opus-5-5.json', 'utf8')) as ResearchRunsFile;
const ID = 'split:homedepot:328690510';

function nov18(models: string[]): PartPriceRecord[] {
  return [...loadInputs('fixtures/validation').partPrices].filter(([, r]) => models.includes(r.model.toUpperCase())).map(([key, r]) => ({
    key, brand: r.brand.toUpperCase(), model: r.model.toUpperCase(), itemId: r.itemId, matchedModel: r.matchedModel?.toUpperCase() ?? null,
    price: r.price, title: r.title, link: r.link, seenAt: r.price === null ? null : 1, checkedAt: 1,
  }));
}

/** A store holding only the question, its bundle and the catalog, and the run's suggestion as the agent keeps it (ledger whole). */
async function world(): Promise<{ store: MemoryScanStore; item: ReviewItem; record: StoredSuggestion }> {
  const c = await researchCase(ID);
  const store = new MemoryScanStore();
  await store.putBundle((await c.w.store.getBundle(c.q.subject))!);
  for (const e of await c.w.store.listCatalog()) await store.putCatalogEntry(e);
  await store.putReview(c.q);
  const stored = LATEST.results.find((r) => r.questionId === ID)!;
  let i = 0;
  const model: ResearchModel = { provider: 'replay', model: LATEST.model, send: async () => (stored.turns[i++] as ResearchTurn | undefined) ?? { ok: false, notJudged: { reason: 'no_answer', message: 'x' } } };
  const s = await researchQuestion(c.q, c.evidence, replayedTools(stored.tools as ToolCallLog[]), model, { catalog: c.catalog });
  expect(s.status).toBe('unverified');
  const record: StoredSuggestion = { key: suggestionKey(ID, 5), questionId: ID, seen: s.seen, askedAt: 5, suggestion: s, costUsd: 0.07 };
  return { store, item: c.q, record };
}

function kept(records: StoredSuggestion[]) {
  return { suggestions: () => records, replace: (r: StoredSuggestion) => records.splice(records.findIndex((x) => x.key === r.key), 1, r) };
}

describe('reverifyPass: an unverified answer checked again when the readings arrive', () => {
  it('waits for PCL525B, asks the part-price reader for it first, and says so on the question', async () => {
    const { store, record } = await world();
    const records = [record];
    expect(await wantedReads(store, records)).toEqual([{ brand: 'RYOBI', model: 'PCL525B' }]);
    const r = await reverifyPass({ store, ...kept(records), now: () => 50 });
    expect(r).toEqual({ checked: 1, verified: [], waiting: 1 });
    expect(records[0]!.waitingFor).toEqual(['PCL525B']);
    expect(records[0]!.suggestion.status).toBe('unverified');
    const wanted = await partPricesWanted(store, DEFAULT_SCAN_SETTINGS, 100, true, await wantedReads(store, records));
    expect(wanted[0]).toMatchObject({ brand: 'RYOBI', model: 'PCL525B' });
    const data = {
      review: { at: null, questions: [(await store.listReview())[0]!], ebayQuestions: [] }, suggestions: records,
      deals: { at: null, bundles: [], auditAt: null, auditBundles: [] }, settings: defaultSettings(),
    } as unknown as Pick<StoreData, 'review' | 'suggestions' | 'deals' | 'settings'>;
    expect(reviewResponse(data).questions[0]!.waitingFor).toBe("Waiting for Home Depot's page for PCL525B to confirm the model.");
  });

  it('verifies once Home Depot\'s readings are stored: same key and cost, no new AI call, the first check kept', async () => {
    const { store, record } = await world();
    for (const p of nov18(['PCL500B', 'PCL525B'])) await store.putPartPrice(p);
    const records = [record];
    const r = await reverifyPass({ store, ...kept(records), now: () => 60 });
    expect(r.verified).toEqual([ID]);
    const after = records[0]!;
    expect(after).toMatchObject({ key: record.key, askedAt: 5, costUsd: 0.07, verifiedAfter: 'new_evidence', recheckedAt: 60 });
    expect(after.firstCheck?.reasons[0]).toMatch(/^PCL525B is not a model any source read gives/);
    expect(after.suggestion.status).toBe('verified');
    if (after.suggestion.status === 'verified') expect(after.suggestion.answer).toEqual({ decision: 'parts', kind: 'split', parts: ['PCL500B', 'PCL525B'] });
    expect(after.waitingFor).toBeUndefined();
    expect(await wantedReads(store, records)).toEqual([]);
    // A second pass finds nothing left to check.
    expect(await reverifyPass({ store, ...kept(records), now: () => 70 })).toEqual({ checked: 0, verified: [], waiting: 0 });
  });

  it('a suggestion kept slimmed, an answered question or a changed question is left alone', async () => {
    const { store, record, item } = await world();
    for (const p of nov18(['PCL500B', 'PCL525B'])) await store.putPartPrice(p);
    const trace = (record.suggestion as typeof record.suggestion & { research: { ledger: { lines: unknown[] }[] } }).research;
    const slim = { ...record, suggestion: { ...record.suggestion, research: { ...trace, ledger: trace.ledger.map((e) => ({ ...e, lines: [], products: [] })) } } } as unknown as StoredSuggestion;
    expect((await reverifyPass({ store, ...kept([slim]), now: () => 1 })).checked).toBe(0);
    expect((await reverifyPass({ store, ...kept([{ ...record, seen: 'other' }]), now: () => 1 })).checked).toBe(0);
    await store.putReview({ ...item, answer: 'PCL500B,PCL525B', answerParts: ['PCL500B', 'PCL525B'], answeredAt: 2 });
    expect((await reverifyPass({ store, ...kept([record]), now: () => 1 })).checked).toBe(0);
  });

  it('the waiting sentence names every model', () => {
    expect(waitingSentence(['DCS334B'])).toBe("Waiting for Home Depot's page for DCS334B to confirm the model.");
    expect(waitingSentence(['PCL500B', 'PCL525B'])).toBe("Waiting for Home Depot's page for PCL500B and PCL525B to confirm the models.");
    expect(waitingSentence([])).toBeNull();
  });
});

describe('lever 2: ask again only when what the ask lacked exists now', () => {
  /** The question asked with a search that failed (a cold tab), as the loop records it. */
  async function failedSearch() {
    const { store, item, record } = await world();
    const trace = (record.suggestion as typeof record.suggestion & { research: Record<string, unknown> }).research;
    const s = { ...record.suggestion, status: 'cannot_tell', reason: 'Home Depot search failed.', quotes: [], research: { ...trace, failedTools: ['search_homedepot'] } } as unknown as StoredSuggestion['suggestion'];
    const stamped = await withEvidenceKey(async () => ({ ...record, suggestion: s }), store)(item, 'research', new AbortController().signal);
    return { store, item, stamped };
  }

  it('stamps the ask with its evidence key and what it lacked', async () => {
    const { stamped } = await failedSearch();
    expect(stamped.lacks).toEqual(['tool:search_homedepot']);
    expect(typeof stamped.evidenceKey).toBe('string');
  });

  it('is not due until a later ask\'s search worked; then due once for that evidence, at most MAX_REASKS times', async () => {
    const { store, stamped } = await failedSearch();
    expect((await reaskDue(store, [stamped])).size).toBe(0);
    // Another question's research, asked later, read Home Depot's search: the tool works again.
    const later: StoredSuggestion = {
      key: 'split:homedepot:1|9', questionId: 'split:homedepot:1', seen: 'x', askedAt: 9, costUsd: 0,
      suggestion: { questionId: 'split:homedepot:1', seen: 'x', provider: 'p', model: 'm', promptVersion: 'v', status: 'cannot_tell', reason: 'r', quotes: [], research: { ledger: [{ id: 'hd-search:1', kind: 'homedepot_search', label: 'Home Depot search', url: null, lines: [], products: [], isBundle: false }] } } as unknown as StoredSuggestion['suggestion'],
    };
    const due = await reaskDue(store, [stamped, later]);
    expect([...due.keys()]).toEqual([ID]);
    expect(due.get(ID)!.of).toBe(stamped.key);
    // Asked again on that key: not due again on the same evidence.
    const again: StoredSuggestion = { ...stamped, key: suggestionKey(ID, 20), askedAt: 20, reaskOf: stamped.key, evidenceKey: due.get(ID)!.evidenceKey };
    expect((await reaskDue(store, [stamped, later, again])).size).toBe(0);
    // A re-ask that lacked something again is due once more only below MAX_REASKS.
    const tries = Array.from({ length: MAX_REASKS }, (_, n) => ({ ...stamped, key: suggestionKey(ID, 30 + n), askedAt: 30 + n, reaskOf: stamped.key, evidenceKey: `k${n}` }));
    expect((await reaskDue(store, [later, ...tries])).size).toBe(0);
  });

  it('runAiPass asks a due question again although a suggestion is on screen, and tags the record', async () => {
    const { store, item, stamped } = await failedSearch();
    const asked: string[] = [];
    const askOne: AskOne = async (q) => {
      asked.push(q.id);
      return { ...stamped, key: suggestionKey(q.id, 40), askedAt: 40 };
    };
    const keptRecords: StoredSuggestion[] = [stamped];
    const base = {
      store, suggestions: () => keptRecords, keep: (r: StoredSuggestion) => void keptRecords.push(r), askOne,
      models: { assist: { ok: true as const, model: 'claude-opus-5-5' }, research: { ok: true as const, model: 'claude-opus-5-5' } },
      chromeConnected: () => true, spentUsd: 0, capUsd: 25, signal: new AbortController().signal, now: () => 41,
    };
    expect((await runAiPass(base)).asked).toBe(0);
    const r = await runAiPass({ ...base, reask: new Map([[item.id, { of: stamped.key, evidenceKey: 'new' }]]) });
    expect(r.asked).toBe(1);
    expect(asked).toEqual([item.id]);
    expect(keptRecords[1]).toMatchObject({ reaskOf: stamped.key, evidenceKey: 'new' });
  });
});
