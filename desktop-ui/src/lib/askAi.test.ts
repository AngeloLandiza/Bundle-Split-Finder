import { describe, expect, it } from 'vitest';
import { QUESTIONS } from '../api/mockData';
import type { ReviewQuestion } from '../api/types';
import { QUEUED_MS, askSig, forceLabel, noteOf, refusedHere, settled } from './askAi';

const base = QUESTIONS.find((q) => q.id === 'q-pcl2001')!;
const q: ReviewQuestion = { ...base, askCostUsd: 0.07 };

describe('what Ask AI says', () => {
  it('queued: the row says it is checking again until the question changes', () => {
    const note = noteOf({ queued: true }, q, 1000);
    expect(note).toMatchObject({ phase: 'queued' });
    expect(settled({ [q.id]: note }, [q], 2000)[q.id]).toBe(note);
    // The agent took it up: the question now has a follow-up, so the note is over.
    const taken: ReviewQuestion = { ...q, followUp: { state: 'queued', tried: [], roundsLeft: 2 } };
    expect(settled({ [q.id]: note }, [taken], 2000)).toEqual({});
    // Never followed up: it does not spin for ever. A question that is gone ends it too.
    expect(settled({ [q.id]: note }, [q], 1000 + QUEUED_MS + 1)).toEqual({});
    expect(settled({ [q.id]: note }, [], 2000)).toEqual({});
    expect(askSig(taken)).not.toBe(askSig(q));
  });

  it('declined for nothing new: the reason, and the one action it implies, with its price', () => {
    const note = noteOf({ queued: false, reason: 'Nothing new to read since the last answer.' }, q, 0);
    expect(note).toEqual({ phase: 'declined', reason: 'Nothing new to read since the last answer.', force: true, sig: askSig(q) });
    expect(forceLabel(note, q)).toBe('Ask anyway · about $0.07');
  });

  it('declined for any other reason: said as it is, with no action that would not change it', () => {
    const note = noteOf({ queued: false, reason: 'The app is already working on this one.' }, q, 0);
    expect(note).toMatchObject({ phase: 'declined', force: false });
    expect(forceLabel(note, q)).toBeNull();
    // No model call would be made: nothing to force.
    expect(noteOf({ queued: false, reason: 'Nothing new to read.' }, { ...q, askCostUsd: null }, 0)).toMatchObject({ force: false });
  });

  it('answers a press at once, without the agent, when it cannot start', () => {
    expect(refusedHere(q, { hasAi: true })).toBeNull();
    expect(refusedHere(q, { hasAi: false })).toMatch(/needs an Anthropic or OpenAI key/);
    expect(refusedHere({ ...q, askCostUsd: null }, { hasAi: true })).toMatch(/nothing more the AI could read/);
    expect(refusedHere({ ...q, followUp: { state: 'running', tried: [], roundsLeft: 1 } }, { hasAi: true })).toMatch(/already working/);
  });
});
