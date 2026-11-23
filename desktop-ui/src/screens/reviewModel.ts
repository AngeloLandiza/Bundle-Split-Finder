import type { DealSection, Grade, QuestionKind, ReviewQuestion } from '../api/types';

export const KIND_LABEL: Record<QuestionKind, string> = {
  split: 'Which parts',
  match: 'Which listing',
  ebay: 'eBay listing',
};

export const SECTION_LABEL: Record<DealSection, string> = {
  confirmed: 'Confirmed',
  waiting: 'Waiting for lookup',
  inactive_listing: 'Inactive listing',
  missing_listing: 'Missing listing',
  split: 'Contents not known',
};

export const SECTION_ORDER: readonly DealSection[] = ['confirmed', 'waiting', 'inactive_listing', 'missing_listing', 'split'];

export const GRADE_LABEL: Record<Grade, string> = {
  verified: 'Verified',
  title_match: 'Title match',
  needs_answer: 'Needs your answer',
  inactive: 'Listing inactive',
  missing: 'No listing found',
  not_looked_up: 'Not looked up yet',
};

/** Review's two groups: AI-verified suggestions (one press approves them) and the rest, which need him. */
export function groupQuestions(questions: ReviewQuestion[]): { verified: ReviewQuestion[]; needsYou: ReviewQuestion[] } {
  const verified = questions.filter((q) => q.suggestion?.status === 'verified');
  const needsYou = questions.filter((q) => q.suggestion?.status !== 'verified');
  return { verified, needsYou };
}

/** The choice a suggestion preselects: only a verified suggestion that names one of the choices. */
export function preselected(q: ReviewQuestion): string | null {
  const s = q.suggestion;
  if (!s || s.status !== 'verified' || !s.choiceId) return null;
  return q.choices.some((c) => c.id === s.choiceId) ? s.choiceId : null;
}

/** The parts a verified research suggestion typed in, when it is not one of the choices. */
export function typedFromSuggestion(q: ReviewQuestion): string {
  const s = q.suggestion;
  if (!s || s.status !== 'verified' || s.choiceId) return '';
  return s.answer.split('+').map((p) => p.trim()).filter(Boolean).join(', ');
}

/** Models typed by hand: "DCF921B, dcd708b  DCB205" reads DCF921B, DCD708B, DCB205. */
export function parseTyped(text: string): string[] {
  return text
    .split(/[\s,;+]+/)
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
}
