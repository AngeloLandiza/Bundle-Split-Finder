// The owner's answer to "Is this eBay listing exactly <MODEL>, New, with the same contents?" (step 10).
// An answer is the listing's verdict from then on: it overrides the judge's, is kept on the part's eBay value
// record (a later scan carries it over while the listing's revision is the same), and recomputes the value.
// It is also what the audit file exports, so it can become an owner label for the judge (fixtures/ebay/labels.json).

import { AnswerRefused } from './answers';
import { valueOf } from './ebayPass';
import { ebayAnswerKey, effectiveVerdict, type EbayOwnerAnswer, type ScanStore } from './types';

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
  const owner = a.answer === 'yes' ? ('match' as const) : ('not_match' as const);
  // The answer is its own record first: it is what every later check applies, so a check that stops partway cannot lose it.
  await store.putEbayAnswer({
    key: ebayAnswerKey(record.key, listing.itemId, listing.revision), part: record.key, model: record.model, itemId: listing.itemId, revision: listing.revision ?? '',
    owner, ownerAt: now, judged: listing.verdict, reasons: [...listing.reasons], title: listing.title, url: listing.url,
  });
  const listings = record.listings.map((l, i) => (i === at ? { ...l, owner, ownerAt: now } : l));
  await store.putEbayValue({ ...record, listings, value: valueOf(listings) });
}

/**
 * The owner's answers as labels for the judge, in the shape of fixtures/ebay/labels.json (`labelledBy` is 'owner'), with what
 * the judge said and the listing's title and page so the label can be checked. From the answer records, so an answer
 * survives whatever happened to the part's value since.
 */
export function ebayLabelsOf(answers: EbayOwnerAnswer[]): {
  itemId: string; model: string; verdict: 'match' | 'not_match'; labelledBy: 'owner'; judged: string; reasons: string[]; title: string; url: string; answeredAt: number | null;
}[] {
  return answers.map((a) => ({
    itemId: a.itemId, model: a.model, verdict: a.owner, labelledBy: 'owner' as const, judged: a.judged, reasons: [...a.reasons], title: a.title, url: a.url, answeredAt: a.ownerAt,
  }));
}
