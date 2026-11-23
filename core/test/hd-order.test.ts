// Home Depot's pace, the order (core/src/scan/hdOrder.ts), replayed on the owner's fifth real scan
// (fixtures/e2e-2026-11-23/after-scan5: 258 bundles, 147 Home Depot sets, 139 of them waiting for their item pages after
// Home Depot refused). Which pages wait, in what order, how many, and how long the backlog takes at the pace's constants.
// Free; no network.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadScanFolder } from '../../scripts/data-folder';
import { backlogOf, bySaving, itemUnread, pagesWanted, savingOf } from '../src/scan/hdOrder';
import { backlogSentence, dripHoursFor, dripPagesPerHour, HD_LIMITS } from '../src/scan/hdPace';
import { MemoryScanStore } from '../src/scan/memoryStore';
import { partPricesWanted, readSetItemsFor } from '../src/scan/runner';
import { DEFAULT_SCAN_SETTINGS } from '../src/scan/types';
import type { PromoPageOutcome } from '../src/tracking/bogoPairs';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'e2e-2026-11-23', 'after-scan5');
/** When scan 5 finished (its job's finishedAt). */
const FINISHED = 1795475782108;

describe('the order Home Depot pages are read in, on the after-scan5 store', () => {
  it('139 sets wait for 220 distinct item pages (347 places: an item 2 sets share is one page); sets with a saving come first, biggest percent first', async () => {
    const store = await loadScanFolder(DIR);
    const bundles = await store.listBundles();
    const wants = pagesWanted(bundles);
    expect(backlogOf(wants)).toEqual({ pages: 220, sets: 139, bundles: 0 });
    // Each item once, however many sets list it: 74 items are in more than one set.
    expect(new Set(wants.map((w) => w.itemId)).size).toBe(220);
    expect(wants.filter((w) => w.kind === 'item' && w.sets.length > 1)).toHaveLength(74);
    const places = bundles.flatMap((b) => (b.set?.items ?? []).filter((i) => !i.model)).length;
    expect(places).toBe(347);

    const byKey = new Map(bundles.map((b) => [b.key, b] as const));
    const saving = (w: (typeof wants)[number]): boolean => w.kind === 'item' && w.sets.some((k) => savingOf(byKey.get(k)!).has);
    // The 71 sets with a Home Depot saving need 106 pages, all read before any page only a no-saving set needs.
    expect(wants.filter(saving)).toHaveLength(106);
    expect(wants.slice(0, 106).every(saving)).toBe(true);
    expect(wants.slice(106).some(saving)).toBe(false);
    // First: the RYOBI set at $59.94, was $99.94 (40.02% off, Home Depot's own figure 40%).
    const first = byKey.get((wants[0] as { sets: string[] }).sets[0]!)!;
    expect(first).toMatchObject({ itemId: '336796097', price: 59.94, regularPrice: 99.94 });
    const sets = [...bundles].filter((b) => b.set?.items.some(itemUnread)).sort(bySaving);
    expect(sets[0]!.itemId).toBe('336796097');
    // A set's items are queued together, so the first pages read finish whole sets: its two items are the first two pages.
    expect(wants.slice(0, 2).map((w) => w.itemId)).toEqual(first.set!.items.map((i) => i.itemId));
  });

  it('the part prices that complete an estimate (a bundle with an Amazon price already) are read before the rest', async () => {
    const store = await loadScanFolder(DIR);
    const parts = await partPricesWanted(store, DEFAULT_SCAN_SETTINGS, FINISHED + 60_000, true);
    expect(parts).toHaveLength(11);
    expect(parts.filter((p) => p.completes).map((p) => p.key)).toEqual(['RYOBI:PSBCK102K2']);
    expect(parts[0]).toMatchObject({ key: 'RYOBI:PSBCK102K2', completes: true });
  });

  it('the backlog at the pace: the drip alone reads the 220 pages in 5.5 hours at most 40 an hour; the sentence says the same', () => {
    expect(dripPagesPerHour()).toBe(40);
    expect(dripHoursFor(220)).toBe(5.5);
    // The 106 pages of the sets with a saving: under 3 hours of drip.
    expect(dripHoursFor(106)).toBe(2.65);
    // A scan reads up to 40 of them too (less what its lists and part prices take).
    expect(HD_LIMITS.pagesPerScan).toBe(40);
    expect(backlogSentence({ pages: 220, sets: 139, pausedUntil: null })).toBe(
      '139 sets wait for 220 Home Depot pages; between scans at most 40 are read an hour (240 a day), and each scan reads up to 40.',
    );
  });

  it('an item page two sets share is read once, and both sets take its reading', async () => {
    const store = await loadScanFolder(DIR);
    const wants = pagesWanted(await store.listBundles());
    const shared = wants.find((w) => w.kind === 'item' && w.sets.length > 1) as { itemId: string; sets: string[] };
    const mem = new MemoryScanStore();
    for (const key of shared.sets) await mem.putBundle((await store.getBundle(key))!);
    const asked: string[][] = [];
    const read = async (ids: string[]): Promise<PromoPageOutcome[]> => {
      asked.push(ids);
      return ids.map((id) => ({ itemId: id, kind: 'read', page: { itemId: id, brand: 'RYOBI', model: 'PBLRC01B', title: 'Item', price: 99, wasPrice: null, bullets: [], description: null, promotions: [] } }));
    };
    const out = await readSetItemsFor({ store: mem, read, itemIds: [shared.itemId, shared.itemId], now: () => FINISHED });
    expect(asked).toEqual([[shared.itemId]]);
    expect(out).toMatchObject({ read: 1, refused: false });
    expect(out.sets.sort()).toEqual([...shared.sets].sort());
    for (const key of shared.sets) expect((await mem.getBundle(key))!.set!.items.find((i) => i.itemId === shared.itemId)).toMatchObject({ model: 'PBLRC01B', readAt: FINISHED });
    // Read now, it waits for no page any more.
    expect(pagesWanted(await mem.listBundles()).some((w) => w.itemId === shared.itemId)).toBe(false);
  });
});
