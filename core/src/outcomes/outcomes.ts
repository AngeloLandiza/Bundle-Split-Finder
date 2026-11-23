// Outcomes: what the owner bought and what became of each part (docs/decisions.md, "Outcomes"). Pure: no storage, no
// clock but the one passed in. The agent stores the records; this module freezes the estimate at purchase, applies his
// changes, and works out the results and the scorecard. Nothing here guesses: a figure the records do not back is null.
//
// Two numbers decide the trial: profit actually realised on deals the app flagged, and how far the estimate was from it.
// So the snapshot of the estimate is taken once, when he says "I bought this", and is never rewritten.

import type {
  OutcomeScorecard,
  OutcomeSnapshot,
  OutcomeSnapshotPart,
  PartOutcome,
  PartOutcomeBody,
  PartResult,
  Purchase,
  PurchasePatch,
  PurchaseResult,
  PurchaseView,
} from '../api/contract';
import { amazonNet, type FeeSettings } from '../money';
import type { BundleRow } from '../scan/types';
import { csvLine } from '../scan/csv';

/** A change he asked for that the records cannot take, in one sentence. */
export class OutcomeRefused extends Error {}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- dates

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** The owner's calendar day for an instant (his clock, not UTC). */
export function dayOf(now: number): string {
  const d = new Date(now);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

const monthOf = (day: string): string => day.slice(0, 7);

// ---------------------------------------------------------------- the snapshot

export interface SnapshotInputs {
  /** The fee settings now: what the estimate on screen used. */
  fees: FeeSettings;
  /** The estimate's basis sentence now ("15% referral ..."). */
  basis: string;
  /** The last scan judged the bundle worth buying now. */
  buyNow: boolean;
  /** The moment, ISO. */
  at: string;
}

/**
 * The estimate as it stands for one bundle, copied: each part with its Amazon listing, its estimated price, its fees and
 * its after-fees amount, and the bundle's profit and ROI. A counted part is one the estimate used a price for. The
 * result holds no reference to `b`, so later changes to the bundle cannot reach it.
 */
export function snapshotOf(b: BundleRow, o: SnapshotInputs): OutcomeSnapshot {
  const uncovered = new Set(b.uncovered);
  const parts: OutcomeSnapshotPart[] = b.parts.map((p, i) => {
    const confirmed = p.prices.some((x) => x.kind === 'confirmed' && !x.reference);
    const counted = !uncovered.has(p.model) && p.price !== null && (p.availability === 'active' || confirmed);
    const link = p.asin ? (p.prices.find((x) => x.asin === p.asin && x.link && x.kind === 'amazon_new')?.link ?? `https://www.amazon.com/dp/${p.asin}`) : null;
    const base = {
      id: `p${i}`, model: p.model, qty: p.qty, counted, asin: p.asin, listingTitle: p.title, listingLink: link, grade: p.grade,
    };
    if (!counted || p.price === null) {
      return { ...base, sellPrice: null, referralRate: null, referralFee: null, fulfillmentFee: null, netEach: null };
    }
    const rate = p.fees?.referralRate ?? o.fees.referralRate;
    const fulfillment = p.fees?.fulfillment ?? o.fees.fulfillmentFee;
    return {
      ...base,
      sellPrice: p.price,
      referralRate: rate,
      referralFee: round2(Math.max(p.price * rate, o.fees.minReferral)),
      fulfillmentFee: fulfillment,
      netEach: amazonNet(p.price, o.fees, { referralRate: rate, fulfillmentFee: fulfillment }),
    };
  });
  return structuredClone({
    takenAt: o.at,
    buyNow: o.buyNow,
    bundle: { id: b.key, itemId: b.itemId, brand: b.brand, model: b.model, title: b.title, link: b.link, price: b.price, regularPrice: b.regularPrice },
    parts,
    uncounted: [...b.uncovered],
    estimate: b.estimate
      ? {
          profit: b.estimate.profit, roi: b.estimate.roi, cost: b.estimate.cost, afterFees: b.estimate.netRevenue,
          partsSellFor: round2(b.parts.reduce((sum, p) => sum + (p.price !== null && !uncovered.has(p.model) ? p.price * p.qty : 0), 0)),
        }
      : null,
    fees: {
      referralRate: o.fees.referralRate, fulfillmentFee: o.fees.fulfillmentFee, minReferral: o.fees.minReferral,
      salesTaxRate: o.fees.salesTaxRate, inboundCost: o.fees.inboundCost,
    },
    basis: o.basis,
  });
}

const openPart = (partId: string): PartOutcome => ({ partId, status: 'open', date: null, salePrice: null, netPayout: null, recovered: null, updatedAt: null });

export const OUTCOME_LIMITS = { maxPrice: 100_000, maxQuantity: 1000 } as const;

function money(v: unknown, what: string, min: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new OutcomeRefused(`${what} must be a number.`);
  if (v < min || v > OUTCOME_LIMITS.maxPrice) throw new OutcomeRefused(`${what} must be between ${min === 0 ? '$0' : `$${min}`} and $${OUTCOME_LIMITS.maxPrice.toLocaleString('en-US')}.`);
  return round2(v);
}

function quantity(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > OUTCOME_LIMITS.maxQuantity) {
    throw new OutcomeRefused(`Quantity must be a whole number from 1 to ${OUTCOME_LIMITS.maxQuantity}.`);
  }
  return v;
}

function date(v: unknown, what: string, today: string): string {
  if (!isIsoDate(v)) throw new OutcomeRefused(`${what} must be a date written YYYY-MM-DD.`);
  // The owner's day may run a day ahead of the agent's clock across time zones; further ahead is a typo.
  const limit = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)) + 1)).toISOString().slice(0, 10);
  if (v > limit) throw new OutcomeRefused(`${what} cannot be in the future.`);
  return v;
}

export interface NewPurchase {
  id: string;
  dealId: string;
  snapshot: OutcomeSnapshot;
  boughtAt?: unknown;
  pricePaid?: unknown;
  quantity?: unknown;
  now: number;
}

/** A new purchase. The price defaults to the deal's Home Depot price at the snapshot; a deal with no split has no parts to follow. */
export function newPurchase(i: NewPurchase): Purchase {
  const today = dayOf(i.now);
  if (i.snapshot.parts.length === 0) throw new OutcomeRefused('This deal has no split yet, so there are no parts to follow. Answer its question or wait for its page first.');
  const defaultPaid = i.snapshot.bundle.price;
  if (i.pricePaid === undefined && defaultPaid === null) throw new OutcomeRefused('This deal has no price on record. Enter the price you paid.');
  const at = new Date(i.now).toISOString();
  return {
    id: i.id,
    dealId: i.dealId,
    boughtAt: i.boughtAt === undefined ? today : date(i.boughtAt, 'The purchase date', today),
    pricePaid: i.pricePaid === undefined ? round2(defaultPaid as number) : money(i.pricePaid, 'The price paid', 0.01),
    quantity: i.quantity === undefined ? 1 : quantity(i.quantity),
    createdAt: at,
    updatedAt: at,
    snapshot: i.snapshot,
    parts: i.snapshot.parts.map((p) => openPart(p.id)),
  };
}

/**
 * What he can correct on a purchase: date, price paid, quantity. A field named in the patch that is not one of these is
 * refused, so the snapshot (or anything else) cannot be reached this way. Later part dates must still follow the purchase date.
 */
export function patchPurchase(p: Purchase, patch: Record<string, unknown>, now: number): Purchase {
  const allowed = new Set(['boughtAt', 'pricePaid', 'quantity']);
  const bad = Object.keys(patch).find((k) => !allowed.has(k));
  if (bad) throw new OutcomeRefused(`${bad} cannot be changed. Only the date, the price paid and the quantity can.`);
  if (Object.keys(patch).length === 0) throw new OutcomeRefused('Nothing to change.');
  const today = dayOf(now);
  const next: Purchase = { ...p, parts: p.parts.map((x) => ({ ...x })) };
  const body = patch as PurchasePatch;
  if (body.boughtAt !== undefined) next.boughtAt = date(body.boughtAt, 'The purchase date', today);
  if (body.pricePaid !== undefined) next.pricePaid = money(body.pricePaid, 'The price paid', 0.01);
  if (body.quantity !== undefined) next.quantity = quantity(body.quantity);
  const early = next.parts.find((x) => x.date !== null && x.date < next.boughtAt);
  if (early) throw new OutcomeRefused(`A part is recorded on ${early.date}, before that purchase date. Change the part first.`);
  next.updatedAt = new Date(now).toISOString();
  return next;
}

/** Records what became of one part. `sold` needs a price per unit; a net payout is optional and, when given, is the part's whole payout. */
export function applyPartOutcome(p: Purchase, partId: string, body: PartOutcomeBody, now: number): Purchase {
  if (!p.parts.some((x) => x.partId === partId)) throw new OutcomeRefused('This purchase has no such part.');
  const today = dayOf(now);
  let next: PartOutcome;
  const at = new Date(now).toISOString();
  if (body.status === 'holding') {
    next = { ...openPart(partId), status: 'holding', updatedAt: at };
  } else if (body.status === 'sold') {
    const when = body.date === undefined ? today : date(body.date, 'The sale date', today);
    if (when < p.boughtAt) throw new OutcomeRefused(`The sale date is before the purchase date (${p.boughtAt}).`);
    next = {
      partId, status: 'sold', date: when, salePrice: money(body.salePrice, 'The sale price', 0.01),
      netPayout: body.netPayout === undefined || body.netPayout === null ? null : money(body.netPayout, 'The net payout', 0),
      recovered: null, updatedAt: at,
    };
  } else if (body.status === 'returned') {
    const when = body.date === undefined ? today : date(body.date, 'The date', today);
    if (when < p.boughtAt) throw new OutcomeRefused(`The date is before the purchase date (${p.boughtAt}).`);
    next = {
      partId, status: 'returned', date: when, salePrice: null, netPayout: null,
      recovered: body.recovered === undefined || body.recovered === null ? null : money(body.recovered, 'The money back', 0),
      updatedAt: at,
    };
  } else {
    throw new OutcomeRefused('status must be sold, holding or returned.');
  }
  return { ...p, parts: p.parts.map((x) => (x.partId === partId ? next : x)), updatedAt: at };
}

// ---------------------------------------------------------------- results

/** What one purchase cost: his price and the snapshot's tax and inbound settings, the way the estimate counted a bundle's cost. */
export function purchaseCost(p: Pick<Purchase, 'pricePaid' | 'quantity' | 'snapshot'>): number {
  const f = p.snapshot.fees;
  return round2((p.pricePaid * (1 + f.salesTaxRate) + f.inboundCost) * p.quantity);
}

/** The feeds of amazonNet from a snapshot: its flat settings, with the part's own rate and fulfillment fee. */
function feeSettingsOf(s: OutcomeSnapshot): FeeSettings {
  return { ...s.fees };
}

export function purchaseResult(p: Purchase): PurchaseResult {
  const s = p.snapshot;
  const cost = purchaseCost(p);
  const fees = feeSettingsOf(s);
  // Each part's cost share follows its estimated net; parts the estimate did not count carry none.
  const estimatedNet = (sp: OutcomeSnapshotPart): number | null => (sp.netEach === null ? null : round2(sp.netEach * sp.qty * p.quantity));
  const weights = s.parts.map((sp) => estimatedNet(sp) ?? 0);
  const total = weights.reduce((a, b) => a + b, 0);
  const partResults: PartResult[] = s.parts.map((sp, i) => {
    const o = p.parts.find((x) => x.partId === sp.id) ?? openPart(sp.id);
    const units = sp.qty * p.quantity;
    let netReceived: number | null = null;
    let netFrom: PartResult['netFrom'] = null;
    if (o.status === 'sold' && o.salePrice !== null) {
      if (o.netPayout !== null) {
        netReceived = o.netPayout;
        netFrom = 'payout';
      } else {
        const own = { ...(sp.referralRate !== null ? { referralRate: sp.referralRate } : {}), ...(sp.fulfillmentFee !== null ? { fulfillmentFee: sp.fulfillmentFee } : {}) };
        netReceived = round2(amazonNet(o.salePrice, fees, own) * units);
        netFrom = 'fees_estimated';
      }
    } else if (o.status === 'returned') {
      netReceived = o.recovered ?? 0;
      netFrom = o.recovered === null ? 'none' : 'refund';
    }
    const settled = netReceived !== null;
    const share = total > 0 ? weights[i]! / total : 1 / s.parts.length;
    const costShare = settled ? round2(cost * share) : null;
    return {
      partId: sp.id, model: sp.model, units, status: o.status, date: o.date, salePrice: o.salePrice, netReceived, netFrom,
      estimatedNet: estimatedNet(sp), costShare, profit: settled ? round2((netReceived as number) - (costShare as number)) : null,
    };
  });
  const settled = partResults.filter((r) => r.netReceived !== null);
  const complete = partResults.length > 0 && settled.length === partResults.length;
  const realisedProfit = settled.length ? round2(settled.reduce((sum, r) => sum + (r.profit as number), 0)) : null;
  // A complete deal's actual profit is what came in less what it cost; the shares sum to the cost (rounded), so use that directly.
  const actualProfit = complete ? round2(settled.reduce((sum, r) => sum + (r.netReceived as number), 0) - cost) : null;
  const estimatedProfit = s.estimate ? round2(s.estimate.profit * p.quantity) : null;
  const accuracy =
    complete && estimatedProfit !== null && actualProfit !== null
      ? { estimated: estimatedProfit, actual: actualProfit, diff: round2(actualProfit - estimatedProfit), diffPercent: percentOf(actualProfit - estimatedProfit, estimatedProfit) }
      : null;
  return {
    cost,
    estimatedProfit,
    partsTotal: partResults.length,
    partsSettled: settled.length,
    partsSold: partResults.filter((r) => r.status === 'sold').length,
    partsHolding: partResults.filter((r) => r.status === 'holding').length,
    parts: partResults,
    complete,
    realisedProfit,
    actualProfit,
    accuracy,
    feesEstimated: partResults.some((r) => r.netFrom === 'fees_estimated'),
  };
}

/** Whole-number-free percent: the difference as a share of the estimate's size; null against an estimate of zero. */
function percentOf(diff: number, estimated: number): number | null {
  return estimated === 0 ? null : Math.round((diff / Math.abs(estimated)) * 1000) / 10;
}

export function viewOf(p: Purchase): PurchaseView {
  return { ...structuredClone(p), result: purchaseResult(p) };
}

// ---------------------------------------------------------------- the scorecard

/** The owner's records for `month` (YYYY-MM, default the month of `now`). Nothing here comes from an estimate except the one it is compared with. */
export function scorecardOf(purchases: readonly Purchase[], now: number, month: string = monthOf(dayOf(now))): OutcomeScorecard {
  // The money is the parts settled in `month`; "N of M parts" counts every part of the deals that had one, whenever it settled.
  let profit = 0;
  let settled = 0;
  let sold = 0;
  let feesEstimated = false;
  const dealsWithSales = new Set<string>();
  let partsOfThose = 0;
  const perDeal: NonNullable<OutcomeScorecard['accuracy']>['perDeal'] = [];
  let estimated = 0;
  let actual = 0;
  for (const p of purchases) {
    const r = purchaseResult(p);
    const inMonth = r.parts.filter((x) => x.date !== null && monthOf(x.date) === month && x.profit !== null);
    if (inMonth.length) {
      dealsWithSales.add(p.id);
      settled += r.partsSettled;
      sold += r.partsSold;
      partsOfThose += r.partsTotal;
      for (const x of inMonth) {
        profit += x.profit as number;
        if (x.netFrom === 'fees_estimated') feesEstimated = true;
      }
    }
    if (r.accuracy) {
      perDeal.push({ purchaseId: p.id, title: p.snapshot.bundle.title, estimated: r.accuracy.estimated, actual: r.accuracy.actual, diff: r.accuracy.diff, diffPercent: r.accuracy.diffPercent });
      estimated += r.accuracy.estimated;
      actual += r.accuracy.actual;
    }
  }
  return {
    month,
    purchases: purchases.length,
    boughtThisMonth: purchases.filter((p) => monthOf(p.boughtAt) === month).length,
    flaggedWhenBought: purchases.filter((p) => p.snapshot.buyNow).length,
    realised: dealsWithSales.size ? { profit: round2(profit), partsSettled: settled, partsSold: sold, partsOfThoseDeals: partsOfThose, deals: dealsWithSales.size, feesEstimated } : null,
    accuracy: perDeal.length
      ? { deals: perDeal.length, estimated: round2(estimated), actual: round2(actual), diff: round2(actual - estimated), diffPercent: percentOf(actual - estimated, estimated), perDeal }
      : null,
  };
}

// ---------------------------------------------------------------- CSV

export const OUTCOME_COLUMNS: readonly string[] = [
  'purchase_id', 'bought_at', 'brand', 'bundle_model', 'bundle_title', 'hd_item_id', 'hd_link', 'bundles_bought', 'price_paid_each', 'cost_total',
  'flagged_buy_now', 'estimate_taken_at', 'est_profit_per_bundle', 'est_roi', 'est_basis',
  'part_model', 'part_units', 'asin', 'amazon_link', 'est_sell_price_each', 'est_referral_fee_each', 'est_fulfillment_fee_each', 'est_net_each',
  'status', 'date', 'sale_price_each', 'net_received', 'net_from', 'part_cost_share', 'part_profit',
  'deal_complete', 'deal_actual_profit', 'deal_est_profit', 'deal_diff',
];

/** One row per part of each purchase, what he recorded beside the estimate frozen at purchase. Estimates are labelled in the columns. */
export function outcomesCsv(purchases: readonly Purchase[]): string {
  const lines = [csvLine([...OUTCOME_COLUMNS])];
  for (const p of purchases) {
    const r = purchaseResult(p);
    const s = p.snapshot;
    for (const sp of s.parts) {
      const x = r.parts.find((y) => y.partId === sp.id)!;
      lines.push(
        csvLine([
          p.id, p.boughtAt, s.bundle.brand, s.bundle.model, s.bundle.title, s.bundle.itemId, s.bundle.link, p.quantity, p.pricePaid, r.cost,
          s.buyNow ? 'yes' : 'no', s.takenAt, s.estimate?.profit ?? null, s.estimate?.roi ?? null, s.basis,
          sp.model, x.units, sp.asin, sp.listingLink, sp.sellPrice, sp.referralFee, sp.fulfillmentFee, sp.netEach,
          x.status, x.date, x.salePrice, x.netReceived, x.netFrom, x.costShare, x.profit,
          r.complete ? 'yes' : 'no', r.actualProfit, r.estimatedProfit, r.accuracy?.diff ?? null,
        ]),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- Activity sentences

const usd = (n: number): string => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayWords = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const nameOf = (p: Pick<Purchase, 'snapshot'>): string => p.snapshot.bundle.model || p.snapshot.bundle.title;

export function purchaseSentence(p: Purchase): string {
  return `Recorded a purchase: ${p.quantity === 1 ? '1 bundle' : `${p.quantity} bundles`} of ${nameOf(p)} at ${usd(p.pricePaid)} each on ${dayWords(p.boughtAt)}.`;
}

export function patchSentence(before: Purchase, after: Purchase): string {
  const changed: string[] = [];
  if (before.boughtAt !== after.boughtAt) changed.push(`date ${dayWords(after.boughtAt)}`);
  if (before.pricePaid !== after.pricePaid) changed.push(`price paid ${usd(after.pricePaid)}`);
  if (before.quantity !== after.quantity) changed.push(`quantity ${after.quantity}`);
  return `Changed the purchase of ${nameOf(after)}: ${changed.join(', ') || 'nothing'}.`;
}

export function partSentence(after: Purchase, partId: string): string {
  const part = after.parts.find((x) => x.partId === partId)!;
  const r = purchaseResult(after).parts.find((x) => x.partId === partId)!;
  const what = `${r.model} from ${nameOf(after)}`;
  if (part.status === 'sold') {
    const net = r.netReceived === null ? '' : ` (net ${usd(r.netReceived)}${r.netFrom === 'fees_estimated' ? ', fees estimated' : ''})`;
    return `Recorded ${what} as sold for ${usd(part.salePrice as number)}${r.units > 1 ? ' each' : ''} on ${dayWords(part.date as string)}${net}.`;
  }
  if (part.status === 'holding') return `Marked ${what} as still holding.`;
  if (part.status === 'returned') return `Marked ${what} as returned or not sold${part.recovered ? `, ${usd(part.recovered)} back` : ''}.`;
  return `Cleared what was recorded about ${what}.`;
}

export const removedSentence = (p: Purchase): string => `Removed the purchase record of ${nameOf(p)}.`;
