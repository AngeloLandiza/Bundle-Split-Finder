// Review questions the owner answers: the choices a split question offers, and what an answer
// changes in the store.
//
// A split question offers the readings its split carries (Decomposition.alternatives), each
// once. Only the owner's answer turns one of them into the split.

import type { Decomposition } from '../decompose';
import type { ReviewItem } from './types';

/** The same parts, whatever their order; a part listed twice counts twice. */
const partsKey = (parts: string[]): string => [...parts].sort().join(',');

/**
 * The readings a split question offers: the split's alternatives, in their order (the model
 * number's reading, then the page's, then the rest sorted by their parts), each set of parts once.
 * Empty when the split has none.
 */
export function splitChoices(split: Decomposition): string[][] {
  const seen = new Set<string>();
  const choices: string[][] = [];
  for (const reading of split.alternatives ?? []) {
    const key = partsKey(reading);
    if (reading.length === 0 || seen.has(key)) continue;
    seen.add(key);
    choices.push([...reading]);
  }
  return choices;
}

/** An item's choices. An item saved before step 5 has none stored: it reads as []. */
export const choicesOf = (item: ReviewItem): string[][] => (Array.isArray(item.choices) ? item.choices : []);

/** Two lists of choices, the same in the same order. */
export const sameChoices = (a: string[][], b: string[][]): boolean =>
  a.length === b.length && a.every((x, i) => x.length === b[i]!.length && x.every((m, j) => m === b[i]![j]));
