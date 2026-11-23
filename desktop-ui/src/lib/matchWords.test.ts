import { describe, expect, it } from 'vitest';
import real from '../api/mockReal.json';
import { matchWords, partsSummary } from './matchWords';

// Every matchState the owner's third scan produced, and what a reseller reads for it.
const WORDS: Record<string, string> = {
  '1 part to look up': '1 part waiting for an Amazon lookup',
  '1 part with no listing · 1 to verify': '1 part has no Amazon listing · 1 listing not confirmed yet',
  '2 title matches': '2 listings not confirmed yet',
  '1 title match': '1 listing not confirmed yet',
  '1 listing inactive': '1 listing is not for sale right now',
  '4 parts to verify': '4 listings not confirmed yet',
  '1 part with no listing': '1 part has no Amazon listing',
  '2 parts with no listing': '2 parts have no Amazon listing',
};

describe('match words', () => {
  it('words every matchState in the owner\'s real scan, and the table has no jargon left', () => {
    const states = [...new Set((real.scan3.deals.rows as { matchState: string | null }[]).map((r) => r.matchState).filter((s): s is string => s !== null))];
    expect(states.length).toBeGreaterThan(5);
    for (const s of states) {
      expect(WORDS[s], `no wording for the real state "${s}"`).toBeDefined();
      expect(matchWords(s)).toBe(WORDS[s]);
      expect(matchWords(s)).not.toMatch(/title match|to verify|inactive|\bmatched\b/);
    }
  });

  it('says "1 of 2" when the inspector knows how many parts there are', () => {
    expect(matchWords('1 title match', { total: 2 })).toBe('1 of 2 listings not confirmed yet');
    expect(matchWords('2 title matches', { total: 2 })).toBe('2 of 2 listings not confirmed yet');
    expect(matchWords('1 title match', { total: 1 })).toBe('1 listing not confirmed yet');
    expect(matchWords('1 part with no listing · 1 to verify', { total: 2 })).toBe('1 part has no Amazon listing · 1 of 2 listings not confirmed yet');
  });

  it('words the other sentences core can send', () => {
    expect(matchWords('2 parts matched')).toBe('All 2 parts on confirmed listings');
    expect(matchWords('1 part matched')).toBe('Its part is on a confirmed listing');
    expect(matchWords('2 listings inactive')).toBe('2 listings are not for sale right now');
    expect(matchWords('3 parts unknown')).toBe('3 parts not looked up on Amazon yet');
    expect(matchWords('No bundle price')).toBe('Home Depot shows no price for it');
    expect(matchWords(null)).toBeNull();
  });

  it('returns a sentence it does not know as the agent wrote it', () => {
    expect(matchWords('Waiting for its Home Depot page')).toBe('Waiting for its Home Depot page');
  });
});

describe('the parts summary in the inspector', () => {
  it('says all confirmed, or what is not', () => {
    expect(partsSummary([])).toBeNull();
    expect(partsSummary(['verified', 'verified'])).toBe('All 2 parts are on confirmed Amazon listings.');
    expect(partsSummary(['verified', 'title_match'])).toBe('1 of 2 parts on a confirmed listing; 1 not confirmed yet.');
    expect(partsSummary(['missing', 'title_match'])).toBe('1 not confirmed yet; 1 has no Amazon listing.');
    expect(partsSummary(['inactive'])).toBe('1 is not for sale right now.');
  });
});
