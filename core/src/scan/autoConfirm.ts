// Rung 2 of the listing ladder (docs/decisions.md, "Confirming listings by themselves"): the owner's "Confirm listing"
// click, done by the agent. Pure: which listings to read and how many searches today may spend. The read itself is the
// paid Verify (paid.ts verify: one SerpApi amazon_product page through SerpApiClient and the SearchBudget), run by
// agent/autoConfirm.ts.
//
// A listing is read only where its confirmation can change a decision, best first:
//   buy      a way to sell that meets the owner's numbers and waits only on its listings (BundleSignals.buyPending)
//   reach    a way to sell with listings not confirmed whose estimate is within REACH of both numbers (75% of the
//            profit and of the ROI): a price drop away from a buy, which then needs no wait
// and only once rung 0 and rung 1 have read the listing (its catalog check is stored) or Keepa cannot read it. A listing
// is read once (tried): its fields do not go stale.

import type { AccountInfo } from '../serpapi/budget';
import type { BundleSignals } from '../tracking/signals';

/** A way to sell is within reach at this share of both of the owner's numbers. */
export const REACH = 0.75;
/** The automatic daily allowance's ceiling: never more than this many searches a day unless the owner sets more. */
export const AUTO_VERIFY_DAILY_MAX = 5;

export interface AutoConfirmTarget {
  bundleKey: string;
  brand: string;
  model: string;
  asin: string;
  why: 'buy' | 'reach';
  /** The way to sell's estimated profit, for the order. */
  profit: number;
}

export interface TargetInput {
  signals: Record<string, Pick<BundleSignals, 'bundleKey' | 'options'>>;
  alerts: { minProfit: number; minRoiPercent: number };
  /** The part a bundle's listing stands for, or null when no part of the bundle holds it. */
  partOf: (bundleKey: string, asin: string) => { brand: string; model: string } | null;
  /** Whether the listing may be read now: an automatic title match, read by rungs 0 and 1, never read by this rung. */
  eligible: (asin: string) => boolean;
}

/** The listings to read, buy before reach, then the largest estimated profit, each ASIN once. */
export function autoConfirmTargets(input: TargetInput): AutoConfirmTarget[] {
  const found: AutoConfirmTarget[] = [];
  const { minProfit, minRoiPercent } = input.alerts;
  for (const s of Object.values(input.signals)) {
    for (const o of s.options) {
      const asins = o.buyPending?.asins ?? o.unconfirmed ?? [];
      if (asins.length === 0 || o.profit === null || o.roiPercent === null) continue;
      const why = o.buyPending ? 'buy' : o.profit >= REACH * minProfit && o.roiPercent >= REACH * minRoiPercent ? 'reach' : null;
      if (why === null) continue;
      for (const asin of asins) {
        const part = input.partOf(s.bundleKey, asin);
        if (part && input.eligible(asin)) found.push({ bundleKey: s.bundleKey, ...part, asin, why, profit: o.profit });
      }
    }
  }
  found.sort((a, b) => Number(a.why === 'reach') - Number(b.why === 'reach') || b.profit - a.profit || (a.asin < b.asin ? -1 : a.asin > b.asin ? 1 : 0));
  const seen = new Set<string>();
  return found.filter((t) => !seen.has(t.asin) && !!seen.add(t.asin));
}

const DAY_MS = 86_400_000;

/** The UTC day of `at`, "2026-11-23": the allowance's day. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Days left until the account renews (its renewal date, else the end of the UTC month), today counted, at least 1. */
export function daysLeftInPlan(account: Pick<AccountInfo, 'renewalDate'>, now: number): number {
  const renew = account.renewalDate ? Date.parse(account.renewalDate) : NaN;
  const d = new Date(now);
  const end = Number.isFinite(renew) && renew > now ? renew : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((end - now) / DAY_MS));
}

/**
 * Searches rung 2 may spend today: the owner's number when set (Settings, lookups.verifySearchesPerDay), else what the
 * account above the reserve leaves per remaining day, at most AUTO_VERIFY_DAILY_MAX; never more than lies above the
 * reserve. `spentToday`: what rung 2 already spent today. The SearchBudget still refuses the reserve and the hour.
 */
export function verifyAllowanceToday(
  account: Pick<AccountInfo, 'totalSearchesLeft' | 'renewalDate'>, reserve: number, perDay: number | null | undefined, spentToday: number, now: number,
): number {
  const above = Math.max(0, account.totalSearchesLeft - Math.max(0, reserve));
  const daily = typeof perDay === 'number' && Number.isFinite(perDay) && perDay >= 0
    ? Math.floor(perDay)
    : Math.min(AUTO_VERIFY_DAILY_MAX, Math.floor(above / daysLeftInPlan(account, now)));
  return Math.max(0, Math.min(daily - Math.max(0, spentToday), above));
}

/** "Confirmed 2 of 3 Amazon listings automatically (3 searches: 2 for buys waiting on them, 1 within reach of your numbers)." */
export function autoConfirmSentence(tried: AutoConfirmTarget[], confirmed: number, searches: number): string | null {
  if (tried.length === 0) return null;
  const buy = tried.filter((t) => t.why === 'buy').length;
  const reach = tried.length - buy;
  const why = [
    ...(buy > 0 ? [`${buy} for ${buy === 1 ? 'a buy' : 'buys'} waiting on ${buy === 1 ? 'it' : 'them'}`] : []),
    ...(reach > 0 ? [`${reach} within reach of your numbers`] : []),
  ].join(', ');
  const n = tried.length;
  return `Confirmed ${confirmed} of ${n} Amazon ${n === 1 ? 'listing' : 'listings'} automatically (${searches} ${searches === 1 ? 'search' : 'searches'}: ${why}).`;
}

/** The deal's words while rung 2 waits: "2 listings are being confirmed — next check in about 4 min". */
export function beingConfirmedWords(listings: number, nextAt: number | null, now: number): string {
  const head = `${listings} ${listings === 1 ? 'listing is' : 'listings are'} being confirmed`;
  if (nextAt === null || nextAt <= now) return `${head} now`;
  const min = Math.max(1, Math.round((nextAt - now) / 60_000));
  return `${head} — next check in about ${min <= 90 ? `${min} min` : `${Math.round(min / 60)} h`}`;
}
