// Holding an automatic match for the owner: a listing the code counted, or had confirmed, that a later rule says needs a
// look (CLAUDE.md rule 4: an uncertain match is a question, never an answer). The part goes to the Review "Which listing"
// question with the listing first and the other listings the scan found for it; the match waits there (status review),
// so no estimate counts it and no buy rests on it. Nothing is rejected: the owner may choose the same listing, and his
// answer stands (decidedBy 'user'). Used by the price guard (priceGuard.ts) and by the ladder's re-read of a stored
// confirmation (catalogCheck.ts). Pure TypeScript over the ScanStore.

import { RESOLVED_BY_SCAN } from './answers';
import type { MatchRecord, ReviewCandidate, ScanStore } from './types';

/** The listing's candidate row, from what the store holds; `title` when the store has no listing row for it. */
async function candidate(store: ScanStore, asin: string, reasons: string[], title: string | null): Promise<ReviewCandidate> {
  const listing = await store.getListing(asin);
  const price = await store.getPrice(asin);
  return {
    asin, title: listing?.title ?? title ?? asin, price: price?.price ?? listing?.price ?? null, reviews: listing?.reviews ?? price?.reviews ?? null,
    reasons, seenAt: price?.seenAt ?? listing?.seenAt ?? null,
  };
}

/**
 * Holds `m` (automatic, matched) for the owner: the match question opened with `reason`, the held listing first and the
 * match's alternatives after it, and the match moved to review with `evidence` as its record. Returns false, changing
 * nothing, when the owner already answered the part's question (his answer stands) or the match is not automatic.
 */
export async function holdForOwner(
  store: ScanStore, m: MatchRecord, o: { reason: string; evidence: string; now: number; title?: string | null; catalogTitle?: string | null },
): Promise<boolean> {
  if (m.decidedBy !== 'auto' || m.status !== 'matched' || m.asin === null) return false;
  const id = `match:${m.key}`;
  const old = await store.getReview(id);
  if (old && old.answer !== null && old.answer !== RESOLVED_BY_SCAN) return false;
  const held = await candidate(store, m.asin, [o.reason], o.title ?? null);
  const others = await Promise.all(m.alternatives.filter((a) => a !== m.asin).map((a) => candidate(store, a, ['another listing found for the part'], null)));
  await store.putReview({
    id, kind: 'match', subject: m.key, brand: m.brand, model: m.model,
    title: o.catalogTitle ?? (await store.getCatalogEntry(m.key))?.title ?? null,
    reason: o.reason, candidates: [held, ...others], choices: [], openedAt: o.now, answer: null, answeredAt: null,
  });
  const { verifiedBy: _v, ...rest } = m;
  await store.putMatch({ ...rest, status: 'review', asin: null, grade: null, alternatives: [], waitingSince: null, updatedAt: o.now, verifyEvidence: o.evidence });
  return true;
}
