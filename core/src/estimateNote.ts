// What a profit estimate leaves out while the owner has not said what his sales tax and inbound shipping are.
//
// The settings default both to 0, and a stored 0 cannot tell "no tax" from "never asked". `FeeSettings.salesTaxAnswered` and
// `inboundAnswered` carry the answer. Every surface that states a profit says the same words from here (rule 5: estimates
// are labelled). This never changes the profit: only what is said beside it.

import type { FeeSettings } from './money';

export type CostKey = 'salesTax' | 'inbound';

/** What each cost is called to the owner. */
export const COST_LABEL: Record<CostKey, string> = { salesTax: 'sales tax', inbound: 'inbound shipping' };

type Answers = Pick<FeeSettings, 'salesTaxRate' | 'inboundCost' | 'salesTaxAnswered' | 'inboundAnswered'>;

/** A cost counts as answered when marked so, or, on a store from before the mark, when it holds something other than 0. */
export const salesTaxAnswered = (f: Answers): boolean => f.salesTaxAnswered ?? f.salesTaxRate !== 0;
export const inboundAnswered = (f: Answers): boolean => f.inboundAnswered ?? f.inboundCost !== 0;

/** The costs the owner has not answered yet, in reading order. */
export function unansweredCosts(fees: Answers | null | undefined): CostKey[] {
  if (!fees) return [];
  const out: CostKey[] = [];
  if (!salesTaxAnswered(fees)) out.push('salesTax');
  if (!inboundAnswered(fees)) out.push('inbound');
  return out;
}

const joinWords = (keys: readonly CostKey[]): string => keys.map((k) => COST_LABEL[k]).join(' and ');

/** "before sales tax and inbound shipping" (only the ones not answered), or null when both are. */
export function profitQualifier(fees: Answers | null | undefined): string | null {
  const keys = unansweredCosts(fees);
  return keys.length ? `before ${joinWords(keys)}` : null;
}

/** An estimate's words with the qualifier after them: "est. profit $34.62 before sales tax and inbound shipping". */
export const withProfitQualifier = (text: string, fees: Answers | null | undefined): string => {
  const q = profitQualifier(fees);
  return q ? `${text} ${q}` : text;
};

/** The one calm question: what is not set and what it does to the figures. Null once both are answered. */
export function costsPromptSentence(fees: Answers | null | undefined): string | null {
  const keys = unansweredCosts(fees);
  if (!keys.length) return null;
  const many = keys.length > 1;
  return `Your ${joinWords(keys)} ${many ? 'are' : 'is'} not set, so profit estimates leave ${many ? 'them' : 'it'} out. Enter ${many ? 'them' : 'it'} in Settings, or confirm that ${many ? 'they are' : 'it is'} 0.`;
}
