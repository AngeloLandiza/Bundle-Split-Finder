// Nov 25, the market around a listing (core/src/tracking/market.ts): every Keepa pull now keeps the averages, Amazon's own
// offer, the New offer counts, the out-of-stock share and the hazard on its trend. A trend stored before that has none; the
// Keepa answers the app already cached hold them (stats=180 with every pull), so each such trend is filled once from the
// newest cached answer for its listing, at start, before the stored deals are judged again. No call, no token, no search.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { marketsOfBody, readPartTrend, writePartTrend, type TrendMarket } from '../core/src/keepa/trends';
import type { Cache } from '../core/src/serpapi/client';

/** Its name in runtime.migrations: done once. */
export const MARKET_BACKFILL = 'keepa-market-backfill';

/** The newest market of each listing in the cached Keepa answers under `<cacheDir>/keepa` (DirCache's layout). Reads only. */
export function cachedMarkets(cacheDir: string): Map<string, TrendMarket> {
  const dir = join(cacheDir, 'keepa');
  const out = new Map<string, TrendMarket>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let entry: { key?: unknown; at?: unknown; data?: unknown };
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8')) as typeof entry;
    } catch {
      continue;
    }
    // Product answers only (by ASIN or by code, and search rows that came with stats); a trend or an alert is not one.
    if (typeof entry.key !== 'string' || !/^keepa:(product|search)\?/.test(entry.key) || typeof entry.at !== 'number') continue;
    for (const { asin, market } of marketsOfBody(entry.data, entry.at)) {
      const had = out.get(asin);
      if (!had || had.at < market.at) out.set(asin, market);
    }
  }
  return out;
}

/** Fills `market` on each stored trend that has none, from `markets`; returns how many it filled. Never fails the start. */
export async function backfillMarkets(cache: Cache, markets: Map<string, TrendMarket>): Promise<number> {
  let filled = 0;
  for (const [asin, market] of markets) {
    try {
      const t = await readPartTrend(cache, asin);
      if (!t || t.market) continue;
      await writePartTrend(cache, { ...t, market });
      filled += 1;
    } catch {
      // A trend that cannot be read or written keeps what it had; the next pull fills it.
    }
  }
  return filled;
}
