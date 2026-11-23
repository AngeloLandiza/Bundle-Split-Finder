// Suggested prices (Nov 23): the Keepa pulls a suggestion needs. A part whose Amazon listing is not for sale now gets
// Keepa's recent average New price as its suggestion (core/src/scan/suggest.ts), read from the listing's stored trend; a
// listing whose trend carries no average yet (never pulled, or pulled before averages were kept) is pulled once, 1 token,
// through the drip's token budget and above the reserve, after the drip's lookups, fee and sales pulls. Nothing here
// counts a price: the pull only stores the trend, and the next report offers the suggestion for the owner to confirm.

import type { TokenBudget } from '../core/src/keepa/budget';
import { productTokenEstimate } from '../core/src/keepa/estimates';
import { readPartTrend, type PartTrend } from '../core/src/keepa/trends';
import type { KeepaTrackingDepth } from '../core/src/keepa/types';
import type { BundleRow } from '../core/src/scan/types';
import type { Cache } from '../core/src/serpapi/client';
import type { ProductPull } from './signalsPass';

/** A trend that answers the average question: Keepa was asked with stats and said a figure or none (null). */
const averagesKnown = (t: Pick<PartTrend, 'newAvg90' | 'newAvg30'> | undefined): boolean => t !== undefined && (t.newAvg90 !== undefined || t.newAvg30 !== undefined);

/**
 * The listings to pull for their average: each inactive, matched part of a bundle missing a price that has no counted price,
 * no suggestion yet, and no stored average (averagesKnown). Bundles by smallest break-even first; each listing once.
 */
export function averagePullsWanted(
  bundles: readonly BundleRow[], trend: (asin: string) => Pick<PartTrend, 'newAvg90' | 'newAvg30'> | undefined,
): { asin: string; model: string }[] {
  const short = bundles.filter((b) => b.incomplete !== undefined).sort((a, b) => a.incomplete!.breakEvenNet - b.incomplete!.breakEvenNet);
  const out = new Map<string, string>();
  for (const b of short) {
    const unpriced = new Set(b.incomplete!.unpriced.filter((u) => u.state === 'inactive').map((u) => u.model));
    for (const p of b.parts) {
      if (!unpriced.has(p.model) || p.status !== 'matched' || !p.asin || p.priceSuggestion || out.has(p.asin)) continue;
      if (averagesKnown(trend(p.asin))) continue;
      out.set(p.asin, p.model);
    }
  }
  return [...out].map(([asin, model]) => ({ asin, model }));
}

export interface AveragePullDeps {
  cache: Cache;
  keepaBudget: Pick<TokenBudget, 'blockReason'>;
  /** A pull that keeps trends (signalsPass.pullKeepingTrends): the trend it writes carries the averages. */
  pull: ProductPull;
  trackingDepth?: KeepaTrackingDepth;
  shouldStop: () => boolean;
}

/**
 * The average pulls: each wanted listing once while a pull's tokens are above the reserve. A listing whose stored trend has
 * an average by now (another pull wrote it) is skipped. Throws what Keepa throws: what was done before stays done.
 */
export async function pullAverages(d: AveragePullDeps, wanted: { asin: string; model: string }[]): Promise<{ pulled: number; tokens: number }> {
  const done = { pulled: 0, tokens: 0 };
  const cost = productTokenEstimate(d.trackingDepth, 1);
  for (const w of wanted) {
    if (d.shouldStop() || d.keepaBudget.blockReason(cost) !== null) break;
    if (averagesKnown(await readPartTrend(d.cache, w.asin).catch(() => undefined))) continue;
    const r = await d.pull(w.asin, `agent:drip:average:${w.model}`);
    done.pulled += 1;
    if (r.source === 'network') done.tokens += r.keepaTokens ?? cost;
  }
  return done;
}
