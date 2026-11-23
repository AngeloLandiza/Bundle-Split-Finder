import { describe, expect, it } from 'vitest';
import { QUESTIONS } from '../api/mockData';
import realData from '../api/mockReal.json';
import { mapReview } from '../api/map';
import { checkedLines, groupBySource, groupQuestions, parseTyped, preselected, rowChip, saveHint, stepSource, suggestionChip, typedFromSuggestion, workingNote, workingTitle } from './reviewModel';

const byId = (id: string) => QUESTIONS.find((q) => q.id === id)!;

describe('review model', () => {
  it('chips a list row only when the code verified the AI’s answer, says "suggested" quietly for an unchecked one, and nothing else', () => {
    expect(rowChip(byId('q-dck200').suggestion)).toBe('verified');
    expect(rowChip(byId('q-pcl500').suggestion)).toBe('suggested');
    expect(rowChip({ ...byId('q-pcl500').suggestion!, status: 'unmatched', choiceId: null })).toBe('suggested');
    expect(rowChip({ ...byId('q-pcl500').suggestion!, status: 'cannot_tell', choiceId: null })).toBeNull();
    expect(rowChip(null)).toBeNull();
    // The owner's 15 real questions: none is verified, so none carries a chip (it is "Not verified" on all 15 that was noise).
    const real = mapReview(realData.review as never).questions;
    expect(real.filter((q) => rowChip(q.suggestion) === 'verified')).toHaveLength(0);
  });
  it('puts only verified suggestions in the AI group', () => {
    const g = groupQuestions(QUESTIONS);
    expect(g.verified.map((q) => q.id)).toEqual(['q-dck200', 'q-pcl660', 'q-dckts']);
    expect(g.needsYou.every((q) => q.suggestion?.status !== 'verified')).toBe(true);
  });
  it('keeps the questions the app is still working on out of both lists, and counts them apart', () => {
    const working = { ...byId('q-pcl500'), followUp: { state: 'running' as const, doing: 'Reading', tried: [], roundsLeft: 2 } };
    const queued = { ...byId('q-dck200'), followUp: { state: 'queued' as const, tried: [], roundsLeft: 2 } };
    const done = { ...byId('q-pcl660'), followUp: { state: 'done' as const, tried: [], roundsLeft: 1 } };
    const g = groupQuestions([working, queued, done, byId('q-pcl2001')]);
    expect(g.working.map((q) => q.id)).toEqual(['q-pcl500', 'q-dck200']);
    // A question the app has finished is the owner's again, and a verified one is still approvable in place.
    expect(g.verified.map((q) => q.id)).toEqual(['q-pcl660']);
    expect(g.needsYou.map((q) => q.id)).toEqual(['q-pcl2001']);
    expect(workingTitle(2)).toBe('The app is still working on 2');
    expect(workingNote(2)).toBe('2 more being checked');
  });
  it('shows at most three of what the app checked and leaves the rest to Details', () => {
    const tried = [1, 2, 3, 4, 5].map((n) => ({ what: `Step ${n}`, result: 'done' }));
    expect(checkedLines(tried.slice(0, 2))).toEqual({ shown: tried.slice(0, 2), rest: [] });
    expect(checkedLines(tried).shown).toHaveLength(3);
    expect(checkedLines(tried).rest.map((s) => s.what)).toEqual(['Step 4', 'Step 5']);
    expect(stepSource('https://www.homedepot.com/s/A21701')).toBe('Home Depot');
    expect(stepSource('https://www.amazon.com/dp/B0B1F877F3')).toBe('Amazon');
    expect(stepSource('https://example.org/x')).toBe('example.org');
  });
  it('preselects the choice a suggestion names, verified or not; nothing when the AI could not tell or named none', () => {
    expect(preselected(byId('q-dck200'))).toBe('c2');
    expect(preselected(byId('q-pcl500'))).toBe('B0B1F877F3');
    expect(preselected(byId('q-pcl2001'))).toBeNull();
    expect(preselected({ ...byId('q-pcl500'), suggestion: { ...byId('q-pcl500').suggestion!, status: 'unmatched', choiceId: null } })).toBeNull();
  });
  it('preselects a real unverified suggestion from the owner’s second scan, and shows it as not verified with the agent’s words', () => {
    const real = mapReview(realData.review as never).questions;
    const named = real.filter((q) => preselected(q) !== null);
    expect(named.length).toBe(12);
    for (const q of named) {
      expect(q.suggestion?.status).toBe('unverified');
      expect(q.suggestion?.quotes.length).toBeGreaterThan(0);
      expect(q.suggestion?.quotes.every((x) => x.source.label.length > 0)).toBe(true);
      expect(suggestionChip(q.suggestion!)).toMatchObject({ label: 'Not verified', tone: 'attention' });
    }
    // Eight of them typed in the parts of an offered reading, exactly (same models, same counts): that reading is the choice.
    // The other three typed in parts that are none of the choices: nothing is preselected for them.
    const unmatched = real.filter((q) => q.suggestion?.status === 'unmatched');
    expect(unmatched.length).toBe(3);
    expect(unmatched.every((q) => preselected(q) === null)).toBe(true);
  });
  it('words the chip: verified says the quoted text says so; not verified says why', () => {
    const v = byId('q-dck200').suggestion!;
    expect(suggestionChip(v)).toEqual({ label: 'Verified', tone: 'verified', why: 'The page text quoted below says so.' });
    expect(suggestionChip({ ...v, status: 'unverified', plain: 'The page never names the saw.' })?.why).toBe('The page never names the saw.');
    expect(suggestionChip({ ...v, status: 'unverified', plain: null, notVerified: 'No quote names DCK240C2.' })?.why).toBe('No quote names DCK240C2.');
    expect(suggestionChip({ ...v, status: 'cannot_tell' })).toBeNull();
  });
  it('updates the key hint: Enter saves and moves on, the last one just saves, and with no choice it says so', () => {
    expect(saveHint({ hasAnswer: true, hasNext: true })).toBe('↩ save and next');
    expect(saveHint({ hasAnswer: true, hasNext: false })).toBe('↩ save');
    expect(saveHint({ hasAnswer: false, hasNext: true })).toBe('Choose an answer to save');
  });
  it('types in the parts a research suggestion found when no choice holds them', () => {
    expect(typedFromSuggestion(byId('q-dckts'))).toBe('DCD771B, DCF885B, DCS381B, DCS391B, DCG412B, DCL040');
    expect(typedFromSuggestion(byId('q-dck200'))).toBe('');
  });
  it('reads typed models in capitals', () => {
    expect(parseTyped('DCF921B, dcd708b  DCB205')).toEqual(['DCF921B', 'DCD708B', 'DCB205']);
  });
  it('groups quotes by their source and keeps every line once, none without its source', () => {
    const hd = { label: 'Home Depot page', url: 'https://www.homedepot.com/p/1' };
    const am = { label: 'Amazon listing', url: 'https://www.amazon.com/dp/B0' };
    const groups = groupBySource([
      { text: 'Includes: Drill', source: hd },
      { text: 'ASIN B0', source: am },
      { text: 'Includes: Saw', source: hd },
      { text: 'Includes: Drill', source: hd },
    ]);
    expect(groups).toEqual([
      { source: hd, texts: ['Includes: Drill', 'Includes: Saw'] },
      { source: am, texts: ['ASIN B0'] },
    ]);
  });
  it('every real quote of every real question lands in a group under its own source', () => {
    for (const q of mapReview((realData as unknown as { review: Parameters<typeof mapReview>[0] }).review).questions) {
      const quotes = [...q.evidence, ...(q.suggestion?.quotes ?? [])];
      const grouped = groupBySource(quotes);
      for (const qt of quotes) expect(grouped.find((g) => g.source.label === qt.source.label && g.source.url === qt.source.url)?.texts).toContain(qt.text);
    }
  });
});
