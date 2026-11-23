// Undo for an answer the owner saved himself (POST /api/review/:id/undo). A split question comes from the recorded
// "ryobi 18v combo kit" page scanned over the replay (as autopilot.test.ts does); a match question is seeded by hand.

import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityResponse, ReviewResponse } from '../../core/src/api/contract';
import { CHANGED_SINCE } from '../ownerAnswers';
import type { Suggestion } from '../../core/src/assist/types';
import { reviewSignature } from '../../core/src/scan/answers';
import { runScan } from '../../core/src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, partKey, type MatchRecord, type ReviewItem, type ScanSettings } from '../../core/src/scan/types';
import { parseAccount, SearchBudget } from '../../core/src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../../core/src/serpapi/client';
import * as fx from '../../core/test/fixtures';
import { replayRecorded } from '../../scripts/replay';
import { createAgent, type Agent } from '../app';

const P553 = 'split:homedepot:320243741';
const BUNDLE = 'homedepot:320243741';
const RYOBI: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, brands: ['RYOBI'], queries: [{ q: 'ryobi 18v combo kit' }] };
const T0 = Date.UTC(2026, 10, 22, 12);

let server: Server;
let agent: Agent;
let base: string;
let clock: number;

beforeEach(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  clock = T0;
  agent = createAgent({ dataDir: mkdtempSync(join(tmpdir(), 'sf-undo-')), port, timers: false, now: () => clock });
  server.on('request', agent.handle);
  const budget = new SearchBudget(parseAccount({ ...fx.SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun: 1 });
  const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replayRecorded().fetchFn, now: () => T0 });
  await runScan({ client, budget, store: agent.work.scanStore, settings: RYOBI, now: () => T0 });
  await agent.work.refresh();
});

afterEach(async () => {
  await agent.work.idle();
  agent.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ui = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${agent.auth.uiToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
const post = (path: string, body: unknown = {}) => ui(path, { method: 'POST', body: JSON.stringify(body) });
const review = async () => (await (await ui('/api/review')).json()) as ReviewResponse;
const activity = async () => (await (await ui('/api/activity')).json()) as ActivityResponse;
const message = async (res: Response) => ((await res.json()) as { error: { message: string } }).error.message;
const open = async (id: string) => (await review()).questions.find((q) => q.id === id);

describe('Undo of the owner’s answer to a split question', () => {
  it('answers, then Undo brings back the same question and the bundle as it was', async () => {
    const store = agent.work.scanStore;
    const item = (await store.getReview(P553))!;
    const bundle = (await store.getBundle(BUNDLE))!;
    const questionBefore = await open(P553);
    expect(questionBefore).toBeTruthy();

    const res = await post(`/api/review/${encodeURIComponent(P553)}/answer`, { answer: { choice: 0 }, seen: reviewSignature(item) });
    expect(res.status).toBe(200);
    const { answerId } = (await res.json()) as { applied: true; answerId?: string };
    expect(answerId).toBeTruthy();
    expect(await open(P553)).toBeUndefined();
    expect((await store.getBundle(BUNDLE))!.split).toMatchObject({ status: 'resolved', components: ['PCL1600K2', 'P553'] });
    const listed = (await activity()).answers!;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: answerId, questionId: P553, answer: 'PCL1600K2, P553', undoable: true });

    const undone = await post(`/api/review/${encodeURIComponent(answerId!)}/undo`);
    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({ reopened: true, questionId: P553 });
    expect(await store.getReview(P553)).toEqual(item);
    expect((await store.getBundle(BUNDLE))!.split).toEqual(bundle.split);
    expect(await open(P553)).toEqual(questionBefore);
    expect((await activity()).answers![0]).toMatchObject({ id: answerId, undoable: false, undoneAt: expect.any(String) });

    // The question can be answered again, and a second Undo of the first entry is refused.
    expect((await post(`/api/review/${encodeURIComponent(P553)}/answer`, { answer: { none: true }, seen: reviewSignature(item) })).status).toBe(200);
    const again = await post(`/api/review/${encodeURIComponent(answerId!)}/undo`);
    expect(again.status).toBe(409);
    expect(await message(again)).toBe('That answer was undone already.');
  });

  it('takes the AI suggestion he used back to unused, so Review shows it again', async () => {
    const item = (await agent.work.scanStore.getReview(P553))!;
    const suggestion: Suggestion = {
      questionId: P553, seen: reviewSignature(item), provider: 'claude', model: 'claude-opus-5-5', promptVersion: 'test', status: 'verified',
      answer: { decision: 'choose', kind: 'split', choiceIndex: 0, parts: ['PCL1600K2', 'P553'] },
      quotes: [{ quote: 'PCL1600K2', sourceId: 'bundle', label: 'Home Depot page', url: 'https://www.homedepot.com/p/320243741', names: true }], reason: 'The page lists both.',
    };
    agent.store.update('suggestions', () => [{ key: `${P553}|1`, questionId: P553, seen: suggestion.seen, askedAt: 1, suggestion, costUsd: 0.01 }]);
    expect((await open(P553))!.suggestion).not.toBeNull();

    const res = await post(`/api/review/${encodeURIComponent(P553)}/answer`, { answer: { choice: 0 }, fromSuggestion: true, seen: reviewSignature(item) });
    const { answerId } = (await res.json()) as { answerId: string };
    expect(agent.store.get('suggestions')[0]!.outcome).toMatchObject({ answer: 'PCL1600K2,P553', agreed: true });

    await post(`/api/review/${encodeURIComponent(answerId)}/undo`);
    expect(agent.store.get('suggestions')[0]!.outcome).toBeUndefined();
    expect((await open(P553))!.suggestion).not.toBeNull();
  });

  it('is refused, with a plain sentence and nothing written, once a later scan changed the bundle', async () => {
    const store = agent.work.scanStore;
    const item = (await store.getReview(P553))!;
    const { answerId } = (await (await post(`/api/review/${encodeURIComponent(P553)}/answer`, { answer: { choice: 0 }, seen: reviewSignature(item) })).json()) as { answerId: string };
    // What a later scan does: it reads the bundle again and the split is something else now.
    const bundle = (await store.getBundle(BUNDLE))!;
    await store.putBundle({ ...bundle, split: { components: ['PCL1600K2'], status: 'resolved', notes: ['read from the page'] } });

    const res = await post(`/api/review/${encodeURIComponent(answerId)}/undo`);
    expect(res.status).toBe(409);
    expect(await message(res)).toBe(CHANGED_SINCE);
    expect((await store.getBundle(BUNDLE))!.split?.components).toEqual(['PCL1600K2']);
    expect((await store.getReview(P553))!.answer).toBe('PCL1600K2,P553');
    // Activity stops offering Undo for it.
    expect((await activity()).answers![0]).toMatchObject({ undoable: false, undoneAt: null });
  });

  it('refuses an unknown entry', async () => {
    expect((await post('/api/review/oa-nothing/undo')).status).toBe(409);
  });
});

describe('Undo of the owner’s answer to a match question', () => {
  const part = partKey('RYOBI', 'P999');
  const matchItem: ReviewItem = {
    id: `match:${part}`, kind: 'match', subject: part, brand: 'RYOBI', model: 'P999', title: 'RYOBI P999 battery', reason: 'Two listings fit.',
    candidates: [
      { asin: 'B000000001', title: 'RYOBI P999 battery', price: 30, reviews: 10, reasons: [], seenAt: T0 },
      { asin: 'B000000002', title: 'RYOBI P999 battery 2 pack', price: 55, reviews: 3, reasons: [], seenAt: T0 },
    ],
    choices: [], openedAt: T0, answer: null, answeredAt: null,
  };
  const record: MatchRecord = { key: part, brand: 'RYOBI', model: 'P999', status: 'review', asin: null, grade: null, alternatives: [], decidedBy: 'auto', updatedAt: T0, waitingSince: null };

  it('puts the part back to the match it had and the question back in Review', async () => {
    const store = agent.work.scanStore;
    await store.putReview(matchItem);
    await store.putMatch(record);
    const res = await post(`/api/review/${encodeURIComponent(matchItem.id)}/answer`, { answer: { choice: 1 }, seen: reviewSignature(matchItem) });
    const { answerId } = (await res.json()) as { answerId: string };
    expect(await store.getMatch(part)).toMatchObject({ status: 'matched', asin: 'B000000002', decidedBy: 'user' });

    expect((await post(`/api/review/${encodeURIComponent(answerId)}/undo`)).status).toBe(200);
    expect(await store.getMatch(part)).toEqual(record);
    expect(await store.getReview(matchItem.id)).toEqual(matchItem);
  });

  it('keeps only the newest 50 answers', async () => {
    const store = agent.work.scanStore;
    for (let i = 0; i < 52; i += 1) {
      const subject = partKey('RYOBI', `P${100 + i}`);
      const item = { ...matchItem, id: `match:${subject}`, subject, model: `P${100 + i}` };
      await store.putReview(item);
      await store.putMatch({ ...record, key: subject, model: item.model });
      await post(`/api/review/${encodeURIComponent(item.id)}/answer`, { answer: { none: true }, seen: reviewSignature(item) });
      clock += 1000;
    }
    const answers = (await activity()).answers!;
    expect(answers).toHaveLength(50);
    expect(answers[0]!.questionId).toBe(`match:${partKey('RYOBI', 'P151')}`);
    expect(answers[49]!.questionId).toBe(`match:${partKey('RYOBI', 'P102')}`);
    expect(answers.every((a) => a.undoable)).toBe(true);
  });
});
