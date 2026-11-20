// Approve, for a suggestion the AI made and the code verified (step 12). The owner's press is the only thing that turns a
// suggestion into an answer (CLAUDE.md rule 4); this file says which answer a press sends, and which questions may be
// approved together. It writes nothing and calls nothing.

import { choicesOf, MAX_ENTERED_PARTS, reviewSignature } from '../scan/answers';
import type { ReviewAnswer, ReviewItem } from '../scan/types';
import { liveSuggestion, type StoredSuggestion } from './stored';
import type { Suggestion } from './types';

/**
 * The answer Approve sends for this suggestion, as the question reads now, or null when it would not send one: the
 * suggestion is not verified, its reading or listing is not one the question offers, or its parts are not a list the
 * typed-parts answer takes (1 to MAX_ENTERED_PARTS models, whole counts). The worker still checks every answer; this
 * keeps a button off a suggestion that would be refused.
 */
export function approvalOf(suggestion: Suggestion, item: ReviewItem): ReviewAnswer | null {
  if (suggestion.status !== 'verified' || suggestion.answer.decision === 'none') return null;
  const seen = reviewSignature(item);
  const a = suggestion.answer;
  // Parts the research found (R1: each model repeated by its quantity), saved through the typed-parts answer.
  if (a.decision === 'parts') {
    const parts = a.parts.map((p) => p.trim().toUpperCase());
    return item.kind === 'split' && parts.length >= 1 && parts.length <= MAX_ENTERED_PARTS && parts.every((p) => p !== '') ? { parts, seen } : null;
  }
  if (a.kind === 'split') return item.kind === 'split' && choicesOf(item)[a.choiceIndex] ? { choice: a.choiceIndex, seen } : null;
  if (a.kind === 'match') {
    const at = item.kind === 'match' ? item.candidates.findIndex((c) => c.asin === a.asin) : -1;
    return at < 0 ? null : { choice: at, seen };
  }
  return null;
}

/** A question the section "AI suggestions" lists: open, with a verified suggestion made for it as it reads now, and the answer Approve sends. */
export interface VerifiedRow {
  item: ReviewItem;
  stored: StoredSuggestion;
  answer: ReviewAnswer;
}

/** The section's rows, in the order of `items`. Only verified suggestions: every other kind stays with its question. */
export function verifiedRows(items: readonly ReviewItem[], records: readonly StoredSuggestion[]): VerifiedRow[] {
  return items.flatMap((item) => {
    const stored = liveSuggestion(records, item);
    const answer = stored ? approvalOf(stored.suggestion, item) : null;
    return stored && answer ? [{ item, stored, answer }] : [];
  });
}
