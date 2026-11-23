// Nov 23 (the third real scan): the words for a bundle missing a price. A part with no counted price is never $0, so
// such a bundle has no profit or ROI; the row and the inspector say how many parts are priced and what the unpriced
// ones must bring to break even. Every figure is the agent's (core/src/scan/report.ts incompleteOf), an estimate from
// the fee settings (rule 5); nothing is worked out here.

import type { DealIncomplete, DealUnpricedPart } from '../api/types';
import { money } from './format';

/** "A", "A and B", "A, B and C". */
const listOf = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`);

/** "2 of 3 parts priced". */
export function pricedCount(i: Pick<DealIncomplete, 'priced' | 'total'>): string {
  return `${i.priced} of ${i.total} ${i.total === 1 ? 'part' : 'parts'} priced`;
}

/**
 * What the unpriced parts must bring: "DCK200D1P1 needs about $186.76 to break even" (one model: its Amazon price),
 * "DCK200D1P1 and DCF860B need about $299.00 after fees to break even" (several: what they bring together), or, when the
 * priced parts already cover the cost, "the priced parts already cover the cost".
 */
export function breakEvenWords(i: Pick<DealIncomplete, 'breakEvenNet' | 'breakEvenPrice' | 'unpriced'>): string {
  if (i.breakEvenNet <= 0) return 'the priced parts already cover the cost';
  if (i.unpriced.length === 1 && i.breakEvenPrice !== null) return `${i.unpriced[0]} needs about ${money(i.breakEvenPrice)} to break even`;
  const who = i.unpriced.length === 1 ? `${i.unpriced[0]} needs` : `${listOf(i.unpriced)} need`;
  return `${who} about ${money(i.breakEvenNet)} after fees to break even`;
}

/** The row's reason line: "2 of 3 parts priced · DCK200D1P1 needs about $186.76 to break even". */
export function incompleteLine(i: DealIncomplete): string {
  return `${pricedCount(i)} · ${breakEvenWords(i)}`;
}

/** Why a part has no price, in a few words. */
export const UNPRICED_STATE: Record<DealUnpricedPart['state'], string> = {
  waiting: 'Waiting for an Amazon lookup',
  review: 'Waiting for your answer in Review',
  no_listing: 'No Amazon listing found',
  inactive: 'Amazon listing not for sale now',
};

/** The one action that moves the part forward. */
export const UNPRICED_ACTION: Record<DealUnpricedPart['action'], string> = {
  look_up: 'Look up now',
  answer: 'Answer in Review',
  confirm_price: 'Confirm a price…',
};

/**
 * A kit's own line, when the part is one: its page not read yet (the next scan, or the agent between scans, reads it for
 * free), or what its page lists and how many of those models still wait for a lookup. Null for a part that is no kit.
 */
export function kitWords(p: Pick<DealUnpricedPart, 'kit' | 'state'>): string | null {
  const k = p.kit;
  if (!k) return null;
  if (!k.pageRead) return 'A kit. Its Home Depot page is read next, free, to find its parts.';
  const parts = k.parts === null ? 'its parts' : `its ${k.parts} parts`;
  const dead = p.state === 'no_listing' || p.state === 'inactive';
  if (!dead) return `A kit. Its page lists ${parts}.`;
  return k.waiting > 0
    ? `A kit with no listing for sale: sold as ${parts} once they are looked up (${k.waiting} ${k.waiting === 1 ? 'waits' : 'wait'}).`
    : `A kit with no listing for sale: sold as ${parts}.`;
}

/**
 * The rows in the order a table sort keeps among rows with no figure (lib/sort.ts keeps their input order): a bundle
 * with an estimate first, then the bundles missing a price, the smallest break-even first (the closest to paying for
 * itself), then the rest (a question, a page not read). Ties keep their order.
 */
export function breakEvenOrder<T extends { profit: number | null; incomplete?: DealIncomplete | null }>(rows: readonly T[]): T[] {
  const rank = (r: T): number => (r.profit !== null ? -Infinity : r.incomplete ? r.incomplete.breakEvenNet : Infinity);
  return rows
    .map((row, i) => ({ row, i, k: rank(row) }))
    .sort((a, b) => (a.k === b.k ? a.i - b.i : a.k < b.k ? -1 : 1))
    .map((x) => x.row);
}
