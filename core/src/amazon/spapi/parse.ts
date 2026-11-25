// Parsers for the four read-only answers, built from the model shapes in docs/sp-api-notes-2026-11-25.md. Strict about
// what the app uses (a missing or wrongly typed field the decision rests on makes the answer unreadable), tolerant about
// the rest: an unknown reason code or fee type is kept by its name ("unknown: <code>"), never a failure and never a pass.
// Nothing here keeps a seller id or any other field the app does not use.

import type { EligibilityResult, FeeLine, FeesResult, ListingStatus, OrderMetric, RestrictionReason, RestrictionsResult } from './types';
import { LISTING_REASON_CODES } from './words';

export class SpParseError extends Error {
  constructor(what: string) {
    super(`Amazon's ${what} answer could not be read`);
    this.name = 'SpParseError';
  }
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 400): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const code = (v: unknown): string => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60) : '');

const MAX_LINK_CHARS = 500;

/**
 * Amazon's path-forward link when it is safe to show and open: https, host exactly sellercentral.amazon.com, no user,
 * password or port, no control characters, spaces or backslash, at most 500 characters. Anything else is dropped (the
 * owner then sees Amazon's message without a link). The window checks it again before it opens it.
 */
export function sellerCentralLink(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_LINK_CHARS) return null;
  if (/[\u0000-\u001f\u007f\s\\]/.test(url) || !url.startsWith('https://')) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  if (u.hostname !== 'sellercentral.amazon.com') return null;
  return u.href;
}

/**
 * GET /listings/2021-08-01/restrictions. `{ restrictions: [{ marketplaceId, conditionType, reasons: [{ message,
 * reasonCode, links: [{ resource, verb, title, type }] }] }] }`; an empty `restrictions` means no restriction. Only the
 * restrictions for `conditionType` (new_new) count; one with no conditionType is counted too (it applies to all).
 */
export function parseRestrictions(asin: string, body: unknown, conditionType = 'new_new'): RestrictionsResult {
  if (!rec(body) || !Array.isArray(body.restrictions)) throw new SpParseError('listing check');
  const reasons: RestrictionReason[] = [];
  for (const r of body.restrictions) {
    if (!rec(r)) throw new SpParseError('listing check');
    if (typeof r.conditionType === 'string' && r.conditionType !== conditionType) continue;
    const list = Array.isArray(r.reasons) ? r.reasons : [];
    // A restriction with no reason at all is still a restriction: kept as an unknown one, never read as allowed.
    if (list.length === 0) reasons.push({ code: 'NO_REASON_GIVEN', known: false, message: '', link: null });
    for (const x of list) {
      if (!rec(x)) continue;
      const c = code(x.reasonCode) || 'NO_REASON_CODE';
      const links = Array.isArray(x.links) ? x.links : [];
      const link = links.map((l) => (rec(l) ? sellerCentralLink(l.resource) : null)).find((l) => l !== null) ?? null;
      reasons.push({ code: c, known: LISTING_REASON_CODES.includes(c), message: text(x.message), link });
    }
  }
  return { asin, status: listingStatusOf(reasons), reasons };
}

/** The worst reason decides: not eligible, then not found, then approval required; an unknown code is never allowed. */
function listingStatusOf(reasons: readonly RestrictionReason[]): ListingStatus {
  if (reasons.length === 0) return 'allowed';
  const has = (c: string) => reasons.some((r) => r.code === c);
  if (has('NOT_ELIGIBLE')) return 'not_eligible';
  if (has('ASIN_NOT_FOUND')) return 'not_found';
  if (reasons.some((r) => !r.known)) return 'unknown';
  return 'approval_required';
}

/**
 * GET /fba/inbound/v1/eligibility/itemPreview. `{ payload: { asin, program, isEligibleForProgram,
 * ineligibilityReasonList[] } }`. `isEligibleForProgram` must be a boolean; an eligible answer that still lists reasons is
 * read as not eligible (rule 4: the safer reading).
 */
export function parseEligibility(asin: string, body: unknown): EligibilityResult {
  const p = rec(body) ? body.payload : undefined;
  if (!rec(p) || typeof p.isEligibleForProgram !== 'boolean') throw new SpParseError('FBA check');
  const raw = Array.isArray(p.ineligibilityReasonList) ? p.ineligibilityReasonList : [];
  const codes = [...new Set(raw.map(code).filter((c) => c !== ''))];
  const reasons = codes.map((c) => ({ code: c, known: /^FBA_INB_\d{4}$/.test(c) || c === 'UNKNOWN_INB_ERROR_CODE' }));
  return { asin, eligible: p.isEligibleForProgram && reasons.length === 0, reasons };
}

const money = (v: unknown): number | null => {
  if (!rec(v)) return null;
  const a = typeof v.Amount === 'number' ? v.Amount : typeof v.Amount === 'string' && /^-?\d+(\.\d+)?$/.test(v.Amount) ? Number(v.Amount) : NaN;
  if (!Number.isFinite(a)) return null;
  if (v.CurrencyCode !== undefined && v.CurrencyCode !== 'USD') return null;
  return Math.round(a * 100) / 100;
};

/** One FeeDetail's amount: FinalFee when given (after promotions), else FeeAmount. */
const feeOf = (d: Rec): number | null => money(d.FinalFee) ?? money(d.FeeAmount);

/**
 * POST /products/fees/v0/feesEstimate: an array, one per item asked, in order; each `{ Status, FeesEstimateIdentifier,
 * FeesEstimate: { TotalFeesEstimate, FeeDetailList[] }, Error }`. The model does not list FeeType values; "ReferralFee" is
 * read as the referral, every other type (FBAFees, closing fees, any unknown) as the rest. An item with no ReferralFee
 * line, or whose lines do not add up to its total, is not used (problem set): its estimate stays as it was (Keepa's).
 */
export function parseFeesBatch(items: readonly { asin: string; price: number }[], body: unknown): FeesResult[] {
  // The model gives a bare array; a `{ payload: [...] }` wrapper (as the single-item call has) is read the same.
  const all = Array.isArray(body) ? body : rec(body) && Array.isArray(body.payload) ? body.payload : null;
  if (all === null) throw new SpParseError('fee estimate');
  return items.map((item, i) => {
    const r = all[i];
    const fail = (problem: string): FeesResult => ({ asin: item.asin, price: item.price, estimate: null, problem });
    if (!rec(r)) return fail('no answer for it');
    // The identifier, when present, must be this item: answers out of order are not matched up by guessing.
    const id = rec(r.FeesEstimateIdentifier) ? r.FeesEstimateIdentifier.IdValue : undefined;
    if (typeof id === 'string' && id !== item.asin) return fail('the answer was for another item');
    const est = r.FeesEstimate;
    if (r.Status !== undefined && r.Status !== 'Success') {
      const err = rec(r.Error) ? text(r.Error.Message, 200) || code(r.Error.Code) : '';
      return fail(err ? `Amazon said: ${err}` : `status ${code(r.Status) || 'not given'}`);
    }
    if (!rec(est)) return fail('no estimate in the answer');
    const total = money(est.TotalFeesEstimate);
    const list = Array.isArray(est.FeeDetailList) ? est.FeeDetailList.filter(rec) : [];
    const lines: FeeLine[] = [];
    for (const d of list) {
      const amount = feeOf(d);
      const type = code(d.FeeType);
      if (amount === null || type === '') continue;
      lines.push({ type, amount });
    }
    if (total === null) return fail('no total in the answer');
    const referralLines = lines.filter((l) => l.type === 'ReferralFee');
    if (referralLines.length !== 1) return fail('no referral fee line to tell it from the other fees');
    const sum = Math.round(lines.reduce((n, l) => n + l.amount, 0) * 100) / 100;
    if (Math.abs(sum - total) > 0.011) return fail(`its fee lines add up to $${sum.toFixed(2)}, not its total of $${total.toFixed(2)}`);
    const referral = referralLines[0]!.amount;
    return { asin: item.asin, price: item.price, estimate: { total, referral, other: Math.round((total - referral) * 100) / 100, lines }, problem: null };
  });
}

/** GET /sales/v1/orderMetrics: `{ payload: [{ interval, unitCount, orderItemCount, orderCount, averageUnitPrice, totalSales }] }`. */
export function parseOrderMetrics(body: unknown): OrderMetric[] {
  const p = rec(body) ? body.payload : undefined;
  if (!Array.isArray(p)) throw new SpParseError('sales');
  return p.map((m) => {
    if (!rec(m) || typeof m.interval !== 'string' || typeof m.unitCount !== 'number') throw new SpParseError('sales');
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      interval: text(m.interval, 80), unitCount: m.unitCount, orderItemCount: n(m.orderItemCount), orderCount: n(m.orderCount),
      averageUnitPrice: money(m.averageUnitPrice), totalSales: money(m.totalSales),
    };
  });
}
