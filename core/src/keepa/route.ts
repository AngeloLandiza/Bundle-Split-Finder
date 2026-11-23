// Step 15, decision 1: a lookup never waits when any budget can pay for it. Pure: what the scan's Amazon work is paid
// with, given what each budget has left. The runner (planParts), the agent's "Look up all" quote and the drip read it.
//
//   1. Lookups, in value order: Keepa while the tokens above its reserve (and the per-scan cap) cover one; then
//      SerpApi while the per-scan cap, the monthly reserve and the hourly limit allow a search; the rest wait.
//   2. Product pulls (a product page owed, then refreshes of matched listings, each in value order): Keepa only when
//      Keepa is in play (1 token each, far cheaper than a search, and the runner sends them to Keepa); SerpApi only
//      when it is not. After every lookup, so a new part is never behind a re-check of a known one.

import type { BlockReason } from '../serpapi/budget';
import { KEEPA_LOOKUP_TOKEN_ESTIMATE, productTokenEstimate } from './estimates';
import type { KeepaTrackingDepth } from './types';

/** Why Amazon lookups wait, in the contract's words (LastScanSummary.lookupsBlockedBy). */
export type LookupBlock = 'keepa_tokens' | 'search_cap' | 'reserve' | 'hourly_limit';

/** The SerpApi limit, in the contract's words. */
export const lookupBlockOf = (r: BlockReason): LookupBlock => (r === 'run_cap' ? 'search_cap' : r);

export interface KeepaRoom {
  /** Tokens this scan may spend on Keepa: the balance above the reserve, under the per-scan cap. */
  tokens: number;
  trackingDepth?: KeepaTrackingDepth;
  /** False when Keepa can pull products but not search (no lookup function): lookups then go to SerpApi. Default true. */
  lookups?: boolean;
}

export interface SerpRoom {
  /** Searches that may still happen (SearchBudget.spendable, what other queued steps already hold taken off). */
  spendable: number;
  /** The SerpApi limit that refuses `n` more searches (SearchBudget.blockReason). */
  blockReason: (n: number) => BlockReason | null;
}

export interface RouteRequest {
  lookups: readonly string[];
  identifies?: readonly string[];
  refreshes?: readonly string[];
}

export interface RoutePlan {
  keepaLookups: string[];
  serpLookups: string[];
  deferredLookups: string[];
  keepaIdentifies: string[];
  serpIdentifies: string[];
  deferredIdentifies: string[];
  /** Refreshes: on Keepa when it is in play, else on SerpApi. */
  keepaRefreshes: string[];
  serpRefreshes: string[];
  deferredRefreshes: string[];
  /** Tokens and searches the plan expects to spend. */
  keepaTokens: number;
  searches: number;
  /** Why lookups wait; null when none does. With Keepa in play it is always Keepa: its tokens refill (the drip). */
  blockedBy: LookupBlock | null;
}

/**
 * Keepa tokens a scan may spend: what the account has above the reserve, and under the per-scan cap when one is set
 * (`tokensPerScan` 0 = automatic, no cap of its own). An unknown balance plans nothing on Keepa: never a guess.
 */
export function keepaTokensForScan(o: { tokensLeft: number | null | undefined; reserve: number; tokensPerScan: number }): number {
  if (o.tokensLeft == null || !Number.isFinite(o.tokensLeft)) return 0;
  const above = Math.max(0, Math.floor(o.tokensLeft) - Math.max(0, Math.floor(o.reserve)));
  const cap = o.tokensPerScan > 0 ? Math.floor(o.tokensPerScan) : Infinity;
  return Math.min(above, cap);
}

export function routeAmazonWork(req: RouteRequest, keepa: KeepaRoom | null, serp: SerpRoom): RoutePlan {
  let tokens = keepa ? Math.max(0, Math.floor(keepa.tokens)) : 0;
  const allowance = Math.max(0, Math.floor(serp.spendable));
  let searches = 0;
  const pull = productTokenEstimate(keepa?.trackingDepth, 1);
  const plan: RoutePlan = {
    keepaLookups: [], serpLookups: [], deferredLookups: [], keepaIdentifies: [], serpIdentifies: [], deferredIdentifies: [],
    keepaRefreshes: [], serpRefreshes: [], deferredRefreshes: [], keepaTokens: 0, searches: 0, blockedBy: null,
  };
  const onKeepa = (cost: number): boolean => {
    if (!keepa || !(tokens >= cost)) return false;
    tokens -= cost;
    plan.keepaTokens += cost;
    return true;
  };
  const onSerp = (): boolean => {
    if (searches >= allowance) return false;
    searches += 1;
    return true;
  };
  const lookupCost = keepa && keepa.lookups !== false ? KEEPA_LOOKUP_TOKEN_ESTIMATE : Infinity;
  for (const k of req.lookups) {
    if (onKeepa(lookupCost)) plan.keepaLookups.push(k);
    else if (onSerp()) plan.serpLookups.push(k);
    else plan.deferredLookups.push(k);
  }
  const pulls = (keys: readonly string[], onK: string[], onS: string[], wait: string[]): void => {
    for (const k of keys) {
      if (keepa) {
        if (onKeepa(pull)) onK.push(k);
        else wait.push(k);
      } else if (onSerp()) onS.push(k);
      else wait.push(k);
    }
  };
  pulls(req.identifies ?? [], plan.keepaIdentifies, plan.serpIdentifies, plan.deferredIdentifies);
  pulls(req.refreshes ?? [], plan.keepaRefreshes, plan.serpRefreshes, plan.deferredRefreshes);
  plan.searches = searches;
  if (plan.deferredLookups.length > 0) {
    plan.blockedBy = keepa && keepa.lookups !== false ? 'keepa_tokens' : lookupBlockOf(serp.blockReason(searches + 1) ?? 'run_cap');
  }
  return plan;
}
