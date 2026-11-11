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
const MINUTE = 60_000;
const RATCHET: ScanSettings = { ...DEFAULT_SCAN_SETTINGS, catalogPagesPerScan: 0, queries: [{ q: 'ryobi extended reach ratchet' }] };

function world() {
  const store = new MemoryScanStore();
  const replay = replayRecorded();
  const w = { store, replay, clock: T0 };
  const scan = (maxPerRun: number, fetchFn: typeof fetch = replay.fetchFn) => {
    const budget = new SearchBudget(parseAccount({ ...SERPAPI_ACCOUNT_FREE }), { reserve: 0, maxPerRun });
    const client = new SerpApiClient({ apiKey: 'TEST', budget, cache: new MemoryCache(), fetchFn, now: () => w.clock });
    return runScan({ client, budget, store, settings: RATCHET, now: () => w.clock });
  };
  return { w, scan };
}

describe('report: a bundle with a part still waiting for its lookup', () => {
  it('has no estimate until the lookup is done, then has one', async () => {
    const { w, scan } = world();

    // One search: the listing page is read, the Amazon lookups are left waiting.
    expect((await scan(1)).status).toBe('stopped');
    const before = (await buildReport(w.store, RATCHET)).bundles.filter((b) => b.parts.some((p) => p.status === 'waiting' || p.status === 'unmatched'));
    expect(before.length).toBeGreaterThan(0);
    for (const row of before) expect(row.estimate).toBeNull();

    // The lookups run: the same bundles now have an estimate from real prices.
    expect((await scan(10)).status).toBe('done');
    const after = (await buildReport(w.store, RATCHET)).bundles;
    for (const old of before) {
      const row = after.find((b) => b.key === old.key)!;
      expect(row.parts.some((p) => p.status === 'waiting' || p.status === 'unmatched')).toBe(false);
      expect(row.estimate).not.toBeNull();
    }
  });

  it('is shown under "waiting" while its lookups wait, then moves to the section its listings give it', async () => {
    const { w, scan } = world();
    expect((await scan(1)).deferred.map((s) => s.kind)).toEqual(['lookup', 'lookup']);
    const waiting = (await buildReport(w.store, RATCHET)).bundles;
    // The two ratchet bundles resolve and have a price; their parts were never looked up. They are
    // not "missing listing": nobody has looked for one yet.
    expect(waiting.filter((b) => b.section !== 'split').map((b) => [b.model, b.section, b.parts.map((p) => [p.model, p.status, p.availability])])).toEqual([
      ['PBLRC01B-PBLRC25B', 'waiting', [['PBLRC01B', 'waiting', 'missing'], ['PBLRC25B', 'waiting', 'missing']]],
      ['PBLRC2501SB', 'waiting', [['PBLRC25B', 'waiting', 'missing'], ['PBLRC01B', 'waiting', 'missing']]],
    ]);
    const rows = waiting.filter((b) => b.section === 'waiting');
    expect(rows.map((b) => b.model).sort()).toEqual(['PBLRC01B-PBLRC25B', 'PBLRC2501SB']);
    for (const row of rows) {
      expect(row.price).not.toBeNull();
      expect(row.estimate).toBeNull();
      expect(row.parts.every((p) => p.status === 'waiting')).toBe(true);
    }
    // The report's order: confirmed, waiting, inactive listing, missing listing, contents not known.
    expect(waiting.map((b) => b.section)).toEqual([...rows.map(() => 'waiting'), ...waiting.filter((b) => b.section === 'split').map(() => 'split')]);

    // The lookups run: no bundle is waiting, and the two leave for the section their listings give.
    expect((await scan(10)).status).toBe('done');
    const after = (await buildReport(w.store, RATCHET)).bundles;
    expect(after.some((b) => b.section === 'waiting')).toBe(false);
    expect(after.filter((b) => rows.some((r) => r.key === b.key)).map((b) => [b.model, b.section]).sort()).toEqual([
      ['PBLRC01B-PBLRC25B', 'confirmed'],
      ['PBLRC2501SB', 'confirmed'],
    ]);
  });

  it('a bundle with no price of its own is not "waiting" whatever its parts', async () => {
    const { w, scan } = world();
    await scan(1);
    const row = (await buildReport(w.store, RATCHET)).bundles.find((b) => b.model === 'PBLRC2501SB')!;
    const bundle = (await w.store.getBundle(row.key))!;
    await w.store.putBundle({ ...bundle, price: null });
    expect((await buildReport(w.store, RATCHET)).bundles.find((b) => b.key === row.key)).toMatchObject({ section: 'missing_listing', estimate: null });
  });
});
