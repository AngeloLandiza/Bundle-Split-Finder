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

/** A prompt-cache write costs 1.25x input (5-minute entries); a read the model's cacheRead rate, else 0.1x input. */
export const CACHE_WRITE_FACTOR = 1.25;
export const CACHE_READ_FACTOR = 0.1;

/**
 * A research question's cost: its uncached input, cache writes and reads, and output at the model's rates,
 * and its web searches (web fetches cost only their tokens).
 */
export function researchCost(
  usage: Pick<ResearchUsage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'> & { webSearchRequests?: number },
  rates: PriceRates,
): number {
  const written = ((usage.cacheCreationInputTokens ?? 0) * rates.input * CACHE_WRITE_FACTOR) / 1_000_000;
  const read = ((usage.cacheReadInputTokens ?? 0) * (rates.cacheRead ?? rates.input * CACHE_READ_FACTOR)) / 1_000_000;
  return costOf(usage, rates) + written + read + (usage.webSearchRequests ?? 0) * WEB_SEARCH_USD;
}

/**
 * What one research press may cost, said on the button before the click. An estimate, never a bill.
 * From the second real run (Opus 5.5, prompt .2, 19 questions, Nov 20; runs-claude-opus-5-5-prompt2.json):
 * 374,137 tokens in over 53 requests, 16,544 out, no web search, $1.83 uncached ($0.096 a question). The
 * prompt is cached since fix round 2 (system prompt and tools, and the growing conversation): each request
 * then reads the one before it from the cache and writes only what is new, which on that run's requests
 * is about 7,300 tokens written and 12,400 read a question (simulated, $1.07 for the 19, not yet measured
 * on a run). Rounded up for a fetched brand page and one web search: 8,000 written, 14,000 read, 1,000 out.
 */
export const ESTIMATED_RESEARCH = { input: 0, cacheWrite: 8_000, cacheRead: 14_000, output: 1_000, webSearches: 1 } as const;

export function estimatedResearchCost(model: string): number | null {
  const rates = PRICE_TABLE[model];
  const e = ESTIMATED_RESEARCH;
  return rates
    ? researchCost({ inputTokens: e.input, cacheCreationInputTokens: e.cacheWrite, cacheReadInputTokens: e.cacheRead, outputTokens: e.output, webSearchRequests: e.webSearches }, rates)
    : null;
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
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  webSearches: number;
  webFetches: number;
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
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, webFetchRequests: 0 };
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
      usage.webFetchRequests += u.webFetchRequests ?? 0;
      usage.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
      usage.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
    }
  }
  return {
    questions: rows.length, byOutcome, wrong, calls,
    tokens: { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadInputTokens, cacheWrite: usage.cacheCreationInputTokens }, webSearches: usage.webSearchRequests, webFetches: usage.webFetchRequests,
    cost: rates ? researchCost(usage, rates) : null,
    trustworthy: byOutcome.verified_wrong === 0,
  };
}
