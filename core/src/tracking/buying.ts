// What Home Depot's own page says about buying a deal (Nov 25, fixtures/homedepot-pages/availability-344305163-2026-11-25.json),
// in the owner's words. Pure: the clock is passed in. The page's first state states whether it can be bought, whether it is
// discontinued, the per-order limit, the return window and the dates of the promotion. It does NOT state per-store stock or a
// delivery estimate, so nothing here says "in stock at your store": the most it says is that the page says it can be bought.
//
// A bundle whose page has not been read since this was kept has no reading: "not checked yet", never "cannot be bought".

import type { DealBuying } from '../api/contract';
import type { BundleBuying } from '../scan/types';

const DAY_MS = 86_400_000;

/**
 * A Buy now deal whose Home Depot price ends within this many days is announced once ("buy before then"). Three days: a
 * price he is told about on a Friday still holds through the weekend, and the keep-current read (every 4 hours for a Buy
 * now deal) has confirmed it by then; a longer notice would repeat what the row already shows for a week.
 */
export const PRICE_ENDS_WITHIN_DAYS = 3;
/** After a deal's promotion ended, its price is read again at most this often until a read confirms it (a read with no price is a try). */
export const ENDED_RETRY_MS = 30 * 60_000;

/**
 * unchecked  no page of it has been read since this was kept
 * can        the page says it can be bought (buyable, not discontinued)
 * cannot     the page says it is discontinued, or not buyable
 * unstated   a page was read and states neither
 */
export type BuyingState = 'unchecked' | 'can' | 'cannot' | 'unstated';

export function buyingState(b: BundleBuying | undefined): BuyingState {
  if (b === undefined) return 'unchecked';
  if (b.discontinued === true || b.buyable === false) return 'cannot';
  if (b.buyable === true) return 'can';
  return 'unstated';
}

const clock = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** "10:55 AM" for a reading of today, "Nov 24, 10:55 AM" for an earlier day (the owner's clock). */
export function readWords(at: number, now: number): string {
  return sameDay(at, now) ? clock(at) : `${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock(at)}`;
}

/** "Jan 31" for "2027-01-31". */
export function monthDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Why the page says it cannot be bought, as a clause of the verdict ("Home Depot's page says it cannot be bought right now
 * (read 10:55 AM)"); null when it does not say so (can be bought, not stated, or not read yet).
 */
export function cannotBuyWords(b: BundleBuying | undefined, now: number): string | null {
  if (b === undefined || buyingState(b) !== 'cannot') return null;
  const read = `(read ${readWords(b.readAt, now)})`;
  return b.discontinued === true ? `Home Depot's page says it is discontinued ${read}` : `Home Depot's page says it cannot be bought right now ${read}`;
}

/** The last moment of the promotion's last day, on the owner's clock; null when the page gave no end date. */
export function priceEndsAt(b: BundleBuying | undefined): number | null {
  if (!b?.promotionEnd) return null;
  const [y, m, d] = b.promotionEnd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/**
 * The promotion has ended and Home Depot's price has not been read since: what the deal shows is the promotion's price,
 * which may no longer be Home Depot's. `priceSeenAt` is when the price was last read (BundleRow.seenAt).
 */
export function endedUnconfirmed(b: BundleBuying | undefined, priceSeenAt: number, now: number): boolean {
  const end = priceEndsAt(b);
  return end !== null && now > end && priceSeenAt <= end;
}

/** The promotion ends in at most `days` days from now (and has not ended). */
export function endsWithin(b: BundleBuying | undefined, now: number, days: number = PRICE_ENDS_WITHIN_DAYS): boolean {
  const end = priceEndsAt(b);
  return end !== null && end >= now && end - now <= days * DAY_MS;
}

const usdWhole = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * What the row and the inspector show of it (DealRow.buying). `profit` is the deal's estimated profit for one bundle (null
 * without an estimate); the allowance line is that times the limit, labelled as an estimate (rule 5).
 */
export function buyingView(b: BundleBuying | undefined, o: { profit: number | null; priceSeenAt: number; now: number }): DealBuying {
  const state = buyingState(b);
  const online = b?.availability === 'Online' ? ' online' : '';
  const line = b === undefined
    ? "Home Depot's page: not checked yet"
    : state === 'cannot'
      ? cannotBuyWords(b, o.now)!
      : state === 'can'
        ? `Home Depot's page says it can be bought${online} (read ${readWords(b.readAt, o.now)})`
        : `Home Depot's page does not say whether it can be bought (read ${readWords(b.readAt, o.now)})`;
  const limit = b?.quantityLimit ?? null;
  const ended = endedUnconfirmed(b, o.priceSeenAt, o.now);
  const end = b?.promotionEnd ?? null;
  const endAt = priceEndsAt(b);
  const priceLine = end === null || endAt === null ? null
    : ended ? `Home Depot's price ended ${monthDay(end)}; it has not been read since`
      : endAt >= o.now ? `Home Depot's price ends ${monthDay(end)}` : null;
  return {
    state, line, readAt: b ? new Date(b.readAt).toISOString() : null,
    limit,
    limitLine: limit !== null ? `Limit ${limit} per order` : null,
    limitProfitLine: limit !== null && limit > 1 && o.profit !== null && o.profit > 0
      ? `Up to ${limit} per order: about +${usdWhole(limit * o.profit)} at this estimate (an estimate from your fee settings, not your real fees)` : null,
    priceEnds: end,
    priceEndsLine: priceLine,
    priceEnded: ended,
    returnsLine: b?.returnable ? `${b.returnable} returns, per Home Depot's page` : null,
  };
}

// ---------------------------------------------------------------- the price is about to end

/** A Buy now deal as the price-ending message reads it. */
export interface PriceEndsDeal {
  key: string;
  model: string;
  link: string | null;
  price: number | null;
  /** The estimated profit for one bundle (an estimate from the fee settings); null without one. */
  profit: number | null;
  buying: BundleBuying | undefined;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Whole calendar days from `now`'s day to `iso`'s day, on the owner's clock. */
function daysTo(iso: string, now: number): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const n = new Date(now);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / DAY_MS);
}

/** What `notified` holds once a deal's ending price was announced: one message per deal and end date. */
export const priceEndsKey = (dealKey: string, end: string): string => `${dealKey}|priceEnds|${end}`;

/**
 * Nov 25: one message for each Buy now deal whose Home Depot price ends within `days` days, once per deal and end date
 * (`notified`). A deal with no end date, one that ended, or one told already is left out. The caller passes only Buy now
 * deals whose prices are current. Estimates are labelled (rule 5).
 */
export function priceEndsMessages(
  deals: readonly PriceEndsDeal[], now: number, notified: readonly string[], days: number = PRICE_ENDS_WITHIN_DAYS,
): { key: string; notifiedKey: string; sentence: string }[] {
  const told = new Set(notified);
  const out: { key: string; notifiedKey: string; sentence: string }[] = [];
  for (const d of deals) {
    const end = d.buying?.promotionEnd;
    if (!end || !endsWithin(d.buying, now, days)) continue;
    const notifiedKey = priceEndsKey(d.key, end);
    if (told.has(notifiedKey)) continue;
    const left = daysTo(end, now);
    const when = left <= 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
    const price = d.price !== null ? ` of ${usd(d.price)}` : '';
    const worth = d.profit !== null ? ` Est. profit ${usd(d.profit)} (an estimate from your fee settings, not your real fees).` : '';
    out.push({
      key: d.key, notifiedKey,
      sentence: `${d.model} is worth buying now, and Home Depot's price${price} ends ${monthDay(end)} (${when}): buy before then.${worth}${d.link ? ` ${d.link}` : ''}`,
    });
  }
  return out;
}
