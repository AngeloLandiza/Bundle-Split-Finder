// Scoring a listing judge against labelled listings. Pure: no files, no network. The eval script
// (scripts/judge-eval-cli.ts) reads the files and calls this.

import { ebayValue } from '../ebay/value';
import type { EbayListing, EbayValue, EbayVerdict } from '../ebay/types';
import type { JudgeVerdict, TokenUsage } from './types';

export interface Label { itemId: string; model: string; verdict: JudgeVerdict; labelledBy: 'draft' | 'owner' }

/** One judged listing as the judgements file keeps it: a verdict, or a notJudged reason, never both. */
export interface EvalResult {
  itemId: string;
  model: string;
  verdict?: JudgeVerdict;
  notJudged?: { reason: string; message: string };
  reasons: string[];
  usage?: TokenUsage;
}

/** Dollars per million tokens. `cacheRead`: a prompt-cache read (step 12 research caches its prompt); a cache write is 1.25x input (5-minute entries). */
export interface PriceRates { input: number; output: number; cacheRead?: number }
/** Dollars per million tokens. */
export const PRICE_TABLE: Record<string, PriceRates> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  // DeepSeek, read Nov 22, 2026 at https://api-docs.deepseek.com/quick_start/pricing: input = the cache-miss rate, cacheRead = the
  // cache-hit rate, at the PEAK price (01:00-04:00 and 06:00-10:00 UTC on weekdays; off-peak is half), so an estimate never undershoots.
  // The page states no effective date for these prices. A model id is its own key: the same model through another host has another id.
  'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 },
  'deepseek-v4-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 }, // the legacy name, served by deepseek-flash (same page)
  'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044 },
};

/** The rates for a model, or null when none is known (a price is then never guessed). */
export const ratesFor = (model: string): PriceRates | null => PRICE_TABLE[model] ?? null;

/**
 * Sets (or replaces) a model's rates: the way a price that changed, or a model this file has never heard of, gets a cost. The agent
 * calls it with the owner's Settings; every cost and estimate in core reads PRICE_TABLE, so they follow.
 */
export function setModelRates(model: string, rates: PriceRates): void {
  PRICE_TABLE[model] = { ...rates };
}

export const costOf = (usage: { inputTokens: number; outputTokens: number }, rates: PriceRates): number =>
  (usage.inputTokens * rates.input + usage.outputTokens * rates.output) / 1_000_000;

export const RELIABLE_MIN_LABELLED = 100;
export const RELIABLE_MIN_OWNER = 30;
export const RELIABLE_MIN_RECALL = 0.7;

export interface PartValueCompare {
  model: string;
  fromJudge: EbayValue | null;
  fromLabels: EbayValue | null;
  /** Listings, units, low or high differ. */
  changed: boolean;
}

export interface EvalScore {
  labelled: number;
  ownerChecked: number;
  labelledMatches: number;
  /** Judge said match, label says not_match or unsure. */
  falseMatches: { itemId: string; model: string; label: JudgeVerdict }[];
  /** Judge said match and label says match. */
  trueMatchesAccepted: number;
  /** trueMatchesAccepted / labelledMatches; null with no labelled match. */
  recall: number | null;
  /** Judge said unsure, over listings that got a verdict. */
  unsure: number;
  judged: number;
  unsureRate: number | null;
  /** Listings with no verdict: a failed call or no result at all. Never counted as a verdict. */
  notJudged: number;
  tokens: { input: number; output: number };
  cost: number | null;
  partValues: PartValueCompare[];
  reliable: { check: string; pass: boolean; detail: string }[];
  passes: boolean;
}

const key = (model: string, itemId: string): string => `${model}\u0000${itemId}`;

const sameValue = (a: EbayValue | null, b: EbayValue | null): boolean =>
  a === null || b === null ? a === b : a.listings === b.listings && a.unitsSold === b.unitsSold && a.low === b.low && a.high === b.high;

export function scoreJudgements(input: {
  labels: Label[];
  results: EvalResult[];
  /** Parsed listings by part model, then item id (the recording's `items`). */
  listings: Record<string, Record<string, EbayListing>>;
  rates?: PriceRates;
}): EvalScore {
  const byKey = new Map(input.results.map((r) => [key(r.model, r.itemId), r]));
  // Only a result with a verdict counts; a notJudged result (or none) is no verdict.
  const verdictOf = (l: Label): JudgeVerdict | null => byKey.get(key(l.model, l.itemId))?.verdict ?? null;

  const falseMatches: EvalScore['falseMatches'] = [];
  let accepted = 0, unsure = 0, judged = 0, notJudged = 0;
  const labelledMatches = input.labels.filter((l) => l.verdict === 'match').length;
  for (const l of input.labels) {
    const v = verdictOf(l);
    if (v === null) { notJudged++; continue; }
    judged++;
    if (v === 'unsure') unsure++;
    if (v === 'match') {
      if (l.verdict === 'match') accepted++;
      else falseMatches.push({ itemId: l.itemId, model: l.model, label: l.verdict });
    }
  }

  let inTok = 0, outTok = 0;
  for (const r of input.results) { inTok += r.usage?.inputTokens ?? 0; outTok += r.usage?.outputTokens ?? 0; }

  const models = [...new Set(input.labels.map((l) => l.model))].sort();
  const partValues = models.map((model): PartValueCompare => {
    const value = (pick: (l: Label) => JudgeVerdict | null): EbayValue | null => {
      const judgedList: { listing: EbayListing; verdict: EbayVerdict }[] = [];
      for (const l of input.labels.filter((x) => x.model === model)) {
        const listing = input.listings[model]?.[l.itemId];
        const verdict = pick(l);
        if (listing && verdict) judgedList.push({ listing, verdict });
      }
      return ebayValue(judgedList);
    };
    const fromJudge = value(verdictOf);
    const fromLabels = value((l) => l.verdict);
    return { model, fromJudge, fromLabels, changed: !sameValue(fromJudge, fromLabels) };
  });

  const labelled = input.labels.length;
  const ownerChecked = input.labels.filter((l) => l.labelledBy === 'owner').length;
  const recall = labelledMatches > 0 ? accepted / labelledMatches : null;
  const reliable = [
    { check: `at least ${RELIABLE_MIN_LABELLED} labelled listings`, pass: labelled >= RELIABLE_MIN_LABELLED, detail: `${labelled} labelled` },
    { check: `at least ${RELIABLE_MIN_OWNER} checked by the owner`, pass: ownerChecked >= RELIABLE_MIN_OWNER, detail: `${ownerChecked} owner-checked` },
    { check: 'zero false matches', pass: falseMatches.length === 0, detail: `${falseMatches.length} false matches` },
    { check: `at least ${RELIABLE_MIN_RECALL * 100}% of labelled matches accepted`, pass: recall !== null && recall >= RELIABLE_MIN_RECALL, detail: recall === null ? 'no labelled match' : `${accepted} of ${labelledMatches} (${(recall * 100).toFixed(1)}%)` },
  ];

  return {
    labelled, ownerChecked, labelledMatches, falseMatches, trueMatchesAccepted: accepted, recall,
    unsure, judged, unsureRate: judged > 0 ? unsure / judged : null, notJudged,
    tokens: { input: inTok, output: outTok },
    cost: input.rates ? costOf({ inputTokens: inTok, outputTokens: outTok }, input.rates) : null,
    partValues, reliable, passes: reliable.every((r) => r.pass),
  };
}
