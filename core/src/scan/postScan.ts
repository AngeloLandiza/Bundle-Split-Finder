// Shared scan-end work: report + option snapshots (extension, agent, CLI).

import { writeOptionSnapshots } from '../keepa/snapshots';
import { readTrends } from '../keepa/trends';
import type { Cache } from '../serpapi/client';
import { applyPriceGuard } from './priceGuard';
import { buildReport, type AmazonFeesLookup } from './report';
import type { ScanReport, ScanSettings, ScanStore } from './types';

export interface PostScanResult {
  report: ScanReport;
  /** Bundles with options written to `keepa:options:*`; 0 when cache is absent or write failed. */
  snapshotCount: number;
}

export async function postScanWork(deps: {
  store: ScanStore;
  settings: ScanSettings;
  cache?: Cache;
  now: () => number;
  /** Nov 25: Amazon's fee estimate for the owner's seller account, where read (agent/seller.ts); absent, as before. */
  amazonFees?: AmazonFeesLookup;
}): Promise<PostScanResult> {
  // The price guard: a counted Amazon price far above Home Depot's for the part sold alone goes to Review first (priceGuard.ts).
  await applyPriceGuard(deps.store, deps.now());
  // Signals round 2: with the Keepa trends stored for every matched listing, so a part's FBA fee can count (fees.fulfillmentSource).
  const asins = deps.cache ? (await deps.store.listMatches()).flatMap((m) => (m.asin ? [m.asin] : [])) : [];
  const trend = deps.cache ? await readTrends(deps.cache, asins) : undefined;
  const report = await buildReport(deps.store, deps.settings, { ...(trend ? { trend } : {}), ...(deps.amazonFees ? { amazonFees: deps.amazonFees } : {}) });
  let snapshotCount = 0;
  if (deps.cache) {
    try {
      snapshotCount = await writeOptionSnapshots(deps.cache, report, deps.now());
    } catch {
      snapshotCount = 0;
    }
  }
  return { report, snapshotCount };
}