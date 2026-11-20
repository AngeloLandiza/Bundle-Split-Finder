// What one Ask AI press costs, said on the button before the click (design.md principle 4). An estimate,
// from the model's published rates and a typical question: the instructions are about 750 tokens, the
// question and its evidence 300 to 900, the answer schema a few hundred, and the answer with its thinking
// a few hundred more (A1 report). The real cost of each call is kept with it (stored.ts, suggestionCost).

import { costOf, PRICE_TABLE } from '../judge/eval';
import { estimatedResearchCost } from '../research/eval';

export const ESTIMATED_TOKENS_PER_QUESTION = { input: 1800, output: 500 } as const;

/** Dollars one question may cost on `model`; null for a model with no published rate. */
export function estimatedAskCost(model: string): number | null {
  const rates = PRICE_TABLE[model];
  return rates ? costOf({ inputTokens: ESTIMATED_TOKENS_PER_QUESTION.input, outputTokens: ESTIMATED_TOKENS_PER_QUESTION.output }, rates) : null;
}

/**
 * "about $0.02": rounded up to a whole cent, so it is never "$0.00" and never less than the estimate. Null when the
 * model has no rate: the button then says nothing about cost rather than guess.
 */
export function askCostLabel(model: string): string | null {
  const cost = estimatedAskCost(model);
  if (cost === null) return null;
  const cents = Math.max(1, Math.ceil(Math.round(cost * 1e6) / 1e4));
  return `about $${(cents / 100).toFixed(2)}`;
}

// Step 12: a split question is researched (it may read the whole Home Depot page and search), which sends and receives more
// than one call about a listing: its estimate is the research agent's (core/src/research/eval.ts). The real cost of each question
// is kept with its suggestion.

/** Dollars one question of this kind may cost on `model`; null for a model with no published rate. */
export function estimatedQuestionCost(kind: 'split' | 'match', model: string): number | null {
  return kind === 'match' ? estimatedAskCost(model) : estimatedResearchCost(model);
}

const centsOf = (dollars: number): number => Math.max(1, Math.ceil(Math.round(dollars * 1e6) / 1e4));

/** "about $0.10" for one question of this kind, rounded up to a whole cent; null when the model has no rate. */
export function questionCostLabel(kind: 'split' | 'match', model: string): string | null {
  const cost = estimatedQuestionCost(kind, model);
  return cost === null ? null : `about $${(centsOf(cost) / 100).toFixed(2)}`;
}

/**
 * What asking about all of these questions may cost: the sum of each one's estimate, rounded up, in cents under a dollar and in
 * whole dollars from a dollar ("about $3"). Null when there is nothing to ask or the model has no rate.
 */
export function askAllCostLabel(kinds: readonly ('split' | 'match')[], model: string): string | null {
  if (kinds.length === 0) return null;
  let total = 0;
  for (const k of kinds) {
    const c = estimatedQuestionCost(k, model);
    if (c === null) return null;
    total += c;
  }
  return total >= 1 ? `about $${Math.ceil(Math.round(total * 1e6) / 1e6)}` : `about $${(centsOf(total) / 100).toFixed(2)}`;
}
