// The app replaces a wrong listing itself, in the agent (core/src/scan/recheck.ts chooses; docs/decisions.md, Nov 25).
//
// Every time the deals are rebuilt (never beside a scan) and at a scan's end: the questions the price guard and the
// ladder's title rule opened become re-checks, the audit's certain findings are withdrawn as "Wrong listing"
// (core/src/audit/withdraw.ts), and every re-check runs as far as it can without a pull. The pulls (1 Keepa token each,
// within the drip's TokenBudget above the Keepa reserve, the cache first) are the drip's: dripPull. Never SerpApi, never AI.

import { sanityFindings } from '../core/src/audit/sanity';
import { certainWithdrawals } from '../core/src/audit/withdraw';
import type { TokenBudget } from '../core/src/keepa/budget';
import { identityFromKeepa } from '../core/src/keepa/verify';
import type { Catalog } from '../core/src/decompose';
import { recheckHeldQuestions, runRechecks, withdrawCertain, type PullResult, type RecheckDone } from '../core/src/scan/recheck';
import { savePrice } from '../core/src/scan/runner';
import type { BundleRow, ScanStore } from '../core/src/scan/types';
import { parseAmazonProduct } from '../core/src/serpapi/parsers';
import type { ProductPull } from './signalsPass';

/** What a re-check waits for when the pull is the drip's to make (the deals are rebuilt between drip rounds). */
export const NEXT_KEEPA_READ = 'the next Keepa read';
/** What it waits for when the drip's tokens are at the reserve. */
export const KEEPA_TOKENS = 'Keepa tokens';

export interface SelfCorrectDeps {
  store: ScanStore;
  catalog: Catalog;
  now: () => number;
  /** Whether the app reads Keepa (a key): then candidates are pulled by the drip; without it the stored rows are read. */
  keepa: boolean;
  /** The findings the owner marked "This is right" (tracking.sanityCleared): never acted on. */
  cleared: readonly string[];
}

export interface SelfCorrected {
  /** Held questions turned into re-checks. */
  held: string[];
  /** Parts whose listing the audit withdrew. */
  withdrawn: string[];
  ran: RecheckDone;
}

/**
 * Held questions become re-checks, the certain findings on `bundles` are withdrawn, and the re-checks run without a
 * pull. `changed` tells the caller to build the report again.
 */
export async function selfCorrect(d: SelfCorrectDeps, bundles: readonly BundleRow[]): Promise<SelfCorrected & { changed: boolean }> {
  const now = d.now();
  const held = await recheckHeldQuestions(d.store, now);
  const withdrawn = await withdrawCertain(d.store, certainWithdrawals(sanityFindings(bundles, { cleared: d.cleared }), bundles), now);
  const ran = await runRechecks({
    store: d.store, catalog: d.catalog, now: d.now, ...(d.keepa ? { pull: async (): Promise<PullResult> => ({ wait: NEXT_KEEPA_READ }) } : {}),
  });
  return { held, withdrawn, ran, changed: held.length > 0 || withdrawn.length > 0 || ran.changed };
}

/**
 * The drip's pull for a re-check: one Keepa product pull while a token is above the reserve, its price saved as a
 * refresh saves it, its trend kept (the drip's ProductPull). `spent` counts the tokens of a pull that reached Keepa.
 */
export function dripPull(store: ScanStore, budget: Pick<TokenBudget, 'blockReason'>, product: ProductPull, spent: (tokens: number) => void): (asin: string, model: string) => Promise<PullResult> {
  return async (asin, model) => {
    if (budget.blockReason(1) !== null) return { wait: KEEPA_TOKENS };
    const r = await product(asin, `agent:drip:recheck:${model}`);
    if (r.source === 'network') spent(r.keepaTokens ?? 1);
    const page = parseAmazonProduct(r.data, asin);
    if (page && page.asin === asin) await savePrice({ store }, asin, page, r.at);
    return r.keepaProduct ? identityFromKeepa(r.keepaProduct) : null;
  };
}
