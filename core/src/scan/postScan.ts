// Shared scan-end work: report + option snapshots (extension, agent, CLI).

import { writeOptionSnapshots } from '../keepa/snapshots';
import type { Cache } from '../serpapi/client';
import { buildReport } from './report';
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
}): Promise<PostScanResult> {
  const report = await buildReport(deps.store, deps.settings);
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