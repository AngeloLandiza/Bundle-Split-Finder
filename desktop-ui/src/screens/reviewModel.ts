import type { AiSuggestion, DealSection, Grade, QuestionKind, ReviewQuestion } from '../api/types';

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

/**
 * The choice a suggestion preselects: any suggestion that names one of the offered choices, verified or not, so one key
 * accepts it (HAX G7-G9). Whether it is verified is shown beside it; an answer that matches no choice preselects nothing.
 */
export function preselected(q: ReviewQuestion): string | null {
  const s = q.suggestion;
  if (!s || (s.status !== 'verified' && s.status !== 'unverified') || !s.choiceId) return null;
  return q.choices.some((c) => c.id === s.choiceId) ? s.choiceId : null;
}

/** What the chip beside a suggested choice says and how it looks; the why is the agent's own plain sentence when it sends one. */
export function suggestionChip(s: AiSuggestion): { label: string; tone: 'verified' | 'attention'; why: string } | null {
  if (s.status === 'verified') return { label: 'Verified', tone: 'verified', why: 'The page text quoted below says so.' };
  if (s.status === 'unverified' || s.status === 'unmatched') {
    return { label: 'Not verified', tone: 'attention', why: s.plain?.trim() || s.notVerified?.trim() || 'The code could not find these quotes on the page. Check the sources below.' };
  }
  return null;
}

/** What a list row shows of the AI: a chip when the code verified its answer, quiet words when it only suggested one, else nothing. */
export function rowChip(s: AiSuggestion | null): 'verified' | 'suggested' | null {
  if (!s) return null;
  if (s.status === 'verified') return 'verified';
  return s.status === 'unverified' || s.status === 'unmatched' ? 'suggested' : null;
}

/**
 * The footer's key hint: Enter saves the selected choice and moves to the next question. Without a choice it says what
 * is missing instead of a key that would do nothing.
 */
export function saveHint(o: { hasAnswer: boolean; hasNext: boolean }): string {
  if (!o.hasAnswer) return 'Choose an answer to save';
  return o.hasNext ? '↩ save and next' : '↩ save';
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
