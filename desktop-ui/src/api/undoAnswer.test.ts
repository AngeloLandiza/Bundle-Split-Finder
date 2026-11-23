import { describe, expect, it } from 'vitest';
import type * as C from '@core/api/contract';
import { SAVED_ROW_MS } from '../screens/reviewModel';
import { mapActivity } from './map';
import { createMockClient } from './mock';

const response = (answers: C.OwnerAnswerEntry[] | undefined): C.ActivityResponse => ({
  runs: [], spend: { serpSearches: 0, keepaTokens: 0, aiUsd: 0, since: '2026-11-01T00:00:00.000Z' }, autopilot: [], ...(answers ? { answers } : {}),
});
const entry = (over: Partial<C.OwnerAnswerEntry>): C.OwnerAnswerEntry => ({ id: 'oa-1', questionId: 'split:homedepot:1', title: 'RYOBI kit', answer: 'PCL1600K2, P553', at: '2026-11-23T10:00:00.000Z', undoable: true, ...over });

describe('the owner’s answers in Activity', () => {
  it('maps the agent’s list as it is, Undo only where the agent says it still works', () => {
    const v = mapActivity(response([entry({}), entry({ id: 'oa-2', undoable: false }), entry({ id: 'oa-3', undoneAt: '2026-11-23T11:00:00.000Z', undoable: true })]), new Map());
    expect(v.answers.map((a) => [a.id, a.undoable, a.undone])).toEqual([['oa-1', true, false], ['oa-2', false, false], ['oa-3', false, true]]);
  });
  it('is empty for an agent that sends none', () => {
    expect(mapActivity(response(undefined), new Map()).answers).toEqual([]);
  });
  it('keeps the Saved row for 8 seconds', () => {
    expect(SAVED_ROW_MS).toBe(8000);
  });
});

describe('Undo in the sample client', () => {
  it('saves an answer, lists it, and Undo brings the same question back', async () => {
    const api = createMockClient();
    const q = (await api.review()).questions[0]!;
    const { answerId } = await api.answer(q.id, { none: true }, { fromSuggestion: false, seen: q.seen });
    expect(answerId).toBeTruthy();
    expect((await api.review()).questions.some((x) => x.id === q.id)).toBe(false);
    expect((await api.activity()).answers[0]).toMatchObject({ id: answerId, questionId: q.id, undoable: true, undone: false });

    expect(await api.undoAnswer(answerId!)).toEqual({ questionId: q.id });
    expect((await api.review()).questions.find((x) => x.id === q.id)).toEqual(q);
    expect((await api.activity()).answers[0]).toMatchObject({ undoable: false, undone: true });
    await expect(api.undoAnswer(answerId!)).rejects.toThrow(/already/);
  });
});
