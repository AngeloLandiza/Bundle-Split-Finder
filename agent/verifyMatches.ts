// The catalog check between scans (the drip's hook; core/src/scan/catalogCheck.ts). Once no lookup waits, each title
// match and each brand or kit question's listing is pulled on Keepa (1 token, above the reserve, through the drip's own
// TokenBudget and client) and read against Amazon's structured fields. Never a SerpApi search.

import type { TokenBudget } from '../core/src/keepa/budget';
import { KEEPA_SEARCH_TOKEN_ESTIMATE, productTokenEstimate } from '../core/src/keepa/estimates';
import { checkListingFields } from '../core/src/keepa/listingFields';
import type { KeepaProduct, KeepaTrackingDepth } from '../core/src/keepa/types';
import { identityFromKeepa, type ListingIdentity } from '../core/src/keepa/verify';
import type { Catalog } from '../core/src/decompose';
import { amazonListingLink, applyCatalogCheck, catalogChecksWanted } from '../core/src/scan/catalogCheck';
import { sameModel } from '../core/src/match';
import { bundleParts, savePrice } from '../core/src/scan/runner';
import type { ScanStore } from '../core/src/scan/types';
import type { SearchResult } from '../core/src/serpapi/client';
import { parseAmazonProduct } from '../core/src/serpapi/parsers';

/** A cached pull this young is read again for rung 1 instead of a new pull: a listing's identity fields do not go stale. */
export const RECHECK_MAX_AGE_MS = 90 * 86_400_000;

export interface VerifyDeps {
  store: ScanStore;
  catalog: Catalog;
  now: () => number;
  keepaBudget: Pick<TokenBudget, 'blockReason'>;
  /** One Keepa product pull (keepa/fetchStep.ts keepaProductSearchResult): its result carries `keepaProduct`. */
  keepaProduct: (asin: string, label: string, maxAgeMs?: number) => Promise<SearchResult>;
  trackingDepth?: KeepaTrackingDepth;
  /** Asked before each pull: the drip stops when a scan or a paid action claims the store. */
  shouldStop: () => boolean;
  /** Buy safety (Nov 23): listings a buy waits on, checked before any other. */
  first?: ReadonlySet<string>;
  /** Check only the listings in `first` (the drip does them before its lookups). */
  onlyFirst?: boolean;
}

export interface VerifyDone {
  /** Listings pulled; verified and removed count ASINs (each once), as the scan counts them. */
  pulled: number;
  verified: number;
  removed: number;
  tokens: number;
}

/** Buy safety (Nov 23): the listings every held-back buy waits on (BundleSignals.buyPending), watched or not. */
export function buyWaitsOn(tracking: { signals: Record<string, { buyPending?: { asins: string[] } }> }): Set<string> {
  return new Set(Object.values(tracking.signals).flatMap((s) => s.buyPending?.asins ?? []));
}

/** How many listings wait for a catalog check now: the drip runs while this is above 0 even with no lookup waiting. */
export async function checksWaiting(store: ScanStore): Promise<number> {
  return (await catalogChecksWanted(store, await bundleParts(store))).length;
}

/** The listings waiting for a catalog check now (rungs 0 and 1), by ASIN. */
export async function checksWanted(store: ScanStore): Promise<string[]> {
  return (await catalogChecksWanted(store, await bundleParts(store))).map((t) => t.asin);
}

/**
 * The listings to check, most valuable first, each pulled once while a pull's tokens are above the reserve. A pull's
 * price is saved as a refresh's is. Throws what Keepa throws (a network error, a 401): what was done before stays done.
 */
export async function verifyMatchesWithKeepa(d: VerifyDeps): Promise<VerifyDone> {
  const done: VerifyDone = { pulled: 0, verified: 0, removed: 0, tokens: 0 };
  const pull = productTokenEstimate(d.trackingDepth, 1);
  const first = d.first ?? new Set<string>();
  const all = await catalogChecksWanted(d.store, await bundleParts(d.store), first);
  const targets = d.onlyFirst ? all.filter((t) => first.has(t.asin)) : all;
  for (const t of targets) {
    if (d.shouldStop() || d.keepaBudget.blockReason(pull) !== null) break;
    // The listing ladder: a listing read before rung 1 is read again from the cached pull when there is one (free).
    const r = await d.keepaProduct(t.asin, `agent:drip:verify:${t.model}`, t.recheck ? RECHECK_MAX_AGE_MS : undefined);
    done.pulled += 1;
    if (r.source === 'network') done.tokens += r.keepaTokens ?? pull;
    const page = parseAmazonProduct(r.data, t.asin);
    if (page && page.asin === t.asin) await savePrice({ store: d.store }, t.asin, page, r.at);
    if (!r.keepaProduct) continue;
    const outcomes = await applyCatalogCheck(d, identityFromKeepa(r.keepaProduct));
    if (outcomes.some((o) => o.change === 'verified')) done.verified += 1;
    if (outcomes.some((o) => o.change === 'removed')) done.removed += 1;
  }
  return done;
}

// ---------------------------------------------------------------- round 2: re-pick before giving up

/** A part's Keepa search for a better listing is made at most this often. */
export const REPICK_SEARCH_EVERY_MS = 7 * 86_400_000;
/** What one Keepa search for a part holds (KEEPA_SEARCH_TOKEN_ESTIMATE plus its price pull). */
export const REPICK_SEARCH_TOKENS = KEEPA_SEARCH_TOKEN_ESTIMATE + 1;

export interface RepickTarget {
  key: string;
  model: string;
  /** The counted listing no rung could confirm. */
  asin: string;
  /** Why (autoConfirm.ts unconfirmableOf): said in the switch's record. */
  reason: string;
}

export interface RepickDeps {
  store: ScanStore;
  now: () => number;
  keepaBudget: Pick<TokenBudget, 'blockReason'>;
  /** One Keepa product search ("RYOBI PCG002"): its products with their catalog fields. Absent: no search. */
  keepaSearch?: (term: string, label: string) => Promise<KeepaProduct[]>;
  /** One Keepa product pull, for the new listing's price. */
  keepaProduct?: (asin: string, label: string) => Promise<SearchResult>;
  /** When each part was last searched (epoch ms), and how to remember a search. */
  searchedAt: Readonly<Record<string, number>>;
  saveSearched: (key: string, at: number) => void;
  shouldStop: () => boolean;
}

export interface RepickDone {
  switched: { key: string; from: string; to: string; evidence: string }[];
  searches: number;
  tokens: number;
}

/** The stored search rows that name the part's model: what a scan already saw, as listings with a title and a brand. */
async function storedCandidates(store: ScanStore, brand: string, model: string): Promise<ListingIdentity[]> {
  return (await store.listListings())
    .filter((l) => l.models.some((m) => sameModel(brand, m, model)))
    .map((l) => ({ asin: l.asin, title: l.title, brand: l.brand, manufacturer: null, partNumber: null, model: null, numberOfItems: null, packageQuantity: null, source: 'serpapi_product' as const }));
}

/** The one candidate rungs 0 and 1 confirm, other than the chosen and the rejected; null when none or more than one. */
export function onlyConfirmed(
  brand: string, model: string, chosen: string, rejected: readonly string[], candidates: ListingIdentity[],
): { asin: string; reason: string; byFields: boolean } | null {
  const want = { brand, model };
  const seen = new Set<string>();
  const passing = candidates.flatMap((c) => {
    if (c.asin === chosen || rejected.includes(c.asin) || seen.has(c.asin)) return [];
    seen.add(c.asin);
    const r = checkListingFields(want, c);
    return r.status === 'confirmed' ? [{ asin: c.asin, reason: r.reason, byFields: r.rule !== null }] : [];
  });
  return passing.length === 1 ? passing[0]! : null;
}

/**
 * Round 2 of the listing ladder: for each counted listing no rung could confirm, the part's other candidates, free first
 * (the stored search rows), then one Keepa search for the part (at most once a week, only while its tokens are above the
 * reserve). When exactly one candidate passes rung 0 or rung 1, the part moves to it, verified, with a record of the
 * switch; the old listing stays an alternative (nothing contradicted it). Otherwise nothing changes.
 */
export async function repickUnconfirmed(d: RepickDeps, targets: RepickTarget[]): Promise<RepickDone> {
  const done: RepickDone = { switched: [], searches: 0, tokens: 0 };
  for (const t of targets) {
    if (d.shouldStop()) break;
    const m = await d.store.getMatch(t.key);
    if (!m || m.decidedBy !== 'auto' || m.status !== 'matched' || m.asin !== t.asin || m.grade === 'exact' || m.grade === 'strong') continue;
    const rejected = m.rejectedAsins ?? [];
    let found = onlyConfirmed(m.brand, m.model, t.asin, rejected, await storedCandidates(d.store, m.brand, m.model));
    let fromSearch = false;
    const last = d.searchedAt[t.key];
    if (!found && d.keepaSearch && (last === undefined || d.now() - last >= REPICK_SEARCH_EVERY_MS) && d.keepaBudget.blockReason(REPICK_SEARCH_TOKENS) === null) {
      d.saveSearched(t.key, d.now());
      const products = await d.keepaSearch(`${m.brand} ${m.model}`, `agent:drip:repick:${m.model}`);
      done.searches += 1;
      done.tokens += KEEPA_SEARCH_TOKEN_ESTIMATE;
      found = onlyConfirmed(m.brand, m.model, t.asin, rejected, products.map(identityFromKeepa));
      fromSearch = found !== null;
    }
    if (!found) continue;
    const to = found.asin;
    const evidence = `switched from ${t.asin} (${t.reason}) to ${to}: ${found.reason}: ${amazonListingLink(to)}`;
    await d.store.putMatch({
      ...m, asin: to, grade: 'strong', alternatives: [t.asin, ...m.alternatives.filter((a) => a !== to && a !== t.asin)],
      source: 'page', verifiedBy: !found.byFields && fromSearch ? 'keepa_catalog' : 'listing_fields', verifyEvidence: evidence, updatedAt: d.now(),
    });
    done.switched.push({ key: t.key, from: t.asin, to, evidence });
    // The new listing's price, so the estimate is recomputed on it (1 token, as a refresh).
    if (d.keepaProduct && d.keepaBudget.blockReason(1) === null) {
      const r = await d.keepaProduct(to, `agent:drip:repick:price:${m.model}`);
      if (r.source === 'network') done.tokens += r.keepaTokens ?? 1;
      const page = parseAmazonProduct(r.data, to);
      if (page && page.asin === to) await savePrice({ store: d.store }, to, page, r.at);
    }
  }
  return done;
}
