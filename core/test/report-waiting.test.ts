import { describe, expect, it } from 'vitest';
import { replayRecorded } from '../../scripts/replay';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { buildReport } from '../src/scan/report';
import { runScan } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '../src/scan/types';
import { parseAccount, SearchBudget } from '../src/serpapi/budget';
import { MemoryCache, SerpApiClient } from '../src/serpapi/client';
import { SERPAPI_ACCOUNT_FREE } from './fixtures';

// A part not looked up yet has no price, not a price of zero: the bundle shows no estimate until it is.

const T0 = Date.UTC(2026, 10, 9, 12);
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

describe('report: a bundle with a part still waiting for its lookup', () => {
  it('has no estimate until the lookup is done, then has one', async () => {
    const store = new MemoryScanStore();
    const replay = replayRecorded();
    const scan = (maxPerRun: number) => {
      const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun });
      const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn: replay.fetchFn, now: () => T0 });
      return runScan({ client, budget, store, settings: RATCHET, now: () => T0 });
    };

    // One search: the listing page is read, the Amazon lookups are left waiting.
    expect((await scan(1)).status).toBe('stopped');
    const before = (await buildReport(store, RATCHET)).bundles.filter((b) => b.parts.some((p) => p.status === 'waiting' || p.status === 'unmatched'));
    expect(before.length).toBeGreaterThan(0);
    for (const row of before) expect(row.estimate).toBeNull();

    // The lookups run: the same bundles now have an estimate from real prices.
    expect((await scan(10)).status).toBe('done');
    const after = (await buildReport(store, RATCHET)).bundles;
    for (const old of before) {
      const row = after.find((b) => b.key === old.key)!;
      expect(row.parts.some((p) => p.status === 'waiting' || p.status === 'unmatched')).toBe(false);
      expect(row.estimate).not.toBeNull();
    }
  });
});
