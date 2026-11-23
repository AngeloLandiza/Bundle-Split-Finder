// BOGO pairs never crowd out the other bundles (controller, Nov 23): the scan's Amazon lookups are the other bundles'
// parts first, then pairs group by group, by Home Depot's own saving (was - price), at most three new pairs per group a
// scan. The pairs, item ids and prices are the Nov 23 recording (fixtures/homedepot-pages/bogo-2026-11-23.json); each
// pair is split as its model number reads (starter + free part), since the pairs' own splits are not recorded.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MemoryScanStore } from '../src/scan/memoryStore';
import { bundleParts, lookupOrder, pairLookupOrder, PAIR_LOOKUPS_PER_GROUP } from '../src/scan/runner';
import { bundleKey, type BundleRecord } from '../src/scan/types';

interface RecordedItem { itemId: string; model: string; brand: string; title: string; price: number; original: number | null }
const recording = JSON.parse(readFileSync(new URL('../../fixtures/homedepot-pages/bogo-2026-11-23.json', import.meta.url), 'utf8')) as { lists: Record<'ryobi' | 'dewalt', { items: RecordedItem[] }> };
const RYOBI_GROUP = '945815:317987584';
const DEWALT_GROUP = '945972:334337675';

const record = (it: { itemId: string; brand: string; model: string; price: number; original: number | null }, components: string[]): BundleRecord => ({
  key: bundleKey(it.itemId), retailer: 'homedepot', itemId: it.itemId, title: it.model, brand: it.brand, model: it.model, upc: null,
  price: it.price, regularPrice: it.original, percentOff: null, link: null, seenAt: 1, split: { components, status: 'resolved', notes: [] },
});

/** The recorded pairs as bundle records, and the group of each. DEWALT's free parts are their full models (an assumption of this test). */
function pairs(): { records: BundleRecord[]; groups: Record<string, string> } {
  const records: BundleRecord[] = [];
  const groups: Record<string, string> = {};
  for (const it of recording.lists.ryobi.items.filter((i) => i.model.startsWith('PCL1201K2-'))) {
    records.push(record(it, ['PCL1201K2', it.model.slice('PCL1201K2-'.length)]));
    groups[bundleKey(it.itemId)] = RYOBI_GROUP;
  }
  const free: Record<string, string> = { DCK200D1P1W921B: 'DCF921B', DCK200D1P1WB606: 'DCB606' };
  for (const it of recording.lists.dewalt.items.filter((i) => free[i.model])) {
    records.push(record(it, ['DCK200D1P1', free[it.model]!]));
    groups[bundleKey(it.itemId)] = DEWALT_GROUP;
  }
  return { records, groups };
}

/** The recorded non-BOGO bundle RYOBI PCL1600K2-P553 ($388, was $488), and any extra parts it is given. */
const normal = (extra: string[] = []) => record({ itemId: '320243741', brand: 'RYOBI', model: 'PCL1600K2-P553', price: 388, original: 488 }, ['PCL1600K2', 'P553', ...extra]);

async function plan(records: BundleRecord[], groups: Record<string, string>, matched: string[] = []) {
  const store = new MemoryScanStore();
  for (const r of records) await store.putBundle(r);
  const parts = await bundleParts(store);
  const lookups = [...parts.keys()].filter((k) => !matched.includes(k)).sort(lookupOrder(parts, new Map(), []).byLookup);
  const savings = new Map(records.filter((r) => groups[r.key]).map((r) => [r.key, (r.regularPrice ?? r.price!) - r.price!]));
  return pairLookupOrder(lookups, parts, groups, savings).map((k) => k.split(':')[1]!);
}

describe('the order of the scan’s lookups with BOGO pairs', () => {
  it('other bundles first; then the group with the larger saving; three new pairs a group, by saving', async () => {
    const { records, groups } = pairs();
    expect(PAIR_LOOKUPS_PER_GROUP).toBe(3);
    expect(await plan([normal(), ...records], groups)).toEqual([
      'P553', 'PCL1600K2',
      // DEWALT: W921B saves $239 (was $538), WB606 $199; the starter kit is shared, so WB606 needs only its battery.
      'DCF921B', 'DCK200D1P1', 'DCB606',
      // RYOBI: PCL265B saves $139, PCL515B $89, PCL430B $79 (PCL525B also $79, after it by key); the rest wait.
      'PCL1201K2', 'PCL265B', 'PCL515B', 'PCL430B',
    ]);
  });

  it('a pair whose free part another bundle holds needs nothing new and is not counted', async () => {
    const { records, groups } = pairs();
    // Invented: the normal bundle also holds PCL515B, so its lookup is the normal bundle's and comes first.
    const order = await plan([normal(['PCL515B']), ...records], groups);
    expect(order.slice(0, 3)).toEqual(['P553', 'PCL1600K2', 'PCL515B']);
    expect(order.slice(-4)).toEqual(['PCL1201K2', 'PCL265B', 'PCL430B', 'PCL525B']);
  });

  it('matched parts cost nothing: a later scan continues down the list', async () => {
    const { records, groups } = pairs();
    const order = await plan([normal(), ...records], groups, ['RYOBI:PCL1201K2', 'RYOBI:PCL265B', 'RYOBI:PCL515B', 'RYOBI:PCL430B']);
    expect(order.filter((m) => m.startsWith('P') && m !== 'PCL1600K2' && m !== 'P553')).toEqual(['PCL525B', 'P20015BTL', 'PCL031B']);
  });

  it('a free part two groups share is looked up once, by the first group to reach it', async () => {
    const { records, groups } = pairs();
    // Invented: a second DEWALT promotion whose one pair is a kit + DCB606, saving less than the first group.
    const other = record({ itemId: '999000010', brand: 'DEWALT', model: 'DCK999WDCB606', price: 100, original: 150 }, ['DCK999', 'DCB606']);
    const order = await plan([normal(), ...records, other], { ...groups, [other.key]: '1:999' });
    expect(order.filter((m) => m === 'DCB606')).toHaveLength(1);
    expect(order.slice(-1)).toEqual(['DCK999']);
  });

  it('without pairs nothing changes', async () => {
    const { records } = pairs();
    const store = new MemoryScanStore();
    for (const r of [normal(), ...records]) await store.putBundle(r);
    const parts = await bundleParts(store);
    const lookups = [...parts.keys()];
    expect(pairLookupOrder(lookups, parts, {}, new Map())).toEqual(lookups);
  });
});
