// What the panel keeps of an Ask AI call (step 11, A2): the price said on the button, the suggestion for the
// question as it is now, and whether the owner's answer is the one suggested. Real questions from the validation
// replay; the model's answers are written here.

import { describe, expect, it } from 'vitest';

import { askCostLabel, estimatedAskCost } from '../src/assist/cost';
import { gatherEvidence } from '../src/assist/evidence';
import { agreedWith, liveSuggestion, MemorySuggestionStore, proposedAnswer, suggestionCost, suggestionKey, type StoredSuggestion } from '../src/assist/stored';
import type { AssistRaw, Suggestion } from '../src/assist/types';
import { verifySuggestion } from '../src/assist/verify';
import { reviewSignature } from '../src/scan/answers';
import type { ReviewItem } from '../src/scan/types';
import { asked, assistWorld } from './assist-world';

describe('the price on the Ask AI button', () => {
  it('rounds the estimate up to a whole cent, never to $0.00', () => {
    expect(askCostLabel('claude-opus-5-5')).toBe('about $0.02');
    // 1,800 tokens in and 500 out on Haiku is under half a cent.
    expect(estimatedAskCost('claude-haiku-5-5')).toBeLessThan(0.005);
    expect(askCostLabel('claude-haiku-5-5')).toBe('about $0.01');
  });

  it('says nothing for a model with no published rate', () => {
    expect(estimatedAskCost('some-other-model')).toBeNull();
    expect(askCostLabel('some-other-model')).toBeNull();
  });

  it('prices a call from its usage at the model rate, and not a call without usage', () => {
    expect(suggestionCost('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(6, 6);
    expect(suggestionCost('claude-opus-5-5', undefined)).toBeNull();
    expect(suggestionCost('some-other-model', { inputTokens: 5, outputTokens: 5 })).toBeNull();
  });
});

const PSK1212SB_INCLUDES = 'Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries, (1) PBP003 18V ONE+ 2Ah Lithium Battery, (1) PCG002 18V ONE+ Charger';
const raw = (a: Partial<AssistRaw>): AssistRaw => ({ evidence: [], reason: 'Because.', decision: 'choose', choiceIndex: null, asin: null, ...a });

async function suggestionFor(id: string, a: Partial<AssistRaw>): Promise<{ q: ReviewItem; s: Suggestion }> {
  const w = await assistWorld();
  const q = asked(w, id);
  const checked = verifySuggestion(JSON.stringify(raw(a)), q, await gatherEvidence(w.store, q));
  return { q, s: { questionId: q.id, seen: reviewSignature(q), provider: 'claude', model: 'claude-haiku-5-5', promptVersion: 'v', ...checked } };
}

const stored = (q: ReviewItem, s: Suggestion, askedAt: number, over: Partial<StoredSuggestion> = {}): StoredSuggestion => ({
  key: suggestionKey(q.id, askedAt), questionId: q.id, seen: reviewSignature(q), askedAt, suggestion: s, costUsd: null, ...over,
});

const PSK = 'split:homedepot:339206615';
const RIGHT: Partial<AssistRaw> = { evidence: [{ quote: PSK1212SB_INCLUDES, source: 'bundle' }], choiceIndex: 0 };

describe('the suggestion shown for a question', () => {
  it('is the latest one made for the question as it is now', async () => {
    const { q, s } = await suggestionFor(PSK, RIGHT);
    const first = stored(q, s, 100);
    const second = stored(q, s, 200);
    expect(liveSuggestion([first, second], q)?.key).toBe(second.key);
  });

  it('is not one made for other choices: the signature is what the question offered when it was asked', async () => {
    const { q, s } = await suggestionFor(PSK, RIGHT);
    const old = stored(q, s, 100, { seen: JSON.stringify([['OTHER']]) });
    expect(liveSuggestion([old], q)).toBeUndefined();
    // A scan that reads the question differently makes the same: nothing shown.
    expect(liveSuggestion([stored(q, s, 100)], { ...q, choices: [['PBP004', 'PCG002']] })).toBeUndefined();
  });

  it('is not shown once the question is answered, or once the owner has answered with it shown', async () => {
    const { q, s } = await suggestionFor(PSK, RIGHT);
    expect(liveSuggestion([stored(q, s, 100)], { ...q, answer: 'PBP004,PBP003,PCG002' })).toBeUndefined();
    expect(liveSuggestion([stored(q, s, 100, { outcome: { answeredAt: 5, answer: 'x', agreed: true } })], q)).toBeUndefined();
  });

  it('is not a call that gave nothing', async () => {
    const w = await assistWorld();
    const q = asked(w, PSK);
    const none: Suggestion = { questionId: q.id, seen: reviewSignature(q), provider: 'claude', model: 'm', promptVersion: 'v', status: 'not_suggested', reason: 'Claude could not be reached.' };
    expect(liveSuggestion([stored(q, none, 100)], q)).toBeUndefined();
  });
});

describe('whether the owner agreed', () => {
  it('a verified reading: the owner chose its parts (agreed) or something else', async () => {
    const { q, s } = await suggestionFor(PSK, RIGHT);
    expect(s.status).toBe('verified');
    expect(proposedAnswer(s, q)).toBe('PBP004,PBP003,PCG002');
    expect(agreedWith(s, { ...q, answer: 'PBP004,PBP003,PCG002' })).toBe(true);
    expect(agreedWith(s, { ...q, answer: 'none' })).toBe(false);
    expect(agreedWith(s, { ...q, answer: 'PBP004,PCG002' })).toBe(false);
  });

  it('a verified "none of these" agrees with the owner saying none', async () => {
    const { q, s } = await suggestionFor(PSK, { decision: 'none', evidence: [{ quote: PSK1212SB_INCLUDES, source: 'bundle' }] });
    expect(s.status).toBe('verified');
    expect(proposedAnswer(s, q)).toBe('none');
    expect(agreedWith(s, { ...q, answer: 'none' })).toBe(true);
    expect(agreedWith(s, { ...q, answer: 'PBP004,PBP003,PCG002' })).toBe(false);
  });

  it("an unverified claim is still compared with the owner's own choice", async () => {
    const { q, s } = await suggestionFor(PSK, { evidence: [{ quote: 'a line the page does not have', source: 'bundle' }], choiceIndex: 0 });
    expect(s.status).toBe('unverified');
    expect(proposedAnswer(s, q)).toBe('PBP004,PBP003,PCG002');
    expect(agreedWith(s, { ...q, answer: 'PBP004,PBP003,PCG002' })).toBe(true);
    // A claimed reading that is not one the question offers proposes nothing.
    const out = verifySuggestion(JSON.stringify(raw({ choiceIndex: 9 })), q, await gatherEvidence((await assistWorld()).store, q));
    expect(proposedAnswer({ ...s, ...out }, q)).toBeNull();
  });

  it('cannot tell proposes nothing, so there is nothing to agree or disagree with', async () => {
    const { q, s } = await suggestionFor(PSK, { decision: 'cannot_tell' });
    expect(s.status).toBe('cannot_tell');
    expect(agreedWith(s, { ...q, answer: 'none' })).toBeNull();
  });
});

describe('the memory store', () => {
  it('keeps every ask, oldest first, and hands back copies', async () => {
    const { q, s } = await suggestionFor(PSK, RIGHT);
    const store = new MemorySuggestionStore();
    await store.put(stored(q, s, 200));
    await store.put(stored(q, s, 100));
    const all = await store.list();
    expect(all.map((r) => r.askedAt)).toEqual([100, 200]);
    all[0]!.costUsd = 99;
    expect((await store.list())[0]!.costUsd).toBeNull();
  });
});
