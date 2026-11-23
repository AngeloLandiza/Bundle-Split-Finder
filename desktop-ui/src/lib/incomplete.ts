// Nov 23 (the third real scan): the words for a bundle missing a price. A part with no counted price is never $0, so
// such a bundle has no profit or ROI; the row and the inspector say how many parts are priced and what the unpriced
// ones must bring to break even. Every figure is the agent's (core/src/scan/report.ts incompleteOf), an estimate from
// the fee settings (rule 5); nothing is worked out here.

import type { DealIncomplete, DealIncompleteEstimate, DealUnpricedPart } from '../api/types';
import { money, profit, roi } from './format';

// ---------------------------------------------------------------- suggested prices and answers kept (Nov 23)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 23", as the agent writes a day (UTC). */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

/** "$66" for whole dollars, else "$65.50". */
const short = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/**
 * The part row's one primary action for a suggestion: "Confirm $66 (eBay middle of 6)", "Confirm $48.15 (Keepa 90-day
 * average)". The figures are the agent's label's; nothing is worked out here.
 */
export function suggestionAction(s: NonNullable<DealUnpricedPart['priceSuggestion']>): string {
  if (s.kind === 'ebay_median') {
    const n = /^(\d+) eBay listings/.exec(s.label)?.[1];
    return `Confirm ${short(s.price)} (eBay middle${n ? ` of ${n}` : ''})`;
  }
  const days = /its (\d+)-day average/.exec(s.label)?.[1] ?? '90';
  return `Confirm ${short(s.price)} (Keepa ${days}-day average)`;
}

/**
 * The incomplete box's second line, never the headline and never a buy: "If you accept the 2 suggested prices: +$74.56
 * est., 25% ROI. Nothing counts until you confirm each one." Null when not every unpriced part has a suggestion.
 */
export function ifAcceptedLine(i: Pick<DealIncompleteEstimate, 'ifAccepted'>): string | null {
  const a = i.ifAccepted;
  if (!a) return null;
  const what = a.suggested === 1 ? 'the suggested price' : `the ${a.suggested} suggested prices`;
  return `If you accept ${what}: ${profit(a.profit)} est., ${roi(a.roi)} ROI. Nothing counts until you confirm ${a.suggested === 1 ? 'it' : 'each one'}.`;
}

/** "from your answer on Nov 23": what a part row says beside a fact he gave. */
export const fromAnswer = (at: number): string => `from your answer on ${dayOf(at)}`;

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
