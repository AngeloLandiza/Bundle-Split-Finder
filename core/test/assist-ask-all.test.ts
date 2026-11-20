// Ask AI about all (step 12, R3): which open questions a queue asks about, what Approve all sends for a verified suggestion,
// what a parts answer proposes, and what the estimate says. Real questions of the validation replay, no network.

import { describe, expect, it } from 'vitest';
import { agreedWith, proposedAnswer, type StoredSuggestion } from '../src/assist/stored';
import { approvalOf, verifiedRows } from '../src/assist/approve';
import { askQueueOf, canAsk } from '../src/assist/askAll';
import { expandParts } from '../src/assist/parts';
import { askAllCostLabel, estimatedAskCost, estimatedQuestionCost, questionCostLabel } from '../src/assist/cost';
import type { Suggestion } from '../src/assist/types';
import { reviewSignature } from '../src/scan/answers';
import type { ReviewItem } from '../src/scan/types';
import { asked, assistWorld, type AssistWorld } from './assist-world';

const MODEL = 'claude-haiku-5-5';
const ONE_READING = 'split:homedepot:339206615';
const NO_READING = 'split:homedepot:314716732';
const MATCH_ONE = 'match:RYOBI:PBP004';
const MATCH_MANY = 'match:RYOBI:P553';

const meta = (q: ReviewItem) => ({ questionId: q.id, seen: reviewSignature(q), provider: 'anthropic', model: MODEL, promptVersion: 'test' });
const stored = (q: ReviewItem, suggestion: Suggestion, askedAt = 1): StoredSuggestion => ({ key: `${q.id}|${askedAt}`, questionId: q.id, seen: suggestion.seen, askedAt, suggestion, costUsd: 0.01 });
const verifiedChoice = (q: ReviewItem, choiceIndex = 0): Suggestion => ({
  ...meta(q), status: 'verified', reason: 'r', quotes: [],
  answer: { decision: 'choose', kind: 'split', choiceIndex, parts: q.choices[choiceIndex]! },
});
const verifiedParts = (q: ReviewItem, parts: { model: string; qty: number }[]): Suggestion => ({
  ...meta(q), status: 'verified', reason: 'r', quotes: [{ quote: 'q', sourceId: 'bundle', label: 'Home Depot page', url: 'https://www.homedepot.com/p/1', names: true }],
  answer: { decision: 'choose', kind: 'parts', parts },
});
const cannotTell = (q: ReviewItem): Suggestion => ({ ...meta(q), status: 'cannot_tell', reason: 'no', quotes: [] });

describe('which questions a queue asks about', async () => {
  const w: AssistWorld = await assistWorld();
  const q = (id: string) => asked(w, id);

  it('asks a split question even with no reading (research can read the page), and a match question only with a listing to choose', () => {
    expect(canAsk(q(ONE_READING))).toBe(true);
    expect(canAsk(q(NO_READING))).toBe(true);
    expect(canAsk(q(MATCH_ONE))).toBe(true);
    expect(canAsk({ ...q(MATCH_ONE), candidates: [] })).toBe(false);
  });

  it('leaves out an answered question, one that already has a suggestion of any kind, and a match question with no listing', () => {
    const open = [q(ONE_READING), q(NO_READING), q(MATCH_ONE), q(MATCH_MANY), { ...q('match:RYOBI:PCL265B'), candidates: [] }];
    const answered = { ...q('split:homedepot:341644756'), answer: 'none', answeredAt: 1 };
    const records = [stored(q(MATCH_ONE), cannotTell(q(MATCH_ONE)))];
    expect(askQueueOf([...open, answered], records).map((x) => x.id)).toEqual([ONE_READING, NO_READING, MATCH_MANY]);
  });

  it('asks again about a question whose suggestion was made for other readings (it is not shown, so it is not a suggestion)', () => {
    const old = { ...q(ONE_READING), choices: [['PBP004', 'PCG002']] };
    expect(askQueueOf([q(ONE_READING)], [stored(old, verifiedChoice(old))]).map((x) => x.id)).toEqual([ONE_READING]);
  });

  it('keeps the order it is given', () => {
    expect(askQueueOf([q(MATCH_MANY), q(ONE_READING)], []).map((x) => x.id)).toEqual([MATCH_MANY, ONE_READING]);
  });
});

describe('what Approve all sends', async () => {
  const w = await assistWorld();
  const q = (id: string) => asked(w, id);

  it('a verified reading is the choice, with the signature of the question as shown', () => {
    const item = q(ONE_READING);
    expect(approvalOf(verifiedChoice(item), item)).toEqual({ choice: 0, seen: reviewSignature(item) });
  });

  it('a verified listing is the choice of that candidate', () => {
    const item = q(MATCH_MANY);
    const second = item.candidates[1]!;
    const s: Suggestion = { ...meta(item), status: 'verified', reason: 'r', quotes: [], answer: { decision: 'choose', kind: 'match', asin: second.asin, title: second.title } };
    expect(approvalOf(s, item)).toEqual({ choice: 1, seen: reviewSignature(item) });
  });

  it('a verified parts answer is the typed-parts answer: each part as many times as its count, one model per entry', () => {
    const item = q(NO_READING);
    const s = verifiedParts(item, [{ model: 'dck940d2', qty: 1 }, { model: 'DCB203', qty: 2 }]);
    expect(approvalOf(s, item)).toEqual({ parts: ['DCK940D2', 'DCB203', 'DCB203'], seen: reviewSignature(item) });
    expect(expandParts([{ model: 'DCB203', qty: 2 }])).toEqual(['DCB203', 'DCB203']);
  });

  it('nothing else is ever approved: not an unverified, cannot-tell or none suggestion, not a reading the question no longer has, not parts for a match question', () => {
    const item = q(ONE_READING);
    expect(approvalOf(cannotTell(item), item)).toBeNull();
    expect(approvalOf({ ...meta(item), status: 'unverified', reasons: ['x'], claimed: null }, item)).toBeNull();
    expect(approvalOf({ ...meta(item), status: 'none_suggested', reason: 'x', quotes: [] }, item)).toBeNull();
    expect(approvalOf({ ...meta(item), status: 'not_suggested', reason: 'x' }, item)).toBeNull();
    expect(approvalOf(verifiedChoice(item, 3), item)).toBeNull();
    const match = q(MATCH_ONE);
    expect(approvalOf(verifiedParts(match, [{ model: 'PBP004', qty: 1 }]), match)).toBeNull();
    // A parts answer with a count that is not a whole number, or nothing in it, is not one.
    expect(approvalOf(verifiedParts(item, [{ model: 'PBP004', qty: 0 }]), item)).toBeNull();
    expect(approvalOf(verifiedParts(item, [{ model: 'PBP004', qty: 1.5 }]), item)).toBeNull();
    expect(approvalOf(verifiedParts(item, []), item)).toBeNull();
    expect(approvalOf(verifiedParts(item, [{ model: 'PBP004', qty: 5 }, { model: 'PBP003', qty: 4 }]), item)).toBeNull();
  });

  it('the rows of the section are the open questions whose live suggestion is verified and approvable, in the order of the questions', () => {
    const a = q(ONE_READING);
    const b = q(NO_READING);
    const c = q(MATCH_ONE);
    const records = [stored(a, verifiedChoice(a)), stored(b, verifiedParts(b, [{ model: 'DCK940D2', qty: 1 }, { model: 'DCB203', qty: 2 }])), stored(c, cannotTell(c))];
    const rows = verifiedRows([a, b, c], records);
    expect(rows.map((r) => r.item.id)).toEqual([ONE_READING, NO_READING]);
    expect(rows.map((r) => r.answer)).toEqual([{ choice: 0, seen: reviewSignature(a) }, { parts: ['DCK940D2', 'DCB203', 'DCB203'], seen: reviewSignature(b) }]);
    // An answered question is not a row.
    expect(verifiedRows([{ ...a, answer: 'none', answeredAt: 1 }], records)).toEqual([]);
  });
});

describe('a verified parts answer in the suggestion store', async () => {
  const w = await assistWorld();
  const item = asked(w, NO_READING);
  const s = verifiedParts(item, [{ model: 'DCK940D2', qty: 1 }, { model: 'DCB203', qty: 2 }]);

  it('proposes what the owner would have saved by Approve: the parts joined by ","', () => {
    expect(proposedAnswer(s, item)).toBe('DCK940D2,DCB203,DCB203');
  });

  it('is agreed with when the owner saves the same parts, and disagreed with for any other', () => {
    expect(agreedWith(s, { ...item, answer: 'DCK940D2,DCB203,DCB203' })).toBe(true);
    expect(agreedWith(s, { ...item, answer: 'DCK940D2,DCB203' })).toBe(false);
    expect(agreedWith(s, { ...item, answer: 'none' })).toBe(false);
  });
});

describe('what asking costs, said before the click', () => {
  it('a listing costs the one-call estimate and a split the research estimate, which is larger', () => {
    expect(estimatedQuestionCost('match', MODEL)).toBe(estimatedAskCost(MODEL));
    expect(estimatedQuestionCost('split', MODEL)!).toBeGreaterThan(estimatedQuestionCost('match', MODEL)!);
    expect(estimatedQuestionCost('split', 'a-model-with-no-rate')).toBeNull();
  });

  it('is said rounded up, never "$0.00"', () => {
    expect(questionCostLabel('match', MODEL)).toBe('about $0.01');
    expect(questionCostLabel('match', 'claude-opus-5-5')).toBe('about $0.02');
    expect(questionCostLabel('split', 'claude-opus-5-5')).toBe('about $0.10');
    expect(questionCostLabel('split', 'a-model-with-no-rate')).toBeNull();
  });

  it('for all: the sum, in cents under a dollar and in whole dollars from a dollar, rounded up; null when no rate or nothing to ask', () => {
    expect(askAllCostLabel(['split', 'split', 'match'], 'claude-opus-5-5')).toBe('about $0.22');
    expect(askAllCostLabel(Array.from({ length: 26 }, () => 'split' as const), 'claude-opus-5-5')).toBe('about $3');
    expect(askAllCostLabel(['split'], 'a-model-with-no-rate')).toBeNull();
    expect(askAllCostLabel([], MODEL)).toBeNull();
  });
});
