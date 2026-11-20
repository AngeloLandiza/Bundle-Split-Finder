// What one Ask AI press costs, said on the button before the click (design.md principle 4). An estimate,
// from the model's published rates and a typical question: the instructions are about 750 tokens, the
// question and its evidence 300 to 900, the answer schema a few hundred, and the answer with its thinking
// a few hundred more (A1 report). The real cost of each call is kept with it (stored.ts, suggestionCost).

import { costOf, PRICE_TABLE } from '../judge/eval';

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
