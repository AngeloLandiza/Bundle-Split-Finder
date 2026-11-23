import { describe, expect, it } from 'vitest';
import { STATE } from '../api/mockData';
import type { AppState } from '../api/types';
import { chooseNotices, moreWords, rejectedKeyNotice, SCREEN_KEYS, type NoticeKind } from './notices';

const item = (kind: NoticeKind, id: string = kind) => ({ kind, id });
const idle = { scanning: false };

describe('one notice at a time', () => {
  it('shows nothing when nothing applies', () => {
    expect(chooseNotices([], idle)).toEqual({ first: null, more: [] });
  });

  it('puts the helper first, then a scan problem, then a rejected key, then waiting lookups', () => {
    const all = [item('lookups'), item('key-rejected'), item('scan'), item('helper')];
    const { first, more } = chooseNotices(all, idle);
    expect(first?.kind).toBe('helper');
    expect(more.map((m) => m.kind)).toEqual(['scan', 'key-rejected', 'lookups']);
  });

  it('shows exactly one banner whatever the count and lists the rest behind it', () => {
    const { first, more } = chooseNotices([item('scan'), item('lookups')], idle);
    expect(first?.kind).toBe('scan');
    expect(more).toHaveLength(1);
    expect(moreWords(more.length)).toBe('1 more');
    expect(moreWords(3)).toBe('3 more');
  });

  it('hides the lookups notice while a scan runs: the scan is doing them', () => {
    expect(chooseNotices([item('lookups')], { scanning: true })).toEqual({ first: null, more: [] });
    const { first, more } = chooseNotices([item('lookups'), item('key-rejected')], { scanning: true });
    expect(first?.kind).toBe('key-rejected');
    expect(more).toEqual([]);
  });

  it('keeps two of one kind in the order they came', () => {
    const { first, more } = chooseNotices([item('pairing', 'a'), item('pairing', 'b'), item('scan')], idle);
    expect(first).toEqual({ kind: 'pairing', id: 'a' });
    expect(more.map((m) => (m as { id: string }).id)).toEqual(['b', 'scan']);
  });

  it('puts the agent being offline above everything', () => {
    expect(chooseNotices([item('helper'), item('offline'), item('pairing')], idle).first?.kind).toBe('offline');
  });
});

describe('a rejected key is a banner only on the screen that needs it', () => {
  const rejected = (name: 'ebay' | 'keepa' | 'anthropic'): AppState => ({ ...STATE, keyProblems: { [name]: 'The service did not accept it.' } });

  it('says nothing about eBay on Deals, Today or Review: the sidebar, Today’s Agent card and Settings say it', () => {
    for (const screen of ['today', 'deals', 'review'] as const) expect(rejectedKeyNotice(rejected('ebay'), SCREEN_KEYS[screen])).toBeNull();
  });

  it('says the key and the agent’s sentence for a key the screen uses', () => {
    expect(rejectedKeyNotice(rejected('keepa'), SCREEN_KEYS.deals)).toEqual({ title: 'The Keepa key is not accepted.', text: 'The service did not accept it.' });
    expect(rejectedKeyNotice(rejected('anthropic'), SCREEN_KEYS.review)?.title).toBe('The Anthropic key is not accepted.');
    expect(rejectedKeyNotice(rejected('keepa'), SCREEN_KEYS.review)).toBeNull();
  });

  it('ignores a problem for a key that is not saved', () => {
    const s: AppState = { ...STATE, keys: { ...STATE.keys, keepa: false }, keyProblems: { keepa: 'old' } };
    expect(rejectedKeyNotice(s, SCREEN_KEYS.deals)).toBeNull();
  });
});
