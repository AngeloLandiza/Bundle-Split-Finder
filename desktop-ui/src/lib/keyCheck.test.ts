import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import type { AppState } from '../api/types';
import { ebayHints, keyCheckLine, worksWords } from './keyCheck';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const withState = (patch: (s: AppState) => void): AppState => {
  const s = structuredClone(STATE);
  patch(s);
  return s;
};

describe('the eBay shape hints', () => {
  // A real-shaped pair (docs: an App ID is "Name-Words-PRD-<digits>-<hex>", a Cert ID "PRD-<hex>-<hex>-..." ).
  const APP = 'AppName-Bundle-PRD-1234567890-abcdef12';
  const CERT = 'PRD-1234567890ab-cdef-4567-89ab-0123';

  it('says nothing for a value in its own field', () => {
    expect(ebayHints('appId', APP)).toEqual([]);
    expect(ebayHints('certId', CERT)).toEqual([]);
    expect(ebayHints('appId', '')).toEqual([]);
  });
  it('notices a Cert ID typed where the App ID goes, and the other way round', () => {
    expect(ebayHints('appId', CERT)).toEqual(['This looks like a Cert ID — the App ID goes here']);
    expect(ebayHints('certId', APP)).toEqual(['This looks like an App ID — the Cert ID goes here']);
  });
  it('says nothing about a value it cannot place (a hint only when it is plain)', () => {
    expect(ebayHints('appId', 'MyApp')).toEqual([]);
    expect(ebayHints('certId', 'abcd-1234')).toEqual([]);
    expect(ebayHints('certId', 'xyz')).toEqual([]);
  });
  it('names a Sandbox key in either field', () => {
    expect(ebayHints('appId', 'AppName-Bundle-SBX-1234567890-abcdef12')).toEqual(['This is a Sandbox key; Split Finder needs the Production keyset.']);
    expect(ebayHints('certId', 'SBX-1234567890ab-cdef-4567-89ab-0123')).toEqual(['This is a Sandbox key; Split Finder needs the Production keyset.']);
    // A Sandbox Cert ID typed in the App ID field: both things are true.
    expect(ebayHints('appId', 'SBX-1234567890ab-cdef-4567-89ab-0123')).toEqual(['This looks like a Cert ID — the App ID goes here', 'This is a Sandbox key; Split Finder needs the Production keyset.']);
  });
  it('ignores the spaces a paste carries', () => {
    expect(ebayHints('appId', `  ${CERT}\n`)).toHaveLength(1);
  });
});

describe('the line under a key', () => {
  const base = (keys: Partial<AppState['keys']>) => withState((s) => { s.keys = { ...s.keys, ...keys }; });
  it('says it is checking, with the service named, before anything else', () => {
    const s = base({ ebay: true });
    expect(keyCheckLine({ name: 'ebay', state: s, checking: true, now: null, at: NOW })).toEqual({ tone: 'checking', text: 'Checking with eBay…' });
    expect(keyCheckLine({ name: 'openai', state: s, checking: true, now: null, at: NOW })).toEqual({ tone: 'checking', text: 'Checking with the model service…' });
  });
  it('shows a fresh answer from this window: works, rejected, or could not reach', () => {
    const s = base({ serpapi: true });
    expect(keyCheckLine({ name: 'serpapi', state: s, checking: false, now: { check: { ok: true, detail: '118 of 250 searches left' }, at: NOW - 30_000 }, at: NOW })).toEqual({ tone: 'works', text: 'Works · 118 of 250 searches left', when: 'just now' });
    expect(keyCheckLine({ name: 'ebay', state: base({ ebay: true }), checking: false, now: { check: { ok: false, kind: 'rejected', problem: 'eBay answered invalid_client (HTTP 401).' }, at: NOW }, at: NOW })).toMatchObject({ tone: 'rejected', text: 'eBay answered invalid_client (HTTP 401).' });
    expect(keyCheckLine({ name: 'ebay', state: base({ ebay: true }), checking: false, now: { check: { ok: false, kind: 'network', problem: 'Saved. Could not reach eBay to check it just now — it is checked again at the next scan.' }, at: NOW }, at: NOW })).toEqual({
      tone: 'unreached',
      text: 'Saved. Could not reach eBay to check it just now — it is checked again at the next scan.',
    });
  });
  it('reads the agent\'s own record when this window has no answer: "Checked 2 min ago · works"', () => {
    const s = withState((x) => { x.keys.keepa = true; x.keyChecks = { keepa: { ok: true, at: minutesAgo(2), detail: '60 tokens, 1 a minute' } }; delete x.keyProblems; });
    expect(keyCheckLine({ name: 'keepa', state: s, checking: false, now: null, at: NOW })).toEqual({ tone: 'works', text: 'Works · 60 tokens, 1 a minute', when: '2 min ago' });
  });
  it('a problem the agent holds is the line, whatever else it recorded', () => {
    const s = withState((x) => { x.keys.ebay = true; x.keyProblems = { ebay: 'eBay did not accept the App ID and Cert ID.' }; x.keyChecks = { ebay: { ok: false, at: minutesAgo(5) } }; });
    expect(keyCheckLine({ name: 'ebay', state: s, checking: false, now: null, at: NOW })).toEqual({ tone: 'rejected', text: 'eBay did not accept the App ID and Cert ID.', when: '5 min ago' });
  });
  it('nothing for a key that is not saved, or saved and never checked', () => {
    const s = withState((x) => { x.keys.telegram = false; x.keys.anthropic = true; delete x.keyChecks; delete x.keyProblems; });
    expect(keyCheckLine({ name: 'telegram', state: s, checking: false, now: null, at: NOW })).toEqual({ tone: 'none' });
    expect(keyCheckLine({ name: 'anthropic', state: s, checking: false, now: null, at: NOW })).toEqual({ tone: 'none' });
  });
  it('says only "Works" when the service had nothing to add', () => {
    expect(worksWords(undefined)).toBe('Works');
    expect(worksWords('  ')).toBe('Works');
  });
});
