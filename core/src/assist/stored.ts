// What the panel keeps of an Ask AI call (step 11, A2): the suggestion, what it cost, and, once the owner
// has answered, whether the answer is the one suggested. This is its own record, apart from the question: a
// suggestion is never an answer (CLAUDE.md rule 4), and nothing here changes a ReviewItem.

import { costOf, PRICE_TABLE } from '../judge/eval';
import type { TokenUsage } from '../judge/types';
import { choicesOf, NONE, reviewSignature } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import type { Suggestion } from './types';

/** What the owner did with a suggestion shown for the question. */
export interface SuggestionOutcome {
  answeredAt: number;
  /** The question's stored answer (ReviewItem.answer): the parts joined by ",", an ASIN, or "none". */
  answer: string;
  /**
   * The answer is the one the AI proposed (true), another one (false), or the AI proposed none because it
   * could not tell (null): then there is nothing to agree with.
   */
  agreed: boolean | null;
}

export interface StoredSuggestion {
  /** `${questionId}|${askedAt}`. Asking again keeps the first record: the audit counts every ask. */
  key: string;
  questionId: string;
  /** reviewSignature of the question as it was asked. */
  seen: string;
  askedAt: number;
  suggestion: Suggestion;
  /** Dollars at the model's published rates; null for a model with no rate or a call with no usage. */
  costUsd: number | null;
  outcome?: SuggestionOutcome;
}

/** Where the suggestions are kept. The worker holds one; the extension's is IndexedDB, tests use memory. */
export interface SuggestionStore {
  put(record: StoredSuggestion): Promise<void>;
  /** Oldest first. */
  list(): Promise<StoredSuggestion[]>;
  clear(): Promise<void>;
}

export class MemorySuggestionStore implements SuggestionStore {
  private readonly records = new Map<string, StoredSuggestion>();

  async put(record: StoredSuggestion): Promise<void> {
    this.records.set(record.key, structuredClone(record));
  }

  async list(): Promise<StoredSuggestion[]> {
    return [...this.records.values()].map((r) => structuredClone(r)).sort((a, b) => a.askedAt - b.askedAt || (a.key < b.key ? -1 : 1));
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

export const suggestionKey = (questionId: string, askedAt: number): string => `${questionId}|${askedAt}`;

/** Dollars one call cost at the model's published rates, or null when the model has no rate or the call has no usage. */
export function suggestionCost(model: string, usage: TokenUsage | undefined): number | null {
  const rates = PRICE_TABLE[model];
  return rates && usage ? costOf(usage, rates) : null;
}

/**
 * The suggestion to show for an open question: the latest one that was made for the question as it is now (its
 * signature), not yet answered, and that gave something to show. One made for choices a scan has since changed is
 * not shown: it was made for another question.
 */
export function liveSuggestion(records: readonly StoredSuggestion[], question: ReviewItem): StoredSuggestion | undefined {
  if (question.answer !== null) return undefined;
  const seen = reviewSignature(question);
  return records
    .filter((r) => r.questionId === question.id && r.seen === seen && r.outcome === undefined && r.suggestion.status !== 'not_suggested')
    .sort((a, b) => b.askedAt - a.askedAt)[0];
}

/**
 * What the AI proposed, as the question's stored answer would read if the owner agreed: the reading's parts joined by ",",
 * a listing's ASIN, or "none". Null when it proposed nothing (could not tell). An unverified suggestion's claim counts: the
 * owner chose for themselves, and whether it was the claim is still worth knowing.
 */
export function proposedAnswer(suggestion: Suggestion, question: ReviewItem): string | null {
  // "None of these" is the AI's view, never verified (none_suggested), and it is still what it proposed.
  if (suggestion.status === 'none_suggested') return NONE;
  if (suggestion.status === 'verified') {
    const a = suggestion.answer;
    return a.decision === 'none' ? NONE : a.decision === 'parts' || a.kind === 'split' ? a.parts.join(',') : a.asin;
  }
  // Step 12 research: an unverified parts answer proposed those parts, each as many times as its quantity.
  if (suggestion.status === 'unverified' && suggestion.claimed === null && suggestion.researchClaim?.decision === 'parts') {
    const parts = suggestion.researchClaim.parts.flatMap((p) => Array<string>(Math.max(0, Math.min(9, p.qty))).fill(p.model.trim().toUpperCase()));
    return parts.length > 0 ? parts.join(',') : null;
  }
  if (suggestion.status !== 'unverified' || suggestion.claimed === null) return null;
  const raw = suggestion.claimed;
  if (raw.decision === 'none') return NONE;
  if (raw.decision !== 'choose') return null;
  if (question.kind === 'split') {
    const parts = raw.choiceIndex === null ? undefined : choicesOf(question)[raw.choiceIndex];
    return parts ? parts.join(',') : null;
  }
  return raw.asin !== null && question.candidates.some((c) => c.asin === raw.asin) ? raw.asin : null;
}

/** Whether the owner's answer is what the AI proposed: null when it proposed nothing. */
export function agreedWith(suggestion: Suggestion, answered: ReviewItem): boolean | null {
  const proposed = proposedAnswer(suggestion, answered);
  return proposed === null || answered.answer === null ? null : proposed === answered.answer;
}
