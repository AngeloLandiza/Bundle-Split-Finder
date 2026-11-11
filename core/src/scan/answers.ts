// Review questions the owner answers: the choices a split question offers, and what an answer
// changes in the store.
//
// A split question offers the readings its split carries (Decomposition.alternatives), each
// once. Only the owner's answer turns one of them into the split: a chosen reading stands on
// every later scan instead of the model number's and the page's (the runner reads the answered
// item before it splits), and "none" keeps the bundle not known. A match answer is a match record
// decided by the user, which no scan changes.

import { type Decomposition, OFFERABLE_PART } from '../decompose';
import { knownModels, readSplit } from './split';
import type { OwnerAnswer, ReviewAnswer, ReviewCandidate, ReviewItem, ScanStore } from './types';

/** The note on a split the owner chose. */
export const CHOSEN_NOTE = 'parts chosen by you';
/** The note on a split whose parts the owner typed, when they are not one of the question's choices. */
export const ENTERED_NOTE = 'parts entered by you';
/** At most this many parts may be typed for one bundle. */
export const MAX_ENTERED_PARTS = 8;
/** The note on a bundle whose split question the owner answered with "None of these". */
export const NONE_NOTE = 'you answered none of these';
/** The answer saved for "None of these", on split and match questions. */
export const NONE = 'none';
/**
 * The answer a scan gives a split question when the bundle resolves; any other answer is the
 * user's. Only a user's answer that names one of the item's choices, typed parts, or 'none',
 * decides the split (ownerSplit).
 */
export const RESOLVED_BY_SCAN = 'resolved by a later scan';

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
const INVALID_PARTS = 'Enter model numbers like PCL500B, separated by commas.';
const NOT_FOR_MATCH = 'Parts can be entered only for a question about what a bundle contains.';
const SELF_PART = "Enter the parts inside the bundle, not the bundle's own model number.";
const NOT_ANSWERED = 'That question has not been answered yet.';
const ONLY_SPLIT = 'Only an answer about what a bundle contains can be changed.';
const NOT_YOURS = 'That question has no answer of yours to change.';

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

/** The split of a bundle whose parts the owner chose (`note` CHOSEN_NOTE) or typed (ENTERED_NOTE). */
export const chosenSplit = (parts: string[], note: string = CHOSEN_NOTE): Decomposition => ({ components: [...parts], status: 'resolved', notes: [note] });

/** The split of a bundle the owner said none of the readings fits: in review, whatever a scan reads. */
export function notKnown(split: Decomposition | null): Decomposition {
  const s: Decomposition = split ?? { components: [], status: 'needs_review', notes: [] };
  return { ...s, status: 'needs_review', notes: s.notes.includes(NONE_NOTE) ? s.notes : [...s.notes, NONE_NOTE] };
}

/**
 * What the owner's answer to a split question fixes: the split of the parts they chose or typed,
 * or NONE. An item with `answerParts` (every answer saved since typed parts exist) is decided by
 * them, when `answer` is them joined and they still pass the typed-parts rule (stored data is
 * untrusted: 1 to MAX_ENTERED_PARTS entries, each OFFERABLE_PART and none the bundle's own model
 * number, Ruling 43); the split is noted as chosen when
 * they are one of the question's choices, as entered otherwise. An item without them, or with
 * parts that fail the rule, counts as before: only when its answer equals one of its choices.
 * Null when the owner has not answered: the item is missing or
 * open, a scan closed it itself, or its answer names none of its choices (an answer saved before
 * step 5).
 */
export function ownerSplit(item: ReviewItem | undefined): Decomposition | typeof NONE | null {
  if (!item || item.kind !== 'split' || item.answer === null) return null;
  if (item.answer === NONE) return NONE;
  const choices = choicesOf(item);
  const parts = item.answerParts;
  if (validParts(parts) && !parts.some(isBundle(item)) && parts.join(',') === item.answer) {
    return chosenSplit(parts, choices.some((c) => c.join(',') === item.answer) ? CHOSEN_NOTE : ENTERED_NOTE);
  }
  const chosen = choices.find((c) => c.join(',') === item.answer);
  return chosen ? chosenSplit(chosen) : null;
}

/**
 * Which of the owner's answers decides `split`, the bundle's split as stored: the answer of `item`, its
 * split question, when ownerSplit reads one and the split is it (the parts chosen or entered, resolved,
 * with its note) or, for "none", the split is noted as the owner's none. Null otherwise: no question,
 * an open one, one a scan closed, an answer that decides nothing, or a split that is not the answer's.
 */
export function ownerAnswer(item: ReviewItem | undefined, split: Decomposition | null): OwnerAnswer | null {
  const owner = ownerSplit(item);
  if (owner === null || !item || !split) return null;
  if (owner === NONE) return split.status !== 'resolved' && split.notes.includes(NONE_NOTE) ? { reviewId: item.id, kind: 'none' } : null;
  const note = owner.notes[0]!;
  const same = split.status === 'resolved' && split.notes.includes(note) &&
    split.components.length === owner.components.length && split.components.every((m, i) => m === owner.components[i]);
  return same ? { reviewId: item.id, kind: note === CHOSEN_NOTE ? 'chosen' : 'entered' } : null;
}

/** 1 to MAX_ENTERED_PARTS entries, each a model number (OFFERABLE_PART). A repeat counts as an entry. */
function validParts(parts: unknown): parts is string[] {
  return (
    Array.isArray(parts) && parts.length > 0 && parts.length <= MAX_ENTERED_PARTS &&
    parts.every((p) => typeof p === 'string' && OFFERABLE_PART.test(p))
  );
}

/** A model number with its hyphens and spaces taken out, upper case: `PCL1600K2-P553` and `PCL1600K2P553` are one model. */
const bare = (model: string): string => model.toUpperCase().replace(/[-\s]/g, '');

/**
 * A part that is the bundle the question is about (its `model`), hyphens and spaces aside: a bundle
 * is never its own part (Ruling 43).
 */
const isBundle = (item: ReviewItem) => (part: string): boolean => bare(part) === bare(item.model);

/**
 * The parts the owner typed for `item`, as model numbers: each trimmed and upper-cased, in the order
 * typed. A part typed twice is kept twice: a split lists a part once per unit, so it means two of it.
 * The entries must pass validParts, and none may be the bundle's own model number (Ruling 43);
 * anything else is refused. Nothing is guessed from what was typed.
 */
function enteredParts(raw: unknown, item: ReviewItem): string[] {
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) throw new AnswerRefused(INVALID_PARTS);
  const parts = raw.map((p: string) => p.trim().toUpperCase());
  if (!validParts(parts)) throw new AnswerRefused(INVALID_PARTS);
  if (parts.some(isBundle(item))) throw new AnswerRefused(SELF_PART);
  return parts;
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
 *        with those parts joined by ',' (and as `answerParts`). `{ parts }` does the same with the
 *        parts the owner typed (enteredParts), noted as entered by the owner unless they are one of
 *        the choices. `{ none: true }` answers 'none' and leaves the bundle in review, noted.
 * match  `{ choice: i }` saves `candidates[i]` as the part's match, decided by the user, with the
 *        price the question showed for it (saveShownPrice), and answers the item with its ASIN.
 *        `{ none: true }` saves that the part has no listing, decided by the user, and answers 'none'.
 *
 * Refused with AnswerRefused, writing nothing, for an unknown id, an item already answered (by
 * the owner or by a scan), an answer whose `seen` is not the item's signature now (a scan changed
 * the question since it was shown; checked before the index or the parts), an answer that is not
 * one the item shows, typed parts for a match question, typed parts that are not 1 to 8 model
 * numbers, or typed parts that name the bundle itself. The record the answer decides is written before the item, so a failure between the
 * two leaves the question open to be answered again.
 */
export async function applyReviewAnswer(store: ScanStore, id: string, answer: ReviewAnswer, now: number): Promise<void> {
  const item = typeof id === 'string' ? await store.getReview(id) : undefined;
  if (!item) throw new AnswerRefused(NOT_FOUND);
  if (item.answer !== null) throw new AnswerRefused(ANSWERED);
  const given = signed(answer);
  if (given.seen !== reviewSignature(item)) throw new AnswerRefused(CHANGED);
  const choices = choicesOf(item);
  const typing = 'parts' in given;
  if (typing && item.kind !== 'split') throw new AnswerRefused(NOT_FOR_MATCH);

  if (item.kind === 'split') {
    let parts: string[] | null;
    if (typing) {
      // Typed parts and a choice or "none" at once is not an answer the panel sends.
      if ('choice' in given || 'none' in given) throw new AnswerRefused(NOT_SHOWN);
      parts = enteredParts(given.parts, item);
    } else {
      const pick = picked(given, choices.length);
      parts = pick === NONE ? null : [...choices[pick]!];
    }
    const answered: ReviewItem = { ...item, choices, answer: parts === null ? NONE : parts.join(','), answerParts: parts, answeredAt: now };
    // The split a later scan reads from the answered item (ownerSplit), so the two never differ.
    const split = ownerSplit(answered);
    const bundle = await store.getBundle(item.subject);
    // A bundle not stored (never the case after a scan) takes the answer when a scan sees it.
    if (bundle) await store.putBundle({ ...bundle, split: split === NONE || split === null ? notKnown(bundle.split) : split });
    await store.putReview(answered);
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

// ---------------------------------------------------------------- changing an answer

/**
 * Opens again split question `id`, which the owner answered (a reading chosen, parts typed, or
 * "none": an answer ownerSplit reads), so it can be answered again (Ruling 42). The item loses its
 * answer, `answerParts` and `answeredAt`, and keeps `openedAt`. Its bundle is split at once as a scan
 * splits a bundle no answer decides (split.ts, readSplit, with the store's known models): normally
 * in review, Contents not known, with the question open and taking that reading's reason and
 * choices, as a scan updates an open question; a new answer is signed against them as usual, so one
 * made for the old choices is refused. Should that reading now resolve, the item
 * is closed as a scan closes it (RESOLVED_BY_SCAN, at `now`), as the next scan would. Match records
 * and prices saved for the old parts stay; nothing reads them for this bundle.
 *
 * Refused with AnswerRefused, writing nothing, for an unknown id, a match question, an open
 * question, and one a scan closed itself or whose stored answer decides nothing. The bundle is
 * written before the item, so a failure between the two leaves the answer standing, and the next
 * scan applies it again.
 */
export async function reopenReviewAnswer(store: ScanStore, id: string, now: number): Promise<void> {
  const item = typeof id === 'string' ? await store.getReview(id) : undefined;
  if (!item) throw new AnswerRefused(NOT_FOUND);
  if (item.kind !== 'split') throw new AnswerRefused(ONLY_SPLIT);
  if (item.answer === null) throw new AnswerRefused(NOT_ANSWERED);
  if (ownerSplit(item) === null) throw new AnswerRefused(NOT_YOURS);

  const { answerParts: _answerParts, ...rest } = item;
  const open: ReviewItem = { ...rest, choices: choicesOf(item), answer: null, answeredAt: null };
  const bundle = await store.getBundle(item.subject);
  // A bundle not stored (never the case after a scan) is split when a scan sees it.
  if (!bundle) {
    await store.putReview(open);
    return;
  }
  const split = readSplit(bundle, await knownModels(store));
  await store.putBundle({ ...bundle, split });
  if (split.status === 'resolved') {
    await store.putReview({ ...open, answer: RESOLVED_BY_SCAN, answeredAt: now });
    return;
  }
  // As a scan updates an open question: the reading's reason and choices, openedAt kept.
  await store.putReview({ ...open, reason: split.notes.join('; '), choices: splitChoices(split) });
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
