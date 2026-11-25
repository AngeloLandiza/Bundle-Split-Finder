// The Bought screen and its sheets, in words and requests (docs/decisions.md, "Outcomes"). Pure: a form's text becomes the
// agent's request or one sentence saying what is wrong; the agent checks it again. Everything shown as realised is what he recorded;
// everything estimated says so.

import type { PartOutcomeBody, PartResult, PurchasePatch, PurchaseView, RecordPurchaseBody } from '@core/api/contract';
import { dayOf, dayWords } from '@core/outcomes/outcomes';
import { money, plural, profit } from './format';

/** The owner's day as YYYY-MM-DD, for a date field's default. */
export const todayIso = (now: number = Date.now()): string => dayOf(now);

/** "$1,234.50", "1234.5" or "12" as a number; null for anything else (no guessing at "12,5" or "twelve"). */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  // A comma is only ever a thousands separator ("1,179.50"); "12,5" is never read as 125.
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) return Number(t.replace(/,/g, ''));
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

export type Problem = { ok: false; problem: string };

// ---------------------------------------------------------------- the purchase sheet

export interface PurchaseForm {
  date: string;
  price: string;
  quantity: string;
}

// Nov 25: Home Depot's page states a per-order limit ("Limit 3 per order"). The quantity starts at 1, which no limit is under,
// so it never starts above the limit; one above it is warned about, not refused (he may buy in several orders).
export const initialPurchaseForm = (price: number | null, now?: number, limit: number | null = null): PurchaseForm => ({
  date: todayIso(now), price: price === null ? '' : price.toFixed(2), quantity: String(limit !== null && limit < 1 ? limit : 1),
});

/** The warning for a quantity above the page's per-order limit; null when it is within it, or the page states none. */
export function limitWarning(quantity: string, limit: number | null): string | null {
  if (limit === null || !/^\d+$/.test(quantity.trim())) return null;
  const n = Number(quantity);
  return n > limit ? `Home Depot's page says Limit ${limit} per order, and this is ${n}. Record it only if you bought it in more than one order.` : null;
}
export const formOfPurchase = (p: Pick<PurchaseView, 'boughtAt' | 'pricePaid' | 'quantity'>): PurchaseForm => ({ date: p.boughtAt, price: p.pricePaid.toFixed(2), quantity: String(p.quantity) });

function checked(form: PurchaseForm): { ok: true; date: string; price: number; quantity: number } | Problem {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { ok: false, problem: 'Enter the date you bought it.' };
  const price = parseMoney(form.price);
  if (price === null || price <= 0) return { ok: false, problem: 'Enter the price you paid for one bundle, like 179.00.' };
  if (!/^\d+$/.test(form.quantity.trim()) || Number(form.quantity) < 1) return { ok: false, problem: 'Enter how many bundles you bought, a whole number.' };
  return { ok: true, date: form.date, price, quantity: Number(form.quantity) };
}

export function purchaseRequest(form: PurchaseForm, dealId: string): { ok: true; body: RecordPurchaseBody } | Problem {
  const c = checked(form);
  return c.ok ? { ok: true, body: { dealId, boughtAt: c.date, pricePaid: c.price, quantity: c.quantity } } : c;
}

/** Only what changed; null when nothing did. */
export function patchRequest(form: PurchaseForm, p: PurchaseView): { ok: true; patch: PurchasePatch | null } | Problem {
  const c = checked(form);
  if (!c.ok) return c;
  const patch: PurchasePatch = {};
  if (c.date !== p.boughtAt) patch.boughtAt = c.date;
  if (c.price !== p.pricePaid) patch.pricePaid = c.price;
  if (c.quantity !== p.quantity) patch.quantity = c.quantity;
  return { ok: true, patch: Object.keys(patch).length ? patch : null };
}

// ---------------------------------------------------------------- a part's sheets

export interface SaleForm {
  date: string;
  price: string;
  payout: string;
}

export const initialSaleForm = (now?: number): SaleForm => ({ date: todayIso(now), price: '', payout: '' });

export function saleRequest(form: SaleForm): { ok: true; body: PartOutcomeBody } | Problem {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { ok: false, problem: 'Enter the date it sold.' };
  const price = parseMoney(form.price);
  if (price === null || price <= 0) return { ok: false, problem: 'Enter what one unit sold for, like 150.00.' };
  const body: PartOutcomeBody = { status: 'sold', date: form.date, salePrice: price };
  if (form.payout.trim() !== '') {
    const payout = parseMoney(form.payout);
    if (payout === null) return { ok: false, problem: 'Enter the net payout as a dollar amount, or leave it empty.' };
    body.netPayout = payout;
  }
  return { ok: true, body };
}

export interface ReturnForm {
  date: string;
  back: string;
}

export const initialReturnForm = (now?: number): ReturnForm => ({ date: todayIso(now), back: '' });

export function returnRequest(form: ReturnForm): { ok: true; body: PartOutcomeBody } | Problem {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { ok: false, problem: 'Enter the date.' };
  const body: PartOutcomeBody = { status: 'returned', date: form.date };
  if (form.back.trim() !== '') {
    const back = parseMoney(form.back);
    if (back === null) return { ok: false, problem: 'Enter the money you got back as a dollar amount, or leave it empty.' };
    body.recovered = back;
  }
  return { ok: true, body };
}

// ---------------------------------------------------------------- words

/** What was recorded about a part, in one line. */
export function partWords(r: PartResult): string {
  switch (r.status) {
    case 'open':
      return 'Not recorded yet';
    case 'holding':
      return 'Still holding';
    case 'sold':
      return `Sold ${dayWords(r.date as string)} for ${money(r.salePrice as number)}${r.units > 1 ? ' each' : ''} · net ${money(r.netReceived as number)}${r.netFrom === 'fees_estimated' ? ' (fees estimated)' : ''}`;
    case 'returned':
      return `Returned or not sold ${dayWords(r.date as string)}${r.netFrom === 'refund' ? ` · ${money(r.netReceived as number)} back` : ''}`;
  }
}

/** The purchase's line under its title: when, how many, at what. */
export const boughtWords = (p: Pick<PurchaseView, 'boughtAt' | 'pricePaid' | 'quantity'>): string => `Bought ${dayWords(p.boughtAt)} · ${p.quantity} × ${money(p.pricePaid)}`;

/** Where the deal stands: "1 of 2 parts sold", "Complete", "Nothing recorded yet". */
export function progressWords(r: PurchaseView['result']): string {
  if (r.complete) return 'Complete';
  if (r.partsSettled === 0) return r.partsHolding > 0 ? `Holding ${plural(r.partsHolding, 'part', 'parts')}` : 'Nothing sold yet';
  return `${r.partsSettled} of ${r.partsTotal} parts ${r.partsSold === r.partsSettled ? 'sold' : 'sold or returned'}`;
}

/** The result line: realised so far, or the made-against-estimated of a complete deal. Estimates are named so. */
export function resultWords(r: PurchaseView['result']): string | null {
  if (r.complete && r.actualProfit !== null) {
    return r.estimatedProfit === null ? `Made ${profit(r.actualProfit)} (recorded by you). It had no estimate when you bought.` : `Made ${profit(r.actualProfit)} (recorded by you) against ${profit(r.estimatedProfit)} estimated.`;
  }
  if (r.realisedProfit !== null) return `Realised so far ${profit(r.realisedProfit)} on the ${r.partsSettled === 1 ? 'part' : 'parts'} settled (recorded by you).`;
  return r.estimatedProfit === null ? null : `Estimated ${profit(r.estimatedProfit)} when you bought (an estimate).`;
}
