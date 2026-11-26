import { describe, expect, it } from 'vitest';

import type { KeyEntryView } from '../api/types';
import { acrossWords, ADD_ANOTHER_HELP, addedWords, entryCheckWords, perKeySplit, removeEntryQuestion } from './keyEntries';

const at = '2026-11-25T15:00:00.000Z';
const serp = (over: Partial<KeyEntryView>): KeyEntryView => ({ id: 'k', label: 'Key 1', addedAt: null, check: { ok: true, at }, searchesLeft: 143, searchesPerMonth: 250, ...over });

describe('key stacking words', () => {
  it("each key's check: accepted with its own balance, refused in the service's words, or not checked yet", () => {
    expect(entryCheckWords('serpapi', serp({}))).toEqual({ tone: 'works', text: 'Accepted, 143 of 250 searches left this month' });
    expect(entryCheckWords('keepa', { id: 'k', label: 'Key 1', addedAt: null, check: { ok: true, at }, tokensLeft: 300, refillPerMin: 5 })).toEqual({ tone: 'works', text: 'Accepted, 300 tokens, 5 a minute' });
    expect(entryCheckWords('serpapi', serp({ check: { ok: false, at, problem: 'SerpApi did not accept this key.' } }))).toEqual({ tone: 'rejected', text: 'Not accepted. SerpApi did not accept this key.' });
    expect(entryCheckWords('serpapi', serp({ check: undefined }))).toEqual({ tone: 'unknown', text: 'Not checked yet' });
    expect(entryCheckWords('serpapi', serp({ searchesLeft: null, check: { ok: true, at, detail: '118 of 250 searches left' } })).text).toBe('Accepted, 118 of 250 searches left');
  });

  it('the split after a total, only with more than one key', () => {
    const state = { keyEntries: { serpapi: [serp({ label: 'Key 1', searchesLeft: 60 }), serp({ id: 'b', label: 'Partner', searchesLeft: 143 }), serp({ id: 'c', label: 'Key 3', check: { ok: false, at } })] } };
    expect(perKeySplit(state, 'serpapi')).toBe('Key 1 60 · Partner 143 · Key 3 not accepted');
    expect(acrossWords(state, 'serpapi')).toBe('across 3 keys');
    expect(perKeySplit({ keyEntries: { serpapi: [serp({})] } }, 'serpapi')).toBeNull();
    expect(acrossWords({ keyEntries: { serpapi: [serp({})] } }, 'serpapi')).toBeNull();
    expect(perKeySplit(null, 'keepa')).toBeNull();
  });

  it('the added date, none for a key from before key stacking', () => {
    expect(addedWords(at, Date.parse(at))).toBe('Added Nov 25');
    expect(addedWords('2025-03-02T10:00:00.000Z', Date.parse(at))).toBe('Added Mar 2, 2025');
    expect(addedWords(null)).toBeNull();
  });

  it('never suggests opening several free accounts; says whose terms', () => {
    for (const help of Object.values(ADD_ANOTHER_HELP)) {
      expect(help).toContain("another account, for example your partner's or a paid plan");
      expect(help).toContain("You are responsible for keeping to each account's terms.");
      expect(help).not.toMatch(/free accounts|sign up again|another free/i);
    }
    expect(removeEntryQuestion('serpapi', 'Partner')).toBe('Remove SerpApi Partner? Its searches no longer count; your other keys stay.');
  });
});
