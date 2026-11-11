// Review questions the owner answers: the choices a split question offers, and what an answer
// changes in the store.
//
// A split question offers the readings its split carries (Decomposition.alternatives), each
// once. Only the owner's answer turns one of them into the split: a chosen reading stands on
// every later scan instead of the model number's and the page's (the runner reads the answered
// item before it splits), and "none" keeps the bundle not known. A match answer is a match record
// decided by the user, which no scan changes.

import type { Decomposition } from '../decompose';
import type { ReviewAnswer, ReviewCandidate, ReviewItem, ScanStore } from './types';

/** The note on a split the owner chose. */
export const CHOSEN_NOTE = 'parts chosen by you';
/** The note on a bundle whose split question the owner answered with "None of these". */
export const NONE_NOTE = 'you answered none of these';
/** The answer saved for "None of these", on split and match questions. */
export const NONE = 'none';

/** An answer that is refused. The message is one plain sentence for the owner. */
export class AnswerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswerRefused';
  }
}

const NOT_FOUND = 'That question was not found.';
const ANSWERED = 'That question was already answered.';
const NOT_SHOWN = 'Choose one of the answers shown.';
const CHANGED = 'That question changed. Choose again.';

// ---------------------------------------------------------------- choices

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

/**
 * What a question shows the owner to choose from, as text: a split question's choices, a match
 * question's listings by ASIN. A scan may rewrite an open split question's choices, so an answer
 * carries the signature of what it was given (ReviewAnswer.seen); the panel computes it with this
 * same function.
 */
export function reviewSignature(item: ReviewItem): string {
  return item.kind === 'split' ? JSON.stringify(choicesOf(item)) : JSON.stringify(item.candidates.map((c) => c.asin));
}

/** Two lists of choices, the same in the same order. */
export const sameChoices = (a: string[][], b: string[][]): boolean =>
  a.length === b.length && a.every((x, i) => x.length === b[i]!.length && x.every((m, j) => m === b[i]![j]));

// ---------------------------------------------------------------- what an answer fixes

/** The split of a bundle whose parts the owner chose. */
export const chosenSplit = (parts: string[]): Decomposition => ({ components: [...parts], status: 'resolved', notes: [CHOSEN_NOTE] });

/** The split of a bundle the owner said none of the readings fits: in review, whatever a scan reads. */
export function notKnown(split: Decomposition | null): Decomposition {
  const s: Decomposition = split ?? { components: [], status: 'needs_review', notes: [] };
  return { ...s, status: 'needs_review', notes: s.notes.includes(NONE_NOTE) ? s.notes : [...s.notes, NONE_NOTE] };
}

/**
 * What the owner's answer to a split question fixes: the parts of the reading they chose, or NONE.
 * Null when they have not answered: the item is missing or open, a scan closed it itself, or its
 * answer names none of its choices (an answer saved before step 5).
 */
export function ownerSplit(item: ReviewItem | undefined): string[] | typeof NONE | null {
  if (!item || item.kind !== 'split' || item.answer === null) return null;
  if (item.answer === NONE) return NONE;
  const chosen = choicesOf(item).find((c) => c.join(',') === item.answer);
  return chosen ? [...chosen] : null;
}

// ---------------------------------------------------------------- applying an answer

/** An answer as the panel sends it: an object signed with a text `seen`. Anything else is refused. */
function signed(answer: unknown): Record<string, unknown> & { seen: string } {
  if (typeof answer === 'object' && answer !== null && typeof (answer as { seen?: unknown }).seen === 'string') {
    return answer as Record<string, unknown> & { seen: string };
  }
  throw new AnswerRefused(NOT_SHOWN);
}

/** The index `a` picks among `count` answers, or NONE. Anything else is refused. */
function picked(a: Record<string, unknown>, count: number): number | typeof NONE {
  if (a.none === true && !('choice' in a)) return NONE;
  const i = a.choice;
  if (!('none' in a) && typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < count) return i;
  throw new AnswerRefused(NOT_SHOWN);
}

/**
 * Saves the owner's answer to review item `id`, answered at `now`.
 *
 * split  `{ choice: i }` sets the bundle's split to `choices[i]`, resolved, and answers the item
 *        with those parts joined by ','. `{ none: true }` answers 'none' and leaves the bundle in
 *        review, noted.
 * match  `{ choice: i }` saves `candidates[i]` as the part's match, decided by the user, with the
 *        price the question showed for it (saveShownPrice), and answers the item with its ASIN.
 *        `{ none: true }` saves that the part has no listing, decided by the user, and answers 'none'.
 *
 * Refused with AnswerRefused, writing nothing, for an unknown id, an item already answered (by
 * the owner or by a scan), an answer whose `seen` is not the item's signature now (a scan changed
 * the question since it was shown; checked before the index), or an answer that is not one the
 * item shows. The record the answer decides is written before the item, so a failure between the
 * two leaves the question open to be answered again.
 */
export async function applyReviewAnswer(store: ScanStore, id: string, answer: ReviewAnswer, now: number): Promise<void> {
  const item = typeof id === 'string' ? await store.getReview(id) : undefined;
  if (!item) throw new AnswerRefused(NOT_FOUND);
  if (item.answer !== null) throw new AnswerRefused(ANSWERED);
  const given = signed(answer);
  if (given.seen !== reviewSignature(item)) throw new AnswerRefused(CHANGED);
  const choices = choicesOf(item);

  if (item.kind === 'split') {
    const pick = picked(given, choices.length);
    const parts = pick === NONE ? null : choices[pick]!;
    const bundle = await store.getBundle(item.subject);
    // A bundle not stored (never the case after a scan) takes the answer when a scan sees it.
    if (bundle) await store.putBundle({ ...bundle, split: parts === null ? notKnown(bundle.split) : chosenSplit(parts) });
    await store.putReview({ ...item, choices, answer: parts === null ? NONE : parts.join(','), answeredAt: now });
    return;
  }

  const pick = picked(given, item.candidates.length);
  const asin = pick === NONE ? null : item.candidates[pick]!.asin;
  if (pick !== NONE) await saveShownPrice(store, item.candidates[pick]!);
  await store.putMatch({
    key: item.subject, brand: item.brand, model: item.model, status: asin === null ? 'none' : 'matched', asin, grade: null,
    alternatives: [], decidedBy: 'user', updatedAt: now, waitingSince: null,
  });
  await store.putReview({ ...item, choices, answer: asin ?? NONE, answeredAt: now });
}

/**
 * The price a match question showed for the listing the owner chose, saved as the response that showed it
 * saw it, at its time (`seenAt`), as a refresh of that response would save it: a listing shown without a
 * price keeps the time its last price was seen. A price checked later than that response is kept. A candidate
 * saved before it carried a time saves nothing; the next scan refreshes its price.
 */
async function saveShownPrice(store: ScanStore, cand: ReviewCandidate): Promise<void> {
  const at = (cand as { seenAt?: unknown }).seenAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) return;
  const old = await store.getPrice(cand.asin);
  if (old && old.checkedAt > at) return;
  const price = typeof cand.price === 'number' ? cand.price : null;
  await store.putPrice({ asin: cand.asin, price, reviews: cand.reviews ?? null, seenAt: price === null ? (old?.seenAt ?? null) : at, checkedAt: at });
}
