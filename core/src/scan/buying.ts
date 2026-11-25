// What a Home Depot page states about buying a bundle, kept on the bundle's record (BundleRecord.buying) from every page of
// it that is read: the scan's bundle pages, the drip's, the item pages a list pass reads, the owner's own page, and keeping
// deals current. The newest reading wins; a page that states none of it leaves the record as it was.

import type { BuyingFacts } from '../hdPage';
import type { BundleBuying, BundleRecord } from './types';

/** The record with the facts of a page read at `readAt`, unless a newer reading is stored or the page stated none. */
export function withBuying(record: BundleRecord, facts: BuyingFacts | undefined, readAt: number): BundleRecord {
  if (facts === undefined) return record;
  if (record.buying && record.buying.readAt > readAt) return record;
  return { ...record, buying: { ...facts, readAt } };
}

/** The page reading as the bundle keeps it: its content, with the buying facts moved to the record's own field. */
export function withoutBuying<P extends { buying?: BuyingFacts }>(page: P): Omit<P, 'buying'> {
  const { buying: _buying, ...rest } = page;
  return rest;
}

/** Whether two readings state the same (the time read is not compared). */
export function sameBuying(a: BundleBuying | undefined, b: BuyingFacts | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a.buyable === b.buyable && a.discontinued === b.discontinued && a.availability === b.availability && a.quantityLimit === b.quantityLimit
    && a.returnable === b.returnable && a.promotionStart === b.promotionStart && a.promotionEnd === b.promotionEnd;
}
