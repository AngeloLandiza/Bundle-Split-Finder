import { describe, expect, it } from 'vitest';
import { DEALS, STATE } from '../api/mockData';
import type { AppState, DealRow } from '../api/types';
import { AI_INTRO, aiIntroDismissed, dismissAiIntro } from './aiIntro';
import { dealReason, matchColumnShown, waitingState } from './dealReason';
import { keepaWords, keyState, rejectedKeys, rejectedKeysWords } from './keyStatus';
import { setupProgress } from './setup';

const withProblem = (patch: (s: AppState) => void): AppState => {
  const s = structuredClone(STATE);
  patch(s);
  return s;
};

describe('a rejected key', () => {
  const s = withProblem((x) => {
    x.keys.ebay = true;
    x.keyProblems = { ebay: 'eBay did not accept the App ID and Cert ID. Use the production keys from developer.ebay.com, not the sandbox pair.', telegram: 'stale' };
  });
  it('is saved but not working, with the agent’s sentence', () => {
    expect(keyState(s, 'ebay')).toEqual({ state: 'rejected', problem: 'eBay did not accept the App ID and Cert ID. Use the production keys from developer.ebay.com, not the sandbox pair.' });
    expect(keyState(s, 'serpapi')).toEqual({ state: 'saved', problem: null });
  });
  it('ignores a problem for a key that is not saved', () => {
    expect(keyState(s, 'telegram')).toEqual({ state: 'missing', problem: null });
    expect(rejectedKeys(s)).toEqual(['ebay']);
  });
  it('is said in the sidebar in a few words', () => {
    expect(rejectedKeysWords(s)).toBe('eBay key not accepted');
    expect(rejectedKeysWords(withProblem((x) => { x.keys.keepa = true; x.keyProblems = { ebay: 'a', keepa: 'b' }; }))).toBe('2 keys not accepted');
    expect(rejectedKeysWords(STATE)).toBeNull();
  });
  it('never counts a rejected SerpApi key as setup done', () => {
    expect(setupProgress(STATE).steps.find((x) => x.id === 'key')?.done).toBe(true);
    expect(setupProgress(withProblem((x) => { x.keyProblems = { serpapi: 'SerpApi did not accept this key.' }; })).steps.find((x) => x.id === 'key')?.done).toBe(false);
  });
});

describe('Keepa tokens', () => {
  it('reads "Keepa 57 tokens · 1 a minute" with a Keepa key and the tokens', () => {
    expect(keepaWords(withProblem((x) => { x.keys.keepa = true; x.budget.keepaTokens = 57; x.budget.keepaRefillPerMin = 1; }))).toBe('Keepa 57 tokens · 1 a minute');
    expect(keepaWords(withProblem((x) => { x.budget.keepaTokens = 1; x.budget.keepaRefillPerMin = undefined; }))).toBe('Keepa 1 token');
  });
  it('is nothing without a key or before the tokens are known', () => {
    expect(keepaWords(withProblem((x) => { x.keys.keepa = false; }))).toBeNull();
    expect(keepaWords(withProblem((x) => { x.budget.keepaTokens = null; }))).toBeNull();
  });
});

describe('a deal row’s reason line', () => {
  const row = (patch: Partial<DealRow>): DealRow => ({ ...DEALS[0]!, profit: null, roi: null, needsAnswer: false, lookup: null, matchKind: null, matchState: null, bogoChoices: null, ...patch });
  const wide = { matchShown: true };
  const narrow = { matchShown: false };

  it('says nothing the Match column already says: a matched row, a question and a waiting row have no third line', () => {
    expect(dealReason(row({ profit: 38, matchState: 'All 3 parts matched' }), wide)).toBeNull();
    expect(dealReason(row({ matchState: '2 of 3 parts matched' }), wide)).toBeNull();
    expect(dealReason(row({ lookup: { searches: 2 } }), wide)).toBeNull();
    expect(dealReason(row({ matchKind: 'waiting_parts', lookup: { searches: 2 } }), wide)).toBeNull();
    expect(dealReason(row({ needsAnswer: true, profit: 12 }), wide)).toBeNull();
    expect(dealReason(row({}), wide)).toBeNull();
  });
  it('says what the hidden Match column would have said when the table is narrow', () => {
    expect(dealReason(row({ profit: 38, matchState: 'All 3 parts matched' }), narrow)).toBe('All 3 parts matched');
    expect(dealReason(row({ matchState: '2 of 3 parts matched' }), narrow)).toBe('2 of 3 parts matched');
    expect(dealReason(row({ lookup: { searches: 2 } }), narrow)).toBe('Waiting for an Amazon lookup');
    expect(dealReason(row({ matchKind: 'waiting_parts', lookup: { searches: 2 } }), narrow)).toBe('Waiting for Home Depot’s part pages');
    expect(dealReason(row({ needsAnswer: true, profit: 12 }), narrow)).toBe('What is inside is not settled. Answer in Review.');
    expect(dealReason(row({}), narrow)).toBeNull();
  });
  it('puts the waiting page before an Amazon lookup', () => {
    expect(waitingState(row({ matchKind: 'waiting_page', lookup: { searches: 2 } }))).toBe('Waiting for its Home Depot page');
  });
  it('adds the BOGO group sentence, which no column shows', () => {
    const bogoChoices = { label: 'BOGO: 11 free-tool choices — best: PCL265B +$61.50 est.', count: 11, bestId: 'x', best: true };
    expect(dealReason(row({ bogoChoices }), wide)).toBe(bogoChoices.label);
    expect(dealReason(row({ bogoChoices, matchState: '3 parts matched' }), narrow)).toBe(`3 parts matched · ${bogoChoices.label}`);
  });
  it('knows from the table width whether the Match column shows', () => {
    expect(matchColumnShown(900)).toBe(true);
    expect(matchColumnShown(720)).toBe(false);
    expect(matchColumnShown(500)).toBe(false);
  });
});

describe('the first-use line for AI suggestions', () => {
  const store = (): Pick<Storage, 'getItem' | 'setItem'> => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };
  it('says what the AI does, that it can be wrong and that only checked answers apply without him', () => {
    expect(AI_INTRO).toMatch(/can be wrong/);
    expect(AI_INTRO).toMatch(/Only answers the code has checked/);
  });
  it('shows until it is dismissed, then is remembered', () => {
    const st = store();
    expect(aiIntroDismissed(st)).toBe(false);
    dismissAiIntro(st);
    expect(aiIntroDismissed(st)).toBe(true);
  });
  it('shows again, harmlessly, where storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(aiIntroDismissed(blocked)).toBe(false);
    expect(() => dismissAiIntro(blocked)).not.toThrow();
    expect(aiIntroDismissed(null)).toBe(false);
  });
});
