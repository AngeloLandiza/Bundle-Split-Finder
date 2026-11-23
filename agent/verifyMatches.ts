// The catalog check between scans (the drip's hook; core/src/scan/catalogCheck.ts). Once no lookup waits, each title
// match and each brand or kit question's listing is pulled on Keepa (1 token, above the reserve, through the drip's own
// TokenBudget and client) and read against Amazon's structured fields. Never a SerpApi search.

import type { TokenBudget } from '../core/src/keepa/budget';
import { productTokenEstimate } from '../core/src/keepa/estimates';
import type { KeepaTrackingDepth } from '../core/src/keepa/types';
import { identityFromKeepa } from '../core/src/keepa/verify';
import type { Catalog } from '../core/src/decompose';
import { applyCatalogCheck, catalogChecksWanted } from '../core/src/scan/catalogCheck';
import { bundleParts, savePrice } from '../core/src/scan/runner';
import type { ScanStore } from '../core/src/scan/types';
import type { SearchResult } from '../core/src/serpapi/client';
import { parseAmazonProduct } from '../core/src/serpapi/parsers';

export interface VerifyDeps {
  store: ScanStore;
  catalog: Catalog;
  now: () => number;
  keepaBudget: Pick<TokenBudget, 'blockReason'>;
  /** One Keepa product pull (keepa/fetchStep.ts keepaProductSearchResult): its result carries `keepaProduct`. */
  keepaProduct: (asin: string, label: string) => Promise<SearchResult>;
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
    const r = await d.keepaProduct(t.asin, `agent:drip:verify:${t.model}`);
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
