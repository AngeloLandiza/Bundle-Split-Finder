// Ask AI about all (step 12): which open questions a background queue asks about. Pure; the queue itself is the worker's.

import type { ReviewItem } from '../scan/types';
import { liveSuggestion, type StoredSuggestion } from './stored';

/**
 * Whether asking about this question makes a call. A split question always does: research can read the bundle's page
 * and propose parts even when the tool offered no reading. A match question needs a listing to choose from.
 */
export const canAsk = (item: ReviewItem): boolean => (item.kind === 'split' ? true : item.candidates.length > 0);

/**
 * The questions worth asking about, in the order given: open, something to ask, and no suggestion of any kind already on
 * screen for them (a "could not tell" is an answer to a question, asked once: asking again is the owner's call, one question
 * at a time). A suggestion made for other readings is not shown, so it does not count.
 */
export function askQueueOf(items: readonly ReviewItem[], records: readonly StoredSuggestion[]): ReviewItem[] {
  return items.filter((q) => q.answer === null && canAsk(q) && liveSuggestion(records, q) === undefined);
}
