import { describe, expect, it } from 'vitest';
import { QUESTIONS } from '../api/mockData';
import { groupQuestions, parseTyped, preselected, typedFromSuggestion } from './reviewModel';

const byId = (id: string) => QUESTIONS.find((q) => q.id === id)!;

describe('review model', () => {
  it('puts only verified suggestions in the AI group', () => {
    const g = groupQuestions(QUESTIONS);
    expect(g.verified.map((q) => q.id)).toEqual(['q-dck200', 'q-pcl660', 'q-dckts']);
    expect(g.needsYou.every((q) => q.suggestion?.status !== 'verified')).toBe(true);
  });
  it('preselects only a verified choice, never an unverified or cannot-tell one', () => {
    expect(preselected(byId('q-dck200'))).toBe('c2');
    expect(preselected(byId('q-pcl500'))).toBeNull();
    expect(preselected(byId('q-pcl2001'))).toBeNull();
  });
  it('types in the parts a research suggestion found when no choice holds them', () => {
    expect(typedFromSuggestion(byId('q-dckts'))).toBe('DCD771B, DCF885B, DCS381B, DCS391B, DCG412B, DCL040');
    expect(typedFromSuggestion(byId('q-dck200'))).toBe('');
  });
  it('reads typed models in capitals', () => {
    expect(parseTyped('DCF921B, dcd708b  DCB205')).toEqual(['DCF921B', 'DCD708B', 'DCB205']);
  });
});
