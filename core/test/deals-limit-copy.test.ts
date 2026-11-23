import { describe, expect, it } from 'vitest';

import { limitCopy } from '../src/deals/limitCopy';
import type { BundleRow, ScanJob } from '../src/scan/types';

const job: ScanJob = {
  id: '1',
  startedAt: 0,
  finishedAt: 0,
  status: 'stopped',
  stopReason: 'run_cap',
  stopMessage: null,
  phase: 'parts',
  queue: [],
  deferred: [],
  searchesUsed: 5,
  counts: {
    pagesFetched: 0,
    productsSeen: 0,
    bundlesSeen: 0,
    bundlesResolved: 0,
    reviewsOpened: 0,
    lookupsDone: 0,
    refreshesDone: 0,
    partsMatched: 0,
    catalogPages: 0,
    listingsSaved: 0,
    partsFromCatalog: 0,
    pagesRead: 0,
  },
};

const emptyBundles: BundleRow[] = [];

describe('limitCopy', () => {
  it('describes a run_cap stop', () => {
    const copy = limitCopy({ lastJob: job, searchesPerScan: 5, rateLimitPerHour: 50, now: 0 }, emptyBundles);
    expect(copy?.title).toBe('Scan stopped at your search limit');
    expect(copy?.limit).toBe(true);
  });
});