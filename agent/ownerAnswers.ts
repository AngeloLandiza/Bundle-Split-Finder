// Undo for an answer the owner saved himself in Review. The same idea as Autopilot's Undo (autopilot.ts) but for both
// kinds of question: before the answer is applied the agent keeps the records the answer is about to write, and right
// after it keeps what it wrote. Undo puts the first back, and only while the records are still the second: if a later
// scan or answer changed any of them, taking the answer back would undo something newer, so it is refused in one plain
// sentence.

import type { Decomposition } from '../core/src/decompose';
import { AnswerRefused } from '../core/src/scan/answers';
import { twinKeys } from '../core/src/scan/twins';
import type { MatchRecord, ReviewItem, ScanStore } from '../core/src/scan/types';
import type { StoredOwnerAnswer } from './store';

/** The newest owner answers the agent keeps for Undo. */
export const KEEP_OWNER_ANSWERS = 50;

/** The records one answer writes: the question (and, for a match, its twins' questions), the bundle's split, the match records. */
export interface Footprint {
  reviews: Record<string, ReviewItem | null>;
  /** A split question's bundle and the split it holds; null for a match question or a bundle that is not stored. */
  bundle: { key: string; split: Decomposition | null } | null;
  matches: Record<string, MatchRecord | null>;
}

/** What an answer to `item` writes, as the records stand now. */
export async function footprintOf(store: ScanStore, item: ReviewItem): Promise<Footprint> {
  const reviews: Footprint['reviews'] = {};
  const matches: Footprint['matches'] = {};
  let bundle: Footprint['bundle'] = null;
  if (item.kind === 'split') {
    reviews[item.id] = (await store.getReview(item.id)) ?? null;
    const b = await store.getBundle(item.subject);
    if (b) bundle = { key: b.key, split: b.split };
  } else {
    const twins = twinKeys(item.brand, item.model);
    for (const id of [item.id, ...twins.map((k) => `match:${k}`)]) reviews[id] = (await store.getReview(id)) ?? null;
    for (const key of [item.subject, ...twins]) matches[key] = (await store.getMatch(key)) ?? null;
  }
  return { reviews, bundle, matches };
}

/** Records compared as the JSON they are stored as, whatever order their keys are in. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );

export const sameFootprint = (a: Footprint, b: Footprint): boolean => canon(a) === canon(b);

/**
 * Whether Undo can put every record back. It cannot delete: a match record the answer created, where none was before, would
 * stay and keep deciding the part, so such an answer is kept without Undo.
 */
export function restorable(before: Footprint, after: Footprint): boolean {
  return Object.entries(after.matches).every(([key, rec]) => rec === null || before.matches[key] != null);
}

export const CHANGED_SINCE = 'This answer can no longer be undone: a later scan or answer changed what it saved. Change the answer in Review instead.';

/** The answer in plain words for Activity: the parts, "None of these", or the listing's ASIN. */
export function answerText(answered: ReviewItem): string {
  if (answered.answer === null || answered.answer === 'none') return 'None of these';
  const parts = answered.answerParts;
  return Array.isArray(parts) && parts.length > 0 ? parts.join(', ') : answered.answer;
}

/**
 * Puts the records back as they were before the answer. Refused (nothing written) when the entry was undone already, is
 * marked not undoable, or any record is no longer what the answer left. The match records and the split go back first and
 * the question last, as an answer writes them, so a failure between leaves the answer standing.
 */
export async function undoOwnerAnswer(store: ScanStore, entry: StoredOwnerAnswer): Promise<void> {
  if (entry.undoneAt !== null) throw new AnswerRefused('That answer was undone already.');
  if (!entry.undoable) throw new AnswerRefused(CHANGED_SINCE);
  const question = entry.before.reviews[entry.questionId];
  if (!question) throw new AnswerRefused(CHANGED_SINCE);
  if (!sameFootprint(await footprintOf(store, question), entry.after)) throw new AnswerRefused(CHANGED_SINCE);
  for (const rec of Object.values(entry.before.matches)) if (rec) await store.putMatch(rec);
  if (entry.before.bundle) {
    // Only the split goes back: the rest of the bundle (its price, when it was seen) may be newer and is not the answer's.
    const b = await store.getBundle(entry.before.bundle.key);
    if (b) await store.putBundle({ ...b, split: entry.before.bundle.split });
  }
  for (const rec of Object.values(entry.before.reviews)) if (rec) await store.putReview(rec);
}
