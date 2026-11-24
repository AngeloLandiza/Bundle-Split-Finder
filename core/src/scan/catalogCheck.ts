// The catalog check applied to the store: a title match, or a listing a match question offers because its brand or its
// kit-ness was not confirmed, is read against Amazon's structured fields (keepa/verify.ts checkIdentity), so the owner is
// not asked what the catalog can prove.
//
//   confirmed     the match is verified: grade strong, verifiedBy and the evidence with the listing's link stored; a
//                 question offering the listing is withdrawn and the part matched to it
//   contradicted  the listing is never this part's (rejectedAsins): a match moves to its next alternative, or the part
//                 has no listing (status none, the reason stored); a question stops offering it, and with nothing left
//                 it is withdrawn the same way
//   unknown       nothing changes; the check is remembered so the listing is not pulled again
//
// Rung 1 of the listing ladder (keepa/listingFields.ts) reads the same pulled fields for an unknown: its adopted rules
// confirm as the catalog does, with verifiedBy 'listing_fields'. No new call.
//
// Each listing is checked once per part (catalogChecks): a brand or part number does not go stale. The owner's own
// decisions are never touched. A rule that holds more (LADDER_VERSION 4: a title that names another model of the brand's
// family) reads every stored confirmation by fields again once, from the cached pull: confirmed, it stands; contradicted,
// it is removed as above; unknown, the part is held for the owner (hold.ts: the Review "Which listing" question). Pure TypeScript over the ScanStore; the pull itself is the caller's (the scan's queue, the
// agent's drip), always on Keepa at 1 token.

import type { Catalog } from '../decompose';
import { checkListingFields } from '../keepa/listingFields';
import type { IdentityStatus, ListingIdentity } from '../keepa/verify';
import { BRAND_IN_TITLE_ONLY, BRAND_NOT_CONFIRMED, KIT_NOT_KNOWN } from '../match';
import { RESOLVED_BY_SCAN } from './answers';
import { wantedFor } from './classify';
import { holdForOwner } from './hold';
import type { CatalogCheckRecord, MatchRecord, ReviewItem, ScanStore } from './types';

/** The candidate reasons whose question a catalog check may settle: the brand, or whether the listing is a kit. */
export const CATALOG_QUESTION_REASONS: readonly string[] = [BRAND_NOT_CONFIRMED, BRAND_IN_TITLE_ONLY, KIT_NOT_KNOWN];

/** One listing to pull and check, for the part whose match or question holds it. */
export interface CatalogTarget {
  key: string;
  brand: string;
  model: string;
  asin: string;
  /** A title match ('match') or a listing an open match question offers ('question'). */
  holds: 'match' | 'question';
  /** Read before rung 1 and left unknown: read again, from the cached pull when there is one. */
  recheck?: boolean;
}

/** What one check changed for one part. */
export interface CatalogOutcome {
  key: string;
  asin: string;
  status: IdentityStatus;
  reason: string;
  /**
   * verified: the part is matched to the listing, verified; removed: the listing is no longer the part's; held: a stored
   * confirmation read again is not one any more, and the part waits for the owner (hold.ts); kept: nothing changed.
   */
  change: 'verified' | 'removed' | 'held' | 'kept';
  /** Rung 1's sub-rule when it, not the catalog check, confirmed. */
  rule?: string;
}

export const amazonListingLink = (asin: string): string => `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;

/** The listing ladder's version: 1 added rung 1 (keepa/listingFields.ts); 2 the brand aliases (keepa/brandAliases.ts); 3 the
 * manufacturer rule (brandAliases.ts makerAgrees), so an unknown read before them is read again once, from the cached pull;
 * 4 the family rule (match.ts FAMILY_PATTERNS), a rule that holds, so a confirmation by fields read before it is read again
 * once too (CONFIRMATION_LADDER). */
export const LADDER_VERSION = 4;
/** The version from which a stored confirmation by fields stands without a new read. */
export const CONFIRMATION_LADDER = 4;

/** Whether a stored check still stands: an unknown from before the current ladder is read again once. */
const stands = (c: CatalogCheckRecord): boolean => c.status !== 'unknown' || (c.ladder ?? 0) >= LADDER_VERSION;
const checkedFor = (m: MatchRecord, asin: string): boolean => (m.catalogChecks ?? []).some((c) => c.asin === asin && stands(c));
/** What a rung confirmed from a listing's fields (not a barcode, not the owner): read again under a rule that holds more. */
const BY_FIELDS: readonly string[] = ['keepa_catalog', 'serpapi_product', 'listing_fields'];
/**
 * A stored automatic confirmation by fields (rung 0 or 1, or a re-pick) that no check at CONFIRMATION_LADDER or later has
 * confirmed: read once more, from the cached pull, under the current rules.
 */
export const confirmationToReread = (m: MatchRecord): boolean =>
  m.decidedBy === 'auto' && m.status === 'matched' && m.asin !== null && m.grade === 'strong' && BY_FIELDS.includes(m.verifiedBy ?? '')
  && !(m.catalogChecks ?? []).some((c) => c.asin === m.asin && c.status === 'confirmed' && (c.ladder ?? 0) >= CONFIRMATION_LADDER);
/** Whether the listing was read before (an unknown read again): its pull may come from the cache. */
const readBefore = (m: MatchRecord, asin: string): boolean => (m.catalogChecks ?? []).some((c) => c.asin === asin);
const isTitleMatch = (m: MatchRecord): boolean => m.decidedBy === 'auto' && m.status === 'matched' && m.asin !== null && m.grade === 'probable';

async function openQuestion(store: ScanStore, key: string): Promise<ReviewItem | null> {
  const q = await store.getReview(`match:${key}`);
  return q && q.kind === 'match' && q.answer === null ? q : null;
}

/**
 * The listings to check now, one per ASIN, those in `first` (a buy waits on them) before any other, for the parts `parts` holds (a bundle wants them), most valuable first
 * (`saving`, the largest Home Depot saving among the part's bundles); a title match before a question at a tie. A
 * title match's listing, and each listing an open automatic match question offers for a reason in
 * CATALOG_QUESTION_REASONS, unless already checked for that part.
 */
export async function catalogChecksWanted(
  store: ScanStore, parts: ReadonlyMap<string, { saving: number }>, first: ReadonlySet<string> = new Set(),
): Promise<CatalogTarget[]> {
  const found: (CatalogTarget & { saving: number })[] = [];
  for (const m of await store.listMatches()) {
    const part = parts.get(m.key);
    if (!part || m.decidedBy !== 'auto') continue;
    if (isTitleMatch(m) && !checkedFor(m, m.asin!)) {
      found.push({ key: m.key, brand: m.brand, model: m.model, asin: m.asin!, holds: 'match', saving: part.saving, ...(readBefore(m, m.asin!) ? { recheck: true } : {}) });
    }
    // Ladder 4: a stored confirmation by fields is read again once, from the cached pull (the listing was pulled to confirm it).
    if (confirmationToReread(m)) found.push({ key: m.key, brand: m.brand, model: m.model, asin: m.asin!, holds: 'match', saving: part.saving, recheck: true });
    if (m.status !== 'review') continue;
    const q = await openQuestion(store, m.key);
    for (const c of q?.candidates ?? []) {
      if (c.reasons.some((r) => CATALOG_QUESTION_REASONS.includes(r)) && !checkedFor(m, c.asin)) {
        found.push({ key: m.key, brand: m.brand, model: m.model, asin: c.asin, holds: 'question', saving: part.saving, ...(readBefore(m, c.asin) ? { recheck: true } : {}) });
      }
    }
  }
  // Buy safety (Nov 23): `first`, the listings a buy waits on (BundleSignals.buyPending), go to the front of the queue.
  found.sort((a, b) => Number(first.has(b.asin)) - Number(first.has(a.asin)) || b.saving - a.saving || Number(a.holds === 'question') - Number(b.holds === 'question') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  return found.filter((t) => !seen.has(t.asin) && !!seen.add(t.asin)).map(({ saving: _s, ...t }) => t);
}

/**
 * Applies one pulled listing's fields to every automatic record that holds the ASIN unchecked: a title match on it, or
 * an open match question offering it. Returns what changed, one outcome per part. The price is the caller's to save.
 */
export async function applyCatalogCheck(
  ctx: { store: ScanStore; catalog: Catalog; now: () => number }, identity: ListingIdentity,
): Promise<CatalogOutcome[]> {
  const { store } = ctx;
  const asin = identity.asin;
  const out: CatalogOutcome[] = [];
  for (const m of await store.listMatches()) {
    const reread = confirmationToReread(m) && m.asin === asin;
    if (m.decidedBy !== 'auto' || (checkedFor(m, asin) && !reread)) continue;
    const onMatch = m.status === 'matched' && m.asin === asin && (reread || (m.grade !== 'exact' && m.grade !== 'strong'));
    const q = m.status === 'review' ? await openQuestion(store, m.key) : null;
    const offered = q?.candidates.some((c) => c.asin === asin) ?? false;
    if (!onMatch && !offered) continue;
    const now = ctx.now();
    const res = checkListingFields(wantedFor(m.brand, m.model, ctx.catalog), identity);
    const checks: CatalogCheckRecord[] = [...(m.catalogChecks ?? []).filter((c) => c.asin !== asin), { asin, status: res.status, reason: res.reason, at: now, ladder: LADDER_VERSION }];
    const evidence = `${res.reason}: ${amazonListingLink(asin)}`;
    const rejected = [...new Set([...(m.rejectedAsins ?? []), asin])];
    let change: CatalogOutcome['change'] = 'kept';
    if (reread && res.status === 'confirmed') {
      // The stored confirmation stands under the current rules: only the check is recorded.
      await store.putMatch({ ...m, catalogChecks: checks });
    } else if (reread && res.status === 'unknown') {
      // B0DGLWKS9S (Nov 24): confirmed from its part number, its title names another model. Not removed (nothing contradicts
      // it): the owner decides, with the reason and the listing's link.
      const held = await holdForOwner(store, { ...m, catalogChecks: checks }, { reason: res.reason, evidence: `${res.reason}: ${amazonListingLink(asin)}`, now, title: identity.title });
      if (!held) await store.putMatch({ ...m, catalogChecks: checks });
      change = held ? 'held' : 'kept';
    } else if (res.status === 'confirmed') {
      const source = res.rule !== null ? 'listing_fields' : identity.source === 'keepa_catalog' ? 'keepa_catalog' : 'serpapi_product';
      // As a Verify from a page: the listings kept beside it were of its old grade, and no scan judges it again from search rows.
      await store.putMatch({
        ...m, status: 'matched', asin, grade: 'strong', alternatives: [], updatedAt: now, waitingSince: null, source: 'page',
        verifiedBy: source, verifyEvidence: evidence, catalogChecks: checks,
      });
      if (q) await store.putReview({ ...q, answer: RESOLVED_BY_SCAN, answeredAt: now });
      change = 'verified';
    } else if (res.status === 'contradicted') {
      change = 'removed';
      if (onMatch) {
        const next = m.alternatives.filter((a) => !rejected.includes(a));
        if (next.length > 0) {
          const { verifyEvidence: _old, verifiedBy: _by, ...rest } = m;
          // A confirmation read again (a re-pick's switch) falls back to the listing it switched from, a title match again.
          await store.putMatch({
            ...rest, asin: next[0]!, alternatives: next.slice(1), rejectedAsins: rejected, catalogChecks: checks, updatedAt: now,
            ...(reread ? { grade: 'probable' as const } : m.verifiedBy ? { verifiedBy: m.verifiedBy } : {}),
          });
        } else {
          await store.putMatch({ ...m, status: 'none', asin: null, grade: null, alternatives: [], rejectedAsins: rejected, catalogChecks: checks, verifyEvidence: evidence, updatedAt: now });
        }
      } else {
        const left = q!.candidates.filter((c) => c.asin !== asin);
        if (left.length > 0) {
          await store.putReview({ ...q!, candidates: left });
          await store.putMatch({ ...m, rejectedAsins: rejected, catalogChecks: checks, updatedAt: now });
        } else {
          await store.putReview({ ...q!, candidates: [], answer: RESOLVED_BY_SCAN, answeredAt: now });
          await store.putMatch({ ...m, status: 'none', asin: null, grade: null, alternatives: [], rejectedAsins: rejected, catalogChecks: checks, verifyEvidence: evidence, updatedAt: now });
        }
      }
    } else {
      await store.putMatch({ ...m, catalogChecks: checks });
    }
    out.push({ key: m.key, asin, status: res.status, reason: res.reason, change, ...(res.rule ? { rule: res.rule } : {}) });
  }
  return out;
}

/** "Verified 6 listings from Amazon's catalog; 1 did not match and was removed." Null when nothing was verified or removed. */
export function catalogSentence(verified: number, removed: number): string | null {
  if (verified === 0 && removed === 0) return null;
  const v = `Verified ${verified} ${verified === 1 ? 'listing' : 'listings'} from Amazon's catalog`;
  if (removed === 0) return `${v}.`;
  return `${v}; ${removed} did not match and ${removed === 1 ? 'was' : 'were'} removed.`;
}
