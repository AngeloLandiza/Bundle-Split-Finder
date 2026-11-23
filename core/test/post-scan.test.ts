import { describe, expect, it } from 'vitest';

import { postScanWork } from '../src/scan/postScan';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { DEFAULT_SCAN_SETTINGS } from '../src/scan/types';
import { MemoryCache } from '../src/serpapi/client';

describe('postScanWork', () => {
  it('builds a report and tolerates empty store', async () => {
    const result = await postScanWork({ store: new MemoryScanStore(), settings: DEFAULT_SCAN_SETTINGS, now: () => 1 });
    expect(result.report.bundles).toEqual([]);
    expect(result.snapshotCount).toBe(0);
  });

  it('writes snapshots when a cache is given', async () => {
    const cache = new MemoryCache();
    const result = await postScanWork({
      store: new MemoryScanStore(),
      settings: DEFAULT_SCAN_SETTINGS,
      cache,
      now: () => 1,
    });
    expect(result.snapshotCount).toBe(0);
    expect(await cache.get('keepa:options:x')).toBeUndefined();
  });
});