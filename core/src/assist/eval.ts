// Scoring the review assistant against an answer key. Pure: no files, no network. The eval script
// (scripts/assist-eval-cli.ts) builds the questions from the validation replay, reads the keys and
// calls this.
//
// Truth for a split question is the answer key's parts (fixtures/validation/answers-*.json): the
// reading with the same parts, or "none" when the key typed parts no reading offers. Truth for a match
// question is the checker's label for the part (fixtures/validation/labels-*.json): the labelled ASINs
// among the listings offered, "none" when none of them is labelled right, and "uncertain" when the
// label itself could not settle it (an empty list with uncertain ASINs): then no answer is right.

import { costOf, type PriceRates } from '../judge/eval';
import type { TokenUsage } from '../judge/types';
import { choicesOf } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import type { Suggestion } from './types';

export type AssistTruth =
  | { kind: 'choose'; choiceIndex: number }
  | { kind: 'choose'; asins: string[] }
  | { kind: 'none' }
  | { kind: 'uncertain' };

/** One part's label in labels-*.json. */
export interface MatchLabel {
  correct: string[] | 'none';
  uncertain?: string[];
}

const partsKey = (parts: string[]): string => parts.map((p) => p.trim().toUpperCase()).sort().join(',');

/** The truth of a split question from the answer key's parts; null without a key. */
export function splitTruth(item: ReviewItem, keyParts: string[] | 'none' | null): AssistTruth | null {
  if (keyParts === null) return null;
  if (keyParts === 'none') return { kind: 'none' };
  const i = choicesOf(item).findIndex((c) => partsKey(c) === partsKey(keyParts));
  return i >= 0 ? { kind: 'choose', choiceIndex: i } : { kind: 'none' };
}

/** The truth of a match question from the part's label; null without a label. */
export function matchTruth(item: ReviewItem, label: MatchLabel | undefined): AssistTruth | null {
  if (!label) return null;
  if (label.correct === 'none') return { kind: 'none' };
  if (label.correct.length === 0) return { kind: 'uncertain' };
  const right = new Set(label.correct.map((a) => a.toUpperCase()));
  const offered = item.candidates.map((c) => c.asin).filter((a) => right.has(a.toUpperCase()));
  return offered.length > 0 ? { kind: 'choose', asins: offered } : { kind: 'none' };
}

/** none_suggested (fix round 2): the AI's view that nothing fits, never verified, so never right or wrong here. */
export type AssistOutcome = 'verified_correct' | 'verified_wrong' | 'unverified' | 'cannot_tell' | 'none_suggested' | 'not_suggested';

/** How a suggestion fares against the truth. Only a verified suggestion can be right or wrong. */
export function outcomeOf(s: Suggestion, truth: AssistTruth): AssistOutcome {
  if (s.status !== 'verified') return s.status;
  const a = s.answer;
  if (a.decision === 'none') return truth.kind === 'none' ? 'verified_correct' : 'verified_wrong';
  if (truth.kind !== 'choose') return 'verified_wrong';
  // Ask AI never proposes parts (only research does, scored by research/eval.ts); here they match no reading.
  if (a.decision === 'parts') return 'verified_wrong';
  if (a.kind === 'split') return 'choiceIndex' in truth && truth.choiceIndex === a.choiceIndex ? 'verified_correct' : 'verified_wrong';
  return 'asins' in truth && truth.asins.includes(a.asin) ? 'verified_correct' : 'verified_wrong';
}

export interface AssistEvalRow {
  questionId: string;
  truth: AssistTruth;
  suggestion: Suggestion;
  /** Whether a model call was made for it (a question that offers nothing is not called). */
  called: boolean;
}

export interface AssistEvalScore {
  questions: number;
  byOutcome: Record<AssistOutcome, number>;
  /** Questions whose verified suggestion disagrees with the key: must be none to trust the assistant. */
  wrong: { questionId: string; truth: AssistTruth; said: string }[];
  /** none_suggested where the key is not "none": shown to the owner, preselecting nothing, so not wrong; listed to watch. */
  noneAgainstKey: { questionId: string; truth: AssistTruth }[];
  /** Model calls made (a question that offers nothing is not called). */
  calls: number;
  tokens: { input: number; output: number };
  cost: number | null;
  /** Zero verified-but-wrong. Necessary, not sufficient: the owner still approves every answer. */
  trustworthy: boolean;
}

const said = (s: Suggestion): string => {
  if (s.status !== 'verified') return s.status;
  const a = s.answer;
  if (a.decision === 'parts') return `parts ${a.parts.join(', ')}`;
  return a.decision === 'none' ? 'none' : a.kind === 'split' ? `reading ${a.choiceIndex} (${a.parts.join(', ')})` : `listing ${a.asin}`;
};

export function scoreSuggestions(rows: AssistEvalRow[], rates?: PriceRates): AssistEvalScore {
  const byOutcome: Record<AssistOutcome, number> = { verified_correct: 0, verified_wrong: 0, unverified: 0, cannot_tell: 0, none_suggested: 0, not_suggested: 0 };
  const noneAgainstKey: AssistEvalScore['noneAgainstKey'] = [];
  const wrong: AssistEvalScore['wrong'] = [];
  let calls = 0;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const r of rows) {
    const o = outcomeOf(r.suggestion, r.truth);
    byOutcome[o]++;
    if (o === 'verified_wrong') wrong.push({ questionId: r.questionId, truth: r.truth, said: said(r.suggestion) });
    if (o === 'none_suggested' && r.truth.kind !== 'none') noneAgainstKey.push({ questionId: r.questionId, truth: r.truth });
    if (r.called) calls++;
    if (r.suggestion.usage) {
      usage.inputTokens += r.suggestion.usage.inputTokens;
      usage.outputTokens += r.suggestion.usage.outputTokens;
    }
  }
  return {
    questions: rows.length, byOutcome, wrong, noneAgainstKey, calls,
    tokens: { input: usage.inputTokens, output: usage.outputTokens },
    cost: rates ? costOf(usage, rates) : null,
    trustworthy: byOutcome.verified_wrong === 0,
  };
}
