// The app replaces a wrong listing itself (docs/decisions.md, "The app replaces a wrong listing itself", Nov 25).
//
// When a part's automatic listing is withdrawn (by the price guard, the ladder's title rule, the audit's certain findings or
// the owner's "Wrong listing"), the part is not a question yet. Its other stored candidates are tried in order through the
// measured ladder only, nothing new:
//
//   1. free: the candidate is not withdrawn or rejected for the part, not counted for another model, and its stored title
//      passes the audit's title checks (names the part, no other model, no pack of N for a single part);
//   2. the ladder: a stored catalog check of it for the part that still stands, else one Keepa pull (1 token, within the
//      drip's TokenBudget above the Keepa reserve; the pull's own cache first) read by rungs 0 and 1; with no Keepa at all,
//      rung 1 on the stored search row, as round 2's re-pick reads it. Never SerpApi, never AI;
//   3. the price guard on its price (PRICE_RATIO_LIMIT against Home Depot's price for the part sold alone) and the audit's
//      title checks on the title the pull returned.
//
// Every candidate is tried before one is chosen, and one is chosen only when exactly one passes: two that pass are two
// listings the ladder cannot tell apart (B0HMV5V9L7 "DEWALT DWST08017 … Deep Compact Organizer" names the adaptor plate's
// model on another product), so the owner decides, as round 2's re-pick decides (agent/verifyMatches.ts onlyConfirmed). A
// listing once withdrawn for a part is never chosen for it again by the app (RecheckRecord.withdrawn, and rejectedAsins
// so the scan's matching from saved listings skips it too); the owner may still choose it.
//
// None passes: the part joins the lookup queue (match status 'waiting', runner.ts lookupWanted), how a lookup finds a
// listing unchanged. Only when that fails too, the owner's "Which listing" question opens, each listing tried with why it
// was not taken (ReviewItem.tried). While tries run or wait for tokens the part is "being re-checked" (PartRow.recheck):
// status 'review' with no question, so the bundle has no estimate a buy could rest on (the existing rule for a part with
// no confirmed listing). Pure TypeScript over the ScanStore; the Keepa pull is the caller's.

import { isKitModel, otherModels, packOf } from '../audit/sanity';
import type { CertainWithdrawal } from '../audit/withdraw';
import type { Catalog } from '../decompose';
import { checkListingFields } from '../keepa/listingFields';
import type { ListingIdentity } from '../keepa/verify';
import { sameModel, titleHasModel } from '../match';
import { RESOLVED_BY_SCAN } from './answers';
import { amazonListingLink, LADDER_VERSION } from './catalogCheck';
import { wantedFor } from './classify';
import { ANOTHER_LISTING, candidate as candidateRow } from './hold';
import { priceCheckFor, priceGuardReason } from './priceGuard';
import {
  partKey, type CatalogCheckRecord, type MatchRecord, type RecheckRecord, type RecheckTry, type ReviewCandidate, type ReviewItem, type ScanStore,
  type VerifiedBy, type WithdrawnBy,
} from './types';

/**
 * A stored unknown catalog check from this ladder version on stands for a re-check without a new read: version 4 (the
 * family rule) only stops confirmations, so an unknown from version 3 is still unknown under the current rules. Earlier
 * unknowns are read again (from the cached pull), as catalogCheck.ts reads them.
 */
export const UNKNOWN_STANDS_FROM_LADDER = 3;

/** The question's reason when every candidate was tried and none passed (or more than one did). */
export const recheckQuestionReason = (tried: readonly RecheckTry[]): string => {
  const passed = tried.filter((t) => t.passed).length;
  if (passed > 1) return `The app tried the part's other listings: ${passed} pass its checks, and it cannot tell which is the part`;
  return tried.length === 0
    ? 'The listing was withdrawn and the app found no other listing for the part'
    : `The listing was withdrawn; the app tried ${tried.length} other ${tried.length === 1 ? 'listing' : 'listings'} and none could be confirmed`;
};

// ---------------------------------------------------------------- withdrawing

export interface Withdraw {
  key: string;
  asin: string;
  reason: string;
  by: WithdrawnBy;
  now: number;
  /** Listings to offer and to try first, in order (a held question's candidates); the match's alternatives otherwise. */
  offered?: ReviewCandidate[];
}

/** Whether the store keeps re-checks: a store without them (the extension's) asks at once, as before. */
export const keepsRechecks = (store: ScanStore): boolean => typeof store.putRecheck === 'function' && typeof store.getRecheck === 'function';

/** The listings withdrawn from the part so far. */
async function withdrawnOf(store: ScanStore, key: string): Promise<Set<string>> {
  return new Set(((await store.getRecheck?.(key))?.withdrawn ?? []).map((w) => w.asin));
}

/**
 * The part's other stored candidates, in order: `first` (the withdrawn match's alternatives, or the held question's other
 * listings), then the stored search rows whose models or title name the part under its brand, each once, none withdrawn
 * or rejected for the part.
 */
export async function storedCandidates(store: ScanStore, m: Pick<MatchRecord, 'brand' | 'model'>, first: readonly string[], skip: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = [];
  const add = (a: string) => {
    if (!skip.has(a) && !out.includes(a)) out.push(a);
  };
  first.forEach(add);
  const brand = m.brand.trim().toUpperCase();
  for (const l of await store.listListings()) {
    if ((l.brand ?? '').trim().toUpperCase() !== brand) continue;
    if (l.models.some((x) => sameModel(m.brand, x, m.model)) || titleHasModel(m.brand, l.title, m.model)) add(l.asin);
  }
  return out;
}

/**
 * Withdraws `asin` from the automatic match of `key` and starts its re-check: the match goes to review with no listing (no
 * estimate counts it), the listing is remembered as withdrawn and rejected for the part, an open question about the part
 * is closed (it reopens if the re-check fails), and the candidates are queued. False, changing nothing, when the store
 * keeps no re-checks, the part was decided by the owner, or the match holds another listing than `asin`.
 */
export async function withdrawListing(store: ScanStore, w: Withdraw): Promise<boolean> {
  if (!keepsRechecks(store)) return false;
  const m = await store.getMatch(w.key);
  if (!m || m.decidedBy !== 'auto') return false;
  // The listing is the match's, or already taken off it by hold.ts (the held question offers it first).
  const held = m.status === 'matched' && m.asin === w.asin;
  const alreadyHeld = m.status === 'review' && m.asin === null && w.offered?.[0]?.asin === w.asin;
  if (!held && !alreadyHeld) return false;
  const old = await store.getRecheck!(w.key);
  const withdrawn = [...(old?.withdrawn ?? []).filter((x) => x.asin !== w.asin), { asin: w.asin, reason: w.reason, by: w.by, at: w.now }];
  const rejected = [...new Set([...(m.rejectedAsins ?? []), w.asin])];
  const skip = new Set([...withdrawn.map((x) => x.asin), ...rejected]);
  const first = w.offered ? w.offered.map((c) => c.asin) : m.alternatives;
  const pending = await storedCandidates(store, m, first, skip);
  const offeredRows = w.offered ?? [await candidateRow(store, w.asin, [w.reason], null)];
  const offered = [
    { ...offeredRows[0]!, reasons: [w.reason] },
    ...offeredRows.slice(1),
    ...(await Promise.all(pending.filter((a) => !offeredRows.some((c) => c.asin === a)).map((a) => candidateRow(store, a, [ANOTHER_LISTING], null)))),
  ];
  const { verifiedBy: _v, ...rest } = m;
  await store.putMatch({
    ...rest, status: 'review', asin: null, grade: null, alternatives: [], waitingSince: null, updatedAt: w.now, rejectedAsins: rejected,
    verifyEvidence: `${w.reason}: ${amazonListingLink(w.asin)}`,
  });
  const q = await store.getReview(`match:${w.key}`);
  if (q && q.answer === null) await store.putReview({ ...q, answer: RESOLVED_BY_SCAN, answeredAt: w.now });
  await store.putRecheck!({
    key: w.key, brand: m.brand, model: m.model, stage: 'trying', withdrawn, pending, tried: [], offered, startedAt: w.now, updatedAt: w.now,
  });
  return true;
}

/**
 * Whether an open question is one hold.ts opened (the price guard, the ladder's title rule): the held listing first with
 * the question's own reason, every other listing "another listing found for the part". The withdrawal it stands for, or null.
 */
export function heldQuestionOf(q: ReviewItem): { asin: string; reason: string; by: WithdrawnBy } | null {
  if (q.kind !== 'match' || q.answer !== null || q.tried !== undefined || q.candidates.length === 0) return null;
  const [first, ...others] = q.candidates;
  if (first!.reasons.length !== 1 || first!.reasons[0] !== q.reason) return null;
  if (!others.every((c) => c.reasons.length === 1 && c.reasons[0] === ANOTHER_LISTING)) return null;
  return { asin: first!.asin, reason: q.reason, by: q.reason.startsWith("Amazon's price is") ? 'price_guard' : 'title_rule' };
}

/**
 * Every question hold.ts opened and the owner has not answered becomes a re-check: the app tries the part's other
 * listings before asking him (also those opened before this existed: DWST08017's of Nov 24). Returns the part keys.
 */
export async function recheckHeldQuestions(store: ScanStore, now: number): Promise<string[]> {
  if (!keepsRechecks(store)) return [];
  const out: string[] = [];
  for (const q of await store.listReview()) {
    const held = heldQuestionOf(q);
    if (!held) continue;
    const r = await store.getRecheck!(q.subject);
    if (r && r.stage !== 'done' && r.withdrawn.some((w) => w.asin === held.asin)) continue;
    if (await withdrawListing(store, { key: q.subject, asin: held.asin, reason: held.reason, by: held.by, now, offered: q.candidates })) out.push(q.subject);
  }
  return out;
}

/**
 * The audit's certain findings (audit/withdraw.ts certainWithdrawals) acted on as "Wrong listing", each part once: its
 * listing withdrawn and its re-check started. Returns the part keys withdrawn.
 */
export async function withdrawCertain(store: ScanStore, found: readonly CertainWithdrawal[], now: number): Promise<string[]> {
  const out: string[] = [];
  for (const w of found) {
    const key = partKey(w.brand, w.model);
    const by: WithdrawnBy = w.kind === 'title_other_model' ? 'audit_title' : 'audit_two_models';
    if (await withdrawListing(store, { key, asin: w.asin, reason: w.reason, by, now })) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------- trying

/** What a pull gives: the listing's catalog fields (null when Keepa has no record), or why no pull can be made now. */
export type PullResult = ListingIdentity | null | { wait: string };

export interface RecheckDeps {
  store: ScanStore;
  catalog: Catalog;
  now: () => number;
  /**
   * One Keepa product pull of the candidate, its price saved by the caller (1 token within the drip's TokenBudget, the
   * cache first): `{ wait }` when the tokens are below the reserve or the read is the drip's to make. Absent when the app
   * has no Keepa at all: the stored search row is read instead (rung 1 on title and brand).
   */
  pull?: (asin: string, model: string) => Promise<PullResult>;
  shouldStop?: () => boolean;
}

export interface RecheckDone {
  /** Candidates tried in this pass. */
  tried: number;
  /** Parts matched to a candidate. */
  replaced: { key: string; from: string; to: string; evidence: string }[];
  /** Parts that joined the lookup queue. */
  lookups: string[];
  /** Parts whose question opened. */
  asked: string[];
  /** Pulls made (the caller counts their tokens). */
  pulls: number;
  /** Whether any record changed: the report is then rebuilt. */
  changed: boolean;
}

const stands = (c: CatalogCheckRecord): boolean => c.status !== 'unknown' || (c.ladder ?? 0) >= UNKNOWN_STANDS_FROM_LADDER;

/** The audit's title checks on a candidate's title (sanity.ts), as one phrase, or null when the title passes. */
export function titleProblem(brand: string, model: string, title: string): string | null {
  const others = otherModels(brand, title, model);
  if (!titleHasModel(brand, title, model)) return others.length > 0 ? `its title names ${others.join(', ')}, not ${model}` : null;
  if (others.length > 0 && !isKitModel(brand, model)) return `its title also names ${others.join(', ')}`;
  const pack = packOf(title);
  if (pack !== null && !/-[0-9]{1,2}$/.test(model)) return `its title sells a pack of ${pack}`;
  return null;
}

/** The stored search row as a listing identity: title and brand only (round 2's re-pick reads it so). */
const storedIdentity = (asin: string, title: string, brand: string | null): ListingIdentity => ({
  asin, title, brand, manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null, source: 'serpapi_product',
});

type Outcome = { passed: boolean; reason: string; by?: VerifiedBy } | { wait: string };

/** One candidate through the free checks, the ladder and the price guard. */
async function tryOne(d: RecheckDeps, m: MatchRecord, asin: string, counted: ReadonlyMap<string, string[]>): Promise<{ outcome: Outcome; pulled: boolean }> {
  const { store } = d;
  const no = (reason: string) => ({ outcome: { passed: false, reason }, pulled: false });
  const elsewhere = (counted.get(asin) ?? []).filter((x) => !sameModel(m.brand, x, m.model));
  if (elsewhere.length > 0) return no(`it is already counted for ${elsewhere.join(', ')}`);
  const listing = await store.getListing(asin);
  const stored = listing?.title ? titleProblem(m.brand, m.model, listing.title) : null;
  if (stored) return no(stored);
  const want = wantedFor(m.brand, m.model, d.catalog);
  let pulled = false;
  let res: { status: 'confirmed' | 'contradicted' | 'unknown'; reason: string; by?: VerifiedBy };
  const kept = [...(m.catalogChecks ?? [])].reverse().find((c) => c.asin === asin && stands(c));
  if (kept) {
    res = { status: kept.status, reason: kept.reason, ...(kept.status === 'confirmed' ? { by: 'keepa_catalog' as const } : {}) };
  } else if (d.pull) {
    const id = await d.pull(asin, m.model);
    if (id !== null && 'wait' in id) return { outcome: { wait: id.wait }, pulled: false };
    pulled = true;
    if (id === null) {
      res = { status: 'unknown', reason: 'Keepa has no record of the listing' };
    } else {
      const r = checkListingFields(want, id);
      res = { status: r.status, reason: r.reason, ...(r.status === 'confirmed' ? { by: r.rule !== null ? ('listing_fields' as const) : ('keepa_catalog' as const) } : {}) };
      // The check is kept on the part, as the catalog check keeps it: the listing is not pulled again for it.
      const checks = [...(m.catalogChecks ?? []).filter((c) => c.asin !== asin), { asin, status: r.status, reason: r.reason, at: d.now(), ladder: LADDER_VERSION }];
      m.catalogChecks = checks;
      await store.putMatch({ ...(await store.getMatch(m.key))!, catalogChecks: checks });
      const pulledTitle = id.title ? titleProblem(m.brand, m.model, id.title) : null;
      if (r.status === 'confirmed' && pulledTitle) return { outcome: { passed: false, reason: pulledTitle }, pulled };
    }
  } else if (listing?.title) {
    const r = checkListingFields(want, storedIdentity(asin, listing.title, listing.brand));
    res = { status: r.status, reason: r.reason, ...(r.status === 'confirmed' ? { by: 'listing_fields' as const } : {}) };
  } else {
    return no('the app has no title or record of it to read');
  }
  if (res.status !== 'confirmed') return { outcome: { passed: false, reason: res.reason }, pulled };
  const guard = await priceCheckFor(store, m, asin);
  if (guard) return { outcome: { passed: false, reason: priceGuardReason(guard.ratio) }, pulled };
  return { outcome: { passed: true, reason: res.reason, ...(res.by ? { by: res.by } : {}) }, pulled };
}

/** Each listing an automatic or owner's match counts, with the models it is counted for (the audit's two-models check). */
async function countedModels(store: ScanStore): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const x of await store.listMatches()) {
    if (x.status !== 'matched' || !x.asin) continue;
    out.set(x.asin, [...(out.get(x.asin) ?? []), x.model]);
  }
  return out;
}

/** Opens the owner's question: every listing offered or tried, each with why it was not taken. */
async function ask(store: ScanStore, r: RecheckRecord, now: number): Promise<void> {
  const why = new Map<string, string[]>();
  for (const w of r.withdrawn) why.set(w.asin, [`withdrawn: ${w.reason}`]);
  for (const t of r.tried) why.set(t.asin, [t.passed ? `passes the app's checks (${t.reason})` : t.reason]);
  const rows = [...r.offered];
  for (const t of r.tried) if (!rows.some((c) => c.asin === t.asin)) rows.push(await candidateRow(store, t.asin, [], null));
  const candidates = rows.map((c) => ({ ...c, reasons: why.get(c.asin) ?? c.reasons }));
  const catalogTitle = (await store.getCatalogEntry(r.key))?.title ?? null;
  await store.putReview({
    id: `match:${r.key}`, kind: 'match', subject: r.key, brand: r.brand, model: r.model, title: catalogTitle,
    reason: recheckQuestionReason(r.tried), candidates, choices: [], openedAt: now, answer: null, answeredAt: null, tried: r.tried,
  });
}

/**
 * One pass over every re-check: candidates tried in order until a pull must wait (the tokens are shared: every re-check
 * waits then), a part whose candidates are all tried is matched (exactly one passed), queued for a lookup (none) or asked
 * (more than one); a part back from its lookup is done (a listing not withdrawn) or asked. Never a search, never AI.
 */
export async function runRechecks(d: RecheckDeps): Promise<RecheckDone> {
  const done: RecheckDone = { tried: 0, replaced: [], lookups: [], asked: [], pulls: 0, changed: false };
  const { store } = d;
  if (!keepsRechecks(store)) return done;
  let waiting: string | null = null;
  for (const start of await store.listRechecks!()) {
    if (d.shouldStop?.()) break;
    const r: RecheckRecord = structuredClone(start);
    const m = await store.getMatch(r.key);
    if (!m || m.decidedBy !== 'auto') continue;
    const now = d.now();
    // A lookup rewrites the match whole (runner.ts applyLookup), so the withdrawn listings are rejected again here.
    const rejectedAsins = [...new Set([...(m.rejectedAsins ?? []), ...r.withdrawn.map((w) => w.asin)])];
    if (m.status === 'matched' && m.asin !== null && r.withdrawn.some((w) => w.asin === m.asin)) {
      // A listing withdrawn before came back (a lookup chose it again): never the app's choice for the part; the owner decides.
      const { verifiedBy: _v, ...rest } = m;
      await store.putMatch({ ...rest, status: 'review', asin: null, grade: null, alternatives: [], rejectedAsins, updatedAt: now });
      await ask(store, r, now);
      await store.putRecheck!({ ...r, stage: 'asked', updatedAt: now });
      done.asked.push(r.key);
      done.changed = true;
      continue;
    }
    if (r.stage === 'trying' && m.status === 'matched') {
      // The scan matched the part from its saved listings meanwhile (runner.ts matchFromListings): the ladder reads it as any.
      await store.putRecheck!({ ...r, stage: 'done', updatedAt: now });
      done.changed = true;
      continue;
    }
    if (r.stage === 'lookup') {
      if (m.status === 'waiting') continue;
      if (m.status === 'matched') {
        await store.putMatch({ ...m, rejectedAsins });
        await store.putRecheck!({ ...r, stage: 'done', updatedAt: now });
      } else if (m.status === 'review') {
        // The lookup opened its own question: it says what was tried too.
        await store.putMatch({ ...m, rejectedAsins });
        const q = await store.getReview(`match:${r.key}`);
        if (q && q.answer === null) await store.putReview({ ...q, tried: r.tried });
        else await ask(store, r, now);
        await store.putRecheck!({ ...r, stage: 'asked', updatedAt: now });
        done.asked.push(r.key);
      } else {
        // The lookup found no listing: the owner decides among those the app tried.
        await store.putMatch({ ...m, status: 'review', rejectedAsins, updatedAt: now });
        await ask(store, r, now);
        await store.putRecheck!({ ...r, stage: 'asked', updatedAt: now });
        done.asked.push(r.key);
      }
      done.changed = true;
      continue;
    }
    if (r.stage !== 'trying' || m.status !== 'review') continue;
    if (waiting !== null) {
      if (r.waitingFor !== waiting) {
        await store.putRecheck!({ ...r, waitingFor: waiting, updatedAt: now });
        done.changed = true;
      }
      continue;
    }
    const counted = await countedModels(store);
    while (r.pending.length > 0 && waiting === null && !d.shouldStop?.()) {
      const asin = r.pending[0]!;
      const { outcome, pulled } = await tryOne(d, m, asin, counted);
      if (pulled) done.pulls += 1;
      if ('wait' in outcome) {
        waiting = outcome.wait;
        break;
      }
      r.pending.shift();
      r.tried.push({ asin, passed: outcome.passed, reason: outcome.reason, at: d.now(), ...(outcome.by ? { by: outcome.by } : {}) });
      done.tried += 1;
      done.changed = true;
    }
    if (r.pending.length > 0) {
      const { waitingFor: _w, ...rest } = r;
      await store.putRecheck!({ ...rest, ...(waiting !== null ? { waitingFor: waiting } : {}), updatedAt: d.now() });
      if (waiting !== null && start.waitingFor !== waiting) done.changed = true;
      continue;
    }
    const { waitingFor: _w, ...settled } = r;
    const passed = r.tried.filter((t) => t.passed);
    const current = (await store.getMatch(r.key))!;
    if (passed.length === 1) {
      const to = passed[0]!;
      const from = r.withdrawn[r.withdrawn.length - 1]!;
      const evidence = `replaced ${from.asin} (${from.reason}) with ${to.asin}: ${to.reason}: ${amazonListingLink(to.asin)}`;
      await store.putMatch({
        ...current, status: 'matched', asin: to.asin, grade: 'strong', alternatives: [], waitingSince: null, source: 'page',
        verifiedBy: to.by ?? 'listing_fields', verifyEvidence: evidence, updatedAt: d.now(),
      });
      await store.putRecheck!({ ...settled, stage: 'done', updatedAt: d.now() });
      done.replaced.push({ key: r.key, from: from.asin, to: to.asin, evidence });
    } else if (passed.length === 0) {
      // The lookup queue (runner.ts lookupWanted): a fresh search, found as any lookup finds a listing.
      await store.putMatch({ ...current, status: 'waiting', asin: null, grade: null, alternatives: [], waitingSince: d.now(), updatedAt: d.now() });
      await store.putRecheck!({ ...settled, stage: 'lookup', updatedAt: d.now() });
      done.lookups.push(r.key);
    } else {
      await ask(store, settled, d.now());
      await store.putRecheck!({ ...settled, stage: 'asked', updatedAt: d.now() });
      done.asked.push(r.key);
    }
    done.changed = true;
  }
  return done;
}

/** How many re-checks have work for the drip (candidates left to try). */
export async function rechecksWaiting(store: ScanStore): Promise<number> {
  if (!keepsRechecks(store)) return 0;
  return (await store.listRechecks!()).filter((r) => r.stage === 'trying' && r.pending.length > 0).length;
}

// ---------------------------------------------------------------- words

/** "B0C3TN1Z7P: Amazon's catalog lists no part number that is DWST08017". */
export const triedWords = (t: Pick<RecheckTry, 'asin' | 'reason'>): string => `${t.asin}: ${t.reason}`;

/**
 * The part's line while it is re-checked: "Being re-checked: B0DGLWKS9S was withdrawn (Amazon's price is 9.7× …); tried
 * B0C3TN1Z7P (…); 3 more listings to try, waiting for Keepa tokens." Null when the part is not being re-checked.
 */
export function recheckSentence(r: RecheckRecord): string | null {
  if (r.stage !== 'trying' && r.stage !== 'lookup') return null;
  const last = r.withdrawn[r.withdrawn.length - 1];
  const parts = [`Being re-checked: ${last ? `${last.asin} was withdrawn (${last.reason})` : 'its listing was withdrawn'}`];
  const failed = r.tried.filter((t) => !t.passed);
  if (failed.length > 0) parts.push(`tried ${failed.map((t) => `${t.asin} (${t.reason})`).join('; ')}`);
  if (r.stage === 'lookup') parts.push('no other stored listing passed, so it waits for a fresh lookup');
  else if (r.pending.length > 0) parts.push(`${r.pending.length} more ${r.pending.length === 1 ? 'listing' : 'listings'} to try${r.waitingFor ? `, waiting for ${r.waitingFor}` : ''}`);
  return `${parts.join('; ')}.`;
}
