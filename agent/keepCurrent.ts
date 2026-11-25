// Keeping deals current between scans (Nov 25): the agent's side of core/src/tracking/keepCurrent.ts. The drip calls here
// for one Home Depot page of a due deal (its own page, free, through Home Depot's pace in drip mode, so a refusal pauses
// it like any other read) and for the Keepa pulls of its due Amazon prices (1 token each, above the Keepa reserve, within
// the day's share; never a SerpApi search). What changed goes through the scan's report and signals (agent/work.ts
// refresh); a verdict that flipped is one sentence in Activity, and through the notification policy when alerts are on.

import type { KeepCurrentState } from '../core/src/api/contract';
import type { TokenBudget } from '../core/src/keepa/budget';
import { savePrice } from '../core/src/scan/runner';
import type { ScanStore } from '../core/src/scan/types';
import { parseAmazonProduct } from '../core/src/serpapi/parsers';
import type { PromoPageOutcome } from '../core/src/tracking/bogoPairs';
import {
  amazonDue, HD_KEEP_CURRENT_PAGES_PER_DAY, hdDue, KEEP_CURRENT_CACHE_MS, keepCost, keepSentence, keepUsageOf, keptDeals, snapshotOf, staleSince,
  type AmazonDue, type DealSnapshot, type KeepTier, type KeepUsage, type KeptDeal,
} from '../core/src/tracking/keepCurrent';
import type { ProductPull } from './signalsPass';
import type { StoreData } from './store';

type Data = Pick<StoreData, 'deals' | 'tracking'>;

/** The watched deals as they are kept current, from the stored deals and tracking. */
export const keptNow = (data: Data): KeptDeal[] => keptDeals(data.deals.bundles, data.tracking);

/** The Buy now deals whose prices are older than the stated limit: shown so, and never announced. */
export function staleBuyKeys(data: Data, now: number): Set<string> {
  return new Set(keptNow(data).filter((d) => staleSince(d, now) !== null).map((d) => d.key));
}

/** What each watched deal's verdict rests on now (before a refresh), by key. */
export function dealSnapshots(data: Data): Map<string, DealSnapshot> {
  const t = data.tracking;
  return new Map(
    data.deals.bundles
      .filter((b) => t.watch[b.key]?.watched === true)
      .map((b) => [b.key, snapshotOf(b, (t.signals[b.key]?.buyNow ?? null) !== null)] as const),
  );
}

/** Whether Amazon prices are refreshed between scans: a Keepa key, Keepa on, the drip on (as the Keepa drip itself). */
export function keepaKeeps(data: Pick<StoreData, 'keys' | 'settings'>): boolean {
  const app = data.settings;
  return Boolean(data.keys.keepa) && app.settings.amazonRefreshViaKeepa && app.lookups?.drip !== false;
}

/** The day's token share for this refill, or 0 while the refill is not known (nothing is pulled on a guessed budget). */
export function tokenShareOf(deals: readonly KeptDeal[], refillPerMin: number | null, tokensPerPull: number): number {
  return keepCost(deals, { tokensPerPull, refillPerMin }).tokenShare ?? 0;
}

/** The Agent panel's figures and words (AgentState.agent.keepCurrent); null when nothing is watched. */
export function keepCurrentView(data: Pick<StoreData, 'deals' | 'tracking' | 'runtime' | 'keys' | 'settings'>, now: number, tokensPerPull = 1): KeepCurrentState | null {
  const kept = keptNow(data);
  if (kept.length === 0) return null;
  const keepa = keepaKeeps(data);
  const usage = keepUsageOf(data.runtime.keepCurrent, now);
  const cost = keepCost(kept, { tokensPerPull, refillPerMin: data.runtime.keepa?.refillRate ?? null });
  const pagesLeft = Math.max(0, cost.pageShare - usage.pages);
  const pagesWaiting = Math.max(0, hdDue(kept, now, usage.tried).length - pagesLeft);
  const pullsLeft = cost.tokenShare === null ? 0 : Math.floor(Math.max(0, cost.tokenShare - usage.tokens) / tokensPerPull);
  const pullsWaiting = keepa && cost.tokenShare !== null ? Math.max(0, amazonDue(kept, now, usage.tried).length - pullsLeft) : 0;
  return {
    buyNow: cost.buyNow, watched: cost.watched, pagesPerDay: cost.pagesPerDay, tokensPerDay: cost.tokensPerDay, pageShare: cost.pageShare,
    tokenShare: cost.tokenShare, pagesToday: usage.pages, tokensToday: usage.tokens, pagesWaiting, pullsWaiting, keepa,
    sentence: keepSentence(cost, { pagesWaiting, pullsWaiting, keepa })!,
  };
}

/** The usage with one more page or tokens, and a try at `at`. */
export function used(u: KeepUsage, add: { pages?: number; tokens?: number; tried?: string }, at: number): KeepUsage {
  return {
    ...u, pages: u.pages + (add.pages ?? 0), tokens: u.tokens + (add.tokens ?? 0),
    tried: add.tried ? { ...u.tried, [add.tried]: at } : u.tried,
  };
}

export interface HdKeepDeps {
  store: ScanStore;
  readPromoPages: (itemIds: string[]) => Promise<PromoPageOutcome[]>;
  now: () => number;
}

/** What one Home Depot read of a kept deal did. */
export interface HdKeepOutcome {
  deal: KeptDeal;
  /** 1 when Home Depot (or Chrome) was asked; 0 when the pace allowed no read. */
  pages: number;
  /** The page gave the deal's price: its record's seenAt moved to now. */
  checked: boolean;
  /** The price (or was-price) is not the stored one. */
  changed: boolean;
  /**
   * Home Depot refused the page (the pace's cool-down pauses every read): not a try, so the deal is read first again once
   * reading goes on. A page with no price for it is a try: not asked again before its cadence.
   */
  refused?: boolean;
}

const percentOff = (price: number | null, was: number | null): number | null =>
  price !== null && was !== null && was > price ? Math.round(((was - price) / was) * 100) : null;

/**
 * The next due deal's own Home Depot page, read once. A page of that item with a price is the deal's price now: its
 * record's price (and was-price, when the page gives one) and seenAt move; anything else (refused, unreadable, no price,
 * another item) changes nothing. Throws what Chrome throws (it did not answer). Null when no deal is due or today's
 * share is read.
 */
export async function readOneDue(d: HdKeepDeps, kept: readonly KeptDeal[], usage: KeepUsage): Promise<HdKeepOutcome | null> {
  if (usage.pages >= HD_KEEP_CURRENT_PAGES_PER_DAY) return null;
  const deal = hdDue(kept, d.now(), usage.tried)[0];
  if (!deal || deal.itemId === null) return null;
  const got = (await d.readPromoPages([deal.itemId])).find((o) => o.itemId === deal.itemId);
  if (!got || got.kind === 'skipped') return { deal, pages: 0, checked: false, changed: false };
  if (got.kind === 'refused') return { deal, pages: 1, checked: false, changed: false, refused: true };
  if (got.kind !== 'read' || got.page.itemId !== deal.itemId || got.page.price === null) return { deal, pages: 1, checked: false, changed: false };
  const rec = await d.store.getBundle(deal.key);
  if (!rec) return { deal, pages: 1, checked: false, changed: false };
  const price = got.page.price;
  const regularPrice = got.page.wasPrice ?? rec.regularPrice;
  const changed = price !== rec.price || regularPrice !== rec.regularPrice;
  const off = changed ? percentOff(price, regularPrice) : rec.percentOff;
  await d.store.putBundle({ ...rec, price, regularPrice, percentOff: off, seenAt: d.now() });
  return { deal, pages: 1, checked: true, changed };
}

export interface KeepaKeepDeps {
  store: ScanStore;
  keepaBudget: Pick<TokenBudget, 'blockReason'>;
  /** A pull that keeps trends (signalsPass.pullKeepingTrends). */
  pull: ProductPull;
  /** Tokens one pull is estimated at (productTokenEstimate of the tracking depth). */
  cost: number;
  /** Tokens of today's share left. */
  tokensLeft: number;
  shouldStop: () => boolean;
  /** Called after each pull with its tokens (0 from the cache) and the listing: the agent counts it. */
  onPull: (asin: string, tokens: number) => void;
}

/**
 * The due Amazon prices of `tier` (Buy now, or every tier), each one Keepa product pull while a pull's tokens are above the
 * reserve and within today's share; the price is saved as a refresh's is (a listing Keepa answers with no New price has
 * none now). A pull whose answer is not that listing saves nothing. Throws what Keepa throws: what was done stays done.
 */
export async function pullDue(d: KeepaKeepDeps, due: readonly AmazonDue[], tier: KeepTier | 'all'): Promise<{ pulled: number; tokens: number }> {
  const done = { pulled: 0, tokens: 0 };
  let left = d.tokensLeft;
  for (const w of due) {
    if (tier !== 'all' && w.tier !== tier) continue;
    if (d.shouldStop() || left < d.cost || d.keepaBudget.blockReason(d.cost) !== null) break;
    const r = await d.pull(w.asin, `agent:keep:${w.model}`, KEEP_CURRENT_CACHE_MS);
    const tokens = r.source === 'network' ? (r.keepaTokens ?? d.cost) : 0;
    done.pulled += 1;
    done.tokens += tokens;
    left -= tokens;
    d.onPull(w.asin, tokens);
    const page = parseAmazonProduct(r.data, w.asin);
    if (page && page.asin === w.asin) await savePrice({ store: d.store }, w.asin, page, r.at);
  }
  return done;
}
