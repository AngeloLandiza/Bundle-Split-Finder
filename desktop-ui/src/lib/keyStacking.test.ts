// Key stacking in the screens' pure helpers: the notice that names a refused key by its label, the sidebar's line and its
// tooltip, and the state as the agent sends it (map.ts). No value of a key is ever in the state.

import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import { keyEntriesOf, keyEntryProblemsOf } from '../api/map';
import type { AppState } from '../api/types';
import { rejectedKeysWords } from './keyStatus';
import { rejectedKeyNotice, SCREEN_KEYS } from './notices';
import { sidebarStatus } from './sidebarStatus';

const at = '2026-11-25T15:00:00.000Z';
const make = (patch: (s: AppState) => void): AppState => {
  const s = structuredClone(STATE);
  patch(s);
  return s;
};
const twoKeys = (s: AppState) => {
  s.budget = { ...s.budget, serpLeft: 203, keepaTokens: 57, keepaRefillPerMin: 1 };
  s.keyEntries = {
    serpapi: [
      { id: 'serpapi-1', label: 'Key 1', addedAt: null, check: { ok: true, at }, searchesLeft: 60, searchesPerMonth: 250 },
      { id: 'serpapi-b', label: 'Partner', addedAt: at, check: { ok: true, at }, searchesLeft: 143, searchesPerMonth: 250 },
    ],
  };
};

describe('a refused key among several', () => {
  const partial = (s: AppState) => {
    twoKeys(s);
    s.keyEntries!.serpapi!.push({ id: 'serpapi-c', label: 'Key 3', addedAt: at, check: { ok: false, at, problem: 'SerpApi did not accept this key.' }, searchesLeft: null, searchesPerMonth: null });
    s.keyEntryProblems = [{ service: 'serpapi', id: 'serpapi-c', label: 'Key 3', problem: 'SerpApi Key 3 is not accepted. SerpApi did not accept this key.' }];
  };

  it('the banner names it by its label and says the others carry on, on the screens that use SerpApi', () => {
    const s = make(partial);
    expect(rejectedKeyNotice(s, SCREEN_KEYS.today)).toEqual({ title: 'SerpApi Key 3 is not accepted.', text: 'SerpApi did not accept this key. Your other SerpApi keys carry on.' });
    expect(rejectedKeyNotice(s, SCREEN_KEYS.deals)?.title).toBe('SerpApi Key 3 is not accepted.');
    expect(rejectedKeyNotice(s, SCREEN_KEYS.review)).toBeNull();
  });

  it('the sidebar says it on its problem line, which goes to Settings, Keys', () => {
    const s = make(partial);
    expect(rejectedKeysWords(s)).toBe('SerpApi Key 3 not accepted');
    expect(sidebarStatus(s).problem).toEqual({ text: 'SerpApi Key 3 not accepted', to: { screen: 'settings', id: 'keys' } });
  });

  it('every key refused is the service-wide notice, as with one key', () => {
    const s = make((x) => {
      x.keyProblems = { serpapi: 'Every SerpApi key was refused. Key 1: SerpApi did not accept this key.' };
    });
    expect(rejectedKeyNotice(s, SCREEN_KEYS.today)?.title).toBe('The SerpApi key is not accepted.');
    expect(rejectedKeysWords(s)).toBe('SerpApi key not accepted');
  });
});

describe('the sidebar with two keys', () => {
  it('keeps the total on the line and gives each key in the tooltip', () => {
    const v = sidebarStatus(make(twoKeys));
    expect(v.usage).toBe('203 searches left · Keepa 57 tokens');
    expect(v.usageFull).toBe('203 searches left · Keepa 57 tokens · 1 a minute · SerpApi Key 1 60 · Partner 143');
  });

  it('with one key reads as before', () => {
    const v = sidebarStatus(make((s) => {
      s.budget = { ...s.budget, serpLeft: 119, keepaTokens: 57, keepaRefillPerMin: 1 };
      s.keyEntries = { serpapi: [{ id: 'serpapi-1', label: 'Key 1', addedAt: null, check: { ok: true, at }, searchesLeft: 119, searchesPerMonth: 250 }] };
    }));
    expect(v.usageFull).toBe('119 searches left · Keepa 57 tokens · 1 a minute');
  });
});

describe('the state as the agent sends it', () => {
  it('keeps each key view and drops a record without an id or a label', () => {
    const entries = keyEntriesOf({
      serpapi: [{ id: 'serpapi-1', label: 'Key 1', addedAt: null, check: { ok: true, at, detail: '60 of 250 searches left' }, searchesLeft: 60, searchesPerMonth: 250 }, { label: 'no id' }],
      keepa: [{ id: 'keepa-1', label: 'Key 1', addedAt: at, tokensLeft: 57, refillPerMin: 1 }],
      ebay: [{ id: 'x', label: 'y' }],
    });
    expect(entries).toEqual({
      serpapi: [{ id: 'serpapi-1', label: 'Key 1', addedAt: null, check: { ok: true, at, detail: '60 of 250 searches left' }, searchesLeft: 60, searchesPerMonth: 250 }],
      keepa: [{ id: 'keepa-1', label: 'Key 1', addedAt: at, tokensLeft: 57, refillPerMin: 1 }],
    });
    expect(keyEntriesOf(null)).toBeUndefined();
    expect(keyEntryProblemsOf([{ service: 'serpapi', id: 'b', label: 'Key 2', problem: 'p' }, { service: 'ebay', id: 'x', label: 'y', problem: 'z' }])).toEqual([{ service: 'serpapi', id: 'b', label: 'Key 2', problem: 'p' }]);
  });
});
