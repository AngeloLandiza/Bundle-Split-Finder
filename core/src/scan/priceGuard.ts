// The price guard (docs/decisions.md, "A title that names another model; a price far above Home Depot's"): an automatic
// match whose counted Amazon price is far above Home Depot's own price for the part sold alone is not counted, whatever
// confirmed it. The part goes to the Review "Which listing" question (hold.ts) with the plain reason and both links; its
// bundle's estimate is then incomplete ("in review") and never a buy. A lower grade, never a rejection: the owner may
// choose the same listing, and his answer stands.
//
// Measured (scripts/measure-wrong-confirm.ts priceRatios, Nov 24) on 265 listings with both prices: every listing an
// answer key says is the part is at or below 1.63×, every listing the owner's scans counted at or below 2.80× (A98401,
// confirmed), and above that only listings that are not the part: 6.72× (B0F3N79KTM for PCL406, audit corpus) and 9.73×
// (B0DGLWKS9S for DWST08017, the owner's example). PRICE_RATIO_LIMIT sits in that gap. The mirror (an Amazon price far
// below Home Depot's) is not adopted: right listings reach down to 0.41×, and nothing any rung confirmed was below it.
//
// Pure TypeScript over the ScanStore; reads what is stored, never a call. Run at a scan's end (postScan.ts) and before
// the agent publishes a report, so a stored match is re-read under it without a new scan.

import { sameModel } from '../match';
import { amazonListingLink } from './catalogCheck';
import { holdForOwner } from './hold';
import { priceActive, type MatchRecord, type ScanStore } from './types';

/** Above this many times Home Depot's price for the part sold alone, Amazon's counted price holds the listing. */
export const PRICE_RATIO_LIMIT = 4;

/** "9.7×": one decimal, as the reason says it. */
const times = (r: number): string => `${(Math.round(r * 10) / 10).toFixed(1)}×`;

/** The reason, in one plain sentence: "Amazon's price is 9.7× Home Depot's price for this part: check the listing". */
export const priceGuardReason = (ratio: number): string => `Amazon's price is ${times(ratio)} Home Depot's price for this part: check the listing`;

/** Amazon's counted price over Home Depot's, when above PRICE_RATIO_LIMIT; null otherwise or when either price is not positive. */
export function priceFarAbove(amazon: number, homeDepot: number): number | null {
  if (!(amazon > 0) || !(homeDepot > 0)) return null;
  const ratio = amazon / homeDepot;
  return ratio > PRICE_RATIO_LIMIT ? ratio : null;
}

export interface PriceGuardOutcome {
  key: string;
  asin: string;
  ratio: number;
  amazon: number;
  homeDepot: number;
  reason: string;
}

/**
 * What the guard reads for one automatic match: the counted Amazon price (the listing's featured price while active, as
 * the report counts it) and Home Depot's price for the part itself (its own page, not another model's). Null when either
 * is missing or the ratio is within the limit.
 */
export async function priceCheckOf(store: ScanStore, m: MatchRecord): Promise<PriceGuardOutcome | null> {
  if (m.decidedBy !== 'auto' || m.status !== 'matched' || m.asin === null) return null;
  return priceCheckFor(store, m, m.asin);
}

/** The guard's reading of `asin` for the part, matched or not (a re-check's candidate: scan/recheck.ts). */
export async function priceCheckFor(store: ScanStore, part: Pick<MatchRecord, 'key' | 'brand' | 'model'>, asin: string): Promise<PriceGuardOutcome | null> {
  const price = await store.getPrice(asin);
  const hd = await store.getPartPrice(part.key);
  if (!price || !priceActive(price) || price.price === null || price.seenAt === null) return null;
  if (!hd || hd.price === null || hd.seenAt === null || !sameModel(part.brand, hd.matchedModel ?? hd.model, part.model)) return null;
  const ratio = priceFarAbove(price.price, hd.price);
  return ratio === null ? null : { key: part.key, asin, ratio, amazon: price.price, homeDepot: hd.price, reason: priceGuardReason(ratio) };
}

/** Every automatic match whose counted price is far above Home Depot's, held for the owner. Returns what was held. */
export async function applyPriceGuard(store: ScanStore, now: number): Promise<PriceGuardOutcome[]> {
  const out: PriceGuardOutcome[] = [];
  for (const m of await store.listMatches()) {
    const check = await priceCheckOf(store, m);
    if (!check) continue;
    const hd = await store.getPartPrice(m.key);
    const evidence = `${check.reason} ($${check.amazon} on Amazon, $${check.homeDepot} at Home Depot): ${amazonListingLink(check.asin)}${hd?.link ? ` ${hd.link}` : ''}`;
    if (await holdForOwner(store, m, { reason: check.reason, evidence, now })) out.push(check);
  }
  return out;
}
