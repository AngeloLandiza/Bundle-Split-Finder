// The owner's answer to "Is this eBay listing exactly <MODEL>, New, with the same contents?" (step 10).
// An answer is the listing's verdict from then on: it overrides the judge's, is kept on the part's eBay value
// record (a later scan carries it over while the listing's revision is the same), and recomputes the value.
// It is also what the audit file exports, so it can become an owner label for the judge (fixtures/ebay/labels.json).

import { AnswerRefused } from './answers';
import { valueOf } from './ebayPass';
import { effectiveVerdict, type EbayValueRecord, type ScanStore } from './types';

export type EbayAnswerKind = 'yes' | 'no';

/** An answer as the panel sends it. Anything else is refused. */
export interface EbayAnswer {
  /** partKey of the part. */
  key: string;
  itemId: string;
  answer: EbayAnswerKind;
}

const NOT_FOUND = 'That question was not found.';
const ANSWERED = 'That question was already answered.';
const CHANGED = 'That question changed. Choose again.';
const NOT_SHOWN = 'Choose Yes or No.';

/**
 * Saves the answer: the listing's `owner` is 'match' (Yes) or 'not_match' (No), and the part's value is
 * computed again with it. Refused with AnswerRefused, writing nothing, for a request that is not an answer, a
 * listing not found, one already answered, or one the judge no longer calls unsure (a later scan changed it).
 */
export async function applyEbayAnswer(store: ScanStore, request: unknown, now: number): Promise<void> {
  const a = request as Partial<EbayAnswer> | null;
  if (typeof a !== 'object' || a === null || typeof a.key !== 'string' || typeof a.itemId !== 'string' || (a.answer !== 'yes' && a.answer !== 'no')) {
    throw new AnswerRefused(NOT_SHOWN);
  }
  const record = await store.getEbayValue(a.key);
  const at = record?.listings.findIndex((l) => l.itemId === a.itemId) ?? -1;
  if (!record || at < 0) throw new AnswerRefused(NOT_FOUND);
  const listing = record.listings[at]!;
  if (listing.owner !== undefined) throw new AnswerRefused(ANSWERED);
  if (effectiveVerdict(listing) !== 'unsure') throw new AnswerRefused(CHANGED);
  const listings = record.listings.map((l, i) => (i === at ? { ...l, owner: a.answer === 'yes' ? ('match' as const) : ('not_match' as const), ownerAt: now } : l));
  await store.putEbayValue({ ...record, listings, value: valueOf(listings) });
}

/**
 * The owner's answers as labels for the judge, in the shape of fixtures/ebay/labels.json (`labelledBy` is
 * 'owner'), with what the judge said and the listing's title and page so the label can be checked.
 */
export function ebayLabelsOf(records: EbayValueRecord[]): {
  itemId: string; model: string; verdict: 'match' | 'not_match'; labelledBy: 'owner'; judged: string; reasons: string[]; title: string; url: string; answeredAt: number | null;
}[] {
  return records.flatMap((r) =>
    r.listings.flatMap((l) =>
      l.owner === undefined
        ? []
        : [{ itemId: l.itemId, model: r.model, verdict: l.owner, labelledBy: 'owner' as const, judged: l.verdict, reasons: [...l.reasons], title: l.title, url: l.url, answeredAt: l.ownerAt ?? null }],
    ),
  );
}
