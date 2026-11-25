// The market around a part's listing (Nov 25, docs/decisions.md "The market around a listing"): whether the price the
// estimate counts is unusual for the listing, whether Amazon itself sells it, how crowded and how available it is, and
// whether Amazon's record lists it as a dangerous good. Pure: everything comes from the stored Keepa trend
// (core/src/keepa/trends.ts TrendMarket), which every product pull keeps; nothing is fetched.
//
// One rule here changes a verdict (rule 1, the usual price): a deal is worth buying now only when it clears the owner's
// numbers at today's prices AND at its usual prices. Everything else is a note the owner reads before buying; none of it
// holds a buy (rules 2 to 4). Every threshold was measured on the 83 recorded listings
// (fixtures/keepa/stats-sample-2026-11-25.json) and is written down with its distribution in docs/decisions.md.

import type { PartTrend } from '../keepa/trends';
import { amazonNet, DEFAULT_FEES, pctVs, usdVs } from '../money';
import type { BundleResult } from '../money';
import type { PartRow } from '../scan/types';
import { estimateRoiPercent } from '../settings';

/**
 * A counted price at least this much above the listing's 90-day average New price is unusual. Measured on the 76 recorded
 * listings with both a counted price and a 90-day average: the median sits 3.8% below its average, the 90th percentile
 * 9% above; above that there is a gap from 13% (DCS380B) to 22% (DCG407B) on Nov 25, and from 13% to 25% on the Nov 23
 * prices, with PCL515B at 31% and PCG002 at 100%. 20% sits in that gap.
 */
export const UNUSUAL_ABOVE_AVG90 = 0.2;
/**
 * New offers grown "a lot": at least double the 90-day average and at least this many more sellers. Recorded: the median
 * listing has as many New offers as its 90-day average, the 90th percentile 1.66 times; 12 of 76 are at 2 times or more,
 * 5 of them small counts (1 to 2 twice, 1 to 3, 4 to 11, 6 to 14), so the +10 floor leaves the 7 that grew by 24 to 50 sellers.
 */
export const CROWD_RATIO = 2;
export const CROWD_MIN_ADDED = 10;
/**
 * Out of stock (no New offer at all) notable at this percent of the last 90 days. Recorded: 70 of 76 priced listings at
 * 0%, three at 1-2%, then DCS380B 17%, A98401 and RHMTS12601 54%.
 */
export const OUT_OF_STOCK_NOTABLE = 10;
/** The setting's minimum referral, which the part row does not carry; it binds only below $2 (amazonNet). */
const MIN_REFERRAL = DEFAULT_FEES.minReferral;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const usd = (n: number): string => (n < 0 ? `-$${(-n).toFixed(2)}` : `$${n.toFixed(2)}`);
const signed = (n: number): string => (n < 0 ? usd(n) : `+${usd(n)}`);
const pct = (n: number): string => `${Math.round(n)}%`;
const usdShort = (n: number): string => (Number.isInteger(n) ? `$${n}` : usd(n));
const names = (xs: string[]): string => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** One part's market as the inspector shows it: the figures, when Keepa read them, and the notes. Dollars. */
export interface PartMarket {
  model: string;
  asin: string;
  qty: number;
  /** The Amazon New price the estimate counts for one unit. */
  price: number;
  /** When Keepa's figures were read (epoch ms). */
  at: number;
  avg30: number | null;
  avg90: number | null;
  avg180: number | null;
  /** price / avg90 - 1 (0.31 for 31% above); null without a 90-day average. */
  aboveAvg90: number | null;
  /** At least UNUSUAL_ABOVE_AVG90 above the 90-day average: the usual-price estimate counts the average for it. */
  unusual: boolean;
  /** No 90-day average yet (a new listing, Keepa's -1): today's rule alone. */
  noHistory?: true;
  /** Amazon itself sells it now (stats.current[0], or Keepa says Amazon holds the Buy Box). */
  amazon?: { price: number | null; buyBox: boolean };
  newOffers?: { now: number; avg90: number; grown: boolean };
  /** Percent of the last 90 days with no New offer, when at least OUT_OF_STOCK_NOTABLE. */
  outOfStock90?: number;
  hazmat?: { unId: string; name: string | null; lithium: boolean };
  /** One short sentence each, in order: price, Amazon, sellers, stock, hazard. Plain words, no judgement beyond the record. */
  notes: string[];
}

/** The estimate with each unusually priced part at its 90-day average, the same fees (CLAUDE.md rule 5: an estimate). */
export interface UsualEstimate {
  profit: number;
  roiPercent: number;
  /** At or above both of the owner's numbers. */
  meets: boolean;
  /** The parts it re-prices, at their 90-day average. */
  parts: { model: string; price: number; usual: number }[];
}

export interface OptionMarket {
  parts: PartMarket[];
  /** Present only when some counted part is unusually priced and the way to sell has an estimate. */
  usual: UsualEstimate | null;
}

/** The counted Amazon New price of a part (report.ts listingFor), or null when it is priced otherwise or not at all. */
function countedAmazonPrice(p: PartRow): number | null {
  if (p.availability !== 'active' || p.asin === null || p.qty <= 0) return null;
  return p.prices.find((o) => o.kind === 'amazon_new' && !o.reference)?.price ?? null;
}

/** The hazard sentence: the brief's words for a lithium battery, the record's own words for anything else. */
function hazardNote(h: NonNullable<PartMarket['hazmat']>): string {
  if (h.lithium) {
    const what = /PACKED WITH EQUIPMENT/i.test(h.name ?? '') ? 'Lithium battery packed with equipment' : 'Lithium battery';
    return `${what} (${h.unId}): Amazon treats it as dangerous goods; check it is approved in your FBA account before buying.`;
  }
  return `Amazon's record lists it as hazardous material: ${h.name ?? 'no shipping name'} (${h.unId}).`;
}

/** One part's market, or null when the part has no counted Amazon price or its trend has no market figures yet. */
export function partMarket(p: PartRow, trend: PartTrend | undefined): PartMarket | null {
  const price = countedAmazonPrice(p);
  const m = trend?.market;
  if (price === null || !m || p.asin === null) return null;
  const above = m.newAvg90 !== null && m.newAvg90 > 0 ? price / m.newAvg90 - 1 : null;
  const unusual = above !== null && above >= UNUSUAL_ABOVE_AVG90;
  const notes: string[] = [];
  if (above === null) notes.push('No price history yet: judged at today’s price alone.');
  else if (unusual) {
    const others = [m.newAvg30 !== null ? `30 days ${usd(m.newAvg30)}` : null, m.newAvg180 !== null ? `180 days ${usd(m.newAvg180)}` : null].filter((x) => x !== null);
    notes.push(`${usd(price)} is ${pct(above * 100)} above its 90-day average of ${usd(m.newAvg90!)}${others.length ? ` (${others.join(', ')})` : ''}.`);
  }
  const amazonSells = m.amazonPrice !== null || m.buyBoxIsAmazon === true;
  if (amazonSells) {
    notes.push(m.amazonPrice !== null ? `Amazon sells this itself at ${usd(m.amazonPrice)}: hard to win sales against.` : 'Amazon holds the Buy Box on this listing: hard to win sales against.');
  }
  const grown = m.newOffers !== null && m.newOffersAvg90 !== null && m.newOffersAvg90 > 0
    && m.newOffers >= CROWD_RATIO * m.newOffersAvg90 && m.newOffers - m.newOffersAvg90 >= CROWD_MIN_ADDED;
  if (grown) notes.push(`${m.newOffers} sellers offer it new, up from ${m.newOffersAvg90} on average over 90 days.`);
  const oos = m.outOfStock90 !== null && m.outOfStock90 >= OUT_OF_STOCK_NOTABLE ? m.outOfStock90 : null;
  if (oos !== null) notes.push(`No New offer at all on ${oos}% of the last 90 days.`);
  const hazmat = m.hazmat ? { unId: m.hazmat.unId, name: m.hazmat.name, lithium: /LITHIUM/i.test(m.hazmat.name ?? '') } : null;
  if (hazmat) notes.push(hazardNote(hazmat));
  return {
    model: p.model, asin: p.asin, qty: p.qty, price, at: m.at, avg30: m.newAvg30, avg90: m.newAvg90, avg180: m.newAvg180,
    aboveAvg90: above === null ? null : Math.round(above * 10_000) / 10_000, unusual,
    ...(above === null ? { noHistory: true as const } : {}),
    ...(amazonSells ? { amazon: { price: m.amazonPrice, buyBox: m.buyBoxIsAmazon === true } } : {}),
    ...(m.newOffers !== null && m.newOffersAvg90 !== null ? { newOffers: { now: m.newOffers, avg90: m.newOffersAvg90, grown } } : {}),
    ...(oos !== null ? { outOfStock90: oos } : {}),
    ...(hazmat ? { hazmat } : {}),
    notes,
  };
}

/**
 * The market of a way to sell: each counted part with stored figures, and when some part is unusually priced, the estimate
 * at the usual prices: the same estimate with each such part's net at its 90-day average instead of today's price, with its
 * own fees (PartRow.fees). Exact for a way that sells every unit (a Buy now leaves nothing unsold).
 */
export function optionMarket(
  o: { parts: PartRow[]; estimate: BundleResult | null },
  trend: (asin: string) => PartTrend | undefined,
  thresholds: { minProfit: number; minRoiPercent: number },
): OptionMarket | null {
  const parts = o.parts.flatMap((p) => {
    const m = partMarket(p, p.asin ? trend(p.asin) : undefined);
    return m ? [m] : [];
  });
  if (parts.length === 0) return null;
  const unusual = parts.filter((p) => p.unusual);
  if (unusual.length === 0 || o.estimate === null) return { parts, usual: null };
  const rowOf = (model: string) => o.parts.find((p) => p.model === model)!;
  const net = (price: number, f: PartRow['fees']) => amazonNet(price, { ...DEFAULT_FEES, minReferral: MIN_REFERRAL }, { fulfillmentFee: f?.fulfillment ?? 0, referralRate: f?.referralRate ?? DEFAULT_FEES.referralRate });
  const delta = unusual.reduce((sum, p) => sum + p.qty * (net(p.avg90!, rowOf(p.model).fees) - net(p.price, rowOf(p.model).fees)), 0);
  const profit = round2(o.estimate.profit + delta);
  const roiPercent = o.estimate.cost ? estimateRoiPercent(Math.round((profit / o.estimate.cost) * 10_000) / 10_000) : 0;
  return {
    parts,
    usual: {
      profit, roiPercent, meets: profit >= thresholds.minProfit && roiPercent >= thresholds.minRoiPercent,
      parts: unusual.map((p) => ({ model: p.model, price: p.price, usual: p.avg90! })),
    },
  };
}

/** "the 90-day average of $61.12 for PCL515B", "the 90-day averages of $17.47 for PCG002 and $61.12 for PCL515B". */
const averagesWords = (u: UsualEstimate): string =>
  `the 90-day average${u.parts.length > 1 ? 's' : ''} of ${names(u.parts.map((p) => `${usd(p.usual)} for ${p.model}`))}`;

/**
 * Why a deal that clears the owner's numbers today is not a buy at its usual prices, as a condition that fails: "at the
 * 90-day average of $61.12 for PCL515B it is +$12.28 (12% ROI), below your $20".
 */
export function usualFailWords(u: UsualEstimate, t: { minProfit: number; minRoiPercent: number }): string {
  const below = u.profit < t.minProfit
    ? `below your ${usdShort(t.minProfit)}${u.roiPercent < t.minRoiPercent ? ` and ${pct(t.minRoiPercent)}` : ''}`
    : `ROI below your ${pct(t.minRoiPercent)}`;
  // A figure below its own number never rounds up to it: "+$19.99 (19.9% ROI), below your $20 and 20%".
  const figure = u.profit < t.minProfit && u.profit >= 0 ? `+${usdVs(u.profit, t.minProfit)}` : signed(u.profit);
  return `at ${averagesWords(u)} it is ${figure} (${pctVs(u.roiPercent, t.minRoiPercent)} ROI), ${below}`;
}

/** The verdict of a deal held back by its usual prices alone (rule 1). */
export const todayOnlyVerdict = (u: UsualEstimate, t: { minProfit: number; minRoiPercent: number }): string =>
  `Worth buying now at today's prices only: ${usualFailWords(u, t)}. Not marked Buy now`;

/** The information a Buy now deal with an unusually priced part carries: it clears at the usual prices too. */
export const usualHoldsWords = (u: UsualEstimate): string => `At ${averagesWords(u)} it is still ${signed(u.profit)} (${pct(u.roiPercent)} ROI)`;

/** A compact key of what the market says, so a stored signal is judged again when it changes (state.ts verdictKey). */
export const marketKey = (m: OptionMarket | null | undefined): string =>
  m ? `${m.parts.map((p) => `${p.model}${p.unusual ? 'U' : ''}${p.noHistory ? 'N' : ''}${p.amazon ? 'A' : ''}${p.newOffers?.grown ? 'C' : ''}${p.outOfStock90 !== undefined ? 'S' : ''}${p.hazmat ? 'H' : ''}`).join(',')}:${m.usual ? `${m.usual.profit}` : ''}` : '';
