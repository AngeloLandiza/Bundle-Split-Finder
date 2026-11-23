// Real data for the brief tests: the owner's third real scan (fixtures/e2e-2026-11-23/after-scan3) and the suggestions the AI gave on his
// second (store/suggestions.json). Nothing here reaches the network.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StoredSuggestion } from '../src/assist/stored';
import { briefInputOf, type BriefSourceLink, poolOfLines } from '../src/brief/input';
import type { BriefInput } from '../src/brief/types';
import type { ReviewItem } from '../src/scan/types';

export const FIXTURE = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23');
export const read = <T>(path: string): T => JSON.parse(readFileSync(join(FIXTURE, path), 'utf8')) as T;

export interface ReviewFile {
  at: string;
  questions: ReviewItem[];
  ebayQuestions: unknown[];
  evidence: Record<string, { text: string; source: { label: string; url: string | null } }[]>;
}

export const REVIEW = read<ReviewFile>('after-scan3/store/review.json');
export const SUGGESTIONS = read<StoredSuggestion[]>('store/suggestions.json');

export const question = (id: string): ReviewItem => REVIEW.questions.find((q) => q.id === id)!;
export const suggestionFor = (id: string): StoredSuggestion => SUGGESTIONS.find((s) => s.questionId === id)!;

/** The Home Depot page of a split question, as a source link. */
export const sourcesOf = (id: string): BriefSourceLink[] => {
  const url = REVIEW.evidence[id]?.[0]?.source.url ?? null;
  return url ? [{ label: 'Home Depot', url, source: 'homedepot' }] : [];
};

/** The brief input of a real question with the suggestion the AI really gave it. */
export function realInput(id: string, suggestion: StoredSuggestion | null = suggestionFor(id)): BriefInput {
  return briefInputOf(question(id), suggestion?.suggestion ?? null, poolOfLines(REVIEW.evidence[id] ?? []), sourcesOf(id));
}

/** PCL500B-PCL525B: the AI's parts answer for the RYOBI 2-tool combo (328690510), which the code did not verify. */
export const COMBO = 'split:homedepot:328690510';
