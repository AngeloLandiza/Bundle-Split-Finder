import { describe, expect, it } from 'vitest';
import type { Run } from '../api/types';
import { byDay, dayLabel, linkPieces, runWords } from './activity';

const NOW = new Date(2026, 10, 23, 12, 0).getTime();
const at = (daysAgo: number, h: number, m = 0): string => new Date(2026, 10, 23 - daysAgo, h, m).toISOString();
const run = (patch: Partial<Run>): Run => ({ id: 'r', kind: 'scan', byYou: false, startedAt: at(0, 9), finishedAt: null, searches: 0, keepaTokens: 0, aiUsd: 0, result: 'finished', summary: '', error: null, steps: [], ...patch });

describe('Activity by day', () => {
  it('groups newest first under Today, Yesterday and a dated heading, whatever order they arrive in', () => {
    const items = [
      { id: 'a', at: at(0, 8, 51) },
      { id: 'b', at: at(0, 8, 52) },
      { id: 'c', at: at(1, 22, 5) },
      { id: 'd', at: at(3, 7, 0) },
    ];
    const groups = byDay(items, (x) => x.at, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Fri, Nov 20']);
    expect(groups[0]!.items.map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('puts an item with no readable time last, never first', () => {
    const groups = byDay([{ at: 'nonsense' }, { at: at(0, 9) }], (x) => x.at, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Earlier']);
  });
  it('labels days', () => {
    expect(dayLabel(at(0, 1), NOW)).toBe('Today');
    expect(dayLabel(at(1, 23), NOW)).toBe('Yesterday');
  });
});

describe('a run in plain words', () => {
  it('names who started it and says what it used, leaving out what it did not', () => {
    expect(runWords(run({ kind: 'lookup', keepaTokens: 16 }))).toMatchObject({ title: 'Scheduled Amazon lookup', outcome: 'Finished', problem: false, spent: 'Used 16 Keepa tokens' });
    expect(runWords(run({ kind: 'scan', byYou: true, searches: 3, keepaTokens: 12, aiUsd: 0.04 })).spent).toBe('Used 3 searches, 12 Keepa tokens and $0.04 of AI');
    expect(runWords(run({ kind: 'ask', byYou: true })).spent).toBeNull();
  });
  it('flags a failure or a stop at the limit as something to act on, and a plain stop not', () => {
    expect(runWords(run({ result: 'failed' })).problem).toBe(true);
    expect(runWords(run({ result: 'limit' })).outcome).toBe('Stopped at the limit');
    expect(runWords(run({ result: 'stopped' })).problem).toBe(false);
  });
});

describe('a sentence that quotes addresses', () => {
  it('turns each address into a source link and keeps the words around it', () => {
    // From the owner's PSK1212SB Autopilot entry.
    const said = 'Every quote was found word for word in the source it names (1): "Includes: (1) PBP004 18V ONE+ 4Ah Lithium Batteries" in Home Depot page (https://www.homedepot.com/p/339206615).';
    const pieces = linkPieces(said);
    expect(pieces.filter((p) => p.url).map((p) => p.url)).toEqual(['https://www.homedepot.com/p/339206615']);
    expect(pieces.map((p) => p.text).join('')).toBe(said.replace('https://www.homedepot.com/p/339206615', 'source'));
  });
  it('leaves plain text alone', () => {
    expect(linkPieces('Nothing to open.')).toEqual([{ text: 'Nothing to open.' }]);
  });
});
