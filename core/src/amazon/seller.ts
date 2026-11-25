// What the owner's own Amazon seller account says about each part, and what that does to a deal (Nov 25). Pure: the agent
// reads Amazon (core/src/amazon/spapi) and stores one record per ASIN; this file decides which listings to check, when a
// record is fresh, the Buy now conditions with their sentences, and the line under each part in the deal inspector.
//
// Rule 4: "not checked" is never "allowed". With an account connected, a part that was not checked (or whose check
// failed) keeps its deal from Buy now and says so. With no account connected, nothing here applies: a Buy now deal only
// carries NOT_CONNECTED_LINE.

import type { PartRow } from '../scan/types';
import type { EligibilityReason, FeeLine, ListingStatus, RestrictionReason } from './spapi/types';
import { FBA_PENDING_CODES, fbaReasonWords } from './spapi/words';

/** One ASIN as the owner's account sees it. Stored in the agent's cache at `spapi:check:<asin>`. */
export interface SellerPartCheck {
  asin: string;
  /** Which account it was read with (sellerAccountTag); a record of another account is not used. */
  account: string;
  listing: { at: number; status: ListingStatus; reasons: RestrictionReason[] } | null;
  fba: { at: number; eligible: boolean; reasons: EligibilityReason[] } | null;
  /** Amazon's fee estimate for his account at `price`, sold through FBA. Null until read, or when Amazon gave none. */
  fees: AmazonFeeRecord | null;
  /** The price the last fee read asked at, whether or not Amazon gave an estimate (so a missing one is not asked again at once). */
  feesAskedAt?: number;
  /** The last check that failed, in words (scrubbed); absent when the last one worked. */
  problem?: { at: number; text: string };
}

/** Amazon's fee estimate at one price (dollars per unit): referral, and everything else it counted (FBA fees and the rest). */
export interface AmazonFeeRecord {
  at: number;
  price: number;
  total: number;
  referral: number;
  other: number;
  lines: FeeLine[];
}

export const sellerCheckCacheKey = (asin: string): string => `spapi:check:${asin}`;

/** A check is used for this long (a week), then read again. */
export const SELLER_CHECK_FRESH_MS = 7 * 86_400_000;
/** Before a deal is first announced, its parts are read again unless checked within this. */
export const SELLER_CHECK_ANNOUNCE_MS = 60 * 60_000;

/** The line a Buy now deal carries when no seller account is connected. */
export const NOT_CONNECTED_LINE = 'Not checked against your Amazon account: connect it in Settings to see whether you may list these.';

/**
 * A short tag for the seller id the records were read with, so a record of an earlier account is never used. Not the id
 * itself (it is part of the key, rule 3): FNV-1a, 32 bits, as hex.
 */
export function sellerAccountTag(sellerId: string): string {
  let h = 0x811c9dc5;
  for (const ch of sellerId.trim()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** What the signals read when an account is connected. */
export interface SellerLookup {
  check(asin: string): SellerPartCheck | undefined;
  /** The owner said he ships this part himself: FBA's answer does not hold the deal. */
  selfShip(asin: string): boolean;
}

/** Parts sold on Amazon by their own listing: the ones his account is asked about. */
export const sellerParts = (parts: readonly PartRow[]): PartRow[] => parts.filter((p) => p.qty > 0 && p.asin !== null && p.price !== null);

const names = (models: string[]): string => (models.length <= 2 ? models.join(' and ') : `${models.slice(0, -1).join(', ')} and ${models.at(-1)}`);

/** One FBA answer in words: its first reason (FBA_REASON_WORDS), or "not eligible" with none given. */
export function fbaWords(reasons: readonly EligibilityReason[]): string {
  return reasons.length === 0 ? 'Amazon gave no reason' : reasons.map((r) => fbaReasonWords(r.code)).filter((w, i, a) => a.indexOf(w) === i).join('; ');
}

/** The listing answer in words, for a part that may not be listed as it is. */
function listingWords(model: string, l: NonNullable<SellerPartCheck['listing']>): string {
  switch (l.status) {
    case 'approval_required':
      return `you need Amazon's approval to list ${model}`;
    case 'not_eligible':
      return `you may not list ${model} on Amazon (not eligible)`;
    case 'not_found':
      return `Amazon does not find ${model}'s listing for your account`;
    case 'unknown':
      return `Amazon restricts listing ${model} (unknown: ${l.reasons.filter((r) => !r.known).map((r) => r.code).join(', ')})`;
    case 'allowed':
      return '';
  }
}

/**
 * The Buy now conditions a connected account adds, as the fails of one way to sell (each a clause of the verdict): every
 * part allowed to list, and every part eligible for FBA unless the owner ships it himself. A part not checked yet says so.
 */
export function sellerFails(parts: readonly PartRow[], lookup: SellerLookup): string[] {
  const out: string[] = [];
  const uncheckedList: string[] = [];
  const uncheckedFba: string[] = [];
  for (const p of sellerParts(parts)) {
    const c = lookup.check(p.asin!);
    if (!c?.listing) uncheckedList.push(p.model);
    else if (c.listing.status !== 'allowed') out.push(listingWords(p.model, c.listing));
    if (lookup.selfShip(p.asin!)) continue;
    if (!c?.fba) uncheckedFba.push(p.model);
    else if (!c.fba.eligible) out.push(`FBA does not take ${p.model} yet: ${fbaWords(c.fba.reasons)}`);
  }
  if (uncheckedList.length > 0) out.push(`not checked yet whether you may list ${names(uncheckedList)}`);
  if (uncheckedFba.length > 0) out.push(`not checked yet whether FBA takes ${names(uncheckedFba)}`);
  return out;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The compact line under a part in the deal inspector, with its tone and Amazon's path-forward link when it gave one. */
export interface SellerPartLine {
  model: string;
  asin: string;
  text: string;
  tone: 'ok' | 'attention';
  /** Amazon's "apply" link (sellercentral.amazon.com only, sellerCentralLink). */
  link: string | null;
  /** FBA does not take it (or was not asked): the owner may say he ships it himself. */
  canSelfShip: boolean;
  selfShip: boolean;
}

export function sellerPartLine(p: Pick<PartRow, 'model' | 'asin'>, c: SellerPartCheck | undefined, selfShip: boolean): SellerPartLine {
  const parts: string[] = [];
  let ok = true;
  let link: string | null = null;
  const l = c?.listing ?? null;
  if (!l) {
    parts.push(c?.problem ? `Not checked: ${c.problem.text}.` : 'Not checked yet whether you may list it.');
    ok = false;
  } else if (l.status === 'allowed') parts.push('You may list it.');
  else {
    ok = false;
    const amazon = l.reasons.find((r) => r.message)?.message;
    link = l.reasons.find((r) => r.link)?.link ?? null;
    const head = l.status === 'approval_required' ? 'You need Amazon\'s approval to list it.' : l.status === 'not_eligible' ? 'You may not list it (not eligible).' : l.status === 'not_found' ? 'Amazon does not find this listing for your account.' : `Amazon restricts it (unknown: ${l.reasons.filter((r) => !r.known).map((r) => r.code).join(', ')}).`;
    parts.push(amazon ? `${head} Amazon: "${amazon.replace(/"/g, "'")}"` : head);
  }
  const f = c?.fba ?? null;
  if (selfShip) parts.push('You ship it yourself.');
  else if (!f) {
    if (l) parts.push('FBA not checked yet.');
    ok = false;
  } else if (f.eligible) parts.push('FBA accepts it.');
  else {
    ok = false;
    const pending = f.reasons.length > 0 && f.reasons.every((r) => FBA_PENDING_CODES.includes(r.code));
    parts.push(`${pending ? 'FBA not yet' : 'FBA does not take it'}: ${fbaWords(f.reasons)}.`);
  }
  if (c?.fees) parts.push(`Amazon's fees: ${usd(c.fees.total)}.`);
  return {
    model: p.model, asin: p.asin ?? '', text: parts.join(' ').replace(/\.\./g, '.'), tone: ok ? 'ok' : 'attention', link,
    canSelfShip: !selfShip && (f === null || !f.eligible), selfShip,
  };
}

/**
 * The ASINs to check now, each once: the counted parts of every deal that is Buy now or within reach of it (`candidates`,
 * the caller's choice: clears his thresholds, or is watched), whose record is missing, of another account, or older than
 * the freshness (SELLER_CHECK_ANNOUNCE_MS for a deal about to be announced for the first time, else a week).
 */
export function checksWanted(
  candidates: readonly { parts: readonly PartRow[]; firstAnnounce: boolean }[],
  check: (asin: string) => SellerPartCheck | undefined,
  account: string,
  now: number,
): SellerCheckWanted[] {
  const out = new Map<string, SellerCheckWanted>();
  for (const c of candidates) {
    const fresh = c.firstAnnounce ? SELLER_CHECK_ANNOUNCE_MS : SELLER_CHECK_FRESH_MS;
    for (const p of sellerParts(c.parts)) {
      const r = check(p.asin!);
      const mine = r !== undefined && r.account === account;
      const at = mine && r.listing && r.fba ? Math.min(r.listing.at, r.fba.at) : null;
      const full = at === null || now - at > fresh;
      // Fees are read again when the price the estimate uses moved, or with a full check.
      const asked = mine ? r.feesAskedAt ?? r.fees?.price : undefined;
      const fees = full || asked === undefined || Math.abs(asked - p.price!) >= 0.005;
      if (!full && !fees) continue;
      const had = out.get(p.asin!);
      if (!had) out.set(p.asin!, { asin: p.asin!, model: p.model, price: p.price!, full, fees });
      else out.set(p.asin!, { ...had, full: had.full || full, fees: had.fees || fees });
    }
  }
  return [...out.values()];
}

/** One listing to read: `full` its listing and FBA answers too, `fees` Amazon's fee estimate at `price`. */
export interface SellerCheckWanted {
  asin: string;
  model: string;
  price: number;
  full: boolean;
  fees: boolean;
}

/** Amazon's fee record for a part, when it was read with this account at exactly the price the estimate uses. */
export function feesAtPrice(c: SellerPartCheck | undefined, account: string, price: number): AmazonFeeRecord | undefined {
  if (!c || c.account !== account || !c.fees) return undefined;
  return Math.abs(c.fees.price - price) < 0.005 ? c.fees : undefined;
}
