// Scoring the research agent against an answer key, and what a question costs. Pure: no files, no
// network. The eval script (scripts/research-eval-cli.ts) builds the questions and calls this.
//
// Truth for a split question is the answer key's parts (fixtures/validation/answers-*.json), as a
// multiset compared by kitKey (PCL500 and PCL500B are the same tool, Ruling 70), or "none". Only a
// verified suggestion can be right or wrong; the bar is zero verified-but-wrong.

import { costOf, PRICE_TABLE, type PriceRates } from '../judge/eval';
import { kitKey } from '../match';
import { choicesOf } from '../scan/answers';
import type { ReviewItem } from '../scan/types';
import type { Suggestion } from '../assist/types';
import type { ResearchUsage } from './types';

/** Dollars per web search on the Claude API ($10 per 1,000, web search tool page). */
export const WEB_SEARCH_USD = 0.01;

/** A research question's cost: its tokens at the model's rates and its web searches. */
export function researchCost(usage: Pick<ResearchUsage, 'inputTokens' | 'outputTokens'> & { webSearchRequests?: number }, rates: PriceRates): number {
  return costOf(usage, rates) + (usage.webSearchRequests ?? 0) * WEB_SEARCH_USD;
}

/**
 * What one research press may cost, said on the button before the click: an estimate from a typical
 * run (the prompt and evidence about 3,000 tokens, sent again on each of about 4 requests as the tool
 * results grow, so about 16,000 in; 1,500 out with thinking; one web search). An estimate, never a bill.
 */
export const ESTIMATED_RESEARCH = { input: 16_000, output: 1_500, webSearches: 1 } as const;

export function estimatedResearchCost(model: string): number | null {
  const rates = PRICE_TABLE[model];
  return rates ? researchCost({ inputTokens: ESTIMATED_RESEARCH.input, outputTokens: ESTIMATED_RESEARCH.output, webSearchRequests: ESTIMATED_RESEARCH.webSearches }, rates) : null;
}

/** "about $0.10": rounded up to a whole cent, never "$0.00". Null for a model with no rate. */
export function researchCostLabel(model: string): string | null {
  const cost = estimatedResearchCost(model);
  if (cost === null) return null;
  const cents = Math.max(1, Math.ceil(Math.round(cost * 1e6) / 1e4));
  return `about $${(cents / 100).toFixed(2)}`;
}

export type ResearchTruth = { kind: 'parts'; parts: string[] } | { kind: 'none' };

export type ResearchOutcome = 'verified_correct' | 'verified_wrong' | 'unverified' | 'cannot_tell' | 'none_suggested' | 'not_suggested';

const bag = (brand: string, parts: string[]): string => parts.map((p) => kitKey(brand, p)).sort().join(',');

/** How a suggestion fares against the truth. Only a verified suggestion can be right or wrong. */
export function researchOutcome(s: Suggestion, truth: ResearchTruth, item: ReviewItem): ResearchOutcome {
  if (s.status !== 'verified') return s.status;
  const a = s.answer;
  if (a.decision === 'none') return truth.kind === 'none' ? 'verified_correct' : 'verified_wrong';
  if (truth.kind !== 'parts' || !('parts' in a)) return 'verified_wrong';
  const said = a.decision === 'choose' && a.kind === 'split' ? (choicesOf(item)[a.choiceIndex] ?? []) : a.parts;
  return bag(item.brand, said) === bag(item.brand, truth.parts) ? 'verified_correct' : 'verified_wrong';
}

export interface ResearchEvalRow {
  questionId: string;
  item: ReviewItem;
  truth: ResearchTruth;
  suggestion: Suggestion;
  called: boolean;
}

export interface ResearchEvalScore {
  questions: number;
  byOutcome: Record<ResearchOutcome, number>;
  wrong: { questionId: string; said: string }[];
  calls: number;
  tokens: { input: number; output: number };
  webSearches: number;
  cost: number | null;
  /** Zero verified-but-wrong. Necessary, not sufficient: the owner still approves every answer. */
  trustworthy: boolean;
}

export function saidOf(s: Suggestion): string {
  if (s.status !== 'verified') return s.status;
  const a = s.answer;
  if (a.decision === 'none') return 'none';
  if (a.decision === 'parts') return `parts ${a.parts.join(', ')}`;
  return a.kind === 'split' ? `reading ${a.choiceIndex} (${a.parts.join(', ')})` : `listing ${a.asin}`;
}

export function scoreResearch(rows: ResearchEvalRow[], rates?: PriceRates): ResearchEvalScore {
  const byOutcome: Record<ResearchOutcome, number> = { verified_correct: 0, verified_wrong: 0, unverified: 0, cannot_tell: 0, none_suggested: 0, not_suggested: 0 };
  const wrong: ResearchEvalScore['wrong'] = [];
  const usage = { inputTokens: 0, outputTokens: 0, webSearchRequests: 0 };
  let calls = 0;
  for (const r of rows) {
    const o = researchOutcome(r.suggestion, r.truth, r.item);
    byOutcome[o]++;
    if (o === 'verified_wrong') wrong.push({ questionId: r.questionId, said: saidOf(r.suggestion) });
    if (r.called) calls++;
    const u = r.suggestion.usage;
    if (u) {
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.webSearchRequests += u.webSearchRequests ?? 0;
    }
  }
  return {
    questions: rows.length, byOutcome, wrong, calls,
    tokens: { input: usage.inputTokens, output: usage.outputTokens }, webSearches: usage.webSearchRequests,
    cost: rates ? researchCost(usage, rates) : null,
    trustworthy: byOutcome.verified_wrong === 0,
  };
}
