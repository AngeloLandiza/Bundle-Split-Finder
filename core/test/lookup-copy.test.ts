// Step 15, decision 2: what happened to the lookups, and the real cause when some wait. The real second scan (Nov 23)
// said "Scan stopped at your search limit" when every lookup waited for Keepa and 17 of 18 searches were unused.

import { describe, expect, it } from 'vitest';

import { limitCopy } from '../src/deals/limitCopy';
import { lookupsSentence, waitCause } from '../src/deals/lookupCopy';
import type { BundleRow, PartRow, ScanJob } from '../src/scan/types';

describe('lookupsSentence', () => {
  it('names Keepa tokens and their refill, and what was done with searches', () => {
    expect(lookupsSentence({ waiting: 12, keepa: 0, serpapi: 6, blockedBy: 'keepa_tokens', refillPerMin: 1 })).toBe(
      '12 Amazon lookups wait for Keepa tokens (1 a minute); 6 were done with searches.',
    );
    expect(lookupsSentence({ waiting: 1, keepa: 4, serpapi: 2, blockedBy: 'keepa_tokens' })).toBe(
      '1 Amazon lookup waits for Keepa tokens; 4 were done with Keepa and 2 with searches.',
    );
  });

  it('names each SerpApi cause in its own words', () => {
    expect(waitCause('search_cap')).toBe('for the next scan: this scan used its search limit');
    expect(waitCause('reserve')).toBe('for searches: more would dip into your monthly reserve');
    expect(waitCause('hourly_limit')).toBe("for SerpApi's hourly limit to reset");
    expect(lookupsSentence({ waiting: 3, keepa: 0, serpapi: 0, blockedBy: 'reserve' })).toBe('3 Amazon lookups wait for searches: more would dip into your monthly reserve.');
  });

  it('none waiting: what paid; none at all: nothing', () => {
    expect(lookupsSentence({ waiting: 0, keepa: 4, serpapi: 14, blockedBy: null })).toBe('18 Amazon lookups done: 4 with Keepa, 14 with searches.');
    expect(lookupsSentence({ waiting: 0, keepa: 0, serpapi: 0, blockedBy: null })).toBe('');
  });
});

describe('limitCopy with a Keepa cause', () => {
  const part = (model: string): PartRow => ({ model, status: 'waiting' }) as PartRow;
  const bundles = [{ key: 'homedepot:1', brand: 'RYOBI', parts: [part('A'), part('B'), part('C')] }] as unknown as BundleRow[];
  const job = (over: Partial<ScanJob>) => ({
    status: 'stopped' as const, stopReason: 'keepa_tokens' as const, stopMessage: null, searchesUsed: 1, finishedAt: 0,
    deferred: ['A', 'B', 'C'].map((model) => ({ kind: 'lookup' as const, brand: 'RYOBI', model })), ...over,
  });

  it('says the lookups wait for Keepa tokens, never "search limit"', () => {
    const copy = limitCopy({ lastJob: job({ lookupsVia: { keepa: 4, serpapi: 0 }, lookupsBlockedBy: 'keepa_tokens' }), searchesPerScan: 18, rateLimitPerHour: 50, now: 0, keepaRefillPerMin: 1 }, bundles);
    expect(copy?.title).toBe('Amazon lookups wait for Keepa tokens');
    expect(copy?.text).toBe('3 Amazon lookups wait for Keepa tokens (1 a minute); 4 were done with Keepa. They run as Keepa refills, between scans or at the next scan.');
    expect(copy?.title).not.toMatch(/search limit/);
  });
});
