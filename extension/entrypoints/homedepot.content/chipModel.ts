// What the chip says, from the worker's PageView. The copy is design.md's ("Chip on Home Depot product
// pages") and the step 7 contract's. Nothing here guesses: a bundle the worker could not split says so.

import { profit, roi } from '../../lib/format';
import type { BundleView } from './protocol';

export type ChipModel =
  /** Splits into N parts, with the estimate. */
  | { kind: 'estimate'; parts: number; profit: string; roi: string; loss: boolean }
  /** Splits into N parts, prices not looked up yet; a Look up would spend `searches`. */
  | { kind: 'lookup'; parts: number; searches: number }
  /** The split needs the owner's answer. `parts` is the one reading's size, null when there is none or several. */
  | { kind: 'question'; parts: number | null }
  /** Splits into N parts, with no figures to show. */
  | { kind: 'plain'; parts: number };

/** "Splits into 2 parts", "Splits into 1 part". */
export const splitsInto = (n: number): string => `Splits into ${n} ${n === 1 ? 'part' : 'parts'}`;

export const searchesText = (n: number): string => `${n} ${n === 1 ? 'search' : 'searches'}`;

/** Null when there is nothing honest to show: the owner said none of the readings fits, so no parts are known. */
export function chipModel(view: BundleView): ChipModel | null {
  if (view.question !== null) {
    const readings = Array.isArray(view.question.choices) ? view.question.choices : [];
    const only = readings.length === 1 ? readings[0] : undefined;
    return { kind: 'question', parts: only !== undefined && only.length > 0 ? only.length : null };
  }
  if (view.parts <= 0) return null;
  const estimate = view.row.estimate;
  if (estimate !== null) return { kind: 'estimate', parts: view.parts, profit: profit(estimate.profit), roi: roi(estimate.roi), loss: estimate.profit < 0 };
  if (view.lookupParts > 0) return { kind: 'lookup', parts: view.parts, searches: view.lookupParts };
  return { kind: 'plain', parts: view.parts };
}
